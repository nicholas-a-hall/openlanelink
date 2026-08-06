import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from './theme'
import OpenLaneSchedulerKiosk from './OpenLaneSchedulerKiosk'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <OpenLaneSchedulerKiosk />
    </ThemeProvider>
  </React.StrictMode>
)
