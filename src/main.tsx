import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Pow } from './pow/Pow';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    {window.location.pathname.replace(/\/$/, '') === '/pow' ? <Pow /> : <App />}
  </StrictMode>,
);
