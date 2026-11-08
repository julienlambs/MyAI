import { createContext, useContext, useLayoutEffect, useState } from 'react'

// Charte Le Déclic : les couleurs vivent dans declic.css (:root = sombre, [data-theme="light"] = clair),
// on ne fait que poser data-theme sur <html>. Même logique que design-system/themes.js, mais dans un
// contexte : le bouton de thème (Header) et le terminal (xterm) doivent partager le même état.
const KEY = 'myai_theme_mode'

function applyTheme(mode) {
  const root = document.documentElement
  root.dataset.theme = mode
  // Sans ça, l'assombrissement forcé de Chrome Android réinterprète certains popups à sa façon.
  root.style.colorScheme = mode
}

function readMode() {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark' } catch { return 'dark' }
}

const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(readMode)

  // Layout (pas useEffect) : data-theme doit être posé avant les effets des enfants, le terminal y lit ses couleurs.
  useLayoutEffect(() => {
    applyTheme(mode)
    try { localStorage.setItem(KEY, mode) } catch {}
  }, [mode])

  const toggle = () => setMode((m) => (m === 'dark' ? 'light' : 'dark'))

  return <ThemeContext.Provider value={{ mode, toggle }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme doit être utilisé sous <ThemeProvider>')
  return ctx
}
