import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTheme } from '../lib/useTheme'
import { usePanelBridge } from '../lib/usePanelBridge'
import { Btn, IconBtn, Icone, Touche } from '@declic/ui'

// xterm.js a son propre système de couleurs, indépendant du CSS (pas de var() possible) : on lit les jetons de
// la charte sur <html> au moment d'appliquer le thème. La palette ANSI doit être complète, sinon PSReadLine
// (coloration syntaxique) retombe sur les couleurs par défaut de xterm, illisibles en thème clair.
// Correspondances : rouge/vert/jaune = sémantiques hi/lo/md ; bleu, magenta, cyan = couleurs de graphique g1, g7, g5.
function xtermTheme() {
  const css = getComputedStyle(document.documentElement)
  const v = (name) => css.getPropertyValue(name).trim()
  const light = document.documentElement.dataset.theme === 'light'
  const ansi = {
    black: light ? v('--text') : v('--borderHi'), red: v('--hi'), green: v('--lo'), yellow: v('--md'),
    blue: v('--g1'), magenta: v('--g7'), cyan: v('--g5'), white: light ? v('--muted') : v('--text'),
  }
  return {
    background: v('--card'), foreground: v('--text'), cursor: v('--acc'), cursorAccent: v('--card'),
    selectionBackground: v('--selBg'), selectionForeground: v('--text'),
    ...ansi,
    brightBlack: v('--muted'), brightRed: ansi.red, brightGreen: ansi.green, brightYellow: ansi.yellow,
    brightBlue: v('--acc'), brightMagenta: v('--g3'), brightCyan: ansi.cyan, brightWhite: v('--text'),
  }
}

const TERM_FONT = "'Declic Mono', ui-monospace, Consolas, monospace"

