// Root. Gates on auth status: a loading splash, the auth screen for anon, or the
// game dashboard once authenticated. State lives in GameProvider.

import './styles.css';
import { GameProvider, useGame } from './useGame.js';
import { Auth } from './components/Auth.js';
import { Dashboard } from './components/Dashboard.js';

function Root() {
  const { status } = useGame();
  if (status === 'loading') {
    return (
      <main className="auth">
        <div className="panel">
          <img className="sigil" src="/assets/sigil.svg" alt="" />
          <h1>Eishera</h1>
          <p className="muted">Loading…</p>
        </div>
      </main>
    );
  }
  return status === 'authed' ? <Dashboard /> : <Auth />;
}

export function App() {
  return (
    <GameProvider>
      <Root />
    </GameProvider>
  );
}
