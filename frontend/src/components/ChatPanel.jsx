import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAgentSocket } from '../lib/useAgentSocket'
import { useContextUsage, formatTokens } from '../lib/useContextUsage'
import { usePanelBridge } from '../lib/usePanelBridge'
import { useDialogs } from '../lib/useDialogs'
import { randomPhrase } from '../lib/loadingPhrases'
import DiffView from './DiffView'

// Au-delà, le composeur scrolle en interne plutôt que de continuer à grandir —
// sinon un très gros pavé de texte collé pousserait toute la conversation hors
// de vue.
const COMPOSER_MAX_HEIGHT = 200

function formatSessionDate(ts) {
  return new Date(ts * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// Phrase rotative + minuteur + estimation de tokens (÷4 des caractères reçus,
// même heuristique que le CLI qwen-code — voir useAgentSocket.jsx) pendant
// qu'un tour est en cours. Pas de "esc to cancel" : contrairement au CLI,
// on n'a pas de mécanisme d'annulation d'un tour en cours pour l'instant.
function LoadingIndicator() {
  const { isGenerating, turnStartedAt, streamedChars } = useAgentSocket()
  const [phrase, setPhrase] = useState('')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isGenerating) return
    setPhrase((p) => randomPhrase(p))
    const phraseTimer = setInterval(() => setPhrase((p) => randomPhrase(p)), 2500)
    const tickTimer = setInterval(() => setNow(Date.now()), 100)
    return () => {
      clearInterval(phraseTimer)
      clearInterval(tickTimer)
    }
  }, [isGenerating, turnStartedAt])

  if (!isGenerating) return null
  const elapsedSeconds = turnStartedAt ? Math.max(0, (now - turnStartedAt) / 1000) : 0
  const tokenEstimate = Math.round(streamedChars / 4)
  return (
    <div className="loading-indicator">
      <span className="loading-phrase">{phrase}</span>
      <span className="loading-meta">
        {elapsedSeconds.toFixed(1)}s{tokenEstimate > 0 ? ` · ↓ ${tokenEstimate} tokens` : ''}
      </span>
    </div>
  )
}

// Extraction volontairement simple (regex, pas le parser Markdown utilisé pour
// l'affichage) — juste assez pour repérer un bloc de commande proposé par
// l'agent et l'envoyer au terminal.
function extractCodeBlock(text) {
  // Gère à la fois "```lang\ncmd```" et "```lang cmd```" (langage collé sur la
  // même ligne — vu en pratique dans une vraie réponse de qwen-code).
  const match = text.match(/```(?:[a-zA-Z]+)?[ \t]*\n?([\s\S]*?)```/)
  return match ? match[1].trim() : null
}

const MODE_ICONS = { plan: '📋', default: '🔒', 'auto-edit': '✏️', auto: '🤖', yolo: '🔓' }

