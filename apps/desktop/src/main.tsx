import * as React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from './providers/AuthProvider';
import { UpdateProvider } from './providers/UpdateProvider';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html.');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <AuthProvider>
      <UpdateProvider>
        <App />
      </UpdateProvider>
    </AuthProvider>
  </React.StrictMode>,
);
