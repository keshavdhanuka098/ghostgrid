import type { CSSProperties, ReactNode } from 'react';

/**
 * The animated diagram beside the scroll story.
 *
 * It is a pure function of the chapter index `ch` (0..6). Every colour, reveal and the failure cascade are driven by
 * CSS transitions / keyframes with per-element delays (`--d`), so the choreography replays each time a chapter is
 * entered and costs nothing while idle. No timers, no per-frame React work.
 */
type Tone = 'dim' | 'ok' | 'map' | 'ghost' | 'down' | 'fixed';
type Kind = 'sys' | 'bb' | 'feed';
type Icon = 'siren' | 'card' | 'ring' | 'cloud' | 'bolt';

const cssVars = (o: Record<string, string | number>) => o as CSSProperties;

const GLYPH: Record<Icon, ReactNode> = {
  siren: <path d="M-7 6h14M-5 6v-5a5 5 0 0 1 10 0v5M0-9v-2M-9-5l-2-1M9-5l2-1" />,
  card: <><rect x="-8" y="-5.5" width="16" height="11" rx="1.6" /><path d="M-8-1.5h16M-5 3h4" /></>,
  ring: <><circle r="7" strokeDasharray="2.2 2.2" /><circle r="2.2" /></>,
  cloud: <path d="M-6 5a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.5 1.5 3.3 3.3 0 0 1 .5 6.5z" />,
  bolt: <path d="M2-9l-7 10h5l-2 8 8-11h-5z" />,
};

const nodeTone = (ch: number, kind: Kind): Tone => {
  if (ch === 0) return 'dim';
  if (ch === 1) return 'ok';
  if (ch === 2) return kind === 'feed' ? 'ghost' : 'ok';
  if (ch === 3 || ch === 5) return 'down';
  if (ch === 4) return kind === 'feed' ? 'ghost' : 'map';
  return 'fixed';
};

/** Seconds at which each tier fails (cascade) or recovers (fix), so the failure visibly travels upward. */
const TIER_DELAY: Record<Kind, (ch: number) => number> = {
  feed: (ch) => (ch === 2 ? 0.5 : ch === 6 ? 0.1 : 0),
  bb: (ch) => (ch === 3 || ch === 5 ? 0.95 : ch === 6 ? 0.55 : ch === 1 ? 0.12 : ch === 4 ? 0.5 : 0),
  sys: (ch) => (ch === 3 || ch === 5 ? 1.9 : ch === 6 ? 1.0 : ch === 4 ? 0.2 : 0),
};

const SUB: Record<string, (ch: number) => string> = {
  dispatch: (c) => ['OPERATIONAL', 'ON YOUR DIAGRAM', 'LIVE', 'DOWN · ROUND 2', 'MAPPED', 'FIBRE LOST · 94%', 'RESILIENT'][c],
  payments: (c) => ['OPERATIONAL', 'ON YOUR DIAGRAM', 'LIVE', 'DOWN · ROUND 2', 'MAPPED', 'CLOUD LOST · 94%', 'RESILIENT'][c],
  fibre: (c) => ['OPERATIONAL', 'ON YOUR DIAGRAM', 'LIVE', 'LOST POWER', 'MAPPED', 'NO POWER · CERTAIN', 'RESILIENT'][c],
  cloud: (c) => ['OPERATIONAL', 'ON YOUR DIAGRAM', 'LIVE', 'LOST POWER', 'MAPPED', 'NO POWER · CERTAIN', 'RESILIENT'][c],
  feed: (c) => (c === 2 ? 'ON NEITHER DIAGRAM' : c === 3 ? 'FAILED' : c === 4 ? 'HIDDEN · RANK 1' : 'FAILED · ROOT CAUSE'),
};

type NodeProps = { x: number; y: number; w: number; h: number; label: string; sub: string; icon: Icon; tone: Tone; show: boolean; d: number; cls?: string };
function Node({ x, y, w, h, label, sub, icon, tone, show, d, cls = '' }: NodeProps) {
  return (
    <g className={`sd-n tone-${tone} ${cls}`} data-show={show} style={cssVars({ '--d': `${d}s` })}>
      <rect className="sd-halo" x={x} y={y} width={w} height={h} rx="3" />
      <rect className="sd-card" x={x} y={y} width={w} height={h} rx="3" />
      <rect className="sd-bar" x={x} y={y + 6} width="2.5" height={h - 12} />
      <g className="sd-ico" transform={`translate(${x + 24} ${y + h / 2})`}>{GLYPH[icon]}</g>
      <text className="sd-label" x={x + 46} y={y + h / 2 - 3}>{label}</text>
      <text className="sd-sub" x={x + 46} y={y + h / 2 + 13}>{sub}</text>
      <circle className="sd-dot" cx={x + w - 15} cy={y + h / 2} r="3.2" />
    </g>
  );
}

