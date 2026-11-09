import { createContext, useCallback, useContext, useEffect, useReducer, useRef } from 'react'

// Statuts ACP d'un appel d'outil (anglais côté protocole), affichés en français dans le chat.
const TOOL_STATUS = { pending: 'en attente', in_progress: 'en cours', completed: 'terminé', failed: 'échec' }

let uid = 0
function nextId() { return `m${++uid}` }

const initialState = {
  connected: false,
  messages: [],
  pendingPermission: null,
  cwd: null,
  modeId: null,
  availableModes: [],
  model: null,
  // Horodatage du dernier tool call terminé — pas filtré par type d'outil
  // (le "kind" ACP réel n'a jamais été vérifié empiriquement pour chaque
  // valeur possible, voir architecture.md) : FilesPanel s'en sert pour se
  // rafraîchir tout seul, un refresh de trop coûte moins qu'un manqué.
  filesChangedAt: null,
  // Indicateur "l'agent travaille" (voir ChatPanel LoadingIndicator) — ouvert
  // à l'écho du message utilisateur, fermé à turn_end. streamedChars alimente
  // une estimation de tokens (÷4, même heuristique que le CLI qwen-code) car
  // le protocole ACP ne transmet aucun compte de tokens pendant le streaming.
  isGenerating: false,
  turnStartedAt: null,
  streamedChars: 0,
}

// Au plus une bulle "en cours de streaming" à la fois — un thought interrompu
// par un tool call (donc plus le dernier message du fil) ne recevait jamais
// son streaming:false, gardant un curseur clignotant indéfiniment (bug trouvé
// en observant une session dont la connexion venait de tomber en plein tour).
function closeDanglingStreams(messages) {
  return messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
}

function reducer(state, action) {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: true }
    case 'disconnected':
      // Plus aucun chunk ne viendra avant la reconnexion — figer l'affichage
      // plutôt que de laisser une bulle clignoter pendant la coupure, et
      // arrêter l'indicateur de génération (le turn_end correspondant ne
      // viendra jamais avant la reconnexion).
      return { ...state, connected: false, messages: closeDanglingStreams(state.messages), isGenerating: false }
    case 'reset':
      // Sert à la fois pour une vraie nouvelle session ET pour le session_info
      // reçu à chaque (re)connexion — vide le fil pour éviter un doublon avec
      // l'historique rejoué juste après par le backend.
      return {
        ...state,
        messages: [],
        pendingPermission: null,
        cwd: action.cwd ?? state.cwd,
        modeId: action.modeId ?? state.modeId,
        availableModes: action.availableModes ?? state.availableModes,
        model: action.model ?? state.model,
        isGenerating: false,
      }
    case 'permission_answered':
      return { ...state, pendingPermission: null }
    case 'begin_generating':
      // Déclenché localement par sendMessage(), pas par l'event 'user_message'
      // rejoué par le serveur — sinon le rejeu d'historique (session reprise)
      // rallumerait l'indicateur pour chaque tour passé, avec un risque de
      // rester bloqué "en cours" si le dernier tour rejoué n'a pas de
      // turn_end (session coupée en plein milieu à l'époque).
      return { ...state, isGenerating: true, turnStartedAt: Date.now(), streamedChars: 0 }
    case 'event':
      return applyEvent(state, action.event)
    default:
      return state
  }
}

function applyEvent(state, event) {
  switch (event.type) {
    case 'user_message':
      return { ...state, messages: [...state.messages, { id: nextId(), role: 'user', text: event.text, streaming: false }] }

    case 'agent_thought_chunk': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      const streamedChars = state.streamedChars + event.text.length
      if (last && last.role === 'thought' && last.streaming) {
        messages[messages.length - 1] = { ...last, text: last.text + event.text }
        return { ...state, messages, streamedChars }
      }
      // Nouvelle bulle de réflexion : referme toute bulle restée "streaming"
      // (ex. un thought précédent coupé par un tool call entre les deux).
      return { ...state, messages: [...closeDanglingStreams(messages), { id: nextId(), role: 'thought', text: event.text, streaming: true }], streamedChars }
    }

    case 'agent_message_chunk': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      const streamedChars = state.streamedChars + event.text.length
      if (last && last.role === 'agent' && last.streaming) {
        messages[messages.length - 1] = { ...last, text: last.text + event.text }
        return { ...state, messages, streamedChars }
      }
      return { ...state, messages: [...closeDanglingStreams(messages), { id: nextId(), role: 'agent', text: event.text, streaming: true }], streamedChars }
    }

    case 'tool_call_update': {
      const messages = [...state.messages]
      const idx = messages.findIndex((m) => m.role === 'system' && m.toolCallId === event.id)
      // Les mises à jour de statut n'ont pas toujours de titre (seule
      // l'annonce initiale l'a) — sans ça, un titre déjà connu se faisait
      // écraser par le texte générique "action" à chaque update suivant.
      const title = event.title || (idx >= 0 ? messages[idx].toolTitle : null) || 'action'
      const label = `${title} · ${TOOL_STATUS[event.status] ?? event.status}`
      if (idx >= 0) messages[idx] = { ...messages[idx], text: label, toolTitle: title }
      else messages.push({ id: nextId(), role: 'system', text: label, toolCallId: event.id, toolTitle: title })
      const filesChangedAt = event.status === 'completed' ? Date.now() : state.filesChangedAt
      return { ...state, messages, filesChangedAt }
    }

    case 'turn_end':
      return { ...state, messages: closeDanglingStreams(state.messages), isGenerating: false }

    case 'permission_request':
      return { ...state, pendingPermission: event }

    case 'permission_resolved':
      return state.pendingPermission?.id === event.id ? { ...state, pendingPermission: null } : state

    case 'compact_started':
      return { ...state, messages: [...state.messages, { id: nextId(), role: 'system', text: 'Compression du contexte…' }] }

    case 'mode_update':
      return { ...state, modeId: event.modeId, availableModes: event.availableModes ?? state.availableModes }

    case 'model_update':
      return { ...state, messages: [...state.messages, { id: nextId(), role: 'system', text: `Modèle changé : ${event.model}` }], model: event.model }

    case 'error':
      // Ex. cwd refusé côté serveur (hors projects.json) sur new_session/
      // resume_project — sans ça, l'échec était totalement silencieux pour
      // l'utilisateur (l'event arrivait bien, mais rien ne le traitait).
      return { ...state, messages: [...state.messages, { id: nextId(), role: 'system', text: event.message }] }

    default:
      return state
  }
}

