import { useEffect, useRef, useState } from 'react';
import { useGame } from '../useGame.js';
import { fmt } from '../format.js';
import { ProfilePanel } from './ProfilePanel.js';
import { InventoryPanel } from './InventoryPanel.js';
import { LogPanel } from './LogPanel.js';
import { GatheringPanel } from './GatheringPanel.js';
import { ProductionPanel } from './ProductionPanel.js';
import { CombatPanel } from './CombatPanel.js';
import { HousingPanel } from './HousingPanel.js';
import { MarketPanel } from './MarketPanel.js';
import { BossPanel } from './BossPanel.js';
import { ChatPanel } from './ChatPanel.js';

// The center column is a set of tabs. The old single "Actions" surface is split
// per activity category (Gathering/Crafting/Alchemy/Combat); Profile (attributes
// /skills) and Inventory (holdings) sit alongside the world surfaces.
type Tab =
  | 'gathering'
  | 'crafting'
  | 'alchemy'
  | 'combat'
  | 'profile'
  | 'inventory'
  | 'housing'
  | 'market'
  | 'boss';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'gathering', label: 'Gathering', icon: '/assets/icons/pickaxe.svg' },
  { id: 'crafting', label: 'Crafting', icon: '/assets/icons/anvil.svg' },
  { id: 'alchemy', label: 'Alchemy', icon: '/assets/icons/flask.svg' },
  { id: 'combat', label: 'Combat', icon: '/assets/icons/sword.svg' },
  { id: 'profile', label: 'Profile', icon: '/assets/icons/character.svg' },
  { id: 'inventory', label: 'Inventory', icon: '/assets/icons/bag.svg' },
  { id: 'housing', label: 'Housing', icon: '/assets/icons/house.svg' },
  { id: 'market', label: 'Market', icon: '/assets/icons/market.svg' },
  { id: 'boss', label: 'World boss', icon: '/assets/icons/boss.svg' },
];

// Per-action countdown: a 100%→0% bar showing time remaining until the next
// action (SPEC §13 "ticking action counter"). It's anchored to real tick events
// (`tickAt`, set on each player:update), so the bar hits 0% exactly as the server
// processes the action and `actions_remaining` ticks down — then re-anchors to
// 100%. Purely visual smoothing; the count itself is server-authoritative.
function ActionTicker({
  active,
  tickSeconds,
  tickAt,
  remaining,
  max,
  onRefill,
}: {
  active: boolean;
  tickSeconds: number;
  tickAt: number | null;
  remaining: number;
  max: number;
  onRefill: () => void;
}) {
  const [pct, setPct] = useState(100);
  const anchor = useRef(performance.now());

  // Re-anchor to 100% when an activity starts...
  useEffect(() => {
    if (active) anchor.current = performance.now();
  }, [active]);
  // ...and on every processed action (the authoritative tick).
  useEffect(() => {
    if (tickAt !== null) anchor.current = tickAt;
  }, [tickAt]);

  // Drive at 60fps with requestAnimationFrame (not a CSS transition): the reset
  // to 100% must SNAP instantly, while the countdown stays smooth. A width
  // transition would animate the reset and make the bar appear to grow from 0.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const frame = () => {
      const elapsed = (performance.now() - anchor.current) / 1000;
      setPct(Math.max(0, 1 - elapsed / tickSeconds) * 100);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, tickSeconds]);

  return (
    <button
      type="button"
      className="bar ticker"
      onClick={onRefill}
      title="Click to refill actions"
      aria-label={`Actions ${remaining} of ${max}. Click to refill.`}
    >
      <span style={{ width: `${active ? pct : 0}%` }} />
      <div className="bar-label">
        ⚡ {fmt(remaining)} / {fmt(max)}
      </div>
    </button>
  );
}

export function Dashboard() {
  const { me, catalog, connected, logout, tickAt, refill } = useGame();
  const [tab, setTab] = useState<Tab>('gathering');

  if (!me || !catalog) {
    return (
      <main className="auth">
        <div className="panel muted">Loading world…</div>
      </main>
    );
  }

  const active = me.active_recipe_id !== null || me.active_monster_id !== null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <img src="/assets/sigil.svg" alt="" />
          Eishera
        </span>
        <span className="who-name">{me.username}</span>
        <span className="stat">💰 {fmt(me.gold)}</span>
        <span className="stat">🎟 {fmt(me.tokens)}</span>
        <ActionTicker
          active={active}
          tickSeconds={catalog.tick_seconds}
          tickAt={tickAt}
          remaining={me.actions_remaining}
          max={me.max_actions}
          onRefill={() => void refill()}
        />
        <span style={{ marginLeft: 'auto' }} className="muted">
          <span className={`dot ${connected ? 'on' : 'off'}`} />
          {connected ? 'live' : 'offline'}
        </span>
        <button onClick={() => void logout()}>Log out</button>
      </header>

      <div className="columns">
        <div className="col-left">
          <nav className="tabs nav-vert">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? 'active' : ''}
                onClick={() => setTab(t.id)}
              >
                <img src={t.icon} alt="" />
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        <main className="col-mid">
          <div className="list">
            {tab === 'gathering' && <GatheringPanel />}
            {tab === 'crafting' && <ProductionPanel category="crafting" verb="Craft" />}
            {tab === 'alchemy' && <ProductionPanel category="alchemy" verb="Brew" />}
            {tab === 'combat' && <CombatPanel />}
            {tab === 'profile' && <ProfilePanel />}
            {tab === 'inventory' && <InventoryPanel />}
            {tab === 'housing' && <HousingPanel />}
            {tab === 'market' && <MarketPanel />}
            {tab === 'boss' && <BossPanel />}
          </div>
        </main>

        <LogPanel />
      </div>

      <div className="chatbar">
        <ChatPanel />
      </div>
    </div>
  );
}
