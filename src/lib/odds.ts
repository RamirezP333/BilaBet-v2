export type PlayerPosition = 'portero' | 'defensa' | 'medio' | 'delantero'

export type Player = {
  id: string
  name: string
  position?: PlayerPosition
  positions?: PlayerPosition[] | null
  active: boolean
}

export type PlayerMatchStat = {
  round_id: string
  round_number: number
  player_id: string
  goals: number
  assists: number
  cards?: number
  yellow_cards?: number
  red_cards?: number
}

export type MarketDraft = {
  market_type: string
  player_id: string | null
  label: string
  odds: number
  sort_order: number
}

/**
 * BilaBet odds model
 *
 * The player markets are intentionally more conservative than a real bookmaker:
 * - no player-stat market can ever be below 1.70
 * - no player-stat market can ever be above 5.00
 * - position-specific floors prevent, for example, a goalkeeper goal market
 *   from becoming unrealistically cheap just because of a tiny sample
 * - the first matches are smoothed with a positional prior
 * - season performance and recent form are combined
 * - drought is used as a gradual adjustment rather than a hard jump
 *
 * Team markets keep the existing values because they are not based on
 * individual player statistics.
 */

const PLAYER_MIN_ODDS = 1.7
const PLAYER_MAX_ODDS = 5.0
const PRIOR_MATCHES = 5
const HOUSE_FACTOR = 0.94
const RECENT_MATCHES = 5

const goalPriorRate: Record<PlayerPosition, number> = {
  portero: 0.03,
  defensa: 0.10,
  medio: 0.22,
  delantero: 0.42,
}

const assistPriorRate: Record<PlayerPosition, number> = {
  portero: 0.03,
  defensa: 0.14,
  medio: 0.30,
  delantero: 0.28,
}

const cardPriorRate: Record<PlayerPosition, number> = {
  portero: 0.10,
  defensa: 0.25,
  medio: 0.17,
  delantero: 0.09,
}

/**
 * Position-specific minimum odds. A player with several positions receives
 * the average of the corresponding limits.
 */
const goalMinOdds: Record<PlayerPosition, number> = {
  portero: 3.5,
  defensa: 2.8,
  medio: 2.1,
  delantero: 1.7,
}

const assistMinOdds: Record<PlayerPosition, number> = {
  portero: 3.8,
  defensa: 3.0,
  medio: 2.3,
  delantero: 2.0,
}

const goalOrAssistMinOdds: Record<PlayerPosition, number> = {
  portero: 3.0,
  defensa: 2.5,
  medio: 2.0,
  delantero: 1.7,
}

const cardMinOdds: Record<PlayerPosition, number> = {
  portero: 3.5,
  defensa: 1.9,
  medio: 2.2,
  delantero: 2.8,
}

