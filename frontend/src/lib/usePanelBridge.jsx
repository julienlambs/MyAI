import { createContext, useCallback, useContext, useState } from 'react'

// Terminal et Chat ont chacun leur propre connexion, sans lien entre eux
// (voir architecture.md) — ce contexte est juste un mécanisme de transfert de
// texte ponctuel entre les deux panneaux, pas un couplage de leurs états.
const PanelBridgeContext = createContext(null)

export function PanelBridgeProvider({ children }) {
  const [toChat, setToChat] = useState(null)
  const [toTerminal, setToTerminal] = useState(null)

  const sendToChat = useCallback((text) => setToChat({ text, nonce: Date.now() }), [])
  const sendToTerminal = useCallback((text) => setToTerminal({ text, nonce: Date.now() }), [])

  const value = { toChat, sendToChat, toTerminal, sendToTerminal }
  return <PanelBridgeContext.Provider value={value}>{children}</PanelBridgeContext.Provider>
}

export function usePanelBridge() {
  const ctx = useContext(PanelBridgeContext)
  if (!ctx) throw new Error('usePanelBridge doit être utilisé sous <PanelBridgeProvider>')
  return ctx
}
