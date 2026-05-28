import React from 'react';
import { createRoot } from 'react-dom/client';

const App = () => (
  <main>
    <h1>ModuleWarden</h1>
    <p>UI scaffold available.</p>
  </main>
);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}

export default App;
