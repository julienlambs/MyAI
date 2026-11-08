import { useEffect, useRef, useState } from 'react'
import HexBackground from './components/HexBackground'
import Header from './components/Header'
import ChatPanel from './components/ChatPanel'
import FilesPanel from './components/FilesPanel'
import TerminalPanel from './components/TerminalPanel'
import ResizeHandle from './components/ResizeHandle'
import { AgentSocketProvider } from './lib/useAgentSocket'
import { ThemeProvider } from './lib/useTheme'
import { PanelBridgeProvider } from './lib/usePanelBridge'
import { DialogProvider } from './lib/useDialogs'
import { useViseurFocus } from '@declic/ui'

const ORDER = ['chat', 'files', 'terminal']
const SHORTCUT_TO_PANEL = { '1': 'chat', '2': 'files', '3': 'terminal' }
// e.code (position physique, indépendant du NumLock) plutôt que e.key — pour
// cibler précisément le pavé numérique sans toucher aux touches 1/2/3 du haut.
const NUMPAD_TO_PANEL = { Numpad1: 'chat', Numpad2: 'files', Numpad3: 'terminal' }
const MOBILE_QUERY = '(max-width: 839.98px)'
const SWIPE_MIN_DISTANCE = 60

export default function App() {
  const [activePanel, setActivePanel] = useState('chat')
  const [secondaryWidth, setSecondaryWidth] = useState(300)
  // null tant que l'utilisateur n'a jamais glissé la poignée verticale — la
  // grille retombe alors sur 1fr/1fr (50/50) via la valeur par défaut CSS,
  // pas besoin de connaître la hauteur réelle disponible pour ce cas-là.
  const [card1Height, setCard1Height] = useState(null)
  const mainRowRef = useRef(null)
  useViseurFocus()

  // Raccourcis clavier globaux ⌘1/⌘2/⌘3 (Ctrl sous Windows/Linux), + pavé
  // numérique seul (sans modificateur) comme alternative rapide.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey) {
        const target = SHORTCUT_TO_PANEL[e.key]
        if (target) {
          e.preventDefault()
          setActivePanel(target)
        }
        return
      }
      const numpadTarget = NUMPAD_TO_PANEL[e.code]
      if (!numpadTarget) return
      // Pas de modificateur sur ce raccourci : sans cette garde, taper un
      // vrai "1"/"2"/"3" au pavé numérique dans le composeur du chat, un
      // renommage de fichier ou le terminal changerait de panneau au lieu
      // de saisir le chiffre.
      const el = document.activeElement
      const isEditable = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable
      if (isEditable) return
      e.preventDefault()
      setActivePanel(numpadTarget)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Balayage horizontal pour changer de panneau — remplace la barre du bas
  // sur mobile (un seul panneau visible à la fois). Pas de sens sur desktop
  // (les 3 panneaux sont déjà visibles simultanément), donc actif seulement
  // sous le même seuil que le layout mobile.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const el = mainRowRef.current
    if (!mq.matches || !el) return

    let startX = 0
    let startY = 0
    let tracking = false

    function onTouchStart(e) {
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      tracking = true
    }
    function onTouchEnd(e) {
      if (!tracking) return
      tracking = false
      const dx = e.changedTouches[0].clientX - startX
      const dy = e.changedTouches[0].clientY - startY
      if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return
      const idx = ORDER.indexOf(activePanel)
      const next = dx < 0 ? (idx + 1) % ORDER.length : (idx - 1 + ORDER.length) % ORDER.length
      setActivePanel(ORDER[next])
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [activePanel])

  const others = ORDER.filter((id) => id !== activePanel)
  const gridArea = {
    [activePanel]: 'main',
    [others[0]]: 'card1',
    [others[1]]: 'card2',
  }

  return (
    <ThemeProvider>
      <AgentSocketProvider>
      <PanelBridgeProvider>
      <DialogProvider>
        <div id="app" style={{ position: 'relative', width: '100vw', overflow: 'hidden' }}>
          <HexBackground />
          <div className="shell">
            <Header activePanel={activePanel} setActivePanel={setActivePanel} />
            <div
              ref={mainRowRef}
              className="main-row"
              style={{
                '--secondary-width': `${secondaryWidth}px`,
                '--card1-height': card1Height == null ? '1fr' : `${card1Height}px`,
              }}
            >
              <ChatPanel
                variant={activePanel === 'chat' ? 'full' : 'card'}
                gridArea={gridArea.chat}
                onActivate={() => setActivePanel('chat')}
              />
              <FilesPanel
                variant={activePanel === 'files' ? 'full' : 'card'}
                gridArea={gridArea.files}
                onActivate={() => setActivePanel('files')}
              />
              <TerminalPanel
                variant={activePanel === 'terminal' ? 'full' : 'card'}
                gridArea={gridArea.terminal}
                onActivate={() => setActivePanel('terminal')}
              />
              <ResizeHandle
                orientation="horizontal"
                gridArea="handle"
                value={secondaryWidth}
                onChange={setSecondaryWidth}
                min={160}
                max={window.innerWidth - 400}
              />
              <ResizeHandle
                orientation="vertical"
                gridArea="handle2"
                value={card1Height ?? (mainRowRef.current ? mainRowRef.current.clientHeight / 2 : 200)}
                onChange={setCard1Height}
                min={100}
                max={window.innerHeight - 220}
              />
            </div>
          </div>
        </div>
      </DialogProvider>
      </PanelBridgeProvider>
      </AgentSocketProvider>
    </ThemeProvider>
  )
}
