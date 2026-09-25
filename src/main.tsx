import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Pow } from './pow/Pow';
import { developerRedirect } from './lib/powLinks';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

const redirect = developerRedirect(window.location.pathname, window.location.search);
if (redirect) {
  window.location.replace(redirect);
} else
  createRoot(root).render(
    <StrictMode>{/^\/pow(?:\/|$)/.test(window.location.pathname) ? <Pow /> : <App />}</StrictMode>,
  );