const AgentSocketContext = createContext(null)

// Une seule connexion WebSocket pour toute l'app — les panneaux (Chat, Explorateur…)
// consomment le même état via useAgentSocket() plutôt que d'ouvrir chacun la leur.
export function AgentSocketProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const wsRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    let retryTimer = null

    function connect() {
      // Même origine que la page (protocole et port compris) — laisse le proxy
      // Vite (dev) ou tailscale serve (HTTPS distant) router vers le backend :8000,
      // au lieu de forcer ws:// en dur (bloqué en mixed content depuis une page https).
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/chat`)
      wsRef.current = ws
      ws.onopen = () => dispatch({ type: 'connected' })
      ws.onclose = () => {
        dispatch({ type: 'disconnected' })
        // Le bandeau affiché pendant la coupure annonce une reconnexion — sans
        // ce retry, ça restait un mensonge : rien ne relançait jamais la
        // connexion (bug trouvé en observant un onglet resté bloqué dessus
        // après un redémarrage backend).
        if (!cancelled) retryTimer = setTimeout(connect, 2000)
      }
      ws.onmessage = (e) => {
        const event = JSON.parse(e.data)
        if (event.type === 'session_info') {
          // 'reset' vide le fil avant le rejeu de l'historique qui suit —
          // sinon une reconnexion dupliquerait tout ce qui était déjà affiché.
          dispatch({ type: 'reset', cwd: event.cwd, modeId: event.modeId, availableModes: event.availableModes, model: event.model })
          return
        }
        if (event.type === 'session_reset') {
          dispatch({ type: 'reset', cwd: event.cwd })
          return
        }
        dispatch({ type: 'event', event })
      }
    }

    connect()
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
      wsRef.current?.close()
    }
  }, [])

  const send = useCallback((payload) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }, [])

  const sendMessage = useCallback((text) => {
    dispatch({ type: 'begin_generating' })
    send({ type: 'user_message', text })
  }, [send])

  // answers optionnel : réponses du formulaire de l'outil natif qwen-code
  // `ask_user_question` ({ [questionIndex]: "texte de la réponse" }), relayées
  // telles quelles jusqu'au process qwen-code (voir agent_bridge.py).
  const respondPermission = useCallback((id, optionId, answers) => {
    dispatch({ type: 'permission_answered' })
    send(answers ? { type: 'permission_response', id, optionId, answers } : { type: 'permission_response', id, optionId })
  }, [send])

  const newSession = useCallback((cwd) => {
    send({ type: 'new_session', cwd })
  }, [send])

  // Reprend une vraie session qwen-code (session/load) — la plus récente du
  // dossier si sessionId omis (changement de projet), ou une précise (liste
  // Sessions). Contrairement à newSession(), le modèle a réellement le
  // contexte de la conversation reprise, pas juste un historique affiché.
  const resumeProject = useCallback((cwd, sessionId) => {
    send({ type: 'resume_project', cwd, sessionId })
  }, [send])

  const compact = useCallback(() => {
    send({ type: 'compact' })
  }, [send])

  const setMode = useCallback((modeId) => {
    send({ type: 'set_mode', modeId })
  }, [send])

  const switchModel = useCallback((modelId) => {
    send({ type: 'switch_model', modelId })
  }, [send])

  // Interrompt un tour en cours (session/cancel ACP) — un vrai abort() de la
  // requête HTTP vers llama-server côté qwen-code, pas juste un rejet
  // d'approbation. turn_end arrive normalement ensuite (stopReason:
  // "cancelled"), qui éteint isGenerating comme pour une fin de tour classique.
  const cancelTurn = useCallback(() => {
    send({ type: 'cancel_turn' })
  }, [send])

  const value = { ...state, sendMessage, respondPermission, newSession, resumeProject, compact, setMode, switchModel, cancelTurn }
  return <AgentSocketContext.Provider value={value}>{children}</AgentSocketContext.Provider>
}

export function useAgentSocket() {
  const ctx = useContext(AgentSocketContext)
  if (!ctx) throw new Error('useAgentSocket doit être utilisé sous <AgentSocketProvider>')
  return ctx
}
