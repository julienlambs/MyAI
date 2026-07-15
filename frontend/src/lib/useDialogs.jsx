import { createContext, useCallback, useContext, useRef, useState } from 'react'

// Remplace window.confirm/alert/prompt (dialogues natifs du navigateur, moches
// et non stylables) par des équivalents cohérents avec le thème de l'app.
// API volontairement calquée sur les originaux (await confirm(msg) au lieu de
// if (!window.confirm(msg))) pour que les call sites changent le minimum.
const DialogContext = createContext(null)

export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null)
  const [inputValue, setInputValue] = useState('')
  const resolveRef = useRef(null)

  const open = useCallback((type, message, defaultValue = '') => {
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setInputValue(defaultValue)
      setDialog({ type, message })
    })
  }, [])

  const confirm = useCallback((message) => open('confirm', message), [open])
  const alert = useCallback((message) => open('alert', message), [open])
  const prompt = useCallback((message, defaultValue) => open('prompt', message, defaultValue), [open])

  function close(result) {
    resolveRef.current?.(result)
    resolveRef.current = null
    setDialog(null)
  }

  function handleSubmit(e) {
    e.preventDefault()
    close(dialog.type === 'prompt' ? inputValue : true)
  }

  const value = { confirm, alert, prompt }

  return (
    <DialogContext.Provider value={value}>
      {children}
      {dialog && (
        <div className="dialog-overlay" onClick={() => close(dialog.type === 'prompt' ? null : false)}>
          <form
            className="dialog-box"
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleSubmit}
            onKeyDown={(e) => { if (e.key === 'Escape') close(dialog.type === 'prompt' ? null : false) }}
          >
            <p className="dialog-message">{dialog.message}</p>
            {dialog.type === 'prompt' && (
              <input
                className="dialog-input"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                autoFocus
              />
            )}
            <div className="dialog-actions">
              {dialog.type !== 'alert' && (
                <button type="button" className="btn btn-reject" onClick={() => close(dialog.type === 'prompt' ? null : false)}>
                  Annuler
                </button>
              )}
              <button type="submit" className="btn btn-approve" autoFocus={dialog.type !== 'prompt'}>
                {dialog.type === 'alert' ? 'OK' : 'Continuer'}
              </button>
            </div>
          </form>
        </div>
      )}
    </DialogContext.Provider>
  )
}

export function useDialogs() {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialogs doit être utilisé sous <DialogProvider>')
  return ctx
}
