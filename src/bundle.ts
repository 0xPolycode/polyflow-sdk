import { attach, initializeWsProxy } from './core/middleware/provider';

window.addEventListener('DOMContentLoaded', () => {
  initializeWsProxy();
});

window.addEventListener('load', () => {
  attach('{{API_KEY}}');
});