type EdgeDef = { id: string; d: string; show: boolean; tone: Tone; delay: number; flow: boolean; fail: boolean };

export function StoryScene({ ch }: { ch: number }) {
  const cascade = ch === 3 || ch === 5;
  const fixed = ch === 6;
  const feedShown = ch >= 2 && ch <= 5;
  const tn = (k: Kind) => nodeTone(ch, k);
  const dl = (k: Kind) => TIER_DELAY[k](ch);

  const edges: EdgeDef[] = [
    // services <- backbone (paths run bottom -> top: power/data flows upward)
    { id: 'e1', d: 'M140 186V112', show: true, tone: ch === 0 ? 'dim' : cascade ? 'down' : ch === 4 ? 'map' : fixed ? 'fixed' : 'ok', delay: cascade ? 1.05 : fixed ? 0.8 : 0.1, flow: ch >= 1 && !cascade, fail: cascade },
    { id: 'e2', d: 'M420 186V112', show: true, tone: ch === 0 ? 'dim' : cascade ? 'down' : ch === 4 ? 'map' : fixed ? 'fixed' : 'ok', delay: cascade ? 1.05 : fixed ? 0.8 : 0.2, flow: ch >= 1 && !cascade, fail: cascade },
    // backbone <- the one shared feed
    { id: 'e3', d: 'M170 330V242', show: feedShown, tone: cascade ? 'down' : 'ghost', delay: cascade ? 0.15 : ch === 2 ? 0.9 : 0.1, flow: feedShown && !cascade, fail: cascade },
    { id: 'e4', d: 'M390 330V242', show: feedShown, tone: cascade ? 'down' : 'ghost', delay: cascade ? 0.15 : ch === 2 ? 1.0 : 0.1, flow: feedShown && !cascade, fail: cascade },
    // fix: two feeds, each backbone wired to both
    { id: 'f1', d: 'M110 330V242', show: fixed, tone: 'fixed', delay: 0.5, flow: fixed, fail: false },
    { id: 'f2', d: 'M450 330V242', show: fixed, tone: 'fixed', delay: 0.6, flow: fixed, fail: false },
    { id: 'f3', d: 'M170 330C170 285 390 285 390 242', show: fixed, tone: 'fixed', delay: 1.1, flow: fixed, fail: false },
    { id: 'f4', d: 'M390 330C390 285 170 285 170 242', show: fixed, tone: 'fixed', delay: 1.25, flow: fixed, fail: false },
  ];

  const stats: [string, string, string][] = [
    [['Systems', '2', ''], ['Systems', '2', ''], ['Systems', '2', ''], ['Services down', '4', 'bad'], ['Hidden deps', '1', 'warn'], ['Services down', '4', 'bad'], ['Services down', '0', 'good']][ch] as [string, string, string],
    [['Shared parts', '?', ''], ['Shared parts', '0', ''], ['Shared parts', '1', 'warn'], ['Cascade rounds', '2', 'bad'], ['Criticality', '0.92', 'warn'], ['Round', '2 / 2', 'bad'], ['Redundancy', '+1 feed', 'good']][ch] as [string, string, string],
    [['Visible to you', 'all', ''], ['Visible to you', '100%', ''], ['Visible to you', '83%', 'warn'], ['Warning given', 'none', 'bad'], ['Fan-in', '2', ''], ['Certainty', '94%', ''], ['Blast radius', '4 → 0', 'good']][ch] as [string, string, string],
  ];

  return (
    <div className="sd" data-ch={ch}>
      <svg viewBox="0 0 560 430" className="story-svg" role="img" aria-label="Two systems that look independent share a hidden power feed">
        <defs>
          <linearGradient id="sd-scan" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--signal)" stopOpacity="0" />
            <stop offset="1" stopColor="var(--signal)" stopOpacity=".34" />
          </linearGradient>
          <radialGradient id="sd-shg"><stop offset="0" stopColor="var(--ghost)" stopOpacity="1" /><stop offset="1" stopColor="var(--ghost)" stopOpacity="0" /></radialGradient>
        </defs>

        {/* the shadow under every system (chapters 1-2) */}
        <ellipse className="sd-shadow" data-show={ch <= 1} cx="280" cy="362" rx="210" ry="44" fill="url(#sd-shg)" />

        {/* "on paper": two separate worlds */}
        <g className="sd-worlds" data-show={ch === 1}>
          {[24, 304].map((x, i) => (
            <g key={x}>
              <rect x={x} y="18" width="232" height="246" rx="6" />
              <text x={x + 12} y="34">{i === 0 ? 'DIAGRAM A' : 'DIAGRAM B'}</text>
            </g>
          ))}
          <path d="M280 30V250" />
          <text transform="translate(284 150) rotate(-90)" textAnchor="middle" className="sd-gap">NOTHING SHARED</text>
        </g>

        {edges.map((e) => (
          <g key={e.id} className={`sd-e tone-${e.tone}`} data-show={e.show} style={cssVars({ '--d': `${e.delay}s` })}>
            <path className="sd-line" d={e.d} />
            {e.flow && [0].map((k) => <circle key={k} className="sd-flow" r="2.1" style={cssVars({ offsetPath: `path("${e.d}")`, '--k': k })} />)}
            {e.fail && <circle className="sd-pulse" r="4.5" style={cssVars({ offsetPath: `path("${e.d}")` })} />}
          </g>
        ))}

        <Node x={40} y={56} w={200} h={56} label="Emergency dispatch" sub={SUB.dispatch(ch)} icon="siren" tone={tn('sys')} show d={dl('sys')} />
        <Node x={320} y={56} w={200} h={56} label="Payment gateway" sub={SUB.payments(ch)} icon="card" tone={tn('sys')} show d={dl('sys')} />
        <Node x={40} y={186} w={200} h={56} label="Fibre ring" sub={SUB.fibre(ch)} icon="ring" tone={tn('bb')} show d={dl('bb')} />
        <Node x={320} y={186} w={200} h={56} label="Cloud region" sub={SUB.cloud(ch)} icon="cloud" tone={tn('bb')} show d={dl('bb')} />

        <Node x={130} y={330} w={300} h={64} label="Colocation power feed" sub={SUB.feed(ch)} icon="bolt" tone={tn('feed')} show={feedShown} d={dl('feed')} cls="is-feed" />
        <Node x={40} y={330} w={210} h={64} label="Colocation feed" sub="PRIMARY · ONLINE" icon="bolt" tone="fixed" show={fixed} d={0.25} />
        <Node x={310} y={330} w={210} h={64} label="Second power feed" sub="NEW · ONLINE" icon="bolt" tone="fixed" show={fixed} d={0.45} cls="is-new" />

        {/* chapter 4: Ghostgrid maps it, a scan sweeps the graph and ranks the hidden feed */}
        {ch === 4 && (
          <g>
            <rect className="sd-sweep" x="0" y="-70" width="560" height="70" fill="url(#sd-scan)" />
            <rect className="sd-sweep-line" x="0" y="-1.5" width="560" height="1.5" />
            <g transform="translate(290 298)">
              <g className="sd-rank">
                <rect width="140" height="22" rx="11" />
                <text x="70" y="15" textAnchor="middle">RANK 1 · SHARED BY 2</text>
              </g>
            </g>
          </g>
        )}

        {/* rounds timeline during a failure */}
        {cascade && (
          <g className="sd-rounds" transform="translate(30 414)">
            {['ROUND 0 · FEED', 'ROUND 1 · BACKBONE', 'ROUND 2 · SERVICES'].map((t, i) => (
              <g key={t} transform={`translate(${i * 168} 0)`}>
                <circle className="sd-rdot" cx="4" cy="-4" r="3" style={cssVars({ '--d': `${[0, 0.95, 1.9][i]}s` })} />
                <text className="sd-rtxt" x="14" y="0" style={cssVars({ '--d': `${[0, 0.95, 1.9][i]}s` })}>{t}</text>
              </g>
            ))}
          </g>
        )}
      </svg>

      <dl className="sd-read" key={ch}>
        {stats.map(([k, v, t], i) => (
          <div key={k} className={`sd-stat ${t}`} style={cssVars({ '--i': i })}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
