import { useEffect, useState } from 'react'

export function formatTokens(n) {
  if (n == null) return '—'
  if (n < 1000) return String(n)
  return `${Math.round(n / 1000)}k`
}

// resetKey (passer le cwd courant) : sans ça, changer de dossier/session
// (bouton projet, "Nouvelle session", reprise d'une session passée) laissait
// affichée la valeur de l'ancienne conversation jusqu'au prochain sondage —
// jusqu'à 4s de décalage, potentiellement une valeur encore fausse si la
// nouvelle session n'a pas encore eu d'activité modèle. Un changement de
// resetKey remet à zéro immédiatement et resonde tout de suite.
export function useContextUsage(intervalMs = 4000, resetKey) {
  const [usage, setUsage] = useState(null)

  useEffect(() => {
    setUsage(null)
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch('/api/context')
        const data = await res.json()
        if (!cancelled) setUsage(data)
      } catch {
        if (!cancelled) setUsage(null)
      }
    }

    poll()
    const id = setInterval(poll, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [intervalMs, resetKey])

  return usage
}
