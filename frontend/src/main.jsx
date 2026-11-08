import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
// infobulles (data-tip), coupe tracée sur Firefox et WebKit (epiphany côté Linux), <declic-loader>
import '@declic/ui/comportements'
import './declic.css'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
