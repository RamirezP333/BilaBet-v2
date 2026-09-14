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

export type RoundResult = {
  round_number: number
  status: 'draft' | 'open' | 'validated'
  bilawal_goals: number | null
  rival_goals: number | null
  halftime_bilawal_goals: number | null
  halftime_rival_goals: number | null
}

export type MarketDraft = {
  market_type: string
  player_id: string | null
  label: string
  odds: number
  sort_order: number
}

/**
 * BilaBet odds model.
 *
 * Player markets:
 * - absolute floor 1.70
 * - absolute ceiling 5.00
 * - position-specific floors
 * - first-round odds are intentionally lower and predefined so the season
 *   starts with playable markets instead of very large statistical odds
 * - from round 2 onward, actual season data gradually takes over
 * - recent form and drought affect the price without replacing the season data
 * - several positions are averaged
 *
 * Team markets:
 * - first round uses explicit starting odds requested for RESULT markets
 * - from round 2 onward, win/draw and goals are recalculated from validated
 *   Bilawal results and goals scored per match
 * - team markets are not subject to the player 1.70/5.00 restriction
 */

const PLAYER_MIN_ODDS = 1.7
const PLAYER_MAX_ODDS = 5.0
const PRIOR_MATCHES = 5
const HOUSE_FACTOR = 0.94
const RECENT_MATCHES = 5

const INITIAL_PLAYER_ODDS: Record<string, Record<PlayerPosition, number>> = {
  PLAYER_GOAL: {
    portero: 5.0,
    defensa: 3.5,
    medio: 2.8,
    delantero: 2.3,
  },
  PLAYER_ASSIST: {
    portero: 5.0,
    defensa: 3.2,
    medio: 2.5,
    delantero: 2.5,
  },
  PLAYER_GOAL_OR_ASSIST: {
    portero: 4.5,
    defensa: 2.9,
    medio: 2.4,
    delantero: 2.0,
  },
  PLAYER_CARD: {
    portero: 4.0,
    defensa: 2.8,
    medio: 3.1,
    delantero: 3.5,
  },
}

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

const TEAM_INITIAL_ODDS = {
  RESULT_WIN: 2.6,
  RESULT_WIN_DRAW: 2.1,
  BTTS_YES: 1.8,
  BTTS_NO: 2.2,
  BTTS_FIRST_HALF_YES: 2.5,
  BTTS_FIRST_HALF_NO: 1.8,
  TEAM_GOALS_3_PLUS: 2.4,
  TEAM_GOALS_4_PLUS: 3.2,
  TEAM_GOALS_5_PLUS: 4.4,
  TEAM_GOALS_6_PLUS: 6.0,
  TEAM_GOALS_7_PLUS: 8.0,
} as const

const TEAM_GOALS_MIN_ODDS: Record<string, number> = {
  TEAM_GOALS_3_PLUS: 1.8,
  TEAM_GOALS_4_PLUS: 2.2,
  TEAM_GOALS_5_PLUS: 2.8,
  TEAM_GOALS_6_PLUS: 3.5,
  TEAM_GOALS_7_PLUS: 4.5,
}

const TEAM_GOALS_MAX_ODDS: Record<string, number> = {
  TEAM_GOALS_3_PLUS: 6.0,
  TEAM_GOALS_4_PLUS: 8.0,
  TEAM_GOALS_5_PLUS: 10.0,
  TEAM_GOALS_6_PLUS: 12.0,
  TEAM_GOALS_7_PLUS: 15.0,
}

const TEAM_GOALS_PRIOR_AVERAGE = 3.5

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

function getInitialPlayerOdds(player: Player, marketType: string) {
  const values = INITIAL_PLAYER_ODDS[marketType]
  if (!values) return PLAYER_MIN_ODDS

  return oneDecimal(
    clamp(
      averagePositionValue(player, values),
      getPlayerMarketMinOdds(player, marketType),
      PLAYER_MAX_ODDS,
    ),
  )
}

function probabilityToRate(probability: number) {
  const safe = clamp(probability, 0.01, 0.95)
  return -Math.log(1 - safe)
}

function smoothedRate(observedEvents: number, played: number, priorRate: number) {
  return (observedEvents + priorRate * PRIOR_MATCHES) / (played + PRIOR_MATCHES)
}

