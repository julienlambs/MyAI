import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAgentSocket } from '../lib/useAgentSocket'
import { useContextUsage, formatTokens } from '../lib/useContextUsage'
import { usePanelBridge } from '../lib/usePanelBridge'
import { useDialogs } from '../lib/useDialogs'
import { randomPhrase } from '../lib/loadingPhrases'
import DiffView from './DiffView'
import { Btn, Field, IconBtn, Icone, Touche } from '@declic/ui'
import { MenuPop, MenuItem, MenuGroupe, MenuSep } from './MenuPop'

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
        {elapsedSeconds.toFixed(1).replace('.', ',')} s
        {tokenEstimate > 0 && <> · <Icone nom="descendre" /> {tokenEstimate.toLocaleString('fr-FR')} tokens</>}
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

// Coupe de la charte sur le code en ligne et les blocs de code rendus par le Markdown (pas de classe possible autrement).
const MD_COMPONENTS = {
  code: ({ node, className, ...props }) => <code className={`cut${className ? ` ${className}` : ''}`} {...props} />,
  pre: ({ node, ...props }) => <pre className="cut" {...props} />,
}

const MODE_ICONS = { plan: 'liste', default: 'verrou', 'auto-edit': 'modifier', auto: 'eclair', yolo: 'cadenas-ouvert' }

// Modes d'approbation qwen-code (plan/default/auto-edit/auto/yolo), vérifiés
// empiriquement via session/set_mode — équivalent des modes de Claude Code
// (Plan / Accepter les modifications / Auto).
function ModeSwitcher() {
  const { modeId, availableModes, setMode } = useAgentSocket()
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)

  if (availableModes.length === 0) return null
  const current = availableModes.find((m) => m.id === modeId)

  return (
    <>
      <Btn kind="sec" ref={btnRef} icon={<Icone nom={MODE_ICONS[modeId] || 'reglages'} />}
        onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        data-tip="Changer le mode d’approbation">
        {current?.name || 'Mode'}
      </Btn>
      <MenuPop anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width={300} label="Mode d’approbation">
        {availableModes.map((m) => (
          <MenuItem key={m.id} icon={MODE_ICONS[m.id] || 'reglages'} label={m.name} desc={m.description}
            checked={m.id === modeId} onSelect={() => { setOpen(false); setMode(m.id) }} />
        ))}
      </MenuPop>
    </>
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
  const btnRef = useRef(null)

  useEffect(() => {
    if (!open) return
    fetch('/api/models').then((r) => r.json()).then((data) => setAvailable(data.available || [])).catch(() => setAvailable([]))
  }, [open])

  if (!model) return null

  return (
    <>
      <Btn kind="sec" ref={btnRef} icon={<Icone nom="ia" />} onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu" aria-expanded={open} data-tip="Changer de modèle (llama-swap)">
        {model}
      </Btn>
      <MenuPop anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width={240} label="Modèle">
        {available.length === 0 && <MenuItem label="Chargement…" disabled />}
        {available.map((m) => (
          <MenuItem key={m} label={m} checked={m === model}
            onSelect={() => { setOpen(false); if (m !== model) switchModel(m) }} />
        ))}
      </MenuPop>
    </>
  )
}

function SessionList({ cwd, onClose }) {
  const { resumeProject, messages } = useAgentSocket()
  const { confirm } = useDialogs()
  const [sessions, setSessions] = useState(null)

  useEffect(() => {
    fetch('/api/sessions').then((r) => r.json()).then(setSessions).catch(() => setSessions([]))
  }, [cwd])

  async function handleSelect(sessionId) {
    onClose()
    if (messages.length > 0 && !(await confirm('Quitter la conversation en cours ?', { action: 'Reprendre la session' }))) return
    resumeProject(cwd, sessionId)
  }

  if (sessions === null) return <MenuItem label="Chargement…" disabled />
  if (sessions.length === 0) return <MenuItem label="Aucune session enregistrée pour ce dossier." disabled />
  return sessions.map((s) => (
    <MenuItem key={s.id} icon="historique" label={s.summary}
      desc={`${formatSessionDate(s.modified)} · ${s.messageCount} messages`} onSelect={() => handleSelect(s.id)} />
  ))
}

