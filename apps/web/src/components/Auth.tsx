// Login / register. Tokens are set as httpOnly cookies by the server — nothing
// is stored client-side (SPEC §13).

import { useState } from 'react';
import { useGame } from '../useGame.js';
import { ApiError } from '../api.js';

export function Auth() {
  const { login, register } = useGame();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(username, password);
      else await register(username, password);
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string })?.error : null;
      setError(code ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <form className="panel" onSubmit={submit}>
        <img className="sigil" src="/assets/sigil.svg" alt="" />
        <h1>Eishera</h1>
        <p className="muted">{mode === 'login' ? 'Sign in' : 'Create an account'}</p>
        <input
          placeholder="username (3–32 chars)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <input
          type="password"
          placeholder="password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />
        {error && <p className="bad">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'Sign in' : 'Register'}
        </button>
        <p className="muted" style={{ marginTop: '0.8rem' }}>
          {mode === 'login' ? 'No account?' : 'Have an account?'}{' '}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode(mode === 'login' ? 'register' : 'login');
            }}
          >
            {mode === 'login' ? 'Register' : 'Sign in'}
          </button>
        </p>
      </form>
    </main>
  );
}
