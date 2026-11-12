import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Cosmos from '../components/Cosmos';
import Globe from '../components/Globe';
import { Icon } from '../components/Icon';
import { Logo, LogoMark } from '../components/Logo';
import { StoryScene } from '../components/StoryScene';
import { Alert, Button, ButtonLink } from '../components/ui';
import { WORKFLOW } from '../nav';
import { describeError, useScenarios } from '../state/ScenarioContext';
import { useSettings } from '../state/SettingsContext';

/* ------------------------------------------------------------------ story chapters */

type Tone = 'ghost' | 'danger' | 'signal' | 'ok';
const CHAPTERS: readonly { k: string; h: string; t: string; hl: string[]; tone: Tone }[] = [
  { k: 'The problem', h: 'Every system has a shadow.', t: 'Hospitals, payments, power, networks. Each one is drawn, audited and trusted on its own.', hl: ['shadow'], tone: 'ghost' },
  { k: 'The blind spot', h: 'Your diagrams show what you drew.', t: 'Dispatch relies on a fibre ring. Payments rely on a cloud region. On paper, two separate worlds.', hl: ['drew'], tone: 'ghost' },
  { k: 'The ghost', h: 'Underneath, something is shared.', t: 'One colocation power feed quietly feeds both. It appears on neither diagram.', hl: ['shared'], tone: 'ghost' },
  { k: 'The cascade', h: 'One feed fails. Two systems fall.', t: 'Emergency dispatch and the payment gateway go dark together, and nobody saw it coming.', hl: ['fails', 'fall'], tone: 'danger' },
  { k: 'Ghostgrid maps it', h: 'See the hidden dependency.', t: 'Ghostgrid links every asset, surfaces shared dependencies and ranks what quietly holds everything up.', hl: ['hidden'], tone: 'signal' },
  { k: 'Ghostgrid simulates it', h: 'Watch the cascade, round by round.', t: 'Fail any asset or link. Get a plain reason for every service that goes down, and how certain it is.', hl: ['cascade'], tone: 'danger' },
  { k: 'Ghostgrid resolves it', h: 'Compare fixes before you spend.', t: 'Add redundancy on a branch, re-run the failure, and prove the decision with numbers.', hl: ['fixes'], tone: 'ok' },
];

/* ------------------------------------------------------------------ page */



const PILLARS = [
  {
    to: '/app/graph-git',
    title: 'Graph Git',
    text: 'Every scenario keeps a main branch. Branch the dependency graph, edit it, commit, compare and restore, then run the cascade on any commit without touching what you trust.',
  },
  {
    to: '/app/simulation',
    title: 'What-if failures',
    text: 'Fail assets or single links and watch the cascade round by round, with a plain reason for every service that goes down and how certain that is.',
  },
  {
    to: '/app/features',
    title: 'Graph features',
    text: 'Turn any graph into numbers: centrality, fan-in, depth, hidden-dependency exposure and cascade reach. Export them as JSON for your own models.',
  },
] as const;

