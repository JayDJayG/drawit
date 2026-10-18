import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Drawit could not find the root element.');
}

createRoot(root).render(<App />);
