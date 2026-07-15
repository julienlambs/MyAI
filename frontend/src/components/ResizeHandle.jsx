import { useRef, useState } from 'react'

// Généralisé horizontal/vertical (au départ horizontal seul, pour la largeur
// principal/secondaire) — même logique, juste l'axe lu (clientX/clientY) et
// la classe CSS qui changent. Les bornes min/max sont laissées à l'appelant
// (App.jsx) plutôt qu'en dur ici : elles dépendent de la fenêtre/du contexte.
export default function ResizeHandle({ orientation = 'horizontal', value, onChange, min, max, gridArea }) {
  const [active, setActive] = useState(false)
  const dragState = useRef(null)
  const isHorizontal = orientation === 'horizontal'

  // Pointer Events (pas mousedown/mousemove) — unifie souris/tactile/stylet
  // en une seule API, plutôt que dupliquer la logique avec des touchstart/
  // touchmove séparés. touchAction:'none' est indispensable : sans lui, le
  // navigateur capte le geste pour scroller la page au lieu de nous laisser
  // les événements pointermove (raison pour laquelle ça ne répondait pas du
  // tout au doigt sur tablette).
  function handlePointerDown(e) {
    e.preventDefault()
    setActive(true)
    dragState.current = { start: isHorizontal ? e.clientX : e.clientY, startValue: value }
    e.currentTarget.setPointerCapture(e.pointerId)

    function onMove(ev) {
      const { start, startValue } = dragState.current
      const pos = isHorizontal ? ev.clientX : ev.clientY
      // Horizontal : la poignée est à droite du panneau principal, glisser
      // vers la gauche (pos diminue) doit agrandir la colonne secondaire —
      // d'où le delta inversé. Vertical : glisser vers le bas agrandit
      // naturellement la carte du haut, pas d'inversion nécessaire.
      const delta = isHorizontal ? start - pos : pos - start
      onChange(Math.max(min, Math.min(max, startValue + delta)))
    }
    function onUp() {
      setActive(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={`resize-handle ${isHorizontal ? 'resize-handle-h' : 'resize-handle-v'}${active ? ' active' : ''}`}
      style={{ gridArea, touchAction: 'none' }}
      onPointerDown={handlePointerDown}
    >
      <div className="grip" />
    </div>
  )
}