function weightedRecentRate(
  rows: PlayerMatchStat[],
  getValue: (row: PlayerMatchStat) => number,
) {
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
  return 1 - Math.exp(-Math.max(0, rate))
}

function oddsFromProbability(probability: number, minOdds: number) {
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

  return {
    played,
    goals,
    assists,
    cards,
    goalRate: played ? goals / played : 0,
    assistRate: played ? assists / played : 0,
    goalOrAssistRate: played ? goalOrAssistMatches / played : 0,
    goalOrAssistMatches,
    cardRate: played ? cards / played : 0,
    recentGoalRate: weightedRecentRate(rows, (row) => Number(row.goals || 0)),
    recentAssistRate: weightedRecentRate(rows, (row) => Number(row.assists || 0)),
    recentGoalOrAssistRate: weightedRecentRate(
      rows,
      (row) => (Number(row.goals || 0) > 0 || Number(row.assists || 0) > 0 ? 1 : 0),
    ),
    recentCardRate: weightedRecentRate(
      rows,
      (row) => Number(row.yellow_cards || 0) + Number(row.red_cards || 0),
    ),
    sinceGoal: sinceLast('goals'),
    sinceAssist: sinceLast('assists'),
    sinceCard: sinceLast('cards'),
  }
}

function calcPlayerOdds(
  player: Player,
  stats: PlayerMatchStat[],
  marketType: string,
  priorProbability: number,
  minOddsByPosition: Record<PlayerPosition, number>,
  recentRate: number | null,
  observedEvents: number,
  droughtGames: number,
) {
  const s = statsForPlayer(player.id, stats)
  const minOdds = averagePositionValue(player, minOddsByPosition)

  if (s.played === 0) {
    return getInitialPlayerOdds(player, marketType)
  }

  const priorRate = probabilityToRate(priorProbability)
  const seasonRate = smoothedRate(observedEvents, s.played, priorRate)
  const effectiveRate = combineSeasonAndRecent(seasonRate, recentRate, s.played)
  const adjustedRate = effectiveRate * droughtAdjustment(droughtGames, s.played)
  const probability = eventProbabilityPerMatch(adjustedRate)

  return oddsFromProbability(probability, minOdds)
}

function calcGoalOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)
  const initialOdds = getInitialPlayerOdds(player, 'PLAYER_GOAL')

  return calcPlayerOdds(
    player,
    stats,
    'PLAYER_GOAL',
    1 / initialOdds,
    goalMinOdds,
    s.recentGoalRate,
    s.goals,
    s.sinceGoal,
  )
}

function calcAssistOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)
  const initialOdds = getInitialPlayerOdds(player, 'PLAYER_ASSIST')

  return calcPlayerOdds(
    player,
    stats,
    'PLAYER_ASSIST',
    1 / initialOdds,
    assistMinOdds,
    s.recentAssistRate,
    s.assists,
    s.sinceAssist,
  )
}

function calcGoalOrAssistOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)
  const initialOdds = getInitialPlayerOdds(player, 'PLAYER_GOAL_OR_ASSIST')

  return calcPlayerOdds(
    player,
    stats,
    'PLAYER_GOAL_OR_ASSIST',
    1 / initialOdds,
    goalOrAssistMinOdds,
    s.recentGoalOrAssistRate,
    s.goalOrAssistMatches,
    Math.min(s.sinceGoal, s.sinceAssist),
  )
}

function calcCardOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)
  const initialOdds = getInitialPlayerOdds(player, 'PLAYER_CARD')

  return calcPlayerOdds(
    player,
    stats,
    'PLAYER_CARD',
    1 / initialOdds,
    cardMinOdds,
    s.recentCardRate,
    s.cards,
    s.sinceCard,
  )
}

function validatedRounds(rounds: RoundResult[]) {
  return rounds
    .filter(
      (round) =>
        round.status === 'validated' &&
        Number.isFinite(Number(round.bilawal_goals)) &&
        Number.isFinite(Number(round.rival_goals)),
    )
    .sort((a, b) => a.round_number - b.round_number)
}

function smoothedProbability(successes: number, matches: number, priorProbability: number) {
  return (successes + priorProbability * PRIOR_MATCHES) / (matches + PRIOR_MATCHES)
}

