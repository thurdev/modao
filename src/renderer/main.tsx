import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/app.css'

// The renderer-only dev server has no preload, so the mock bridge is installed
// before the app is imported. In the packaged app window.modao already
// exists and installDevBridge() is never bundled.
if (import.meta.env.DEV) {
  const { installDevBridge } = await import('./devBridge')
  installDevBridge()
}

const { App } = await import('./App')
const { I18nProvider } = await import('./lib/i18n')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
)
