import { useEffect, useRef, useState } from 'react';
import { useGame } from '../useGame.js';

// A client-only lane that collects /whisper DMs (not a server chat channel).
const WHISPER_LANE = 'whispers';

// [HH:MM:SS] from the message's ISO timestamp (server-sent, local-rendered).
function clock(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Anchor for the per-user popover: which name was clicked and where it sits.
type MenuState = { username: string; x: number; bottom: number };

export function ChatPanel() {
  // Usernames share one colour for now; titles & custom name colours will be a
  // token-unlocked perk (applied as a per-message override on top of this).
  const { me, catalog, chat, chatError, whispers, socialNotice, sendChat, wire, whisper } =
    useGame();
  const serverChannels = catalog?.chat.channels ?? [];
  const channels = [...serverChannels, WHISPER_LANE];
  const [channel, setChannel] = useState<string>(serverChannels[0] ?? 'global');
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Per-user popover (Profile / Wire / Whisper / Ignore) + the local ignore list.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Unread-whisper count: messages arrived since the lane was last viewed.
  const [seen, setSeen] = useState(0);
  const unread = Math.max(0, whispers.length - seen);

  const onWhisperLane = channel === WHISPER_LANE;
  const messages = (chat[channel] ?? []).filter((m) => !ignored.has(m.username));

  // Keep the active channel valid once the catalog loads.
  useEffect(() => {
    if (serverChannels.length > 0 && !channels.includes(channel)) setChannel(serverChannels[0]!);
  }, [serverChannels, channels, channel]);

  // Newest message sits at the top, so keep the log pinned to the top.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [messages.length, whispers.length]);

  // Viewing the whisper lane clears its unread badge.
  useEffect(() => {
    if (onWhisperLane) setSeen(whispers.length);
  }, [onWhisperLane, whispers.length]);

  // Dismiss the popover on outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>, username: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPending(null);
    setMenu({ username, x: r.left, bottom: window.innerHeight - r.top + 4 });
  };

  const ignore = () => {
    if (menu) setIgnored((prev) => new Set(prev).add(menu.username));
    setMenu(null);
  };

  // Drop a slash command targeting `user` into the entry line, ready to complete.
  const compose = (cmd: string, user: string) => {
    setDraft(`/${cmd} ${user} `);
    inputRef.current?.focus();
  };
  // Wire / Whisper from the per-user popover.
  const prefill = (cmd: string) => {
    if (menu) compose(cmd, menu.username);
    setMenu(null);
  };
  // Clicking a whisper composes a reply to the other party (whoever isn't you).
  const replyTo = (from: string, to: string) => compose('whisper', from === me?.username ? to : from);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setHint(null);
    const body = draft.trim();
    if (!body) return;
    const lower = body.toLowerCase();

    // Slash commands are routed off the public channel.
    if (lower.startsWith('/wire')) {
      const [, to, amount] = body.split(/\s+/);
      if (!to || !amount) {
        setHint('Usage: /wire <username> <amount>');
        return;
      }
      wire(to, Number(amount));
      setDraft('');
      return;
    }
    if (lower.startsWith('/whisper ') || lower.startsWith('/w ')) {
      const rest = body.slice(body.indexOf(' ') + 1).trim();
      const sep = rest.indexOf(' ');
      const to = sep === -1 ? rest : rest.slice(0, sep);
      const msg = sep === -1 ? '' : rest.slice(sep + 1).trim();
      if (!to || !msg) {
        setHint('Usage: /whisper <username> <message>');
        return;
      }
      whisper(to, msg);
      setDraft('');
      return;
    }
    if (onWhisperLane) {
      setHint('Whispers are private — use /whisper <username> <message>');
      return;
    }
    sendChat(channel, body);
    setDraft('');
  };

  const notice = hint ?? socialNotice?.text ?? null;
  const noticeBad = !hint && socialNotice?.kind === 'error';

  return (
    <section className="panel chat">
      <div className="chat-channels">
        {channels.map((c) => (
          <button
            key={c}
            className={`chat-chan ${c === channel ? 'active' : ''}`}
            onClick={() => setChannel(c)}
          >
            {c === WHISPER_LANE ? 'whispers' : c}
            {c === WHISPER_LANE && unread > 0 && <span className="chan-badge">{unread}</span>}
          </button>
        ))}
      </div>

      <div className="chat-main">
        <div className="chat-log" ref={logRef}>
          {onWhisperLane ? (
            whispers.length === 0 ? (
              <div className="chat-empty">— no whispers yet —</div>
            ) : (
              whispers
                .slice()
                .reverse()
                .map((w) => (
                  <div key={w.id} className="chat-line">
                    <span className="ts">{clock(w.created_at)}</span>
                    <button
                      type="button"
                      className="who whisper-pair"
                      title={`Reply to ${w.from === me?.username ? w.to : w.from}`}
                      onClick={() => replyTo(w.from, w.to)}
                    >
                      {w.from} » {w.to}
                    </button>
                    <span className="msg">{w.body}</span>
                  </div>
                ))
            )
          ) : messages.length === 0 ? (
            <div className="chat-empty">— no messages in {channel} yet —</div>
          ) : (
            // Render newest-first (the stored list is oldest-first).
            messages
              .slice()
              .reverse()
              .map((m) => (
                <div key={m.id} className="chat-line">
                  <span className="ts">{clock(m.created_at)}</span>
                  <button type="button" className="who" onClick={(e) => openMenu(e, m.username)}>
                    {m.username}
                  </button>
                  <span className="msg">{m.body}</span>
                </div>
              ))
          )}
        </div>

        {notice && <div className={`chat-notice ${noticeBad ? 'bad' : ''}`}>{notice}</div>}

        <form className="chat-entry" onSubmit={submit}>
          <span className="chat-prompt">{onWhisperLane ? 'whisper' : channel}</span>
          <input
            ref={inputRef}
            placeholder={
              chatError === 'rate_limited'
                ? 'slow down…'
                : onWhisperLane
                  ? '/whisper <user> <message>'
                  : 'type a message'
            }
            value={draft}
            maxLength={catalog?.chat.max_length ?? 500}
            onChange={(e) => setDraft(e.target.value)}
            className={chatError ? 'rate-limited' : ''}
          />
          <button className="primary" type="submit">
            Send
          </button>
        </form>
      </div>

      {menu && (
        <div className="user-menu" ref={menuRef} style={{ left: menu.x, bottom: menu.bottom }}>
          <div className="user-menu-name">{menu.username}</div>
          <button type="button" onClick={() => setPending('Profile')}>
            Profile
          </button>
          <button type="button" onClick={() => prefill('wire')}>
            Wire
          </button>
          <button type="button" onClick={() => prefill('whisper')}>
            Whisper
          </button>
          <button type="button" onClick={ignore}>
            Ignore
          </button>
          {pending && <div className="user-menu-note">{pending} — coming soon</div>}
        </div>
      )}
    </section>
  );
}
