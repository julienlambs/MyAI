import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icone } from '@declic/ui'

// Menu flottant de MyAI, dessiné avec les briques du menu d'actions de la charte (.dd-pop.am, .dd-opt, .grp, .sep).
// MenuActions de @declic/ui ne convient pas ici : ses lignes sont figées (icône + verbe), alors que MyAI affiche
// des listes chargées à l'ouverture (modèles, sessions, projets) avec une description sur deux lignes.
// Rendu dans document.body : les panneaux ont overflow:hidden, un menu ancré dedans se faisait couper à leur bord.
// anchorRef : le bouton qui ouvre le menu (le focus y revient sur Échap).
// width : nombre de px, ou 'panel' pour reprendre la largeur du panneau qui contient le bouton.
// point : { x, y } pour un menu contextuel (clic droit), à la place de anchorRef.
export function MenuPop({ anchorRef, point, open, onClose, width = 240, label, children }) {
  const popRef = useRef(null)
  const [pos, setPos] = useState(null)
  // onClose change à chaque rendu du parent (fonction en ligne) : sans cette ref, l'effet ci-dessous se relançait
  // à chaque jeton reçu pendant le streaming du chat et remettait le focus sur la première ligne.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    if (open && point) {
      const w = Math.min(width, window.innerWidth - 24)
      const left = Math.max(12, Math.min(point.x, window.innerWidth - w - 12))
      const up = point.y > window.innerHeight / 2
      setPos(up
        ? { left, width: w, top: 'auto', bottom: window.innerHeight - point.y, '--mh': `${Math.min(420, point.y - 24)}px` }
        : { left, width: w, top: point.y, '--mh': `${Math.min(420, window.innerHeight - point.y - 24)}px` })
      return
    }
    if (!open || !anchorRef?.current) { setPos(null); return }
    const a = anchorRef.current.getBoundingClientRect()
    const panel = width === 'panel' ? anchorRef.current.closest('.panel')?.getBoundingClientRect() : null
    const w = Math.min(panel ? panel.width : width, window.innerWidth - 24)
    let left = panel ? panel.left : a.right - w
    left = Math.max(12, Math.min(left, window.innerWidth - w - 12))
    // .dd-pop fixe top: 0 : vers le haut, il faut le remettre à auto pour que bottom compte.
    // Ouvre vers le haut quand le bouton est dans la moitié basse (zone du composeur), sinon il sortirait de l'écran.
    const up = a.top > window.innerHeight / 2
    setPos(up
      ? { left, width: w, top: 'auto', bottom: window.innerHeight - a.top + 6, '--mh': `${Math.min(420, a.top - 24)}px` }
      : { left, width: w, top: a.bottom + 6, '--mh': `${Math.min(420, window.innerHeight - a.bottom - 24)}px` })
  }, [open, width, anchorRef, point])

  useEffect(() => {
    if (!open) return
    const items = () => [...(popRef.current?.querySelectorAll('.dd-opt:not([aria-disabled="true"])') || [])]
    requestAnimationFrame(() => (popRef.current?.querySelector('.dd-opt[aria-checked="true"]') || items()[0])?.focus())
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || anchorRef?.current?.contains(e.target)) return
      closeRef.current()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); anchorRef?.current?.focus?.(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
      const list = items()
      if (!list.length) return
      e.preventDefault()
      const i = list.indexOf(document.activeElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1
        : e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length
      list[next].focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, anchorRef])

  if (!open || !pos) return null
  return createPortal(
    <div className="dd-pop am" style={pos} ref={popRef}>
      <div className="cs cut pan"><div className="in cut2">
        <ul className="dd-ul" role="menu" aria-label={label}>{children}</ul>
      </div></div>
    </div>,
    document.body,
  )
}

// checked : coche de la valeur courante (aria-checked) ; desc : seconde ligne en petit ; dan : action destructive (rose).
export function MenuItem({ icon, label, desc, checked, disabled, dan, onSelect }) {
  const choisir = () => { if (!disabled) onSelect?.() }
  return (
    <li
      className={`dd-opt cut${dan ? ' dan' : ''}`}
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked === undefined ? undefined : checked}
      aria-selected={checked || undefined}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onClick={choisir}
      onMouseEnter={(e) => e.currentTarget.focus()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choisir() } }}
    >
      <span className="in cut2">
        {icon && <Icone nom={icon} />}
        <span className="dd-tx">
          <span className="dd-l">{label}</span>
          {desc && <span className="dd-d">{desc}</span>}
        </span>
        {checked !== undefined && <i className="dd-ck" />}
      </span>
    </li>
  )
}

export const MenuGroupe = ({ children }) => <li className="grp" role="presentation">{children}</li>
export const MenuSep = () => <li className="sep" role="separator" />
