import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { api } from './lib/api.ts';
import { useAsync, useLiveIndex, useRoute } from './lib/hooks.ts';
import { relativeTime } from './lib/format.ts';
import { Money } from './components/ui.tsx';
import { Fleet } from './views/Fleet.tsx';
import { Sessions } from './views/Sessions.tsx';
import { SessionDetail } from './views/SessionDetail.tsx';
import { Config } from './views/Config.tsx';
import { Analytics } from './views/Analytics.tsx';
import { Doctor } from './views/Doctor.tsx';
import { Hq, orgWorking, urgentCount } from './views/Hq.tsx';

interface NavItem {
  view: string;
  href: string;
  label: string;
}

/** Session usage across every project, in or out of the org. Secondary to HQ. */
const USAGE_NAV: NavItem[] = [
  { view: 'fleet', href: '#/fleet', label: 'Fleet' },
  { view: 'sessions', href: '#/sessions', label: 'Sessions' },
  { view: 'analytics', href: '#/analytics', label: 'Analytics' },
  { view: 'config', href: '#/config', label: 'Config' },
  { view: 'doctor', href: '#/doctor', label: 'Doctor' },
];

const KNOWN_VIEWS = new Set(['hq', 'session', ...USAGE_NAV.map((item) => item.view)]);

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem('pebble.theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Private window or blocked storage. The system default is a fine answer.
  }
  return 'system';
}

export function App(): ReactNode {
  const route = useRoute();
  const [reloadToken, setReloadToken] = useState(0);
  const [lastIndexAt, setLastIndexAt] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(readTheme);

  // One live subscription for the whole app: a server index pass bumps a token
  // that every view depends on, so there is no per-view polling.
  const stream = useLiveIndex(
    useCallback((event: { type: string }) => {
      setReloadToken((token) => token + 1);
      if (event.type === 'index') setLastIndexAt(new Date().toISOString());
    }, []),
  );

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem('pebble.theme', theme);
    } catch {
      // Not being able to remember the theme is not worth surfacing.
    }
  }, [theme]);

  const counts = useAsync(() => api.overview(), [reloadToken]);
  const hq = useAsync(() => api.hq(), [reloadToken]);
  const live = counts.data?.live ?? [];
  const working = live.filter((session) => session.status === 'active').length;
  const orgActive = orgWorking(hq.data);
  // The badge counts what the HQ "Needs you" list counts. If the server cannot
  // answer /api/hq at all, fall back to sessions waiting or errored, so a
  // blocked agent is never silently dropped from the rail.
  const hqAvailable = hq.data !== null;
  const needsYou = hqAvailable
    ? urgentCount(hq.data)
    : live.filter((session) => session.status === 'waiting' || session.errorCount > 0).length;
  const needsYouHref = hqAvailable ? '#/hq' : '#/sessions';
  const brandLine = hq.data?.org?.name ?? 'holding company';
  const view = KNOWN_VIEWS.has(route.view) ? route.view : 'hq';

  const navCount = (item: string): string | undefined => {
    if (item === 'hq' && orgActive > 0) return `${orgActive} live`;
    if (item === 'fleet' && working > 0) return `${working} live`;
    if (item === 'sessions' && counts.data) return String(counts.data.stats.sessions);
    return undefined;
  };

  const connected = stream !== null;

  return (
    <div className="shell">
      <nav className="rail">
        <div className="brand">
          <span className="brand__mark">Pebble</span>
          <span className="faint micro" title={brandLine}>
            {brandLine}
          </span>
        </div>

        <div className="nav">
          <a className="nav__link nav__link--primary" href="#/hq" aria-current={view === 'hq' ? 'page' : undefined}>
            <span>HQ</span>
            <span className="nav__count">{navCount('hq')}</span>
          </a>
          {needsYou > 0 && (
            <a className="badge badge--warn rail__alert" href={needsYouHref}>
              {needsYou} need{needsYou === 1 ? 's' : ''} you
            </a>
          )}
        </div>

        <div className="rail__group" role="group" aria-labelledby="rail-usage">
          <span id="rail-usage" className="rail__label micro">
            Usage
          </span>
          <div className="nav">
            {USAGE_NAV.map((item) => (
              <a
                key={item.view}
                className="nav__link"
                href={item.href}
                aria-current={view === item.view || (item.view === 'sessions' && view === 'session') ? 'page' : undefined}
              >
                <span>{item.label}</span>
                <span className="nav__count">{navCount(item.view)}</span>
              </a>
            ))}
          </div>

          <div className="rail__foot">
            <span className={`badge ${connected ? 'badge--live' : ''}`} title={connected ? 'Receiving live updates' : 'Not connected to the event stream'}>
              {connected ? 'live' : 'offline'}
            </span>
            {lastIndexAt && <span className="faint micro">indexed {relativeTime(lastIndexAt)}</span>}
            {counts.data && (
              <span className="faint micro">
                <Money usd={counts.data.stats.costUsd} approximate={counts.data.stats.approximateSessions > 0} /> all time
              </span>
            )}
            <div className="pills" role="group" aria-label="theme">
              {(['system', 'light', 'dark'] as Theme[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="pill"
                  aria-pressed={theme === option}
                  onClick={() => setTheme(option)}
                >
                  {option}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void api.reindex(true).then(() => setReloadToken((token) => token + 1));
              }}
              title="Re-read every transcript, ignoring the freshness check"
            >
              rebuild index
            </button>
          </div>
        </div>
      </nav>

      <main className="main">
        <Routed route={route} reloadToken={reloadToken} />
      </main>
    </div>
  );
}

function Routed(props: { route: ReturnType<typeof useRoute>; reloadToken: number }): ReactNode {
  const { route, reloadToken } = props;
  switch (route.view) {
    case 'sessions':
      return <Sessions route={route} reloadToken={reloadToken} />;
    case 'session':
      return route.params.adapter && route.params.id ? (
        <SessionDetail adapter={route.params.adapter} id={route.params.id} reloadToken={reloadToken} />
      ) : (
        <Sessions route={route} reloadToken={reloadToken} />
      );
    case 'config':
      return <Config reloadToken={reloadToken} />;
    case 'analytics':
      return <Analytics reloadToken={reloadToken} />;
    case 'doctor':
      return <Doctor reloadToken={reloadToken} />;
    case 'fleet':
      return <Fleet reloadToken={reloadToken} />;
    default:
      // '#/', '#/hq', an empty hash and anything unrecognised all land on HQ.
      return <Hq reloadToken={reloadToken} />;
  }
}
