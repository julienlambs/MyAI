import { useEffect, useRef } from 'react'

// Fond hexagonal avec glow de proximité — voir Projets/design-system/patterns.md section 16.
// Point de glow fixe (pas ancré à un élément) : reproduit design_handoff_myai_interface/reference.
export default function HexBackground() {
  const svgRef = useRef(null)

  useEffect(() => {
    const svg = svgRef.current
    const parent = svg?.parentElement
    if (!svg || !parent) return

    const r = 38
    const w = r * Math.sqrt(3)
    const vStep = r * 1.5
    const ns = 'http://www.w3.org/2000/svg'
    const accentRgb = '96,80,220'

    function hexPts(cx, cy) {
      const pts = []
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6
        pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1))
      }
      return pts.join(' ')
    }

    function build() {
      const W = parent.clientWidth
      const H = parent.clientHeight
      svg.innerHTML = `<defs><filter id="hglow" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter></defs>`

      const glowX = W * 0.72, glowY = H * 0.42, glowRadius = W * 0.55
      const cols = Math.ceil(W / w) + 2, rows = Math.ceil(H / vStep) + 2

      for (let row = -1; row < rows; row++) {
        for (let col = -1; col < cols; col++) {
          const cx = col * w + (row % 2 === 1 ? w / 2 : 0)
          const cy = row * vStep
          const dist = Math.sqrt((cx - glowX) ** 2 + (cy - glowY) ** 2)
          const prox = Math.max(0, 1 - dist / glowRadius)
          if (prox === 0) continue
          const p = document.createElementNS(ns, 'polygon')
          p.setAttribute('points', hexPts(cx, cy))
          if (prox > 0.55 && Math.random() < prox * 0.18) {
            p.setAttribute('fill', `rgba(${accentRgb}, ${(prox * 0.07).toFixed(2)})`)
            p.setAttribute('stroke', `rgba(${accentRgb}, ${(prox * 0.35).toFixed(2)})`)
            p.setAttribute('stroke-width', '0.9')
            p.setAttribute('filter', 'url(#hglow)')
          } else {
            p.setAttribute('fill', 'none')
            p.setAttribute('stroke', `rgba(${accentRgb}, ${(prox * 0.14).toFixed(2)})`)
            p.setAttribute('stroke-width', '0.4')
          }
          svg.appendChild(p)
        }
      }
    }

    build()
    let t
    const onResize = () => { clearTimeout(t); t = setTimeout(build, 250) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div id="hex-bg">
      <svg ref={svgRef} aria-hidden="true" />
    </div>
  )
}