// Modes d'approbation qwen-code (plan/default/auto-edit/auto/yolo), vérifiés
// empiriquement via session/set_mode — équivalent des modes de Claude Code
// (Plan / Accepter les modifications / Auto).
function ModeSwitcher() {
  const { modeId, availableModes, setMode } = useAgentSocket()
  const [open, setOpen] = useState(false)
  const [dropdownStyle, setDropdownStyle] = useState({})
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open || !wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    const width = Math.min(300, window.innerWidth - 24)
    let left = rect.left
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12
    if (left < 12) left = 12
    // Ouvre vers le haut : ce bouton vit en bas de l'écran (zone du composeur),
    // un dropdown classique vers le bas sortirait de l'écran.
    setDropdownStyle({ left: left - rect.left, right: 'auto', width, top: 'auto', bottom: 'calc(100% + 6px)' })
  }, [open])

  if (availableModes.length === 0) return null
  const current = availableModes.find((m) => m.id === modeId)

  return (
    <div style={{ position: 'relative' }} ref={wrapRef}>
      <button
        className="btn mode-switch-btn"
        onClick={() => setOpen((v) => !v)}
        title="Changer le mode d'approbation"
      >
        {MODE_ICONS[modeId] || '⚙'} {current?.name || 'Mode'}
      </button>
      {open && (
        <div className="mobile-menu-dropdown" style={dropdownStyle}>
          {availableModes.map((m) => (
            <button key={m.id} onClick={() => { setOpen(false); setMode(m.id) }} style={{ height: 'auto', display: 'block' }}>
              <div style={{ color: m.id === modeId ? 'var(--accent)' : 'var(--text)', fontWeight: m.id === modeId ? 600 : 400, fontSize: 12.5 }}>
                {MODE_ICONS[m.id] || '⚙'} {m.name}
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{m.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Changer de profil llama-swap tue et relance le process qwen-code derrière
// (pas un simple appel ACP à la volée comme ModeSwitcher, voir agent_bridge.py
// switch_model) — le catalogue vient de llama-swap (/api/models), pas de
// qwen-code, qui ne connaît que son propre modèle courant.
function ModelSwitcher() {
  const { model, switchModel } = useAgentSocket()
  const [available, setAvailable] = useState([])
  const [open, setOpen] = useState(false)
  const [dropdownStyle, setDropdownStyle] = useState({})
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    fetch('/api/models').then((r) => r.json()).then((data) => setAvailable(data.available || [])).catch(() => setAvailable([]))
  }, [open])

  useEffect(() => {
    if (!open || !wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    const width = Math.min(220, window.innerWidth - 24)
    let left = rect.left
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12
    if (left < 12) left = 12
    setDropdownStyle({ left: left - rect.left, right: 'auto', width, top: 'auto', bottom: 'calc(100% + 6px)' })
  }, [open])

  if (!model) return null

  return (
    <div style={{ position: 'relative' }} ref={wrapRef}>
      <button
        className="btn mode-switch-btn"
        onClick={() => setOpen((v) => !v)}
        title="Changer de modèle (llama-swap)"
      >
        🧠 {model}
      </button>
      {open && (
        <div className="mobile-menu-dropdown" style={dropdownStyle}>
          {available.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 11.5, color: 'var(--muted)' }}>chargement…</div>
          )}
          {available.map((m) => (
            <button key={m} onClick={() => { setOpen(false); if (m !== model) switchModel(m) }} style={{ height: 'auto', display: 'block' }}>
              <div style={{ color: m === model ? 'var(--accent)' : 'var(--text)', fontWeight: m === model ? 600 : 400, fontSize: 12.5 }}>
                {m === model ? '● ' : ''}{m}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SessionList({ cwd, onClose }) {
  const { resumeProject, messages } = useAgentSocket()
  const { confirm } = useDialogs()
  const [sessions, setSessions] = useState([])

  useEffect(() => {
    fetch('/api/sessions').then((r) => r.json()).then(setSessions).catch(() => setSessions([]))
  }, [cwd])

  async function handleSelect(sessionId) {
    onClose()
    if (messages.length > 0 && !(await confirm('La conversation en cours sera perdue. Continuer ?'))) return
    resumeProject(cwd, sessionId)
  }

  if (sessions.length === 0) {
    return <div style={{ padding: '8px 10px', fontSize: 11.5, color: 'var(--muted)' }}>Aucune session enregistrée pour ce dossier.</div>
  }
  return sessions.map((s) => (
    <button key={s.id} onClick={() => handleSelect(s.id)} style={{ height: 'auto', display: 'block' }}>
      <div style={{ fontSize: 11.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.summary}</div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{formatSessionDate(s.modified)} · {s.messageCount} messages</div>
    </button>
  ))
}

// Bouton propre (desktop, popover positionné dynamiquement) — masqué sur
// mobile, où la même liste (SessionList) est intégrée au menu "⋯" du panneau.
function SessionHistory({ cwd }) {
  const [open, setOpen] = useState(false)
  const [dropdownStyle, setDropdownStyle] = useState({})
  const wrapRef = useRef(null)

  // Calé sur la largeur réelle du panneau Chat (pas une largeur fixe) — le
  // panneau peut être redimensionné (ResizeHandle) ou tout simplement occuper
  // des largeurs différentes desktop/mobile, autant exploiter tout l'espace
  // dispo à chaque fois plutôt qu'une valeur en dur toujours trop étroite.
  // position: fixed (pas absolute) — le panneau a overflow:hidden, un ancrage
  // absolute se faisait couper net à son bord plutôt qu'à celui de la fenêtre
  // (bug remonté par Julien), même piège déjà résolu ailleurs pour le menu ☰.
  useEffect(() => {
    if (!open || !wrapRef.current) return
    const buttonRect = wrapRef.current.getBoundingClientRect()
    const panelEl = wrapRef.current.closest('.panel')
    const panelRect = panelEl ? panelEl.getBoundingClientRect() : buttonRect
    setDropdownStyle({ position: 'fixed', top: buttonRect.bottom + 6, left: panelRect.left, right: 'auto', width: panelRect.width })
  }, [open])

  return (
    <div style={{ position: 'relative' }} ref={wrapRef}>
      <button
        className="btn desktop-only-btn"
        style={{ background: 'var(--card-2)', color: 'var(--muted)', borderRadius: 6, padding: '3px 8px', fontSize: 11 }}
        onClick={() => setOpen((v) => !v)}
        title="Sessions qwen-code passées dans ce dossier — cliquer pour reprendre"
      >
        📜 Sessions
      </button>
      {open && (
        <div className="mobile-menu-dropdown" style={dropdownStyle}>
          <SessionList cwd={cwd} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

function contextColor(pct) {
  if (pct == null) return 'var(--muted)'
  if (pct < 50) return 'var(--lo)'
  if (pct < 80) return 'var(--md)'
  return 'var(--hi)'
}

function findOption(options, predicate) {
  return options?.find(predicate)?.optionId ?? options?.[0]?.optionId
}

// Rendu interactif de l'outil natif qwen-code `ask_user_question` (voir
// architecture.md) — sans ça, `rawInput.questions` s'affichait en JSON brut
// dans la bannière d'approbation (bug remonté par Julien, 2026-07-08). Toutes
// les questions sont affichées en une fois (contrairement au CLI qwen-code,
// qui les paginate une par une) — plus adapté à une page web qu'à un terminal.
function AskUserQuestionForm({ questions, onSubmit }) {
  const [answers, setAnswers] = useState({})

  function selectSingle(idx, label) {
    setAnswers((prev) => ({ ...prev, [idx]: { value: label, custom: '' } }))
  }

  function toggleMulti(idx, label) {
    setAnswers((prev) => {
      const values = prev[idx]?.values || []
      return {
        ...prev,
        [idx]: { ...prev[idx], values: values.includes(label) ? values.filter((v) => v !== label) : [...values, label] },
      }
    })
  }

  function setCustom(idx, text, multiSelect) {
    setAnswers((prev) => (multiSelect
      ? { ...prev, [idx]: { ...prev[idx], custom: text } }
      : { ...prev, [idx]: { value: text, custom: text } }))
  }

  const hasAnswer = (idx) => {
    const a = answers[idx]
    if (!a) return false
    return questions[idx].multiSelect ? (a.values?.length > 0 || a.custom?.trim()) : Boolean(a.value?.trim())
  }

  function handleSubmit() {
    const result = {}
    questions.forEach((q, idx) => {
      const a = answers[idx]
      if (!a) return
      if (q.multiSelect) {
        const parts = [...(a.values || [])]
        if (a.custom?.trim()) parts.push(a.custom.trim())
        if (parts.length) result[idx] = parts.join(', ')
      } else if (a.value?.trim()) {
        result[idx] = a.value.trim()
      }
    })
    onSubmit(result)
  }

  return (
    <div className="ask-question-form">
      {questions.map((q, idx) => {
        const a = answers[idx] || {}
        return (
          <div className="question-card" key={idx}>
            <div className="question-card-header">
              {q.header && <span className="question-chip">{q.header}</span>}
              <span className="question-text">{q.question}</span>
            </div>
            <div className="question-options">
              {q.options.map((opt) => {
                const selected = q.multiSelect ? (a.values || []).includes(opt.label) : a.value === opt.label
                return (
                  <button
                    key={opt.label}
                    type="button"
                    className={`option-btn${selected ? ' selected' : ''}`}
                    title={opt.description}
                    onClick={() => (q.multiSelect ? toggleMulti(idx, opt.label) : selectSingle(idx, opt.label))}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
            <input
              type="text"
              className="dialog-input custom-answer-input"
              placeholder="Autre…"
              value={a.custom || ''}
              onChange={(e) => setCustom(idx, e.target.value, q.multiSelect)}
            />
          </div>
        )
      })}
      <button
        type="button"
        className="btn btn-approve"
        style={{ alignSelf: 'flex-start' }}
        disabled={!questions.some((_, idx) => hasAnswer(idx))}
        onClick={handleSubmit}
      >
        Valider les réponses
      </button>
    </div>
  )
}

// Fusionne les tool calls (role 'system' avec toolCallId) consécutifs en un seul
// groupe pliable — évite un mur de lignes "⚙ ... — completed" sur une tâche longue.
function groupMessages(messages) {
  const out = []
  for (const m of messages) {
    const isToolCall = m.role === 'system' && m.toolCallId
    const last = out[out.length - 1]
    if (isToolCall && last?.type === 'tool_group') {
      last.items.push(m)
    } else if (isToolCall) {
      out.push({ type: 'tool_group', id: m.id, items: [m] })
    } else {
      out.push(m)
    }
  }
  return out
}

// Composant monté en permanence — reste actif en fond que ce soit le panneau
// principal ou une carte réduite (variant), voir App.jsx pour l'agencement grid.
export default function ChatPanel({ variant, gridArea, onActivate }) {
  const { connected, messages, pendingPermission, cwd, sendMessage, respondPermission, newSession, compact, isGenerating, cancelTurn } = useAgentSocket()
  const { toChat, sendToTerminal } = usePanelBridge()
  const { confirm } = useDialogs()
  const contextUsage = useContextUsage(4000, cwd)
  const [composerValue, setComposerValue] = useState('')
  const textareaRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [showNewSessionForm, setShowNewSessionForm] = useState(false)
  const [newSessionPath, setNewSessionPath] = useState('')
  const [cwdExpanded, setCwdExpanded] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false)
  const [hideThoughts, setHideThoughts] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState({})
  const messagesRef = useRef(null)
  // true tant que l'utilisateur n'a pas remonté manuellement lire un message
  // plus haut — sinon charger une session entière (ou le streaming en direct)
  // laissait le scroll là où il était (en haut par défaut) au lieu de suivre
  // la conversation, contrairement à n'importe quel client de chat.
  const autoScrollRef = useRef(true)
  // Rejeu d'une session = rafale de dizaines de messages en quelques ms,
  // chacun redéclenchant l'effet de scroll ci-dessous. Le scroll programmatique
  // déclenche lui-même un event "scroll" natif — sans cette distinction, cet
  // event se faisait interpréter comme "l'utilisateur a bougé" (le prochain
  // message avait déjà agrandi le conteneur au moment où l'event est traité),
  // coupant le suivi en plein milieu de la rafale (bug remonté par Julien :
  // ça atterrissait au milieu de la conversation au lieu du bas). On ignore
  // un event scroll tant que le scrollHeight vient de changer — seul un
  // scrollTop qui bouge à hauteur de contenu stable est un vrai geste utilisateur.
  const lastScrollHeightRef = useRef(0)

  function handleMessagesScroll(e) {
    const el = e.currentTarget
    if (el.scrollHeight !== lastScrollHeightRef.current) {
      lastScrollHeightRef.current = el.scrollHeight
      return
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    autoScrollRef.current = distanceFromBottom < 80
  }

  // Un changement de cwd = nouvelle conversation affichée (nouvelle session,
  // reprise, changement de dossier) — repartir du bas par défaut, même si on
  // avait remonté dans la précédente.
  useEffect(() => { autoScrollRef.current = true }, [cwd])

  useEffect(() => {
    if (autoScrollRef.current && messagesRef.current) {
      const el = messagesRef.current
      el.scrollTop = el.scrollHeight
      lastScrollHeightRef.current = el.scrollHeight
    }
  }, [messages])

  // Texte sélectionné dans le Terminal (voir TerminalPanel) — inséré dans le composeur.
  useEffect(() => {
    if (toChat) setComposerValue((v) => (v ? v + '\n' : '') + toChat.text)
  }, [toChat])

  function handleDropPath(path) {
    if (!path) return
    setComposerValue((v) => (v ? v + ' ' : '') + path)
  }

  function handleSend() {
    if (!composerValue.trim()) return
    sendMessage(composerValue.trim())
    setComposerValue('')
  }

  // Hauteur recalculée à chaque changement de contenu (frappe, insertion de
  // chemin, envoi qui vide le champ) — repasser par 'auto' avant de mesurer
  // scrollHeight est nécessaire pour détecter un rétrécissement, pas
  // seulement une croissance.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
  }, [composerValue])

  function handleApprove() {
    const optionId = findOption(pendingPermission.options, (o) => o.kind === 'allow_once')
    respondPermission(pendingPermission.id, optionId)
  }

  function handleApproveAlways() {
    const optionId = findOption(pendingPermission.options, (o) => o.kind === 'allow_always')
    respondPermission(pendingPermission.id, optionId)
  }

  function handleReject() {
    const optionId = findOption(pendingPermission.options, (o) => o.kind?.startsWith('reject'))
    respondPermission(pendingPermission.id, optionId)
  }

  function handleSubmitAnswers(answers) {
    const optionId = findOption(pendingPermission.options, (o) => o.kind === 'allow_once')
    respondPermission(pendingPermission.id, optionId, answers)
  }

  function handleOpenNewSessionForm() {
    setNewSessionPath(cwd || '')
    setShowNewSessionForm(true)
  }

  async function handleConfirmNewSession() {
    if (!newSessionPath.trim()) return
    if (messages.length > 0 && !(await confirm('La conversation en cours sera perdue. Continuer ?'))) return
    newSession(newSessionPath.trim())
    setShowNewSessionForm(false)
  }

  const dragHandlers = {
    onDragOver: (e) => { e.preventDefault(); setDragOver(true) },
    onDragLeave: () => setDragOver(false),
    onDrop: (e) => { e.preventDefault(); setDragOver(false); handleDropPath(e.dataTransfer.getData('text/plain')) },
  }

  const canSend = composerValue.trim().length > 0

  // Sans mémoïsation, groupMessages (filtre + regroupement) retraitait tout
  // l'historique de conversation à CHAQUE chunk de streaming reçu (un token
  // toutes les quelques dizaines de ms) — le coût par token grandissait avec
  // la taille de la session, sur une app justement pensée pour en reprendre
  // des longues.
  const groupedMessages = useMemo(
    () => groupMessages(messages.filter((m) => !(hideThoughts && m.role === 'thought'))),
    [messages, hideThoughts]
  )

  return (
    <div className="panel is-main" style={{ gridArea }} data-slot={gridArea}>
      <div className="panel-full">
        <div className="section-header">
          <div className="section-title-row">
            <div className="section-title">
              <span className="sym">◈</span>
              <span className="name">Chat</span>
              <span className="pill model-pill">qwen-code</span>
              {cwd && (
                <span
                  className={`pill cwd-pill${cwdExpanded ? ' expanded' : ''}`}
                  title={cwd}
                  onClick={() => setCwdExpanded((v) => !v)}
                  style={cwdExpanded
                    ? { whiteSpace: 'normal', wordBreak: 'break-all', cursor: 'pointer' }
                    : { maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                >
                  {cwd}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {variant !== 'full' && (
                <button
                  className="btn"
                  style={{ background: 'var(--card-2)', color: 'var(--muted)', borderRadius: 6, width: 24, height: 24, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={onActivate}
                  title="Agrandir ce panneau"
                >
                  ⤢
                </button>
              )}
              <button
                className="btn desktop-only-btn"
                style={{
                  background: hideThoughts ? 'var(--card-2)' : 'var(--accent-soft)',
                  color: hideThoughts ? 'var(--muted)' : 'var(--accent)',
                  borderRadius: 6, padding: '3px 8px', fontSize: 11,
                }}
                onClick={() => setHideThoughts((v) => !v)}
                title="Masquer/afficher le raisonnement de l'agent"
              >
                {hideThoughts ? '💭 Raisonnement masqué' : '💭 Raisonnement visible'}
              </button>
              <button
                className="btn desktop-only-btn"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 6, padding: '3px 8px', fontSize: 11 }}
                onClick={compact}
                title="Compacter le contexte (/compress)"
              >
                🗜 Compacter
              </button>
              <button
                className="btn desktop-only-btn"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 6, padding: '3px 8px', fontSize: 11 }}
                onClick={handleOpenNewSessionForm}
                title="Démarrer une nouvelle session dans un autre dossier"
              >
                ↻ Nouvelle session
              </button>
              <SessionHistory cwd={cwd} />
              <div className="mobile-menu-wrap">
                <button
                  className="btn"
                  style={{ background: 'var(--card-2)', color: 'var(--muted)', borderRadius: 6, padding: '3px 10px', fontSize: 13 }}
                  onClick={() => setMobileMenuOpen((v) => !v)}
                >
                  ⋯
                </button>
                {mobileMenuOpen && (
                  <div className="mobile-menu-dropdown mobile-menu-dropdown--full">
                    <div className="mobile-menu-info">
                      qwen-code{cwd ? ` · ${cwd}` : ''}
                    </div>
                    <button onClick={() => { setMobileMenuOpen(false); setHideThoughts((v) => !v) }}>
                      {hideThoughts ? '💭 Afficher le raisonnement' : '💭 Masquer le raisonnement'}
                    </button>
                    <button onClick={() => { setMobileMenuOpen(false); compact() }}>🗜 Compacter</button>
                    <button onClick={() => { setMobileMenuOpen(false); handleOpenNewSessionForm() }}>↻ Nouvelle session</button>
                    <button onClick={() => setMobileSessionsOpen((v) => !v)}>
                      {mobileSessionsOpen ? '📜 Sessions ▾' : '📜 Sessions ▸'}
                    </button>
                    {mobileSessionsOpen && (
                      <div className="mobile-menu-sublist">
                        <SessionList cwd={cwd} onClose={() => { setMobileMenuOpen(false); setMobileSessionsOpen(false) }} />
                      </div>
                    )}
                  </div>
                )}
              </div>
              <span className="kbd">⌘1</span>
            </div>
          </div>

          {showNewSessionForm && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input
                className="files-search"
                style={{ flex: 1 }}
                placeholder="Chemin du dossier de la nouvelle session…"
                value={newSessionPath}
                onChange={(e) => setNewSessionPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmNewSession(); if (e.key === 'Escape') setShowNewSessionForm(false) }}
                autoFocus
              />
              <button className="btn btn-approve" onClick={handleConfirmNewSession}>Démarrer</button>
              <button className="btn btn-reject" onClick={() => setShowNewSessionForm(false)}>Annuler</button>
            </div>
          )}

          <div className="context-row">
            <span className="context-label">Contexte</span>
            <span className="context-value" style={{ color: contextColor(contextUsage?.percent) }}>
              {contextUsage?.percent != null
                ? `${contextUsage.percent}% · ${formatTokens(contextUsage.used)} / ${formatTokens(contextUsage.total)} tokens`
                : '—'}
            </span>
          </div>
          <div className={`context-track${(contextUsage?.percent ?? 0) >= 90 ? ' context-warning' : ''}`}>
            <div className="context-overlay" style={{ width: `${100 - (contextUsage?.percent ?? 0)}%` }} />
          </div>
        </div>

        <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
          {!connected && (
            <div className="msg-system-wrap">
              <span className="msg-system">⚠ connexion à l'agent perdue — reconnexion en cours…</span>
            </div>
          )}
          {connected && messages.length === 0 && (
            <div className="empty-daemon">
              <div><span className="caret">&gt;</span> myai.chat()</div>
              <div>statut: en ligne&nbsp;&nbsp;/&nbsp;&nbsp;historique: vide</div>
              <div className="note">[note] aucune tâche en cours. en attente.</div>
            </div>
          )}
          {groupedMessages.map((m) => {
            if (m.type === 'tool_group') {
              if (m.items.length === 1) {
                return (
                  <div className="msg-system-wrap" key={m.id}>
                    <span className="msg-system">{m.items[0].text}</span>
                  </div>
                )
              }
              const isOpen = Boolean(expandedGroups[m.id])
              return (
                <div className="msg-system-wrap" key={m.id}>
                  <div className="tool-group">
                    <button
                      className="tool-group-toggle"
                      onClick={() => setExpandedGroups((p) => ({ ...p, [m.id]: !p[m.id] }))}
                    >
                      {isOpen ? '▾' : '▸'} {m.items.length} actions{isOpen ? '' : ' — cliquer pour détailler'}
                    </button>
                    {isOpen && m.items.map((item) => (
                      <div className="msg-system tool-group-item" key={item.id}>{item.text}</div>
                    ))}
                  </div>
                </div>
              )
            }
            if (m.role === 'system') {
              return (
                <div className="msg-system-wrap" key={m.id}>
                  <span className="msg-system">{m.text}</span>
                </div>
              )
            }
            if (m.role === 'thought') {
              return (
                <div className="msg-col agent" key={m.id}>
                  <div
                    className="bubble agent"
                    style={{ background: 'transparent', border: '1px dashed var(--border-hi)', color: 'var(--muted)', fontStyle: 'italic' }}
                  >
                    💭 {m.text}
                    {m.streaming && <span className="cursor" />}
                  </div>
                </div>
              )
            }
            const isUser = m.role === 'user'
            const code = !isUser && !m.streaming ? extractCodeBlock(m.text) : null
            return (
              <div className={`msg-col ${isUser ? 'user' : 'agent'}`} key={m.id}>
                <div className={`bubble ${isUser ? 'user' : 'agent'} markdown-body`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                  {m.streaming && <span className="cursor" />}
                </div>
                {code && (
                  <button
                    className="btn"
                    style={{ alignSelf: 'flex-start', background: 'var(--card-2)', color: 'var(--muted)', borderRadius: 6, padding: '3px 8px', fontSize: 10.5 }}
                    onClick={() => sendToTerminal(code)}
                    title="Envoyer cette commande au terminal"
                  >
                    ▸ Exécuter dans le terminal
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <div className="composer-zone">
          <LoadingIndicator />
          {pendingPermission && (() => {
            const questions = pendingPermission.rawInput?.questions
            const isQuestionForm = !pendingPermission.diff && Array.isArray(questions)
            return (
              <div className={`approval-banner${pendingPermission.dangerousCommand ? ' approval-banner-danger' : ''}`}>
                <span className="icon">{pendingPermission.dangerousCommand ? '⚠' : '⚙'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12 }}>
                    {isQuestionForm ? "L'agent a besoin de précisions" : "L'agent souhaite exécuter une action"}
                  </div>
                  {pendingPermission.dangerousCommand && (
                    <div className="danger-warning">
                      Commande potentiellement destructrice détectée ({pendingPermission.dangerousCommand}) — vérifie avant d'approuver
                    </div>
                  )}
                  <code className="cmd">{pendingPermission.toolTitle}</code>
                  {pendingPermission.diff && <DiffView diff={pendingPermission.diff} />}
                  {isQuestionForm && (
                    <AskUserQuestionForm questions={questions} onSubmit={handleSubmitAnswers} />
                  )}
                  {!pendingPermission.diff && !isQuestionForm && pendingPermission.rawInput && (
                    <pre className="raw-input-view">{JSON.stringify(pendingPermission.rawInput, null, 2)}</pre>
                  )}
                </div>
                <div className="approval-banner-actions">
                  <button className="btn btn-reject" onClick={handleReject}>Rejeter</button>
                  {!isQuestionForm && pendingPermission.options?.some((o) => o.kind === 'allow_always') && (
                    <button
                      className="btn btn-approve-always"
                      onClick={handleApproveAlways}
                      title="Toujours autoriser ce type d'action dans ce dossier, pour la durée de vie du backend"
                    >
                      Toujours
                    </button>
                  )}
                  {!isQuestionForm && <button className="btn btn-approve" onClick={handleApprove}>Approuver</button>}
                </div>
              </div>
            )
          })()}

          <div className={`composer${dragOver ? ' drag-over' : ''}`} {...dragHandlers}>
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Écrire à l'agent…"
              value={composerValue}
              onChange={(e) => setComposerValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (canSend) handleSend()
                }
              }}
            />
            <div className="composer-toolbar">
              <div style={{ display: 'flex', gap: 6 }}>
                <ModeSwitcher />
                <ModelSwitcher />
              </div>
              {isGenerating ? (
                <button
                  className="btn btn-send enabled btn-stop"
                  onClick={cancelTurn}
                  title="Interrompre la génération en cours"
                >
                  <span className="btn-send-text">Stop</span>
                  <span className="btn-send-icon">⏹</span>
                </button>
              ) : (
                <button
                  className={`btn btn-send ${canSend ? 'enabled' : 'disabled'}`}
                  disabled={!canSend}
                  onClick={handleSend}
                >
                  <span className="btn-send-text">Envoyer</span>
                  <span className="btn-send-icon">➤</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
