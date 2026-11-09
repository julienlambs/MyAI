import { useEffect, useRef, useState } from 'react'
import { Btn, IconBtn, Icone, Touche } from '@declic/ui'
import { useTheme } from '../lib/useTheme'
import { useGpuUsage } from '../lib/useGpuUsage'
import { useAgentSocket } from '../lib/useAgentSocket'
import { usePushNotifications } from '../lib/usePushNotifications'
import { useDialogs } from '../lib/useDialogs'
import { MenuPop, MenuItem, MenuGroupe, MenuSep } from './MenuPop'

function normalizePath(p) {
  return p ? p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '') : ''
}

export const PANEL_META = {
  chat: { icon: 'bulle', label: 'Chat' },
  files: { icon: 'dossier', label: 'Fichiers' },
  terminal: { icon: 'terminal', label: 'Terminal' },
}
const PANEL_ORDER = ['chat', 'files', 'terminal']
const CONFIRM_PERTE = 'Quitter la conversation en cours ?'

function useProjects(enabled) {
  const [projects, setProjects] = useState([])
  useEffect(() => {
    if (!enabled) return
    fetch('/api/projects').then((r) => r.json()).then(setProjects).catch(() => setProjects([]))
  }, [enabled])
  return projects
}

// Remplace la barre de navigation du bas sur mobile — les 2 panneaux non
// actifs sont accessibles ici en 1 tap (le 3e est déjà à l'écran), sans
// perdre la place que prenait la barre. Voir aussi le balayage horizontal
// dans App.jsx pour changer de panneau au doigt sans viser un bouton.
function MobilePanelSwitcher({ activePanel, setActivePanel }) {
  const others = PANEL_ORDER.filter((id) => id !== activePanel)
  return (
    <div className="mobile-panel-switch">
      {others.map((id) => (
        <IconBtn
          key={id}
          kind="ghost"
          label={`Ouvrir ${PANEL_META[id].label}`}
          icon={<Icone nom={PANEL_META[id].icon} />}
          onClick={() => setActivePanel(id)}
        />
      ))}
    </div>
  )
}

function ProjectSwitcher() {
  const { cwd, resumeProject, messages } = useAgentSocket()
  const { confirm } = useDialogs()
  const projects = useProjects(true)
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)

  const current = projects.find((p) => normalizePath(p.path) === normalizePath(cwd))

  async function handleSelect(path) {
    setOpen(false)
    if (messages.length > 0 && !(await confirm(CONFIRM_PERTE, { action: 'Changer de projet' }))) return
    // Reprend la session la plus récente de ce dossier si elle existe (voir
    // agent_bridge.py resume_session) — pas un simple "new_session" vierge.
    resumeProject(path)
  }

  if (projects.length === 0) return null

  return (
    <div className="header-desktop-only">
      <Btn kind="sec" ref={btnRef} icon={<Icone nom="dossier" />} onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu" aria-expanded={open} data-tip="Changer de projet">
        {current ? current.name : 'Projet'}<Icone nom="deplier" />
      </Btn>
      <MenuPop anchorRef={btnRef} open={open} onClose={() => setOpen(false)} label="Projets">
        {projects.map((p) => (
          <MenuItem key={p.path} label={p.name} checked={p === current} onSelect={() => handleSelect(p.path)} />
        ))}
      </MenuPop>
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
  const [open, setOpen] = useState(false)
  const projects = useProjects(open)
  const btnRef = useRef(null)

  async function handleSelect(path) {
    setOpen(false)
    if (messages.length > 0 && !(await confirm(CONFIRM_PERTE, { action: 'Changer de projet' }))) return
    resumeProject(path)
  }

  const current = projects.find((p) => normalizePath(p.path) === normalizePath(cwd))

  return (
    <div className="mobile-menu-wrap">
      <IconBtn kind="ghost" ref={btnRef} label="Menu de l’application" icon={<Icone nom="menu" />}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <MenuPop anchorRef={btnRef} open={open} onClose={() => setOpen(false)} label="Menu de l’application" width={260}>
        <MenuItem icon={mode === 'dark' ? 'soleil' : 'lune'} label={mode === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre'}
          onSelect={() => { setOpen(false); toggle() }} />
        {push.supported && (
          <MenuItem icon={push.subscribed ? 'cloche-barree' : 'cloche'} disabled={push.busy}
            label={push.subscribed ? 'Désactiver les notifications' : 'Activer les notifications'}
            onSelect={() => { setOpen(false); push.subscribed ? push.unsubscribe() : push.subscribe() }} />
        )}
        {projects.length > 0 && <><MenuSep /><MenuGroupe>Projets</MenuGroupe></>}
        {projects.map((p) => (
          <MenuItem key={p.path} label={p.name} checked={p === current} onSelect={() => handleSelect(p.path)} />
        ))}
      </MenuPop>
    </div>
  )
}

export default function Header({ activePanel, setActivePanel }) {
  const { mode, toggle } = useTheme()
  const gpu = useGpuUsage()
  const { cwd, connected } = useAgentSocket()
  const push = usePushNotifications()

  return (
    <header className="header">
      <div className="brand">
        <span className="logo">MyAI</span>
        <span className="path">qwen-code · session locale · {cwd || '…'}</span>
      </div>
      <MobilePanelSwitcher activePanel={activePanel} setActivePanel={setActivePanel} />
      <div className="header-right">
        <ProjectSwitcher />
        {gpu?.percent != null && (
          <span
            className={`badge cut gpu-widget ${gpu.warning ? 'bg-hi gpu-warning' : 'bg-neu'}`}
            data-tip={`VRAM ${gpu.used} / ${gpu.total} Mio · GPU ${gpu.utilization} %`}
          >
            {gpu.warning && <Icone nom="attention" />}VRAM {gpu.percent} %
          </span>
        )}
        <span className={`badge cut status-badge ${connected ? 'bg-lo' : 'bg-md'}`}>
          <Icone nom={connected ? 'succes' : 'attention'} />{connected ? 'En ligne' : 'Reconnexion'}
        </span>
        <span className="kbd-hint"><Touche>Ctrl 1</Touche> Chat <Touche>Ctrl 2</Touche> Fichiers <Touche>Ctrl 3</Touche> Terminal</span>
        {/* IconBtn remplace son className par le sien : la classe de mise en page va sur un enveloppant */}
        <span className="header-desktop-only header-icons">
          {push.supported && (
            <IconBtn
              kind="ghost"
              disabled={push.busy}
              onClick={() => (push.subscribed ? push.unsubscribe() : push.subscribe())}
              label={push.subscribed ? 'Désactiver les notifications' : 'Activer les notifications (approbation requise, tâche terminée)'}
              icon={<Icone nom={push.subscribed ? 'cloche' : 'cloche-barree'} />}
            />
          )}
          <IconBtn
            kind="ghost"
            onClick={toggle}
            label={mode === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre'}
            icon={<Icone nom={mode === 'dark' ? 'soleil' : 'lune'} />}
          />
        </span>
        <MobileHeaderMenu />
      </div>
    </header>
  )
}
