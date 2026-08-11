import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from './theme';
import App from './App';
import Display from './Display';
import Mechanic from './Mechanic';

const Root =
  window.location.pathname === '/display' ? Display :
  window.location.pathname === '/mechanic' ? Mechanic :
  App;

ReactDOM.createRoot(document.getElementById('root')).render(
  <ThemeProvider><Root /></ThemeProvider>
);
