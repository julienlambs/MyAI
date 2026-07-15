import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // hôtes servis via `tailscale serve` (HTTPS) — Vite bloque sinon (protection
  // anti DNS-rebinding). Valeurs réelles dans .env (non versionné), voir .env.example
  const allowedHosts = (env.VITE_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)

  return {
    plugins: [react()],
    server: {
      host: true, // écoute sur toutes les interfaces — nécessaire pour l'accès Tailscale
      port: 5180, // fixé pour ne pas dépendre de la disponibilité du 5173 par défaut (DAEMON le fixe aussi dessus)
      strictPort: true, // échoue plutôt que de glisser sur un autre port si 5180 est pris
      allowedHosts,
      proxy: {
        '/api': 'http://localhost:8000',
        '/ws': { target: 'ws://localhost:8000', ws: true },
      },
    },
  }
})