function teamResultOdds(rounds: RoundResult[], marketType: 'RESULT_WIN' | 'RESULT_WIN_DRAW') {
  const results = validatedRounds(rounds)
  const initialOdds = marketType === 'RESULT_WIN'
    ? TEAM_INITIAL_ODDS.RESULT_WIN
    : TEAM_INITIAL_ODDS.RESULT_WIN_DRAW

  if (results.length === 0) return initialOdds

  const wins = results.filter((r) => Number(r.bilawal_goals) > Number(r.rival_goals)).length
  const winsOrDraws = results.filter((r) => Number(r.bilawal_goals) >= Number(r.rival_goals)).length
  const matches = results.length
  const priorProbability = 1 / initialOdds
  const successes = marketType === 'RESULT_WIN' ? wins : winsOrDraws
  const probability = smoothedProbability(successes, matches, priorProbability)
  const fairCurrentOdds = 1 / clamp(probability, 0.05, 0.95)
  const fairPriorOdds = initialOdds / HOUSE_FACTOR
  const dynamicOdds = initialOdds * (fairCurrentOdds / fairPriorOdds)
  const floor = marketType === 'RESULT_WIN' ? 1.5 : 1.3

  return oneDecimal(clamp(dynamicOdds, floor, 8.0))
}

function poissonTailProbability(mean: number, threshold: number) {
  const lambda = Math.max(0.01, mean)
  let cumulative = 0
  let term = 1

  for (let k = 0; k < threshold; k++) {
    if (k > 0) term *= lambda / k
    cumulative += term
  }

  return 1 - Math.exp(-lambda) * cumulative
}

function teamGoalsOdds(rounds: RoundResult[], marketType: string) {
  const results = validatedRounds(rounds)
  const initialOdds = TEAM_INITIAL_ODDS[marketType as keyof typeof TEAM_INITIAL_ODDS]

  if (results.length === 0) {
    return initialOdds ?? 2.4
  }

  const totalGoals = results.reduce(
    (sum, round) => sum + Number(round.bilawal_goals || 0),
    0,
  )
  const matches = results.length

  // The prior keeps the first few rounds from being dominated by one unusual
  // result. It represents a neutral starting expectation of 3 Bilawal goals.
  const averageGoals =
    (totalGoals + TEAM_GOALS_PRIOR_AVERAGE * PRIOR_MATCHES) /
    (matches + PRIOR_MATCHES)

  const threshold = Number(
    marketType.replace('TEAM_GOALS_', '').replace('_PLUS', ''),
  )

  const priorProbability = poissonTailProbability(
    TEAM_GOALS_PRIOR_AVERAGE,
    threshold,
  )
  const currentProbability = poissonTailProbability(averageGoals, threshold)

  const priorFairOdds = 1 / clamp(priorProbability, 0.01, 0.95)
  const currentFairOdds = 1 / clamp(currentProbability, 0.01, 0.95)

  // Preserve the hand-tuned first-round price and move it gradually according
  // to how Bilawal's actual scoring average evolves.
  const dynamicOdds = (initialOdds ?? 2.4) * (currentFairOdds / priorFairOdds)

  return oneDecimal(
    clamp(
      dynamicOdds,
      TEAM_GOALS_MIN_ODDS[marketType] ?? 1.5,
      TEAM_GOALS_MAX_ODDS[marketType] ?? 15,
    ),
  )
}


function scoringProbability(
  results: RoundResult[],
  team: 'bilawal' | 'rival',
  half: 'full' | 'first',
) {
  const valid = results.filter((round) => {
    const goals = half === 'full'
      ? team === 'bilawal' ? round.bilawal_goals : round.rival_goals
      : team === 'bilawal' ? round.halftime_bilawal_goals : round.halftime_rival_goals
    return Number.isFinite(Number(goals))
  })

  if (valid.length === 0) return null

  const successes = valid.filter((round) => {
    const goals = half === 'full'
      ? team === 'bilawal' ? round.bilawal_goals : round.rival_goals
      : team === 'bilawal' ? round.halftime_bilawal_goals : round.halftime_rival_goals
    return Number(goals) > 0
  }).length

  // A small prior prevents the first one or two results from completely
  // changing the BTTS price. It is intentionally derived from the initial
  // BTTS probability rather than from an arbitrary team-goal average.
  const initialProbability = half === 'full'
    ? (1 / TEAM_INITIAL_ODDS.BTTS_YES) ** 0.5
    : (1 / TEAM_INITIAL_ODDS.BTTS_FIRST_HALF_YES) ** 0.5

  return smoothedProbability(successes, valid.length, initialProbability)
}

