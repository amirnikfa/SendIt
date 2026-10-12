import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class Boundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error)
      return (
        <div className="fatal">
          <h1>The workspace needs to reload</h1>
          <p>{this.state.error}</p>
          <p>Your saved data is preserved.</p>
          <button onClick={() => location.reload()}>Reload application</button>
        </div>
      );
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(
  <Boundary>
    <App />
  </Boundary>,
);
