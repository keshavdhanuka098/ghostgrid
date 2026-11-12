import { Component, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { markIntroSeen, useSettings } from '../state/SettingsContext';
import { useScenarios } from '../state/ScenarioContext';

/**
 * The startup splash. Progress is driven by three real milestones, not a fake timer:
 *   1. the graph engine and typefaces are ready,
 *   2. the Graph-Git repository answers (GET /api/health),
 *   3. the scenarios have loaded.
 * A minimum duration keeps the choreography readable, and a failsafe guarantees the splash can never trap the app.
 */
const MIN_MS = 3400;
const FAILSAFE_MS = 9000;
const CURTAIN_MS = 1250;
const WORD = 'GHOSTGRID'.split('');

const STAGES = ['Initialising the graph engine', 'Opening the Graph-Git repository', 'Loading your scenarios', 'Welcome'] as const;

const ROSETTE = Array.from({ length: 18 }, (_, i) => i * 10);

function Dial({ reduced }: { reduced: boolean }) {
  return (
    <svg className={`splash-dial-svg ${reduced ? 'is-static' : ''}`} viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="sp-gold" x1="20" y1="10" x2="180" y2="190" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F6E7BA" />
          <stop offset="0.5" stopColor="#CDA45D" />
          <stop offset="1" stopColor="#85652B" />
        </linearGradient>
        <linearGradient id="sp-face" x1="86" y1="86" x2="114" y2="114" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFF6D6" />
          <stop offset="1" stopColor="#B88B3F" />
        </linearGradient>
      </defs>

      <g className="sp-rosette">
        {ROSETTE.map((deg, i) => (
          <ellipse
            key={deg}
            cx="100"
            cy="100"
            rx="74"
            ry="27"
            transform={`rotate(${deg} 100 100)`}
            style={{ animationDelay: `${0.15 + i * 0.07}s` }}
          />
        ))}
      </g>

      <circle className="sp-bezel" cx="100" cy="100" r="92" pathLength={1} />
      <circle className="sp-ticks" cx="100" cy="100" r="85" />

      <g className="sp-spokes">
        <path d="M100 82V20" />
        <path d="M85 109L30 142" />
        <path d="M115 109L170 142" />
      </g>

      <path className="sp-g" d="M132.5 67.5A46 46 0 1 0 146 100H116" pathLength={1} />
      <g className="sp-gem">
        <path className="sp-gem-pulse" d="M100 84L116 100L100 116L84 100Z" />
        <path className="sp-gem-face" d="M100 84L116 100L100 116L84 100Z" />
        <path className="sp-gem-cut" d="M100 84V116M84 100H116" />
      </g>
    </svg>
  );
}

function Splash({ onDone }: { onDone: () => void }) {
  const { reducedMotion } = useSettings();
  const { status } = useScenarios();
  const [progress, setProgress] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [offline, setOffline] = useState(false);

  const skipRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const milestones = useRef({ engine: false, repo: false, scenarios: false });
  const finishRef = useRef<() => void>(() => {});

  // Milestone 3 follows the scenario provider; an unreachable server also counts as settled so the app can open.
  useEffect(() => {
    if (status !== 'loading') milestones.current.scenarios = true;
    if (status === 'error') setOffline(true);
  }, [status]);

  useEffect(() => {
    markIntroSeen();
    skipRef.current?.focus();
    const app = document.querySelector('.app-root');
    app?.setAttribute('inert', '');

    const started = performance.now();
    const timers: number[] = [];
    let raf = 0;
    let shown = 0;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      setProgress(100);
      setLeaving(true);
      timers.push(window.setTimeout(() => doneRef.current(), reducedMotion ? 0 : CURTAIN_MS));
    };
    finishRef.current = finish;

    // Milestone 1: typefaces decoded and the engine module graph already evaluated (we are running), capped at 1.2s.
    const fontsReady = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready ?? Promise.resolve();
    Promise.race([fontsReady, new Promise((r) => window.setTimeout(r, 1200))]).then(() => {
      milestones.current.engine = true;
    });
    // Milestone 2: the repository answers (any HTTP response means the API is up; a network error is treated as settled).
    const ctl = new AbortController();
    fetch('/api/health', { signal: ctl.signal })
      .catch(() => setOffline(true))
      .finally(() => {
        milestones.current.repo = true;
      });

    const minMs = reducedMotion ? 500 : MIN_MS;
    const tick = (now: number) => {
      const m = milestones.current;
      const goal = Math.min(((now - started) / minMs) * 100, (m.engine ? 34 : 0) + (m.repo ? 33 : 0) + (m.scenarios ? 33 : 0));
      shown = Math.min(goal, shown + Math.max(0.28, (goal - shown) * 0.09));
      const rounded = Math.round(shown);
      setProgress((p) => (p === rounded ? p : rounded));
      if (shown >= 99.4 && m.engine && m.repo && m.scenarios) return finish();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    timers.push(window.setTimeout(finish, FAILSAFE_MS));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      finished = true;
      ctl.abort();
      cancelAnimationFrame(raf);
      timers.forEach(window.clearTimeout);
      window.removeEventListener('keydown', onKey);
      app?.removeAttribute('inert');
    };
  }, [reducedMotion]);

  const stage = progress >= 100 ? 3 : progress >= 67 ? 2 : progress >= 34 ? 1 : 0;
  const label = offline && stage < 3 ? 'The server is not answering. Opening anyway' : STAGES[stage];
  const pct = useMemo(() => String(progress).padStart(3, '0'), [progress]);

  return (
    <div
      className={`splash ${leaving ? 'is-leaving' : ''} ${reducedMotion ? 'is-reduced' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Ghostgrid is loading"
    >
      <div className="splash-half splash-top" aria-hidden="true" />
      <div className="splash-half splash-bottom" aria-hidden="true" />
      <div className="splash-grain" aria-hidden="true" />

      <div className="splash-content">
        <div className="splash-dial">
          <Dial reduced={reducedMotion} />
        </div>

        <h1 className="splash-word" aria-hidden="true">
          {WORD.map((ch, i) => (
            <span key={i} style={{ '--i': i } as CSSProperties}>
              {ch}
            </span>
          ))}
        </h1>
        <p className="splash-tag">Infrastructure dependency explorer</p>

        <div className="splash-meter">
          <div className="splash-count" aria-hidden="true">
            <span className="splash-pct">{pct}</span>
            <span className="splash-unit">%</span>
          </div>
          <div className="splash-rail" aria-hidden="true">
            <i style={{ transform: `scaleX(${progress / 100})` }} />
          </div>
          <p className="splash-status" role="status" aria-live="polite" key={label}>
            {label}
          </p>
        </div>
      </div>

      <button ref={skipRef} type="button" className="splash-skip" onClick={() => finishRef.current()}>
        Skip <kbd>Esc</kbd>
      </button>
    </div>
  );
}

/** If the splash itself ever throws, drop it and release the app instead of leaving the screen blocked. */
class SplashBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function SplashGate() {
  const { introVisible, dismissIntro } = useSettings();
  const { pathname } = useLocation();
  if (!introVisible || pathname === '/') return null;
  return (
    <SplashBoundary onFail={dismissIntro}>
      <Splash onDone={dismissIntro} />
    </SplashBoundary>
  );
}