// Une instance = un pty backend + son propre xterm + sa propre connexion
// WebSocket. Toujours montée tant que son onglet existe (même si un autre
// onglet est affiché) — même philosophie que les 3 panneaux principaux
// (voir architecture.md, Bloc 4) : changer d'onglet ne doit pas perdre le
// scrollback. `instancesRef` expose getSelection() au parent (bouton "Envoyer
// au chat" vit dans la barre d'onglets partagée, pas dans l'instance).
function TerminalInstance({ id, isActive, mode, toTerminal, instancesRef }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const fitAddonRef = useRef(null)
  const [connected, setConnected] = useState(true)
  const toTerminalRef = useRef(null)
  const lastSentNonceRef = useRef(null)
  useEffect(() => { toTerminalRef.current = toTerminal }, [toTerminal])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontFamily: TERM_FONT,
      fontSize: 13,
      theme: xtermTheme(),
      cursorBlink: true,
    })
    termRef.current = term
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()
    instancesRef.current[id] = { getSelection: () => termRef.current?.getSelection() }
    // Déclic Mono n'est téléchargée qu'au premier usage : xterm mesurerait la largeur des caractères sur la police
    // de repli. Une fois chargée, changer fontFamily (aller-retour) l'oblige à remesurer, puis on recale la grille.
    if (!document.fonts.check("13px 'Declic Mono'")) {
      document.fonts.load("13px 'Declic Mono'").then(() => {
        if (termRef.current !== term) return
        term.options.fontFamily = 'monospace'
        term.options.fontFamily = TERM_FONT
        fitAddon.fit()
      }).catch(() => {})
    }

    let cancelled = false
    let retryTimer = null

    // La connexion WebSocket et la stabilisation de la mise en page (montage
    // du panneau) sont deux évènements async indépendants — envoyer un resize
    // depuis chacun séparément créait une course : si l'utilisateur tape avant
    // que les deux se soient produits, PowerShell redessine sa ligne pour une
    // largeur intermédiaire fausse, et cette première ligne reste corrompue
    // jusqu'au prochain prompt. Un seul envoi, une fois les deux acquis.
    let layoutSettled = false
    function sendInitialResizeIfReady() {
      const ws = wsRef.current
      if (!layoutSettled || !ws || ws.readyState !== WebSocket.OPEN) return
      fitAddon.fit()
      ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }))
    }

    const raf = requestAnimationFrame(() => {
      layoutSettled = true
      sendInitialResizeIfReady()
    })

    // Toujours relire wsRef.current (jamais fermer sur `ws` directement) —
    // sinon dataDisposable/handleResize continueraient d'écrire vers la
    // socket fermée après une reconnexion, la nouvelle ne recevant plus rien.
    function connect() {
      // Même origine que la page — voir le commentaire équivalent dans useAgentSocket.jsx
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/terminal/${id}`)
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        sendInitialResizeIfReady()
        const pending = toTerminalRef.current
        if (pending && pending.nonce !== lastSentNonceRef.current) {
          ws.send(JSON.stringify({ type: 'input', data: pending.text + '\r' }))
          lastSentNonceRef.current = pending.nonce
        }
      }
      ws.onclose = (e) => {
        setConnected(false)
        // 4404 = onglet fermé côté backend (ou backend redémarré) — le pty
        // n'existe plus, retenter en boucle ne servirait à rien.
        if (e.code === 4404) return
        // Même bug/correctif que useAgentSocket.jsx : sans ce retry, "connexion
        // perdue" restait vrai indéfiniment après un redémarrage backend.
        if (!cancelled) retryTimer = setTimeout(connect, 2000)
      }
      ws.onerror = () => setConnected(false)
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'data') term.write(msg.data)
      }
    }
    connect()

    const dataDisposable = term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })

    function handleResize() {
      fitAddon.fit()
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }))
      }
    }
    window.addEventListener('resize', handleResize)
    // Le clavier virtuel mobile réduit le viewport visible sans déclencher
    // fiablement 'resize' sur window — visualViewport le capte correctement,
    // sinon PowerShell continue de redessiner ses lignes pour l'ancienne
    // largeur et le texte se chevauche/se répète à chaque frappe.
    window.visualViewport?.addEventListener('resize', handleResize)
    // window.resize ne suffit plus maintenant que la taille du terminal peut
    // changer sans que la fenêtre bouge : permuter quel panneau/onglet est
    // actif, ou glisser une poignée de redimensionnement, change la taille de
    // CE conteneur précisément — sans ça on retombe dans la même corruption
    // d'affichage PowerShell que window.resize corrigeait déjà pour le cas fenêtre.
    const resizeObserver = new ResizeObserver(() => handleResize())
    resizeObserver.observe(containerRef.current)

    return () => {
      cancelled = true
      clearTimeout(retryTimer)
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
      resizeObserver.disconnect()
      dataDisposable.dispose()
      wsRef.current?.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
      delete instancesRef.current[id]
    }
  }, [])

  // Terminal déjà monté et thème changé en cours de route : on met à jour sans le recréer.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme()
  }, [mode])

  // Onglet resté en arrière-plan pendant qu'autre chose changeait sa taille
  // (fenêtre redimensionnée, poignée glissée pendant qu'un autre onglet était
  // affiché) — resynchroniser dès qu'il redevient visible, sinon PowerShell
  // continue de redessiner pour l'ancienne largeur au prochain affichage.
  useEffect(() => {
    if (!isActive || !fitAddonRef.current || !termRef.current) return
    fitAddonRef.current.fit()
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', rows: termRef.current.rows, cols: termRef.current.cols }))
    }
  }, [isActive])

  // Commande envoyée depuis le Chat (voir ChatPanel) — tapée comme si l'utilisateur
  // l'avait écrite, avec un retour chariot pour la lancer. Seul l'onglet actif
  // la reçoit (toTerminal vaut null pour les autres, voir TerminalPanel).
  useEffect(() => {
    if (toTerminal && toTerminal.nonce !== lastSentNonceRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: toTerminal.text + '\r' }))
      lastSentNonceRef.current = toTerminal.nonce
    }
  }, [toTerminal])

  return (
    <div style={{ display: isActive ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {!connected && (
        <div className="msg-system-wrap term-status">
          <span className="badge cut bg-md"><Icone nom="attention" /> Terminal déconnecté, reconnexion en cours…</span>
        </div>
      )}
      <div ref={containerRef} className="term-screen" />
    </div>
  )
}

// Terminal indépendant de l'agent — un ou plusieurs pty côté backend
// (pywinpty), un onglet par pty. Le backend est la source de vérité de la
// liste d'onglets (voir terminal_bridge.py:TerminalManager) : elle survit à
// un rechargement de page, comme le process shell lui-même.
export default function TerminalPanel({ variant, gridArea, onActivate }) {
  const { mode } = useTheme()
  const { toTerminal, sendToChat } = usePanelBridge()
  const [tabs, setTabs] = useState([])
  const [activeTabId, setActiveTabId] = useState(null)
  const instancesRef = useRef({})

  // Reprend les onglets déjà ouverts côté backend (refresh de page), ou en
  // crée un premier automatiquement — pas besoin de cliquer "+" pour avoir
  // un terminal, comme avant l'introduction des onglets.
  useEffect(() => {
    let cancelled = false
    fetch('/api/terminals')
      .then((r) => r.json())
      .then(async (existing) => {
        if (cancelled) return
        if (existing.length > 0) {
          setTabs(existing)
          setActiveTabId(existing[0].id)
          return
        }
        const created = await fetch('/api/terminals', { method: 'POST' }).then((r) => r.json())
        if (cancelled) return
        setTabs([created])
        setActiveTabId(created.id)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  async function handleNewTab() {
    const created = await fetch('/api/terminals', { method: 'POST' }).then((r) => r.json())
    setTabs((prev) => [...prev, created])
    setActiveTabId(created.id)
  }

  async function handleCloseTab(id, e) {
    e.stopPropagation()
    await fetch(`/api/terminals/${id}`, { method: 'DELETE' }).catch(() => {})
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeTabId === id) setActiveTabId(next.length > 0 ? next[next.length - 1].id : null)
      return next
    })
  }

  function handleSendSelectionToChat() {
    const selection = instancesRef.current[activeTabId]?.getSelection()
    if (selection) sendToChat(selection)
  }

  return (
    <div className="panel is-main coupe" style={{ gridArea }} data-slot={gridArea}>
      <div className="panel-full">
        <div className="term-tabbar">
          <div className="term-tabs-wrap">
            <div className="term-tabs" role="tablist" aria-label="Terminaux">
              {tabs.map((tab) => (
                <div key={tab.id} className={`term-tab cut${tab.id === activeTabId ? ' active' : ''}`}>
                  <button type="button" role="tab" aria-selected={tab.id === activeTabId} className="term-tab-btn"
                    onClick={() => setActiveTabId(tab.id)}>
                    <Icone nom="terminal" />{tab.name}
                  </button>
                  {tabs.length > 1 && (
                    <IconBtn kind="ghost" label={`Fermer ${tab.name}`} icon={<Icone nom="fermer" />}
                      onClick={(e) => handleCloseTab(tab.id, e)} />
                  )}
                </div>
              ))}
            </div>
            <IconBtn kind="ghost" label="Nouveau terminal" icon={<Icone nom="ajouter" />} onClick={handleNewTab} />
          </div>
          <div className="section-actions">
            {variant !== 'full' && (
              <IconBtn kind="ghost" label="Agrandir ce panneau" icon={<Icone nom="plein-ecran" />} onClick={onActivate} />
            )}
            <Btn kind="ghost" className="term-send" icon={<Icone nom="envoyer" />} onClick={handleSendSelectionToChat}
              aria-label="Envoyer au chat" data-tip="Envoyer le texte sélectionné dans le terminal au chat">
              <span className="term-send-label">Envoyer au chat</span>
            </Btn>
            <span className="kbd"><Touche>Ctrl 3</Touche></span>
          </div>
        </div>
        {tabs.map((tab) => (
          <TerminalInstance
            key={tab.id}
            id={tab.id}
            isActive={tab.id === activeTabId}
            mode={mode}
            toTerminal={tab.id === activeTabId ? toTerminal : null}
            instancesRef={instancesRef}
          />
        ))}
      </div>
    </div>
  )
}