function bttsProbability(rounds: RoundResult[], half: 'full' | 'first') {
  const bilawal = scoringProbability(rounds, 'bilawal', half)
  const rival = scoringProbability(rounds, 'rival', half)

  if (bilawal === null || rival === null) return null

  return clamp(bilawal * rival, 0.01, 0.95)
}

function bttsOdds(rounds: RoundResult[], marketType: string) {
  const isFirstHalf = marketType.startsWith('BTTS_FIRST_HALF_')
  const isYes = marketType.endsWith('_YES')
  const initialOdds = TEAM_INITIAL_ODDS[marketType as keyof typeof TEAM_INITIAL_ODDS]

  if (initialOdds === undefined) return 2.0

  const probability = bttsProbability(rounds, isFirstHalf ? 'first' : 'full')
  if (probability === null) return initialOdds

  const yesProbability = probability
  const currentProbability = isYes ? yesProbability : 1 - yesProbability
  const initialProbability = 1 / initialOdds
  const currentFairOdds = 1 / clamp(currentProbability, 0.05, 0.95)
  const initialFairOdds = 1 / clamp(initialProbability, 0.05, 0.95)

  const dynamicOdds = initialOdds * (currentFairOdds / initialFairOdds)

  return oneDecimal(clamp(dynamicOdds, 1.3, 6.0))
}

export function generateMarketsForRound(
  players: Player[],
  stats: PlayerMatchStat[],
  rounds: RoundResult[] = [],
): MarketDraft[] {
  const markets: MarketDraft[] = []

  markets.push(
    {
      market_type: 'RESULT_WIN_DRAW',
      player_id: null,
      label: 'Bilawal gana o empata',
      odds: teamResultOdds(rounds, 'RESULT_WIN_DRAW'),
      sort_order: 1,
    },
    {
      market_type: 'RESULT_WIN',
      player_id: null,
      label: 'Bilawal gana',
      odds: teamResultOdds(rounds, 'RESULT_WIN'),
      sort_order: 2,
    },
    {
      market_type: 'BTTS_YES',
      player_id: null,
      label: 'Ambos marcan - Sí',
      odds: bttsOdds(rounds, 'BTTS_YES'),
      sort_order: 4,
    },
    {
      market_type: 'BTTS_NO',
      player_id: null,
      label: 'Ambos marcan - No',
      odds: bttsOdds(rounds, 'BTTS_NO'),
      sort_order: 5,
    },
    {
      market_type: 'BTTS_FIRST_HALF_YES',
      player_id: null,
      label: 'Ambos marcan 1ª parte - Sí',
      odds: bttsOdds(rounds, 'BTTS_FIRST_HALF_YES'),
      sort_order: 6,
    },
    {
      market_type: 'BTTS_FIRST_HALF_NO',
      player_id: null,
      label: 'Ambos marcan 1ª parte - No',
      odds: bttsOdds(rounds, 'BTTS_FIRST_HALF_NO'),
      sort_order: 7,
    },
    {
      market_type: 'TEAM_GOALS_3_PLUS',
      player_id: null,
      label: 'Bilawal marca 3+ goles',
      odds: teamGoalsOdds(rounds, 'TEAM_GOALS_3_PLUS'),
      sort_order: 10,
    },
    {
      market_type: 'TEAM_GOALS_4_PLUS',
      player_id: null,
      label: 'Bilawal marca 4+ goles',
      odds: teamGoalsOdds(rounds, 'TEAM_GOALS_4_PLUS'),
      sort_order: 11,
    },
    {
      market_type: 'TEAM_GOALS_5_PLUS',
      player_id: null,
      label: 'Bilawal marca 5+ goles',
      odds: teamGoalsOdds(rounds, 'TEAM_GOALS_5_PLUS'),
      sort_order: 12,
    },
    {
      market_type: 'TEAM_GOALS_6_PLUS',
      player_id: null,
      label: 'Bilawal marca 6+ goles',
      odds: teamGoalsOdds(rounds, 'TEAM_GOALS_6_PLUS'),
      sort_order: 13,
    },
    {
      market_type: 'TEAM_GOALS_7_PLUS',
      player_id: null,
      label: 'Bilawal marca 7+ goles',
      odds: teamGoalsOdds(rounds, 'TEAM_GOALS_7_PLUS'),
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
