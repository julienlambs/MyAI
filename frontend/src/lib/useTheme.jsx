import { createContext, useContext, useEffect, useState } from 'react'

// Valeurs reprises telles quelles de Projets/design-system/themes.js.
export const THEMES = {
  'leeroy-dark': {
    mode: 'dark',
    vars: {
      '--bg': '#0D0D14',
      '--card': '#13131F',
      '--card-2': '#171725',
      '--accent': '#6050DC',
      '--accent-soft': 'rgba(96,80,220,0.14)',
      '--accent-rgb': '96,80,220',
      '--text': '#FFFFFF',
      '--muted': '#8888AA',
      '--border': '#1E1E30',
      '--border-hi': '#2A2A42',
      '--hi': '#FF7A6B',
      '--md': '#E0B96B',
      '--lo': '#6BCB9C',
      '--header-bg': 'rgba(13,13,20,0.92)',
    },
  },
  'leeroy-light': {
    mode: 'light',
    vars: {
      '--bg': '#F5F5F0',
      '--card': '#EEEEE8',
      '--card-2': '#E4E4DC',
      '--accent': '#4A3CC8',
      '--accent-soft': 'rgba(74,60,200,0.10)',
      '--accent-rgb': '74,60,200',
      '--text': '#1A1A18',
      '--muted': '#70708A',
      '--border': 'rgba(0,0,0,0.09)',
      '--border-hi': 'rgba(0,0,0,0.14)',
      '--hi': '#C0392B',
      '--md': '#A0720A',
      '--lo': '#2D8A5A',
      '--header-bg': 'rgba(245,245,240,0.92)',
    },
  },
}

function resolveThemeKey(mode) {
  return mode === 'dark' ? 'leeroy-dark' : 'leeroy-light'
}

function applyTheme(theme) {
  const root = document.documentElement
  Object.entries(theme.vars).forEach(([k, v]) => root.style.setProperty(k, v))
  // Sans ça, le mode "assombrissement forcé" de Chrome Android peut réinterpréter
  // certains éléments (popups en position absolue notamment) avec ses propres
  // heuristiques au lieu de respecter notre thème custom — vu sur le sélecteur
  // de projet qui restait clair alors que le reste de l'app était en dark.
  root.style.colorScheme = theme.mode
}

const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => localStorage.getItem('myai_theme_mode') || 'dark')

  useEffect(() => {
    applyTheme(THEMES[resolveThemeKey(mode)])
    localStorage.setItem('myai_theme_mode', mode)
  }, [mode])

  const toggle = () => setMode((m) => (m === 'dark' ? 'light' : 'dark'))

  return <ThemeContext.Provider value={{ mode, toggle }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme doit être utilisé sous <ThemeProvider>')
  return ctx
}
