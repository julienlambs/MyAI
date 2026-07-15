import { useEffect, useState } from 'react'
import { useTheme } from '../lib/useTheme'
import { useGpuUsage } from '../lib/useGpuUsage'
import { useAgentSocket } from '../lib/useAgentSocket'
import { usePushNotifications } from '../lib/usePushNotifications'
import { useDialogs } from '../lib/useDialogs'

function normalizePath(p) {
  return p ? p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '') : ''
}

const PANEL_META = {
  chat: { symbol: '◈', label: 'Chat' },
  files: { symbol: '◎', label: 'Fichiers' },
  terminal: { symbol: '›_', label: 'Terminal' },
}
const PANEL_ORDER = ['chat', 'files', 'terminal']

// Remplace la barre de navigation du bas sur mobile — les 2 panneaux non
// actifs sont accessibles ici en 1 tap (le 3e est déjà à l'écran), sans
// perdre la place que prenait la barre. Voir aussi le balayage horizontal
// dans App.jsx pour changer de panneau au doigt sans viser un bouton.
function MobilePanelSwitcher({ activePanel, setActivePanel }) {
  const others = PANEL_ORDER.filter((id) => id !== activePanel)
  return (
    <div className="mobile-panel-switch">
      {others.map((id) => (
        <button
          key={id}
          className="mobile-panel-switch-btn"
          onClick={() => setActivePanel(id)}
          title={`Ouvrir ${PANEL_META[id].label}`}
        >
          {PANEL_META[id].symbol}
        </button>
      ))}
    </div>
  )
}

function ProjectSwitcher() {
  const { cwd, resumeProject, messages } = useAgentSocket()
  const { confirm } = useDialogs()
  const [projects, setProjects] = useState([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    fetch('/api/projects').then((r) => r.json()).then(setProjects).catch(() => setProjects([]))
  }, [])

  const current = projects.find((p) => normalizePath(p.path) === normalizePath(cwd))

  async function handleSelect(path) {
    setOpen(false)
    if (messages.length > 0 && !(await confirm('La conversation en cours sera perdue. Continuer ?'))) return
    // Reprend la session la plus récente de ce dossier si elle existe (voir
    // agent_bridge.py resume_session) — pas un simple "new_session" vierge.
    resumeProject(path)
  }

  if (projects.length === 0) return null

  return (
    <div className="header-desktop-only" style={{ position: 'relative' }}>
      <button
        className="btn"
        onClick={() => setOpen((v) => !v)}
        style={{ background: 'var(--card-2)', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: 8, padding: '4px 10px', fontSize: 11 }}
        title="Changer de projet"
      >
        📁 {current ? current.name : 'Projet'} ▾
      </button>
      {open && (
        <div className="mobile-menu-dropdown">
          {projects.map((p) => (
            <button key={p.path} onClick={() => handleSelect(p.path)} style={p === current ? { color: 'var(--accent)' } : undefined}>
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Sur mobile, la barre globale se réduit à logo + statut + ce menu unique —
// tout le reste (projet, thème...) passe dedans plutôt que de s'entasser sur
// une ligne trop étroite (voir retour Julien sur le layout mobile).
function MobileHeaderMenu() {
  const { cwd, resumeProject, messages } = useAgentSocket()
  const { mode, toggle } = useTheme()
  const push = usePushNotifications()
  const { confirm } = useDialogs()
  const [projects, setProjects] = useState([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    fetch('/api/projects').then((r) => r.json()).then(setProjects).catch(() => setProjects([]))
  }, [open])

  async function handleSelect(path) {
    setOpen(false)
    if (messages.length > 0 && !(await confirm('La conversation en cours sera perdue. Continuer ?'))) return
    resumeProject(path)
  }

  const current = projects.find((p) => normalizePath(p.path) === normalizePath(cwd))

  return (
    <div className="mobile-menu-wrap">
      <button
        className="btn"
        style={{ background: 'var(--card-2)', color: 'var(--muted)', borderRadius: 6, padding: '3px 10px', fontSize: 13 }}
        onClick={() => setOpen((v) => !v)}
        title="Menu de l'application"
      >
        ☰
      </button>
      {open && (
        <div className="mobile-menu-dropdown">
          <button onClick={() => { setOpen(false); toggle() }}>
            {mode === 'dark' ? '☀ Thème clair' : '☾ Thème sombre'}
          </button>
          {push.supported && (
            <button disabled={push.busy} onClick={() => (push.subscribed ? push.unsubscribe() : push.subscribe())}>
              {push.subscribed ? '🔕 Désactiver les notifs' : '🔔 Activer les notifs'}
            </button>
          )}
          <div className="mobile-menu-sublist">
            {projects.map((p) => (
              <button key={p.path} onClick={() => handleSelect(p.path)} style={p === current ? { color: 'var(--accent)' } : undefined}>
                📁 {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Header({ activePanel, setActivePanel }) {
  const { mode, toggle } = useTheme()
  const gpu = useGpuUsage()
  const { cwd } = useAgentSocket()
  const push = usePushNotifications()

  return (
    <div className="header">
      <div className="brand">
        <span className="logo">My<em>AI</em></span>
        <span className="path">qwen-code · session locale · {cwd || '…'}</span>
      </div>
      <MobilePanelSwitcher activePanel={activePanel} setActivePanel={setActivePanel} />
      <div className="header-right">
        <ProjectSwitcher />
        {gpu?.percent != null && (
          <div
            className={`gpu-widget${gpu.warning ? ' gpu-warning' : ''}`}
            title={`VRAM ${gpu.used} / ${gpu.total} MiB · GPU ${gpu.utilization}%`}
          >
            <span className="dot" style={{ background: gpu.warning ? 'var(--hi)' : 'var(--lo)' }} />
            VRAM {gpu.percent}%
          </div>
        )}
        <div className="status-dot"><span className="dot" />En ligne</div>
        <span className="kbd-hint">⌘1 Chat &nbsp;&nbsp; ⌘2 Fichiers &nbsp;&nbsp; ⌘3 Terminal</span>
        {push.supported && (
          <button
            className="btn header-desktop-only"
            disabled={push.busy}
            onClick={() => (push.subscribed ? push.unsubscribe() : push.subscribe())}
            style={{ background: 'var(--card-2)', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: 8, padding: '4px 10px', fontSize: 11 }}
            title={push.subscribed ? 'Désactiver les notifications push' : 'Activer les notifications push (approbation requise, tâche terminée)'}
          >
            {push.subscribed ? '🔕 Notifs' : '🔔 Notifs'}
          </button>
        )}
        <button
          className="btn header-desktop-only"
          onClick={toggle}
          style={{ background: 'var(--card-2)', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: 8, padding: '4px 10px', fontSize: 11 }}
          title="Basculer le thème"
        >
          {mode === 'dark' ? '☀ Light' : '☾ Dark'}
        </button>
        <MobileHeaderMenu />
      </div>
    </div>
  )
}
