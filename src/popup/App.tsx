import { useEffect, useMemo, useState } from "react";
import {
  computeStats,
  getInvitations,
  getSettings,
  pruneExpired,
  saveSettings,
  type UsageStats,
} from "../utils/storage";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type Invitation,
  type Settings,
} from "../utils/types";

const LIMIT_PRESETS = [100, 150, 200, 250];

function useTracker() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      const [inv, s] = await Promise.all([pruneExpired(), getSettings()]);
      if (!active) return;
      setInvitations(inv);
      setSettings(s);
      setLoading(false);
    }
    void load();

    // React to writes from the background worker while the popup is open.
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEYS.invitations]) {
        void getInvitations().then((list) => active && setInvitations(list));
      }
      if (changes[STORAGE_KEYS.settings]) {
        void getSettings().then((s) => active && setSettings(s));
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const update = async (patch: Partial<Settings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
  };

  return { invitations, settings, loading, update };
}

function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < day) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

function formatFrees(ts: number): string {
  const diff = ts - Date.now();
  const day = 24 * 60 * 60 * 1000;
  const hours = Math.max(0, Math.round(diff / (60 * 60_000)));
  if (hours < 1) return "< 1h";
  if (hours < 24) return `${hours}h`;
  const days = Math.round(diff / day);
  return `${days}d`;
}

function statusColor(stats: UsageStats): string {
  if (stats.usableRemaining <= 0) return "#c0392b"; // out / into reserve
  if (stats.usedFraction >= 0.85) return "#e67e22"; // warning
  if (stats.usedFraction >= 0.6) return "#f1c40f";
  return "#2ecc71";
}

export default function App() {
  const { invitations, settings, loading, update } = useTracker();
  const stats = useMemo(
    () => computeStats(invitations, settings),
    [invitations, settings],
  );

  if (loading) {
    return <div className="app loading">Loading…</div>;
  }

  const color = statusColor(stats);
  const maxDay = Math.max(1, ...stats.dailyHistory.map((d) => d.count));
  const recent = [...invitations]
    .sort((a, b) => b.sentAt - a.sentAt)
    .slice(0, 8);

  return (
    <div className="app">
      <header>
        <h1>Invite Tracker</h1>
        <span className="window-label">rolling 7 days</span>
      </header>

      {settings.detectedLimit != null && (
        <div className="detected-note">
          LinkedIn enforced a limit near <b>{settings.detectedLimit}</b>. Using
          it for estimates.
        </div>
      )}

      {stats.usableRemaining <= 0 && (
        <div className="warning">
          {stats.remaining <= 0
            ? "You've reached your configured limit."
            : `Only your ${settings.reserved} reserved invites remain.`}
        </div>
      )}

      <section className="gauge">
        <div className="gauge-numbers">
          <span className="big" style={{ color }}>
            {stats.usableRemaining}
          </span>
          <span className="sub">usable left</span>
        </div>
        <div className="bar">
          <div
            className="bar-fill"
            style={{
              width: `${Math.round(stats.usedFraction * 100)}%`,
              background: color,
            }}
          />
        </div>
        <div className="gauge-legend">
          <span>{stats.sentInWindow} sent</span>
          <span>limit {stats.effectiveLimit}</span>
        </div>
      </section>

      <section className="tiles">
        <div className="tile">
          <span className="tile-num">{stats.todayCount}</span>
          <span className="tile-label">today</span>
        </div>
        <div className="tile">
          <span className="tile-num">{stats.sentInWindow}</span>
          <span className="tile-label">this week</span>
        </div>
        <div className="tile">
          <span className="tile-num">{stats.remaining}</span>
          <span className="tile-label">remaining</span>
        </div>
      </section>

      <section>
        <h2>Last 7 days</h2>
        <div className="history">
          {stats.dailyHistory.map((d) => {
            const label = new Date(d.date).toLocaleDateString(undefined, {
              weekday: "short",
            });
            return (
              <div
                className="hist-col"
                key={d.date}
                title={`${d.date}: ${d.count}`}
              >
                <div className="hist-bar-wrap">
                  <div
                    className="hist-bar"
                    style={{ height: `${(d.count / maxDay) * 100}%` }}
                  />
                </div>
                <span className="hist-count">{d.count}</span>
                <span className="hist-label">{label}</span>
              </div>
            );
          })}
        </div>
      </section>

      {stats.upcomingSlots.length > 0 && (
        <section>
          <h2>Slots freeing up</h2>
          <ul className="slots">
            {stats.upcomingSlots.slice(0, 3).map((s) => (
              <li key={s.invitation.id}>
                <span>+1 in {formatFrees(s.freesAt)}</span>
                <span className="muted">{s.invitation.name ?? "unknown"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Recent invitations</h2>
        {recent.length === 0 ? (
          <p className="muted empty">
            No invitations tracked yet. Send a connection request on LinkedIn
            and it'll show up here.
          </p>
        ) : (
          <ul className="recent">
            {recent.map((inv) => (
              <li key={inv.id}>
                <span className="recent-name">
                  {inv.profileUrl ? (
                    <a href={inv.profileUrl} target="_blank" rel="noreferrer">
                      {inv.name ?? "Unknown"}
                    </a>
                  ) : (
                    (inv.name ?? "Unknown")
                  )}
                </span>
                <span className="muted">{formatWhen(inv.sentAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings">
        <h2>Settings</h2>
        <label>
          Weekly limit
          <select
            value={settings.weeklyLimit}
            onChange={(e) =>
              void update({ weeklyLimit: Number(e.target.value) })
            }
          >
            {LIMIT_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            {!LIMIT_PRESETS.includes(settings.weeklyLimit) && (
              <option value={settings.weeklyLimit}>
                {settings.weeklyLimit}
              </option>
            )}
          </select>
        </label>
        <label>
          Reserved invites
          <input
            type="number"
            min={0}
            max={settings.weeklyLimit}
            value={settings.reserved}
            onChange={(e) =>
              void update({ reserved: Math.max(0, Number(e.target.value) || 0) })
            }
          />
        </label>
        {settings.detectedLimit != null && (
          <button
            className="reset-detected"
            onClick={() => void update({ detectedLimit: null })}
          >
            Clear detected limit
          </button>
        )}
      </section>
    </div>
  );
}