// Bouton propre (desktop) — masqué sur mobile, où la même liste (SessionList)
// est intégrée au menu « Plus d'options » du panneau. Le menu reprend la largeur
// du panneau Chat (redimensionnable), pas une largeur fixe toujours trop étroite.
function SessionHistory({ cwd }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)

  return (
    <>
      <Btn kind="ghost" className="desktop-only-btn" ref={btnRef} icon={<Icone nom="historique" />}
        onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        data-tip="Sessions qwen-code passées dans ce dossier">
        Sessions
      </Btn>
      <MenuPop anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width="panel" label="Sessions">
        <SessionList cwd={cwd} onClose={() => setOpen(false)} />
      </MenuPop>
    </>
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
          <div className="cs cut question-card" key={idx}><div className="in cut2">
            <div className="question-card-header">
              {q.header && <span className="badge cut bg-acc">{q.header}</span>}
              <span className="question-text">{q.question}</span>
            </div>
            <div className="question-options">
              {q.options.map((opt) => {
                const selected = q.multiSelect ? (a.values || []).includes(opt.label) : a.value === opt.label
                return (
                  <Btn
                    key={opt.label}
                    type="button"
                    kind={selected ? 'pri' : 'sec'}
                    aria-pressed={selected}
                    icon={selected ? <Icone nom="valider" /> : null}
                    data-tip={opt.description}
                    onClick={() => (q.multiSelect ? toggleMulti(idx, opt.label) : selectSingle(idx, opt.label))}
                  >
                    {opt.label}
                  </Btn>
                )
              })}
            </div>
            <Field
              label="Autre réponse"
              value={a.custom || ''}
              onChange={(e) => setCustom(idx, e.target.value, q.multiSelect)}
            />
          </div></div>
        )
      })}
      <div>
        <Btn type="button" disabled={!questions.some((_, idx) => hasAnswer(idx))} onClick={handleSubmit}>
          Envoyer les réponses
        </Btn>
      </div>
    </div>
  )
}

