import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from './theme'
import LunarLanesKiosk from './LunarLanesKiosk'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <LunarLanesKiosk />
    </ThemeProvider>
  </React.StrictMode>
)
