import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { supabase } from './lib/supabaseClient'
import {
  generateMarketsForRound,
  type Player,
  type PlayerMatchStat,
} from './lib/odds'

const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`

type Profile = {
  id: string
  username: string
  auth_email: string
  role: 'user' | 'admin'
  points: number
  current_streak: number
  best_streak: number
  credits: number
  last_collected_round_id: string | null
}

type Round = {
  id: string
  round_number: number
  rival: string
  closes_at: string
  status: 'draft' | 'open' | 'validated'
  credit_collection_enabled: boolean
  bilawal_goals: number | null
  rival_goals: number | null
}

type Market = {
  id: string
  round_id: string
  market_type: string
  player_id: string | null
  label: string
  odds: number
  is_active: boolean
  manual_odds: boolean
  status: 'pending' | 'won' | 'lost'
  sort_order: number
}

type Bet = {
  id: string
  round_id: string
  user_id: string
  market_id: string
  credits: number
  odds_at_bet: number
  status: 'pending' | 'won' | 'lost'
  points_won: number
}

type ExactScoreBet = {
  id: string
  round_id: string
  user_id: string
  bilawal_goals: number
  rival_goals: number
  status: 'pending' | 'won' | 'lost'
  points_won: number
}

type LeagueTeam = {
  id: string
  name: string
  played: number
  won: number
  drawn: number
  lost: number
  goals_for: number
  goals_against: number
  points: number
}

type RoundPlayer = {
  round_id: string
  player_id: string
}

const positionLabels: Record<string, string> = {
  portero: 'Portero',
  defensa: 'Defensa',
  medio: 'Medio',
  delantero: 'Delantero',
}

const marketGroupLabels: Record<string, string> = {
  RESULT_WIN_DRAW: 'Resultado del partido',
  RESULT_WIN: 'Resultado del partido',
  TEAM_GOALS_1_PLUS: 'Goles de Bilawal',
  TEAM_GOALS_2_PLUS: 'Goles de Bilawal',
  TEAM_GOALS_3_PLUS: 'Goles de Bilawal',
  PLAYER_GOAL: 'Jugador anota',
  PLAYER_ASSIST: 'Jugador asiste',
  PLAYER_GOAL_OR_ASSIST: 'Jugador anota o asiste',
  PLAYER_CARD: 'Jugador recibe tarjeta',
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase().replace('@', '').replace(/\s+/g, '')
}

function authEmailFromUsername(username: string) {
  return `${username}@bilabet.local`
}

function formatPoints(value: number | string | null | undefined) {
  return Number(value || 0).toFixed(1)
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function isRoundClosed(round: Round | null) {
  if (!round) return true
  if (round.status !== 'open') return true
  return Date.now() >= new Date(round.closes_at).getTime()
}

function App() {
  const [loading, setLoading] = useState(true)
  const [sessionUserId, setSessionUserId] = useState<string | null>(null)

  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')

  const [profile, setProfile] = useState<Profile | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [players, setPlayers] = useState<Player[]>([])
  const [leagueTeams, setLeagueTeams] = useState<LeagueTeam[]>([])
  const [rounds, setRounds] = useState<Round[]>([])
  const [currentRound, setCurrentRound] = useState<Round | null>(null)
  const [roundPlayers, setRoundPlayers] = useState<RoundPlayer[]>([])
  const [markets, setMarkets] = useState<Market[]>([])
  const [bets, setBets] = useState<Bet[]>([])
  const [exactBet, setExactBet] = useState<ExactScoreBet | null>(null)
  const [playerStats, setPlayerStats] = useState<PlayerMatchStat[]>([])

  const [playerName, setPlayerName] = useState('')
  const [playerPosition, setPlayerPosition] = useState<Player['position']>('medio')

  const [teamForm, setTeamForm] = useState({
    name: '',
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    goals_for: 0,
    goals_against: 0,
    points: 0,
  })

  const [roundRival, setRoundRival] = useState('')
  const [roundClose, setRoundClose] = useState('')
  const [availablePlayerIds, setAvailablePlayerIds] = useState<string[]>([])

  const [betSlip, setBetSlip] = useState<Record<string, number>>({})
  const [exactBilawal, setExactBilawal] = useState('')
  const [exactRival, setExactRival] = useState('')

  const [validateBilawal, setValidateBilawal] = useState('')
  const [validateRival, setValidateRival] = useState('')
  const [goalIds, setGoalIds] = useState<string[]>([])
  const [assistIds, setAssistIds] = useState<string[]>([])
  const [yellowCardIds, setYellowCardIds] = useState<string[]>([])
  const [redCardIds, setRedCardIds] = useState<string[]>([])

  const isAdmin = profile?.role === 'admin'

  const activePlayers = useMemo(
    () => players.filter((player) => player.active),
    [players],
  )

  const availablePlayersForCurrentRound = useMemo(() => {
    const ids = new Set(roundPlayers.map((rp) => rp.player_id))
    return players.filter((player) => ids.has(player.id))
  }, [players, roundPlayers])

  const sortedLeague = useMemo(() => {
    return [...leagueTeams].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points

      const gdA = a.goals_for - a.goals_against
      const gdB = b.goals_for - b.goals_against

      if (gdB !== gdA) return gdB - gdA
      return b.goals_for - a.goals_for
    })
  }, [leagueTeams])

  const sortedRanking = useMemo(() => {
    return [...profiles].sort((a, b) => {
      if (Number(b.points) !== Number(a.points)) return Number(b.points) - Number(a.points)
      return a.username.localeCompare(b.username)
    })
  }, [profiles])

  const groupedMarkets = useMemo(() => {
    const groups: Record<string, Market[]> = {}

    for (const market of markets.filter((m) => m.is_active)) {
      const group = marketGroupLabels[market.market_type] || 'Otros'
      if (!groups[group]) groups[group] = []
      groups[group].push(market)
    }

    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => a.sort_order - b.sort_order)
    }

    return groups
  }, [markets])

  const submittedBetMarkets = useMemo(() => {
    return bets.map((bet) => ({
      bet,
      market: markets.find((market) => market.id === bet.market_id),
    }))
  }, [bets, markets])

  const totalStaked = useMemo(() => {
    return Object.values(betSlip).reduce((acc, value) => acc + Number(value || 0), 0)
  }, [betSlip])

  const selectedBetCount = useMemo(() => {
    return Object.values(betSlip).filter((value) => Number(value || 0) > 0).length
  }, [betSlip])

  const potentialPoints = useMemo(() => {
    return Object.entries(betSlip).reduce((acc, [marketId, credits]) => {
      const market = markets.find((m) => m.id === marketId)
      if (!market) return acc
      return acc + Number(credits || 0) * Number(market.odds || 0)
    }, 0)
  }, [betSlip, markets])

  const canSubmitBets =
    !!currentRound &&
    currentRound.status === 'open' &&
    !isRoundClosed(currentRound) &&
    !!profile &&
    profile.credits > 0 &&
    selectedBetCount >= 2 &&
    totalStaked === profile.credits

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSessionUserId(data.session?.user?.id ?? null)
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionUserId(session?.user?.id ?? null)
    })

    return () => {
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [sessionUserId])

  useEffect(() => {
    if (activePlayers.length && availablePlayerIds.length === 0) {
      setAvailablePlayerIds(activePlayers.map((player) => player.id))
    }
  }, [activePlayers, availablePlayerIds.length])

  async function loadData() {
    const [
      profilesRes,
      playersRes,
      leagueRes,
      roundsRes,
      statsRes,
    ] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('players').select('*').order('name'),
      supabase.from('league_teams').select('*'),
      supabase.from('rounds').select('*').order('round_number', { ascending: false }),
      supabase.from('player_match_stats').select('*'),
    ])

    if (profilesRes.data) setProfiles(profilesRes.data as Profile[])
    if (playersRes.data) setPlayers(playersRes.data as Player[])
    if (leagueRes.data) setLeagueTeams(leagueRes.data as LeagueTeam[])
    if (roundsRes.data) setRounds(roundsRes.data as Round[])
    if (statsRes.data) setPlayerStats(statsRes.data as PlayerMatchStat[])

    const latestRound = (roundsRes.data?.[0] as Round | undefined) || null
    setCurrentRound(latestRound)

    if (sessionUserId) {
      const { data: ownProfile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', sessionUserId)
        .single()

      setProfile((ownProfile as Profile) || null)
    } else {
      setProfile(null)
    }

    if (latestRound) {
      const [marketsRes, roundPlayersRes] = await Promise.all([
        supabase
          .from('markets')
          .select('*')
          .eq('round_id', latestRound.id)
          .order('sort_order'),
        supabase
          .from('round_players')
          .select('*')
          .eq('round_id', latestRound.id),
      ])

      setMarkets((marketsRes.data as Market[]) || [])
      setRoundPlayers((roundPlayersRes.data as RoundPlayer[]) || [])

      if (sessionUserId) {
        const [betsRes, exactRes] = await Promise.all([
          supabase
            .from('bets')
            .select('*')
            .eq('round_id', latestRound.id)
            .eq('user_id', sessionUserId),
          supabase
            .from('exact_score_bets')
            .select('*')
            .eq('round_id', latestRound.id)
            .eq('user_id', sessionUserId)
            .maybeSingle(),
        ])

        setBets((betsRes.data as Bet[]) || [])
        setExactBet((exactRes.data as ExactScoreBet) || null)
      } else {
        setBets([])
        setExactBet(null)
      }
    } else {
      setMarkets([])
      setRoundPlayers([])
      setBets([])
      setExactBet(null)
    }
  }

  async function handleAuth() {
    setAuthError('')

    const cleanUsername = normalizeUsername(authUsername)

    if (!cleanUsername || !authPassword) {
      setAuthError('Rellena usuario y contraseña.')
      return
    }

    const authEmail = authEmailFromUsername(cleanUsername)

    if (authMode === 'register') {
      const { data, error } = await supabase.auth.signUp({
        email: authEmail,
        password: authPassword,
      })

      if (error) {
        setAuthError(error.message)
        return
      }

      if (!data.user) {
        setAuthError('No se pudo crear el usuario.')
        return
      }

      const { error: profileError } = await supabase.from('profiles').insert({
        id: data.user.id,
        username: cleanUsername,
        auth_email: authEmail,
      })

      if (profileError) {
        setAuthError(
          `${profileError.message}. Si aparece error de permisos, revisa que "Confirm email" esté desactivado en Supabase.`,
        )
        return
      }

      setAuthUsername('')
      setAuthPassword('')
      await loadData()
      return
    }

    const { data: profileLookup } = await supabase
      .from('profiles')
      .select('auth_email')
      .eq('username', cleanUsername)
      .maybeSingle()

    const emailToUse = profileLookup?.auth_email || authEmail

    const { error } = await supabase.auth.signInWithPassword({
      email: emailToUse,
      password: authPassword,
    })

    if (error) {
      setAuthError('Usuario o contraseña incorrectos.')
      return
    }

    setAuthUsername('')
    setAuthPassword('')
    await loadData()
  }

  async function logout() {
    await supabase.auth.signOut()
    setProfile(null)
    setSessionUserId(null)
    setBetSlip({})
  }

  async function savePlayer() {
    const name = playerName.trim()

    if (!name) {
      alert('Nombre obligatorio.')
      return
    }

    const { error } = await supabase.from('players').upsert(
      {
        name,
        position: playerPosition,
        active: true,
      },
      { onConflict: 'name' },
    )

    if (error) {
      alert(error.message)
      return
    }

    setPlayerName('')
    await loadData()
  }

  async function togglePlayerActive(player: Player) {
    const { error } = await supabase
      .from('players')
      .update({ active: !player.active })
      .eq('id', player.id)

    if (error) alert(error.message)
    await loadData()
  }

  async function saveLeagueTeam() {
    if (!teamForm.name.trim()) {
      alert('Nombre de equipo obligatorio.')
      return
    }

    const { error } = await supabase.from('league_teams').upsert(
      {
        name: teamForm.name.trim(),
        played: Number(teamForm.played || 0),
        won: Number(teamForm.won || 0),
        drawn: Number(teamForm.drawn || 0),
        lost: Number(teamForm.lost || 0),
        goals_for: Number(teamForm.goals_for || 0),
        goals_against: Number(teamForm.goals_against || 0),
        points: Number(teamForm.points || 0),
      },
      { onConflict: 'name' },
    )

    if (error) {
      alert(error.message)
      return
    }

    setTeamForm({
      name: '',
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goals_for: 0,
      goals_against: 0,
      points: 0,
    })

    await loadData()
  }

  async function createRound() {
    if (!roundRival.trim() || !roundClose) {
      alert('Rellena rival y cierre de apuestas.')
      return
    }

    if (availablePlayerIds.length === 0) {
      alert('Selecciona jugadores disponibles.')
      return
    }

    const nextRoundNumber =
      rounds.length > 0
        ? Math.max(...rounds.map((round) => round.round_number)) + 1
        : 1

    const { data: newRound, error } = await supabase
      .from('rounds')
      .insert({
        round_number: nextRoundNumber,
        rival: roundRival.trim(),
        closes_at: new Date(roundClose).toISOString(),
        status: 'draft',
        credit_collection_enabled: false,
      })
      .select('*')
      .single()

    if (error || !newRound) {
      alert(error?.message || 'Error creando ronda.')
      return
    }

    const selectedPlayers = players.filter((player) =>
      availablePlayerIds.includes(player.id),
    )

    const generatedMarkets = generateMarketsForRound(selectedPlayers, playerStats)

    const { error: playersError } = await supabase.from('round_players').insert(
      selectedPlayers.map((player) => ({
        round_id: newRound.id,
        player_id: player.id,
      })),
    )

    if (playersError) {
      alert(playersError.message)
      return
    }

    const { error: marketsError } = await supabase.from('markets').insert(
      generatedMarkets.map((market) => ({
        round_id: newRound.id,
        market_type: market.market_type,
        player_id: market.player_id,
        label: market.label,
        odds: market.odds,
        sort_order: market.sort_order,
      })),
    )

    if (marketsError) {
      alert(marketsError.message)
      return
    }

    setRoundRival('')
    setRoundClose('')
    await loadData()
  }

  async function activateCurrentRound() {
    if (!currentRound) return

    const { error } = await supabase
      .from('rounds')
      .update({
        status: 'open',
        credit_collection_enabled: true,
      })
      .eq('id', currentRound.id)

    if (error) {
      alert(error.message)
      return
    }

    await loadData()
  }

  async function updateMarketOdds(market: Market) {
    const value = prompt('Nueva cuota:', String(market.odds))

    if (!value) return

    const odds = Number(value.replace(',', '.'))

    if (!Number.isFinite(odds) || odds < 1.1 || odds > 20) {
      alert('Cuota inválida.')
      return
    }

    const { error } = await supabase
      .from('markets')
      .update({
        odds,
        manual_odds: true,
      })
      .eq('id', market.id)

    if (error) alert(error.message)
    await loadData()
  }

  async function toggleMarket(market: Market) {
    const { error } = await supabase
      .from('markets')
      .update({ is_active: !market.is_active })
      .eq('id', market.id)

    if (error) alert(error.message)
    await loadData()
  }

  async function collectCredits() {
    if (!currentRound) return

    const { error } = await supabase.rpc('collect_weekly_credits', {
      p_round_id: currentRound.id,
    })

    if (error) {
      alert(error.message)
      return
    }

    await loadData()
  }

  function addMarketToSlip(market: Market) {
    setBetSlip((current) => ({
      ...current,
      [market.id]: current[market.id] || 1,
    }))
  }

  function removeMarketFromSlip(marketId: string) {
    setBetSlip((current) => {
      const copy = { ...current }
      delete copy[marketId]
      return copy
    })
  }

  function setSlipCredits(marketId: string, credits: number) {
    setBetSlip((current) => ({
      ...current,
      [marketId]: credits,
    }))
  }

  async function submitBets() {
    if (!currentRound || !profile) return

    if (!canSubmitBets) {
      alert('Debes hacer mínimo 2 apuestas y gastar todos tus créditos.')
      return
    }

    const exactA = exactBilawal.trim()
    const exactB = exactRival.trim()

    if ((exactA && !exactB) || (!exactA && exactB)) {
      alert('Rellena ambos goles del resultado exacto o deja ambos vacíos.')
      return
    }

    const payload = Object.entries(betSlip).map(([market_id, credits]) => ({
      market_id,
      credits,
    }))

    const { error } = await supabase.rpc('submit_user_bets', {
      p_round_id: currentRound.id,
      p_bets: payload,
      p_exact_bilawal: exactA ? Number(exactA) : null,
      p_exact_rival: exactB ? Number(exactB) : null,
    })

    if (error) {
      alert(error.message)
      return
    }

    setBetSlip({})
    setExactBilawal('')
    setExactRival('')
    await loadData()
  }

  async function validateRound() {
    if (!currentRound) return

    const bilawalGoals = Number(validateBilawal)
    const rivalGoals = Number(validateRival)

    if (!Number.isInteger(bilawalGoals) || !Number.isInteger(rivalGoals)) {
      alert('Introduce el resultado final.')
      return
    }

    const { error } = await supabase.rpc('validate_round', {
      p_round_id: currentRound.id,
      p_bilawal_goals: bilawalGoals,
      p_rival_goals: rivalGoals,
      p_goal_player_ids: goalIds,
      p_assist_player_ids: assistIds,
      p_yellow_card_player_ids: yellowCardIds,
      p_red_card_player_ids: redCardIds,
    })

    if (error) {
      alert(error.message)
      return
    }

    setValidateBilawal('')
    setValidateRival('')
    setGoalIds([])
    setAssistIds([])
    setYellowCardIds([])
    setRedCardIds([])
    await loadData()
  }

  async function updateUserPoints(user: Profile) {
    const value = prompt(`Puntos de @${user.username}:`, String(user.points))

    if (!value) return

    const points = Number(value.replace(',', '.'))

    if (!Number.isFinite(points) || points < 0) {
      alert('Puntos inválidos.')
      return
    }

    const { error } = await supabase
      .from('profiles')
      .update({ points })
      .eq('id', user.id)

    if (error) alert(error.message)
    await loadData()
  }

  async function deleteUser(user: Profile) {
    if (!confirm(`¿Eliminar a @${user.username}?`)) return

    const { error } = await supabase
      .from('profiles')
      .delete()
      .eq('id', user.id)

    if (error) alert(error.message)
    await loadData()
  }

  function toggleId(list: string[], id: string) {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
  }

  function renderStatusPill() {
    if (!currentRound) return <span className="status-pill">Sin ronda</span>

    if (currentRound.status === 'draft') {
      return <span className="status-pill status-closed">Ronda {currentRound.round_number} en borrador</span>
    }

    if (currentRound.status === 'validated') {
      return <span className="status-pill status-final">Ronda {currentRound.round_number} validada</span>
    }

    if (isRoundClosed(currentRound)) {
      return <span className="status-pill status-closed">Ronda {currentRound.round_number} cerrada</span>
    }

    return <span className="status-pill status-open">Ronda {currentRound.round_number} abierta</span>
  }

  if (loading) {
    return (
      <main className="page">
        <section className="card">
          <h2>BilaBet v2.0</h2>
          <p>Cargando...</p>
        </section>
      </main>
    )
  }

  if (!profile) {
    return (
      <main className="page">
        <section className="card auth-card">
          <img
            className="auth-logo"
            src={asset('bilalogo.jpeg')}
            alt="Bilawal FC"
          />

          <h1 className="app-title">BilaBet v2.0</h1>
          <h2>{authMode === 'login' ? 'Entrar' : 'Crear cuenta'}</h2>

          <input
            value={authUsername}
            onChange={(event) => setAuthUsername(event.target.value)}
            placeholder="@tu_instagram"
            autoCapitalize="none"
          />

          <input
            value={authPassword}
            onChange={(event) => setAuthPassword(event.target.value)}
            placeholder="Contraseña"
            type="password"
          />

          {authError && <div className="alert error">{authError}</div>}

          <button onClick={handleAuth}>
            {authMode === 'login' ? 'JUGAR' : 'CREAR CUENTA'}
          </button>

          <button
            className="secondary"
            onClick={() => {
              setAuthError('')
              setAuthMode(authMode === 'login' ? 'register' : 'login')
            }}
          >
            {authMode === 'login'
              ? 'No tengo cuenta'
              : 'Ya tengo cuenta'}
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="page">
      {isAdmin && (
        <section className="card admin-card">
        <img
          className="admin-logo"
          src={asset('bilalogo.jpeg')}
          alt="Bilawal FC"
        />

        <h2>🛠️ Panel admin</h2>

          <div className="admin-section">
            <h3>0. Ronda actual</h3>
            <div>{renderStatusPill()}</div>

            {currentRound && (
              <div className="round-summary">
                <b>Bilawal FC vs {currentRound.rival}</b>
                <span>Cierre: {formatDate(currentRound.closes_at)}</span>
              </div>
            )}
          </div>

          <div className="admin-section">
            <h3>1. Jugadores</h3>

            <input
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
              placeholder="Nombre jugador"
            />

            <select
              value={playerPosition}
              onChange={(event) => setPlayerPosition(event.target.value as Player['position'])}
            >
              <option value="portero">Portero</option>
              <option value="defensa">Defensa</option>
              <option value="medio">Medio</option>
              <option value="delantero">Delantero</option>
            </select>

            <button onClick={savePlayer}>AÑADIR / ACTUALIZAR JUGADOR</button>

            <div className="mini-list">
              {players.map((player) => (
                <div className="mini-row" key={player.id}>
                  <span>
                    <b>{player.name}</b> · {positionLabels[player.position]}
                  </span>
                  <button className="small-btn" onClick={() => togglePlayerActive(player)}>
                    {player.active ? 'Activo' : 'Inactivo'}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="admin-section">
            <h3>2. Clasificación liga</h3>

            <div className="form-field">
            <label>Equipo</label>
            <input
              value={teamForm.name}
              onChange={(event) => setTeamForm({ ...teamForm, name: event.target.value })}
              placeholder="Nombre equipo"
            />
          </div>

          <div className="grid-3">
            <div className="form-field">
              <label>J</label>
              <input
                type="number"
                value={teamForm.played}
                onChange={(e) => setTeamForm({ ...teamForm, played: Number(e.target.value) })}
                placeholder="Partidos jugados"
              />
            </div>

            <div className="form-field">
              <label>G</label>
              <input
                type="number"
                value={teamForm.won}
                onChange={(e) => setTeamForm({ ...teamForm, won: Number(e.target.value) })}
                placeholder="Ganados"
              />
            </div>

            <div className="form-field">
              <label>E</label>
              <input
                type="number"
                value={teamForm.drawn}
                onChange={(e) => setTeamForm({ ...teamForm, drawn: Number(e.target.value) })}
                placeholder="Empatados"
              />
            </div>

            <div className="form-field">
              <label>P</label>
              <input
                type="number"
                value={teamForm.lost}
                onChange={(e) => setTeamForm({ ...teamForm, lost: Number(e.target.value) })}
                placeholder="Perdidos"
              />
            </div>

            <div className="form-field">
              <label>GF</label>
              <input
                type="number"
                value={teamForm.goals_for}
                onChange={(e) => setTeamForm({ ...teamForm, goals_for: Number(e.target.value) })}
                placeholder="Goles a favor"
              />
            </div>

            <div className="form-field">
              <label>GC</label>
              <input
                type="number"
                value={teamForm.goals_against}
                onChange={(e) => setTeamForm({ ...teamForm, goals_against: Number(e.target.value) })}
                placeholder="Goles en contra"
              />
            </div>
          </div>

          <div className="form-field">
            <label>Pts</label>
            <input
              type="number"
              value={teamForm.points}
              onChange={(event) => setTeamForm({ ...teamForm, points: Number(event.target.value) })}
              placeholder="Puntos"
            />
          </div>

            <button onClick={saveLeagueTeam}>AÑADIR / ACTUALIZAR EQUIPO</button>
          </div>

          <div className="admin-section">
            <h3>3. Usuarios</h3>

            <div className="mini-list">
              {sortedRanking.map((user) => (
                <div className="mini-row" key={user.id}>
                  <span>
                    <b>@{user.username}</b> · {formatPoints(user.points)} pts · 🔥 {user.current_streak}
                    {user.role === 'admin' ? ' · admin' : ''}
                  </span>

                  <div className="mini-actions">
                    <button className="small-btn" onClick={() => updateUserPoints(user)}>
                      Pts
                    </button>

                    {user.role !== 'admin' && (
                      <button className="small-btn danger" onClick={() => deleteUser(user)}>
                        Eliminar
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="admin-section">
            <h3>4. Crear ronda</h3>

            <input
              value={roundRival}
              onChange={(event) => setRoundRival(event.target.value)}
              placeholder="Rival"
            />

            <input
              type="datetime-local"
              value={roundClose}
              onChange={(event) => setRoundClose(event.target.value)}
            />

            <div className="small-help">Jugadores disponibles para apostar. Si están marcados, cuentan como que han jugado.</div>

            <div className="checklist">
              {activePlayers.map((player) => (
                <label className="check-item" key={player.id}>
                  <input
                    type="checkbox"
                    checked={availablePlayerIds.includes(player.id)}
                    onChange={() => setAvailablePlayerIds(toggleId(availablePlayerIds, player.id))}
                  />
                  <span>{player.name} · {positionLabels[player.position]}</span>
                </label>
              ))}
            </div>

            <button onClick={createRound}>GENERAR RONDA Y CUOTAS</button>
          </div>

          {currentRound && (
            <div className="admin-section">
              <h3>5. Mercados y cuotas</h3>

              {currentRound.status === 'draft' && (
                <button onClick={activateCurrentRound} className="success">
                  ACTIVAR RONDA + CRÉDITOS
                </button>
              )}

              <div className="market-admin-list">
                {markets.map((market) => (
                  <div className={`market-admin-row ${!market.is_active ? 'disabled-row' : ''}`} key={market.id}>
                    <span>
                      <b>{market.label}</b>
                      <small>{market.market_type}</small>
                    </span>

                    <div className="mini-actions">
                      <button className="small-btn" onClick={() => updateMarketOdds(market)}>
                        {market.odds.toFixed(1)}
                      </button>

                      <button className="small-btn" onClick={() => toggleMarket(market)}>
                        {market.is_active ? 'ON' : 'OFF'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {currentRound && currentRound.status !== 'validated' && (
            <div className="admin-section">
              <h3>6. Validar partido</h3>

              <div className="grid-2">
                <div>
                  <label>Bilawal</label>
                  <input
                    type="number"
                    value={validateBilawal}
                    onChange={(event) => setValidateBilawal(event.target.value)}
                    placeholder="0"
                  />
                </div>

                <div>
                  <label>{currentRound.rival}</label>
                  <input
                    type="number"
                    value={validateRival}
                    onChange={(event) => setValidateRival(event.target.value)}
                    placeholder="0"
                  />
                </div>
              </div>

              <h4>Goleadores</h4>
              <div className="checklist">
                {availablePlayersForCurrentRound.map((player) => (
                  <label className="check-item" key={`goal-${player.id}`}>
                    <input
                      type="checkbox"
                      checked={goalIds.includes(player.id)}
                      onChange={() => setGoalIds(toggleId(goalIds, player.id))}
                    />
                    <span>{player.name}</span>
                  </label>
                ))}
              </div>

              <h4>Asistentes</h4>
              <div className="checklist">
                {availablePlayersForCurrentRound.map((player) => (
                  <label className="check-item" key={`assist-${player.id}`}>
                    <input
                      type="checkbox"
                      checked={assistIds.includes(player.id)}
                      onChange={() => setAssistIds(toggleId(assistIds, player.id))}
                    />
                    <span>{player.name}</span>
                  </label>
                ))}
              </div>

              <h4>Tarjetas amarillas</h4>
              <div className="checklist">
                {availablePlayersForCurrentRound.map((player) => (
                  <label className="check-item" key={`yellow-${player.id}`}>
                    <input
                      type="checkbox"
                      checked={yellowCardIds.includes(player.id)}
                      onChange={() => setYellowCardIds(toggleId(yellowCardIds, player.id))}
                    />
                    <span>{player.name}</span>
                  </label>
                ))}
              </div>

              <h4>Tarjetas rojas</h4>
              <div className="checklist">
                {availablePlayersForCurrentRound.map((player) => (
                  <label className="check-item" key={`red-${player.id}`}>
                    <input
                      type="checkbox"
                      checked={redCardIds.includes(player.id)}
                      onChange={() => setRedCardIds(toggleId(redCardIds, player.id))}
                    />
                    <span>{player.name}</span>
                  </label>
                ))}
              </div>

              <button className="warning" onClick={validateRound}>
                VALIDAR RONDA
              </button>
            </div>
          )}
        </section>
      )}

      <section className="card game-card">
        <img
          className="team-photo"
          src={asset('bilawal-team.jpeg')}
          alt="Bilawal FC"
        />
        <div className="top-user">
          <div>
            <h2>@{profile.username}</h2>
            <span>{profile.role === 'admin' ? 'Admin' : 'Jugador'}</span>
          </div>

          <button className="small-btn secondary" onClick={logout}>
            Salir
          </button>
        </div>

        <div className="wallet">💼 {profile.credits} créditos</div>

        <div className="status-box">{renderStatusPill()}</div>

        {currentRound && (
          <div className="next-match-card">
            <div className="label">PRÓXIMO PARTIDO</div>
            <div className="rival">Bilawal FC vs {currentRound.rival}</div>
            <div className="small-help">Cierre: {formatDate(currentRound.closes_at)}</div>
          </div>
        )}

        {currentRound &&
          currentRound.status === 'open' &&
          currentRound.credit_collection_enabled &&
          profile.credits === 0 &&
          bets.length === 0 &&
          !isRoundClosed(currentRound) && (
            <div className="credits-box">
              💰 Créditos semanales disponibles
              <button onClick={collectCredits}>RECOGER CRÉDITOS</button>
            </div>
          )}

        <div className="inner-card">
          <h3>📋 Clasificación liga</h3>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Pos</th>
                  <th>Equipo</th>
                  <th>J</th>
                  <th>G</th>
                  <th>E</th>
                  <th>P</th>
                  <th>GF</th>
                  <th>GC</th>
                  <th>DG</th>
                  <th>Pts</th>
                </tr>
              </thead>

              <tbody>
                {sortedLeague.map((team, index) => (
                  <tr key={team.id}>
                    <td><b>{index + 1}</b></td>
                    <td className="team-cell">{team.name}</td>
                    <td>{team.played}</td>
                    <td>{team.won}</td>
                    <td>{team.drawn}</td>
                    <td>{team.lost}</td>
                    <td>{team.goals_for}</td>
                    <td>{team.goals_against}</td>
                    <td>{team.goals_for - team.goals_against}</td>
                    <td><b>{team.points}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="inner-card stats-card">
          <h3>📊 Estadísticas</h3>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Jugador</th>
                  <th>Pos</th>
                  <th>PJ</th>
                  <th>Gol</th>
                  <th>Asis</th>
                  <th>AM</th>
                  <th>RO</th>
                </tr>
              </thead>

              <tbody>
                {players.map((player) => {
                  const rows = playerStats.filter((s) => s.player_id === player.id)
                  const goals = rows.reduce((acc, row) => acc + Number(row.goals || 0), 0)
                  const assists = rows.reduce((acc, row) => acc + Number(row.assists || 0), 0)
                  const yellowCards = rows.reduce((acc, row) => acc + Number(row.yellow_cards || 0), 0)
                  const redCards = rows.reduce((acc, row) => acc + Number(row.red_cards || 0), 0)

                  return (
                    <tr key={player.id}>
                      <td className="team-cell">{player.name}</td>
                      <td>{positionLabels[player.position]}</td>
                      <td>{rows.length}</td>
                      <td>{goals}</td>
                      <td>{assists}</td>
                      <td><span className="yellow-card">{yellowCards}</span></td>
                      <td><span className="red-card">{redCards}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {currentRound && bets.length > 0 && (
          <div className="inner-card">
            <h3>🎟️ Tu boleto</h3>

            {submittedBetMarkets.map(({ bet, market }) => (
              <div className="ticket-row" key={bet.id}>
                <div>
                  <b>{market?.label || 'Mercado'}</b>
                  <small>
                    {bet.credits} créditos · cuota {Number(bet.odds_at_bet).toFixed(1)}
                  </small>
                </div>

                <span className={`bet-status ${bet.status}`}>
                  {bet.status === 'pending'
                    ? `${formatPoints(bet.credits * bet.odds_at_bet)} pts posibles`
                    : bet.status === 'won'
                      ? `+${formatPoints(bet.points_won)}`
                      : 'Fallada'}
                </span>
              </div>
            ))}

            {exactBet && (
              <div className="ticket-row purple">
                <div>
                  <b>Resultado exacto</b>
                  <small>
                    Bilawal {exactBet.bilawal_goals} - {exactBet.rival_goals} {currentRound.rival}
                  </small>
                </div>

                <span className={`bet-status ${exactBet.status}`}>
                  {exactBet.status === 'pending'
                    ? '+5 pts posibles'
                    : exactBet.status === 'won'
                      ? '+5'
                      : 'Fallada'}
                </span>
              </div>
            )}
          </div>
        )}

        {currentRound &&
          bets.length === 0 &&
          currentRound.status === 'open' &&
          !isRoundClosed(currentRound) &&
          profile.credits > 0 && (
            <div className="inner-card">
              <h3>🎲 Apuestas</h3>

              <div className="alert">
                Debes hacer mínimo <b>2 apuestas</b>, máximo <b>3 créditos</b> por apuesta y gastar todos tus créditos.
              </div>

              {Object.entries(groupedMarkets).map(([groupName, groupMarkets]) => (
                <div className="market-group" key={groupName}>
                  <h4>{groupName}</h4>

                  {groupMarkets.map((market) => (
                    <div className="market-card" key={market.id}>
                      <div>
                        <b>{market.label}</b>
                        <span>Cuota {Number(market.odds).toFixed(1)}</span>
                      </div>

                      <button className="small-btn" onClick={() => addMarketToSlip(market)}>
                        Añadir
                      </button>
                    </div>
                  ))}
                </div>
              ))}

              <div className="bet-slip">
                <h3>🧾 Tu boleto</h3>

                {Object.keys(betSlip).length === 0 && (
                  <p className="small-help">Añade mercados para crear tu boleto.</p>
                )}

                {Object.entries(betSlip).map(([marketId, credits]) => {
                  const market = markets.find((m) => m.id === marketId)
                  if (!market) return null

                  return (
                    <div className="slip-row" key={marketId}>
                      <div>
                        <b>{market.label}</b>
                        <small>Cuota {Number(market.odds).toFixed(1)}</small>
                      </div>

                      <div className="credit-pills">
                        {[1, 2, 3].map((value) => (
                          <button
                            key={value}
                            className={credits === value ? 'selected' : ''}
                            onClick={() => setSlipCredits(marketId, value)}
                          >
                            {value}
                          </button>
                        ))}

                        <button className="danger" onClick={() => removeMarketFromSlip(marketId)}>
                          ✕
                        </button>
                      </div>
                    </div>
                  )
                })}

                <div className={`bet-total ${canSubmitBets ? 'ok' : ''}`}>
                  <b>{totalStaked} / {profile.credits} créditos</b>
                  <span>Ganancia potencial: {formatPoints(potentialPoints)} pts</span>
                </div>
              </div>

              <div className="porra-card">
                <h3>⚽ Resultado exacto</h3>
                <p>Acierto opcional = <b>+5 puntos</b>. No cuesta créditos.</p>

                <div className="score-grid">
                  <div>
                    <label>Bilawal</label>
                    <input
                      type="number"
                      min={0}
                      value={exactBilawal}
                      onChange={(event) => setExactBilawal(event.target.value)}
                      placeholder="0"
                    />
                  </div>

                  <div className="score-sep">-</div>

                  <div>
                    <label>{currentRound.rival}</label>
                    <input
                      type="number"
                      min={0}
                      value={exactRival}
                      onChange={(event) => setExactRival(event.target.value)}
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>

              <button className="success" disabled={!canSubmitBets} onClick={submitBets}>
                ENVIAR APUESTA
              </button>
            </div>
          )}

        <div className="ranking-section">
          <h3>🏆 Ranking</h3>
          <p className="small-help">Con racha de 2+ rondas ganando puntos recibes 6 créditos.</p>

          {sortedRanking.map((user, index) => (
            <div className="ranking-row" key={user.id}>
              <div>
                <span className="medal">
                  {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`}
                </span>

                <b>@{user.username}</b>

                {user.current_streak >= 2 && (
                  <span className="streak">🔥 {user.current_streak}</span>
                )}
              </div>

              <b>{formatPoints(user.points)} pts</b>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

export default App