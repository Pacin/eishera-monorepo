import { useEffect, useRef, useState } from 'react';
import { useGame } from '../useGame.js';

export function ChatPanel() {
  const { catalog, chat, chatError, sendChat } = useGame();
  const channels = catalog?.chat.channels ?? [];
  const [channel, setChannel] = useState<string>(channels[0] ?? 'global');
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const messages = chat[channel] ?? [];

  // Keep the active channel valid once the catalog loads.
  useEffect(() => {
    if (channels.length > 0 && !channels.includes(channel)) setChannel(channels[0]!);
  }, [channels, channel]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages.length]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    sendChat(channel, body);
    setDraft('');
  };

  return (
    <section className="panel">
      <h2>Chat</h2>
      <div className="tabs" style={{ padding: 0, marginBottom: 8 }}>
        {channels.map((c) => (
          <button key={c} className={c === channel ? 'active' : ''} onClick={() => setChannel(c)}>
            #{c}
          </button>
        ))}
      </div>
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 ? (
          <span className="muted">No messages yet.</span>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="chat-line">
              <span className="who">{m.username}</span>
              <span>{m.body}</span>
            </div>
          ))
        )}
      </div>
      {chatError && (
        <p className="bad" style={{ fontSize: 12 }}>
          {chatError === 'rate_limited' ? 'Slow down — you’re sending too fast.' : chatError}
        </p>
      )}
      <form className="row" onSubmit={submit} style={{ marginTop: 8 }}>
        <input
          style={{ flex: 1 }}
          placeholder={`Message #${channel}`}
          value={draft}
          maxLength={catalog?.chat.max_length ?? 500}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="primary" type="submit">
          Send
        </button>
      </form>
    </section>
  );
}