export default function Landing() {
  const navigate = useNavigate();
  const { openSample } = useScenarios();
  const { reducedMotion, dismissIntro } = useSettings();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ch, setCh] = useState(0);
  const [glFailed, setGlFailed] = useState(false);
  const onGlFail = useCallback(() => setGlFailed(true), []);
  const chEls = useRef<(HTMLDivElement | null)[]>([]);
  const rail = useRef<HTMLSpanElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const progress = useRef(0);
  const story = useRef<HTMLElement>(null);
  const intro = useRef<HTMLElement>(null);
  const mood = useRef<(HTMLElement | null)[]>([]);
  const diagram = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = 'Ghostgrid · Infrastructure dependency explorer';
    dismissIntro(); // this page is the intro; skip the app splash
  }, [dismissIntro]);

  // Scroll engine. The scrollbar position is the target; ONE eased position (a critically-damped spring, so motion
  // accelerates in and settles softly, with no overshoot) drives everything: hero, chapters, rail, mood, diagram and
  // the globe all read from it, so they can never drift apart. Styles are written straight to the DOM, so scrolling
  // never triggers a React re-render.
  useEffect(() => {
    const N = CHAPTERS.length;
    const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);
    const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
    // frame-rate independent critically-damped smoothing (SmoothDamp): returns the new [value, velocity]
    const damp = (cur: number, to: number, vel: number, time: number, dt: number): [number, number] => {
      const om = 2 / time, x = om * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      const ch = cur - to, tmp = (vel + om * ch) * dt;
      return [to + (ch + tmp) * e, (vel - om * tmp) * e];
    };
    // touch scrolling already has native momentum, so it gets a tighter spring than a wheel or trackpad
    const time = window.matchMedia?.('(pointer: coarse)').matches ? 0.14 : 0.24;
    const born = performance.now();
    let raf = 0, last = born, ey = window.scrollY, vel = 0;
    // geometry is cached (re-measured on resize) so the per-frame loop never forces a layout
    let storyTop = 0, storyH = 0;
    const measure = () => { const el = story.current; if (el) { storyTop = el.offsetTop; storyH = el.offsetHeight; } };
    measure();
    // Pacing: each chapter is fully readable across a wide plateau (|d| < HOLD) and hands off to the next over the
    // short band [HOLD, 0.5]. Hand-offs are sequential (never two chapters visible at once), so the page never
    // rests on half-faded text and a chapter costs only ~one step of scrolling (--step in landing.css).
    const HOLD = 0.2;
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05); last = now;
      const y = window.scrollY, vh = window.innerHeight;
      // snap (don't glide) while the page is loading: the browser restores the previous scroll position a moment
      // after mount, and that must not read as a fast fly-through from the top
      if (reducedMotion || now - born < 700) { ey = y; vel = 0; } else [ey, vel] = damp(ey, y, vel, time, dt);
      const span = Math.max(storyH - vh, 1);
      const sm = 0.5 + clamp01((ey - storyTop) / span) * (N - 1);
      // the globe finishes sinking exactly when the story ends, however long the story is
      progress.current = Math.min(ey / Math.max(storyTop + span, 1), 1);
      for (let i = 0; i < N; i++) {
        const c = chEls.current[i]; if (!c) continue;
        const d = sm - (i + 0.5);
        const inn = smooth(-0.5, -HOLD, d), leave = smooth(HOLD, 0.5, d), o = inn * (1 - leave);
        c.style.opacity = o.toFixed(3);
        c.style.transform = `translate3d(0,${(-d * 44).toFixed(1)}px,0)`;
        c.style.filter = o > 0.9 ? 'none' : `blur(${((1 - o) * 2.5).toFixed(1)}px)`;
        c.style.visibility = o < 0.005 ? 'hidden' : 'visible';
        c.style.setProperty('--in', inn.toFixed(3));
        c.style.setProperty('--out', leave.toFixed(3));
      }
      // the diagram dissolves with the hand-off and swaps while it is at its dimmest, so it never pops
      const dg = diagram.current;
      if (dg) {
        const v = smooth(0, 0.3, Math.abs(sm - Math.round(sm)));
        dg.style.opacity = (0.18 + 0.82 * v).toFixed(3);
        dg.style.transform = `scale(${(0.975 + 0.025 * v).toFixed(4)})`;
      }
      // scene mood follows the story position continuously: amber (the ghost), red (failure), teal (mapped), green (fixed)
      const bump = (c: number, r: number) => Math.max(0, 1 - Math.abs(sm - c) / r);
      const mw = [bump(2.5, 1.1) * 0.9, Math.max(bump(3.5, 0.95), bump(5.5, 0.95)), bump(4.5, 0.9) * 0.9, smooth(5.7, 6.5, sm)];
      mw.forEach((v, i) => { const m = mood.current[i]; if (m) { m.style.opacity = v.toFixed(3); m.style.visibility = v < 0.01 ? 'hidden' : 'visible'; } });
      // the hero lifts away as the story begins
      const it = clamp01(ey / (vh * 0.75));
      if (intro.current) {
        intro.current.style.opacity = String(1 - it);
        intro.current.style.transform = `translate3d(0,${(-it * 70).toFixed(1)}px,0) scale(${(1 - it * 0.05).toFixed(3)})`;
        intro.current.style.visibility = it >= 1 ? 'hidden' : 'visible';
        intro.current.classList.toggle('is-gone', it >= 1);
      }
      if (rail.current) rail.current.style.transform = `scaleY(${((sm - 0.5) / (N - 1)).toFixed(4)})`;
      const idx = Math.min(N - 1, Math.max(0, Math.floor(sm)));
      setCh((c) => (c === idx ? c : idx));
      const sc = y > 40;
      setScrolled((v) => (v === sc ? v : sc));
      // keep animating until the spring has settled; otherwise idle until the next scroll
      if (Math.abs(y - ey) > 0.05 || Math.abs(vel) > 0.05) raf = requestAnimationFrame(loop); else { ey = y; raf = 0; }
    };
    const wake = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); } };
    wake();
    window.addEventListener('scroll', wake, { passive: true });
    const onResize = () => { measure(); wake(); };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', wake); window.removeEventListener('resize', onResize); };
  }, [reducedMotion]);

  // Reveal-on-scroll for the lower sections.
  useEffect(() => {
    const els = document.querySelectorAll('.lp-reveal');
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  const explore = async () => {
    setLoading(true);
    setError(null);
    try {
      await openSample();
      navigate('/app/graph');
    } catch (err) {
      setError(describeError(err));
      setLoading(false);
    }
  };

  const goStory = () => story.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });

  return (
    <div className={`lp ${reducedMotion ? 'is-reduced' : ''}`}>
      <a className="skip-link" href="#story">Skip to content</a>
      {glFailed ? <Cosmos progress={progress} reduced={reducedMotion} /> : <Globe progress={progress} reduced={reducedMotion} onFail={onGlFail} />}
      <div className="lp-vignette" aria-hidden="true" />
      <div className="lp-mood" aria-hidden="true">{['ghost', 'danger', 'signal', 'ok'].map((m, i) => <i key={m} className={`m-${m}`} ref={(el) => { mood.current[i] = el; }} />)}</div>

      <header className={`lp-head ${scrolled ? 'is-solid' : ''}`}>
        <Link to="/" aria-label="Ghostgrid home"><Logo size={36} /></Link>
        <nav className="lp-nav" aria-label="Site">
          <a href="#capabilities">Capabilities</a>
          <a href="#workflow">Workflow</a>
          <ButtonLink to="/app/dashboard" size="sm">Open dashboard</ButtonLink>
        </nav>
      </header>

      {/* ---------- intro ---------- */}
      <section ref={intro} className="lp-intro" aria-label="Ghostgrid">
        <div className="lp-mark">
          <span className="lp-halo" aria-hidden="true" />
          <span className="lp-halo h2" aria-hidden="true" />
          <LogoMark size={168} title="Ghostgrid" className="lp-mark-svg" />
          <span className="lp-sheen" aria-hidden="true" />
        </div>
        <h1 className="lp-word" aria-label="Ghostgrid">
          {'GHOST'.split('').map((c, i) => <span key={i} style={{ '--i': i } as CSSProperties}>{c}</span>)}
          {'GRID'.split('').map((c, i) => <b key={i} style={{ '--i': i + 5 } as CSSProperties}>{c}</b>)}
        </h1>
        <p className="lp-tag">Infrastructure Dependency Intelligence<br />&amp; Resilience Simulation Platform</p>
        <div className="lp-cta">
          <Button variant="primary" size="lg" onClick={() => void explore()} loading={loading}>
            Explore the sample scenario {!loading && <Icon name="arrow" size={18} />}
          </Button>
        </div>
        {error && <Alert tone="error">Could not open the sample. {error}</Alert>}
        <button type="button" className="lp-scroll" onClick={goStory} aria-label="Scroll to the story">
          <span>Scroll</span><i aria-hidden="true" />
        </button>
      </section>

      {/* ---------- scroll story ---------- */}
      <section id="story" ref={story} className="lp-story" style={{ '--steps': CHAPTERS.length - 1 } as CSSProperties} aria-label="What is Ghostgrid">
        <div className="lp-stage">
          <div className="lp-text">
            {CHAPTERS.map((c, i) => (
              <div key={c.k} ref={(el) => { chEls.current[i] = el; }} className="lp-ch" data-tone={c.tone} aria-hidden={ch !== i}>
                <span className="lp-kick">{String(i + 1).padStart(2, '0')} <em>{c.k}</em></span>
                <h2>{c.h.split(' ').map((w, j) => <span key={j} className={c.hl.includes(w.replace(/[^a-z]/gi, '').toLowerCase()) ? 'hl' : undefined} style={{ '--w': j } as CSSProperties}>{w}&nbsp;</span>)}</h2>
                <i className="lp-rule" aria-hidden="true" />
                <p>{c.t}</p>
              </div>
            ))}
            <p className="sr-only">{CHAPTERS.map((c) => `${c.h} ${c.t}`).join(' ')}</p>
          </div>
          <div ref={diagram} className="lp-diagram on"><StoryScene ch={ch} /></div>
          <div className="lp-count" key={ch} aria-hidden="true"><b>{String(ch + 1).padStart(2, '0')}</b><i>/ {String(CHAPTERS.length).padStart(2, '0')}</i><em>{CHAPTERS[ch].k}</em></div>
          <div className="lp-rail" aria-hidden="true"><span ref={rail} /></div>
          <ol className="lp-dots" aria-hidden="true">
            {CHAPTERS.map((c, i) => <li key={c.k} className={i === ch ? 'on' : i < ch ? 'done' : ''} />)}
          </ol>
        </div>
      </section>

      {/* ---------- lower content ---------- */}
      <main className="lp-main">
        <section id="capabilities" className="lp-sec" aria-labelledby="cap-t">
          <h2 id="cap-t" className="lp-h lp-reveal">Built to question the map, not just draw it.</h2>
          <ul className="m-0 list-none p-0">
            {PILLARS.map((p, i) => (
              <li key={p.title} className="lp-reveal border-t border-hair" style={{ '--d': `${i * 90}ms` } as CSSProperties}>
                <Link to={p.to} className="group grid items-baseline gap-3 py-8 no-underline sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_auto] sm:gap-10">
                  <span className="font-display text-3xl font-medium text-ivory transition-colors group-hover:text-brass-hi sm:text-4xl">{p.title}</span>
                  <span className="max-w-[54ch] text-[15.5px] leading-relaxed text-mute">{p.text}</span>
                  <span className="hidden text-brass transition-transform group-hover:translate-x-1 sm:block" aria-hidden="true"><Icon name="arrow" size={22} /></span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section id="workflow" className="lp-sec" aria-labelledby="wf-t">
          <h2 id="wf-t" className="lp-h lp-reveal">One workflow, from map to decision.</h2>
          <ol className="m-0 grid list-none gap-x-10 gap-y-9 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {WORKFLOW.filter((w) => w.path !== '/app/graph-git').map((w, i) => (
              <li key={w.path} className="lp-reveal" style={{ '--d': `${(i % 3) * 90}ms` } as CSSProperties}>
                <Link to={w.path} className="group flex flex-col gap-2 no-underline">
                  <span className="font-display text-[28px] italic leading-none text-brass">{i + 1}</span>
                  <span className="font-display text-2xl font-medium text-ivory transition-colors group-hover:text-brass-hi">{w.label}</span>
                  <span className="max-w-[34ch] text-[14.5px] leading-relaxed text-mute">{w.summary}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-sec lp-final lp-reveal" aria-labelledby="fin-t">
          <LogoMark size={64} />
          <h2 id="fin-t" className="lp-h">See the grid behind the grid.</h2>
          <div className="lp-cta">
            <Button variant="primary" size="lg" onClick={() => void explore()} loading={loading}>
              Explore the sample scenario {!loading && <Icon name="arrow" size={18} />}
            </Button>
            <ButtonLink to="/app/dashboard" size="lg">Open dashboard</ButtonLink>
          </div>
          <p className="text-[13px] text-faint">Prototype decision-support tool. The sample data is invented and your data stays on your machine.</p>
        </section>
      </main>

      <footer className="lp-foot">
        <span className="flex items-center gap-3"><LogoMark size={24} />Ghostgrid</span>
        <span>Prototype. Your data stays on your machine.</span>
      </footer>
    </div>
  );
}
