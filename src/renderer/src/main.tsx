import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './theme.css'
import App from './App'

// Surface renderer crashes to the smoke harness instead of losing them.
declare global {
  interface Window {
    __wardenUiErrors?: string[]
  }
}
window.addEventListener('error', (event) => {
  window.__wardenUiErrors = [...(window.__wardenUiErrors ?? []), String(event.message)]
})
window.addEventListener('unhandledrejection', (event) => {
  window.__wardenUiErrors = [...(window.__wardenUiErrors ?? []), String(event.reason)]
})

const container = document.getElementById('root')
if (!container) throw new Error('mount point missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
