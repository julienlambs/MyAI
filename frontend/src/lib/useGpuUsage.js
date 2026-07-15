import { useEffect, useState } from 'react'

export function useGpuUsage(intervalMs = 5000) {
  const [usage, setUsage] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch('/api/gpu')
        const data = await res.json()
        if (!cancelled) setUsage(data)
      } catch {
        if (!cancelled) setUsage(null)
      }
    }

    poll()
    const id = setInterval(poll, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [intervalMs])

  return usage
}