export function getPlayerMarketMinOdds(player: Player, marketType: string) {
  const minimums =
    marketType === 'PLAYER_GOAL'
      ? goalMinOdds
      : marketType === 'PLAYER_ASSIST'
        ? assistMinOdds
        : marketType === 'PLAYER_GOAL_OR_ASSIST'
          ? goalOrAssistMinOdds
          : marketType === 'PLAYER_CARD'
            ? cardMinOdds
            : null

  if (!minimums) return PLAYER_MIN_ODDS

  return Math.max(PLAYER_MIN_ODDS, averagePositionValue(player, minimums))
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function oneDecimal(value: number) {
  return Math.round(value * 10) / 10
}

function getPlayerPositions(player: Player): PlayerPosition[] {
  if (player.positions && player.positions.length > 0) return player.positions
  if (player.position) return [player.position]
  return ['medio']
}

function averagePositionValue(
  player: Player,
  values: Record<PlayerPosition, number>,
) {
  const positions = getPlayerPositions(player)
  const total = positions.reduce((acc, position) => acc + values[position], 0)
  return total / positions.length
}

function smoothedRate(observedEvents: number, played: number, priorRate: number) {
  return (observedEvents + priorRate * PRIOR_MATCHES) / (played + PRIOR_MATCHES)
}

function weightedRecentRate(rows: PlayerMatchStat[], getValue: (row: PlayerMatchStat) => number) {
  const recentRows = rows.slice(0, RECENT_MATCHES)

  if (recentRows.length === 0) return null

  let weightedEvents = 0
  let weightTotal = 0

  recentRows.forEach((row, index) => {
    const weight = 1 - index * 0.1
    weightedEvents += Math.max(0, Number(getValue(row) || 0)) * weight
    weightTotal += weight
  })

  return weightTotal > 0 ? weightedEvents / weightTotal : 0
}

function recentWeight(played: number) {
  if (played < 5) return 0
  return Math.min(0.35, 0.15 + (played - 5) * 0.04)
}

function combineSeasonAndRecent(
  seasonRate: number,
  recentRate: number | null,
  played: number,
) {
  if (recentRate === null) return seasonRate

  const weight = recentWeight(played)
  return seasonRate * (1 - weight) + recentRate * weight
}

function droughtAdjustment(gamesSinceLast: number, played: number) {
  if (played === 0) return 1

  if (gamesSinceLast === 0) return 1.10
  if (gamesSinceLast === 1) return 1.04
  if (gamesSinceLast === 2) return 1.00
  if (gamesSinceLast === 3) return 0.96
  if (gamesSinceLast === 4) return 0.92
  return 0.88
}

function eventProbabilityPerMatch(rate: number) {
  // Poisson-style probability of at least one event.
  return 1 - Math.exp(-Math.max(0, rate))
}

function oddsFromProbability(
  probability: number,
  minOdds: number,
) {
  const safeProbability = clamp(probability, 0.01, 0.95)
  const fairOdds = 1 / safeProbability
  const bookmakerOdds = fairOdds * HOUSE_FACTOR

  return oneDecimal(
    clamp(
      bookmakerOdds,
      Math.max(PLAYER_MIN_ODDS, minOdds),
      PLAYER_MAX_ODDS,
    ),
  )
}

function statsForPlayer(playerId: string, stats: PlayerMatchStat[]) {
  const rows = stats
    .filter((s) => s.player_id === playerId)
    .sort((a, b) => b.round_number - a.round_number)

  const played = rows.length
  const goals = rows.reduce((acc, s) => acc + Number(s.goals || 0), 0)
  const assists = rows.reduce((acc, s) => acc + Number(s.assists || 0), 0)
  const cards = rows.reduce(
    (acc, s) => acc + Number(s.yellow_cards || 0) + Number(s.red_cards || 0),
    0,
  )
  const goalOrAssistMatches = rows.filter(
    (s) => Number(s.goals || 0) > 0 || Number(s.assists || 0) > 0,
  ).length

  const sinceLast = (field: 'goals' | 'assists' | 'cards') => {
    if (played === 0) return 99

    let count = 0

    for (const row of rows) {
      if (field === 'cards') {
        if (Number(row.yellow_cards || 0) + Number(row.red_cards || 0) > 0) return count
      } else if (Number(row[field] || 0) > 0) {
        return count
      }

      count++
    }

    return played + 1
  }

  const recentGoals = weightedRecentRate(rows, (row) => Number(row.goals || 0))
  const recentAssists = weightedRecentRate(rows, (row) => Number(row.assists || 0))
  const recentCards = weightedRecentRate(
    rows,
    (row) => Number(row.yellow_cards || 0) + Number(row.red_cards || 0),
  )
  const recentGoalOrAssist = weightedRecentRate(
    rows,
    (row) => (Number(row.goals || 0) > 0 || Number(row.assists || 0) > 0 ? 1 : 0),
  )

  return {
    played,
    goals,
    assists,
    cards,
    goalRate: played ? goals / played : 0,
    assistRate: played ? assists / played : 0,
    goalOrAssistRate: played ? goalOrAssistMatches / played : 0,
    cardRate: played ? cards / played : 0,
    recentGoalRate: recentGoals,
    recentAssistRate: recentAssists,
    recentGoalOrAssistRate: recentGoalOrAssist,
    recentCardRate: recentCards,
    sinceGoal: sinceLast('goals'),
    sinceAssist: sinceLast('assists'),
    sinceCard: sinceLast('cards'),
  }
}

function calcPlayerOdds(
  player: Player,
  stats: PlayerMatchStat[],
  priorRates: Record<PlayerPosition, number>,
  minOddsByPosition: Record<PlayerPosition, number>,
  recentRate: number | null,
  seasonRate: number,
  droughtGames: number,
) {
  const priorRate = averagePositionValue(player, priorRates)
  const minOdds = averagePositionValue(player, minOddsByPosition)
  const s = statsForPlayer(player.id, stats)

  const smoothedSeasonRate = smoothedRate(
    seasonRate * s.played,
    s.played,
    priorRate,
  )

  const effectiveRate = combineSeasonAndRecent(
    smoothedSeasonRate,
    recentRate,
    s.played,
  )

  const adjustedRate = effectiveRate * droughtAdjustment(droughtGames, s.played)
  const probability = eventProbabilityPerMatch(adjustedRate)

  return oddsFromProbability(probability, minOdds)
}

function calcGoalOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)

  return calcPlayerOdds(
    player,
    stats,
    goalPriorRate,
    goalMinOdds,
    s.recentGoalRate,
    s.goalRate,
    s.sinceGoal,
  )
}

function calcAssistOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)

  return calcPlayerOdds(
    player,
    stats,
    assistPriorRate,
    assistMinOdds,
    s.recentAssistRate,
    s.assistRate,
    s.sinceAssist,
  )
}

function calcGoalOrAssistOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)

  return calcPlayerOdds(
    player,
    stats,
    {
      portero: goalPriorRate.portero + assistPriorRate.portero,
      defensa: goalPriorRate.defensa + assistPriorRate.defensa,
      medio: goalPriorRate.medio + assistPriorRate.medio,
      delantero: goalPriorRate.delantero + assistPriorRate.delantero,
    },
    goalOrAssistMinOdds,
    s.recentGoalOrAssistRate,
    s.goalOrAssistRate,
    Math.min(s.sinceGoal, s.sinceAssist),
  )
}

function calcCardOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)

  return calcPlayerOdds(
    player,
    stats,
    cardPriorRate,
    cardMinOdds,
    s.recentCardRate,
    s.cardRate,
    s.sinceCard,
  )
}

export function generateMarketsForRound(
  players: Player[],
  stats: PlayerMatchStat[],
): MarketDraft[] {
  const markets: MarketDraft[] = []

  markets.push(
    {
      market_type: 'RESULT_WIN_DRAW',
      player_id: null,
      label: 'Bilawal gana o empata',
      odds: 1.3,
      sort_order: 1,
    },
    {
      market_type: 'RESULT_WIN',
      player_id: null,
      label: 'Bilawal gana',
      odds: 1.8,
      sort_order: 2,
    },
    {
      market_type: 'TEAM_GOALS_3_PLUS',
      player_id: null,
      label: 'Bilawal marca 3+ goles',
      odds: 2.4,
      sort_order: 10,
    },
    {
      market_type: 'TEAM_GOALS_4_PLUS',
      player_id: null,
      label: 'Bilawal marca 4+ goles',
      odds: 3.2,
      sort_order: 11,
    },
    {
      market_type: 'TEAM_GOALS_5_PLUS',
      player_id: null,
      label: 'Bilawal marca 5+ goles',
      odds: 4.4,
      sort_order: 12,
    },
    {
      market_type: 'TEAM_GOALS_6_PLUS',
      player_id: null,
      label: 'Bilawal marca 6+ goles',
      odds: 6.0,
      sort_order: 13,
    },
    {
      market_type: 'TEAM_GOALS_7_PLUS',
      player_id: null,
      label: 'Bilawal marca 7+ goles',
      odds: 8.0,
      sort_order: 14,
    },
    {
      market_type: 'MATCH_CARDS_1_PLUS',
      player_id: null,
      label: 'Bilawal recibe 1+ tarjetas',
      odds: 1.4,
      sort_order: 30,
    },
    {
      market_type: 'MATCH_CARDS_2_PLUS',
      player_id: null,
      label: 'Bilawal recibe 2+ tarjetas',
      odds: 2.2,
      sort_order: 31,
    },
    {
      market_type: 'MATCH_CARDS_3_PLUS',
      player_id: null,
      label: 'Bilawal recibe 3+ tarjetas',
      odds: 3.2,
      sort_order: 32,
    },
  )

  const sortedPlayers = [...players].sort((a, b) =>
    a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }),
  )

  let order = 100

  for (const player of sortedPlayers) {
    markets.push(
      {
        market_type: 'PLAYER_GOAL',
        player_id: player.id,
        label: `${player.name} marca`,
        odds: calcGoalOdds(player, stats),
        sort_order: order++,
      },
      {
        market_type: 'PLAYER_ASSIST',
        player_id: player.id,
        label: `${player.name} asiste`,
        odds: calcAssistOdds(player, stats),
        sort_order: order++,
      },
      {
        market_type: 'PLAYER_GOAL_OR_ASSIST',
        player_id: player.id,
        label: `${player.name} marca o asiste`,
        odds: calcGoalOrAssistOdds(player, stats),
        sort_order: order++,
      },
      {
        market_type: 'PLAYER_CARD',
        player_id: player.id,
        label: `${player.name} recibe tarjeta`,
        odds: calcCardOdds(player, stats),
        sort_order: order++,
      },
    )
  }

  return markets
}
