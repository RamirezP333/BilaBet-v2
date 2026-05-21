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

const goalPositionFactor: Record<PlayerPosition, number> = {
  delantero: 0.8,
  medio: 1,
  defensa: 1.35,
  portero: 2.4,
}

const assistPositionFactor: Record<PlayerPosition, number> = {
  delantero: 1.05,
  medio: 0.9,
  defensa: 1.2,
  portero: 2.5,
}

const goalOrAssistPositionFactor: Record<PlayerPosition, number> = {
  delantero: 0.85,
  medio: 0.9,
  defensa: 1.25,
  portero: 2.4,
}

const cardPositionFactor: Record<PlayerPosition, number> = {
  delantero: 1.15,
  medio: 1,
  defensa: 0.85,
  portero: 1.5,
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

function averagePositionFactor(player: Player, factors: Record<PlayerPosition, number>) {
  const positions = getPlayerPositions(player)
  const total = positions.reduce((acc, position) => acc + factors[position], 0)
  return total / positions.length
}

function positiveRateFactor(rate: number, played: number) {
  if (played === 0) return 1.05
  if (rate >= 1) return 0.75
  if (rate >= 0.6) return 0.85
  if (rate >= 0.35) return 0.95
  if (rate >= 0.15) return 1.05
  if (rate > 0) return 1.15
  return 1.3
}

function cardRateFactor(rate: number, played: number) {
  if (played === 0) return 1.05
  if (rate >= 0.7) return 0.75
  if (rate >= 0.45) return 0.85
  if (rate >= 0.25) return 0.95
  if (rate >= 0.1) return 1.05
  if (rate > 0) return 1.15
  return 1.3
}

function droughtFactor(gamesSinceLast: number, played: number) {
  if (played === 0) return 1.05
  if (gamesSinceLast === 0) return 0.85
  if (gamesSinceLast === 1) return 0.95
  if (gamesSinceLast === 2) return 1.05
  if (gamesSinceLast === 3) return 1.15
  if (gamesSinceLast >= 5) return 1.35
  return 1.25
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
    goalOrAssistRate: played ? (goals + assists) / played : 0,
    cardRate: played ? cards / played : 0,
    sinceGoal: sinceLast('goals'),
    sinceAssist: sinceLast('assists'),
    sinceCard: sinceLast('cards'),
  }
}

function calcGoalOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)

  const raw =
    2.6 *
    averagePositionFactor(player, goalPositionFactor) *
    positiveRateFactor(s.goalRate, s.played) *
    droughtFactor(s.sinceGoal, s.played)

  return oneDecimal(clamp(raw, 1.2, 8))
}

function calcAssistOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)

  const raw =
    3 *
    averagePositionFactor(player, assistPositionFactor) *
    positiveRateFactor(s.assistRate, s.played) *
    droughtFactor(s.sinceAssist, s.played)

  return oneDecimal(clamp(raw, 1.2, 8))
}

function calcGoalOrAssistOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)
  const drought = Math.min(s.sinceGoal, s.sinceAssist)

  const raw =
    2.1 *
    averagePositionFactor(player, goalOrAssistPositionFactor) *
    positiveRateFactor(s.goalOrAssistRate, s.played) *
    droughtFactor(drought, s.played)

  return oneDecimal(clamp(raw, 1.2, 7))
}

function calcCardOdds(player: Player, stats: PlayerMatchStat[]) {
  const s = statsForPlayer(player.id, stats)

  const raw =
    2.8 *
    averagePositionFactor(player, cardPositionFactor) *
    cardRateFactor(s.cardRate, s.played) *
    droughtFactor(s.sinceCard, s.played)

  return oneDecimal(clamp(raw, 1.2, 7))
}

export function generateMarketsForRound(players: Player[], stats: PlayerMatchStat[]): MarketDraft[] {
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
