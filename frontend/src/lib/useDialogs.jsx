import { createContext, useCallback, useContext, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Btn, Field, useSurface } from '@declic/ui'

// Remplace window.confirm/alert/prompt (dialogues natifs du navigateur, moches
// et non stylables) par la fenêtre de la charte (.scrim + .modal).
// API volontairement calquée sur les originaux (await confirm(msg) au lieu de
// if (!window.confirm(msg))) pour que les call sites changent le minimum.
const DialogContext = createContext(null)

function Dialog({ dialog, close }) {
  const [inputValue, setInputValue] = useState(dialog.defaultValue || '')
  const firstRef = useRef(null)
  const titleId = useId()
  const cancel = () => close(dialog.type === 'prompt' ? null : false)
  // Échap, page derrière inerte, focus d'entrée (champ, ou action la moins risquée) et de retour
  useSurface(true, cancel, firstRef)

  function handleSubmit(e) {
    e.preventDefault()
    close(dialog.type === 'prompt' ? inputValue : true)
  }

  return createPortal(
    <>
      <div className="scrim open" onClick={cancel} />
      <div className="dialog-place">
        <form className="cs cut modal dialog-box" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={handleSubmit}>
          <div className="in cut2">
            <p className="dialog-message" id={titleId}>{dialog.message}</p>
            {dialog.type === 'prompt' && (
              <Field label="Nom" value={inputValue} onChange={(e) => setInputValue(e.target.value)} ref={firstRef} />
            )}
            <div className="dialog-actions">
              {dialog.type !== 'alert' && (
                <Btn type="button" kind="sec" onClick={cancel} ref={dialog.type === 'prompt' ? undefined : firstRef}>Annuler</Btn>
              )}
              <Btn type="submit" kind={dialog.danger ? 'dan' : 'pri'} ref={dialog.type === 'alert' ? firstRef : undefined}>
                {dialog.action || (dialog.type === 'alert' ? 'OK' : 'Continuer')}
              </Btn>
            </div>
          </div>
        </form>
      </div>
    </>,
    document.body,
  )
}

export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null)
  const resolveRef = useRef(null)

  // opts : { action: libellé du bouton de validation, danger: bouton rouge (suppression) }
  const open = useCallback((type, message, defaultValue = '', opts = {}) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setDialog({ type, message, defaultValue, ...opts, key: Date.now() })
    })
  }, [])

  const confirm = useCallback((message, opts) => open('confirm', message, '', opts), [open])
  const alert = useCallback((message) => open('alert', message), [open])
  const prompt = useCallback((message, defaultValue) => open('prompt', message, defaultValue), [open])

  function close(result) {
    resolveRef.current?.(result)
    resolveRef.current = null
    setDialog(null)
  }

  const value = { confirm, alert, prompt }

  return (
    <DialogContext.Provider value={value}>
      {children}
      {dialog && <Dialog key={dialog.key} dialog={dialog} close={close} />}
    </DialogContext.Provider>
  )
}

export function useDialogs() {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialogs doit être utilisé sous <DialogProvider>')
  return ctx
}
