import { useCallback, useEffect, useState } from 'react'

// applicationServerKey doit être un Uint8Array, pas la chaîne base64url brute.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

// serviceWorker/PushManager n'existent que dans un contexte sécurisé (HTTPS ou
// localhost) — indisponibles sur l'accès Tailscale brut en HTTP (voir
// architecture.md, c'est ce qui bloquait toute la Phase H avant `tailscale serve`).
export function usePushNotifications() {
  const [supported] = useState(() => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window)
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!supported) return
    navigator.serviceWorker.register('/sw.js')
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription()
      setSubscribed(Boolean(sub))
    })
  }, [supported])

  const subscribe = useCallback(async () => {
    if (!supported || busy) return
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return
      const reg = await navigator.serviceWorker.ready
      const { key } = await fetch('/api/push/vapid-public-key').then((r) => r.json())
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      })
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      })
      setSubscribed(true)
    } finally {
      setBusy(false)
    }
  }, [supported, busy])

  const unsubscribe = useCallback(async () => {
    if (!supported || busy) return
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        })
        await sub.unsubscribe()
      }
      setSubscribed(false)
    } finally {
      setBusy(false)
    }
  }, [supported, busy])

  return { supported, subscribed, busy, subscribe, unsubscribe }
}