// Fusionne les tool calls (role 'system' avec toolCallId) consécutifs en un seul
// groupe pliable — évite un mur de lignes « … — completed » sur une tâche longue.
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
  const mobileMenuRef = useRef(null)
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
    if (messages.length > 0 && !(await confirm('Quitter la conversation en cours ?', { action: 'Démarrer la session' }))) return
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
    <div className="panel is-main coupe" style={{ gridArea }} data-slot={gridArea}>
      <div className="panel-full">
        <div className="section-header">
          <div className="section-title-row">
            <div className="section-title">
              <Icone nom="bulle" className="sym" />
              <h2 className="name">Chat</h2>
              <span className="badge cut bg-neu model-pill">qwen-code</span>
              {cwd && (
                <button
                  type="button"
                  className={`badge cut bg-neu cwd-pill${cwdExpanded ? ' expanded' : ''}`}
                  data-tip={cwdExpanded ? undefined : cwd}
                  aria-expanded={cwdExpanded}
                  onClick={() => setCwdExpanded((v) => !v)}
                >
                  {cwd}
                </button>
              )}
            </div>
            <div className="section-actions">
              {variant !== 'full' && (
                <IconBtn kind="ghost" label="Agrandir ce panneau" icon={<Icone nom="plein-ecran" />} onClick={onActivate} />
              )}
              <Btn
                kind="ghost"
                className="desktop-only-btn"
                aria-pressed={!hideThoughts}
                icon={<Icone nom={hideThoughts ? 'oeil-barre' : 'oeil'} />}
                onClick={() => setHideThoughts((v) => !v)}
                data-tip="Masquer ou afficher le raisonnement de l’agent"
              >
                Raisonnement
              </Btn>
              <Btn kind="ghost" className="desktop-only-btn" icon={<Icone nom="reduire" />} onClick={compact}
                data-tip="Compacter le contexte (/compress)">
                Compacter
              </Btn>
              <Btn kind="ghost" className="desktop-only-btn" icon={<Icone nom="ajouter" />} onClick={handleOpenNewSessionForm}
                data-tip="Démarrer une nouvelle session dans un autre dossier">
                Nouvelle session
              </Btn>
              <SessionHistory cwd={cwd} />
              <div className="mobile-menu-wrap">
                <IconBtn kind="ghost" ref={mobileMenuRef} label="Plus d’options" icon={<Icone nom="plus-options" />}
                  aria-haspopup="menu" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((v) => !v)} />
                <MenuPop anchorRef={mobileMenuRef} open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)}
                  width="panel" label="Options du chat">
                  <MenuGroupe>qwen-code{cwd ? ` · ${cwd}` : ''}</MenuGroupe>
                  <MenuItem icon={hideThoughts ? 'oeil' : 'oeil-barre'}
                    label={hideThoughts ? 'Afficher le raisonnement' : 'Masquer le raisonnement'}
                    onSelect={() => { setMobileMenuOpen(false); setHideThoughts((v) => !v) }} />
                  <MenuItem icon="reduire" label="Compacter le contexte" onSelect={() => { setMobileMenuOpen(false); compact() }} />
                  <MenuItem icon="ajouter" label="Nouvelle session" onSelect={() => { setMobileMenuOpen(false); handleOpenNewSessionForm() }} />
                  <MenuSep />
                  <MenuGroupe>Sessions</MenuGroupe>
                  <SessionList cwd={cwd} onClose={() => setMobileMenuOpen(false)} />
                </MenuPop>
              </div>
              <span className="kbd"><Touche>Ctrl 1</Touche></span>
            </div>
          </div>

          {showNewSessionForm && (
            <div className="new-session-form">
              <Field
                label="Dossier de la nouvelle session"
                value={newSessionPath}
                onChange={(e) => setNewSessionPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmNewSession(); if (e.key === 'Escape') setShowNewSessionForm(false) }}
                autoFocus
              />
              <Btn onClick={handleConfirmNewSession}>Démarrer</Btn>
              <Btn kind="sec" onClick={() => setShowNewSessionForm(false)}>Annuler</Btn>
            </div>
          )}

          <div className="context-row">
            <span className="context-label">Contexte</span>
            <span className="context-value" style={{ color: contextColor(contextUsage?.percent) }}>
              {contextUsage?.percent != null
                ? `${contextUsage.percent} % · ${formatTokens(contextUsage.used)} / ${formatTokens(contextUsage.total)} tokens`
                : '—'}
            </span>
          </div>
          <div className={`context-track cut${(contextUsage?.percent ?? 0) >= 90 ? ' context-warning' : ''}`}>
            <div className="context-overlay" style={{ width: `${100 - (contextUsage?.percent ?? 0)}%` }} />
          </div>
        </div>

        <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
          {!connected && (
            <div className="msg-system-wrap">
              <span className="badge cut bg-md"><Icone nom="attention" /> Connexion à l’agent perdue, reconnexion en cours…</span>
            </div>
          )}
          {connected && messages.length === 0 && (
            <div className="empty-daemon">
              <div><span className="caret">&gt;</span> myai.chat()</div>
              <div>statut&nbsp;: en ligne&nbsp;&nbsp;/&nbsp;&nbsp;historique&nbsp;: vide</div>
              <div className="note">[note] aucune tâche en cours. En attente.</div>
            </div>
          )}
          {groupedMessages.map((m) => {
            if (m.type === 'tool_group') {
              if (m.items.length === 1) {
                return (
                  <div className="msg-system-wrap" key={m.id}>
                    <span className="msg-system cut">{m.items[0].text}</span>
                  </div>
                )
              }
              const isOpen = Boolean(expandedGroups[m.id])
              return (
                <div className="msg-system-wrap" key={m.id}>
                  <div className="tool-group">
                    <Btn
                      kind="ghost"
                      className="tool-group-toggle"
                      aria-expanded={isOpen}
                      icon={<Icone nom={isOpen ? 'replier' : 'deplier'} />}
                      onClick={() => setExpandedGroups((p) => ({ ...p, [m.id]: !p[m.id] }))}
                    >
                      {m.items.length} actions
                    </Btn>
                    {isOpen && m.items.map((item) => (
                      <div className="msg-system cut tool-group-item" key={item.id}>{item.text}</div>
                    ))}
                  </div>
                </div>
              )
            }
            if (m.role === 'system') {
              return (
                <div className="msg-system-wrap" key={m.id}>
                  <span className="msg-system cut">{m.text}</span>
                </div>
              )
            }
            if (m.role === 'thought') {
              return (
                <div className="msg-col agent" key={m.id}>
                  <div className="bubble thought coupe tir">
                    <Icone nom="ia" /> {m.text}
                    {m.streaming && <span className="cursor" />}
                  </div>
                </div>
              )
            }
            const isUser = m.role === 'user'
            // Tour d'agent qui n'a produit qu'un appel d'outil : pas de bulle vide à l'écran.
            if (!isUser && !m.streaming && !m.text?.trim()) return null
            const code = !isUser && !m.streaming ? extractCodeBlock(m.text) : null
            return (
              <div className={`msg-col ${isUser ? 'user' : 'agent'}`} key={m.id}>
                <div className={`bubble ${isUser ? 'user' : 'agent'} coupe markdown-body`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{m.text}</ReactMarkdown>
                  {m.streaming && <span className="cursor" />}
                </div>
                {code && (
                  <Btn kind="ghost" className="run-in-terminal" icon={<Icone nom="terminal" />}
                    onClick={() => sendToTerminal(code)} data-tip="Envoyer cette commande au terminal">
                    Exécuter dans le terminal
                  </Btn>
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
            const danger = Boolean(pendingPermission.dangerousCommand)
            return (
              <div className={`approval-banner coupe${danger ? ' approval-banner-danger' : ''}`} role="alert">
                <Icone nom={danger ? 'attention' : 'reglages'} className="icon" />
                <div className="approval-body">
                  <div className="approval-title">
                    {isQuestionForm ? 'L’agent a besoin de précisions' : 'L’agent souhaite exécuter une action'}
                  </div>
                  {danger && (
                    <div className="danger-warning">
                      Commande potentiellement destructrice détectée ({pendingPermission.dangerousCommand}) : vérifie avant d’approuver.
                    </div>
                  )}
                  <code className="cmd cut">{pendingPermission.toolTitle}</code>
                  {pendingPermission.diff && <DiffView diff={pendingPermission.diff} />}
                  {isQuestionForm && (
                    <AskUserQuestionForm questions={questions} onSubmit={handleSubmitAnswers} />
                  )}
                  {!pendingPermission.diff && !isQuestionForm && pendingPermission.rawInput && (
                    <pre className="raw-input-view coupe">{JSON.stringify(pendingPermission.rawInput, null, 2)}</pre>
                  )}
                </div>
                <div className="approval-banner-actions">
                  <Btn kind="sec" onClick={handleReject}>Rejeter</Btn>
                  {!isQuestionForm && pendingPermission.options?.some((o) => o.kind === 'allow_always') && (
                    <Btn kind="sec" onClick={handleApproveAlways}
                      data-tip="Toujours autoriser ce type d’action dans ce dossier, pour la durée de vie du backend">
                      Toujours autoriser
                    </Btn>
                  )}
                  {!isQuestionForm && <Btn onClick={handleApprove}>Approuver</Btn>}
                </div>
              </div>
            )
          })()}

          <div className={`composer coupe${dragOver ? ' drag-over' : ''}`} {...dragHandlers}>
            <textarea
              ref={textareaRef}
              rows={1}
              aria-label="Message à l’agent"
              placeholder="Écrire à l’agent…"
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
              <div className="composer-switches">
                <ModeSwitcher />
                <ModelSwitcher />
              </div>
              {isGenerating ? (
                <Btn kind="dan" className="btn-send" icon={<Icone nom="stop" />} onClick={cancelTurn}
                  aria-label="Interrompre la génération" data-tip="Interrompre la génération en cours">
                  <span className="btn-send-text">Arrêter</span>
                </Btn>
              ) : (
                <Btn className="btn-send" icon={<Icone nom="envoyer" />} disabled={!canSend} onClick={handleSend} aria-label="Envoyer">
                  <span className="btn-send-text">Envoyer</span>
                </Btn>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
