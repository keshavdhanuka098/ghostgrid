import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { edgeGeometry, layoutGraph, NODE_H, NODE_W, type Point, type Trace } from '../lib/graph';
import {
  CRIT_LABEL,
  KIND_CODE,
  KIND_LABEL,
  LINK_STATUSES,
  RELATION_LABEL,
  STATUS_GLYPH,
  STATUS_LABEL,
  type Asset,
  type AssetKind,
  type Dependency,
  type LinkStatus,
} from '../lib/types';
import { Button } from './ui';

export interface GraphHandle {
  fit: () => void;
  centerOn: (id: string) => void;
}

interface Props {
  assets: Asset[];
  dependencies: Dependency[];
  label: string;
  ref?: Ref<GraphHandle>;
  /** CSS height of the viewport. */
  height?: number | string;

  selectedId?: string | null;
  selectedLinkId?: string | null;
  onSelect?: (id: string) => void;
  onSelectLink?: (id: string) => void;
  /** Click on empty canvas. */
  onBackgroundClick?: () => void;
  /** Delete / Backspace pressed while the graph has focus. */
  onDeleteRequest?: () => void;
  /** Dragging an asset moves it; the callback receives the new top-left position. Omit to make assets fixed. */
  onMoveNode?: (id: string, x: number, y: number) => void;
  /** An asset the user is in the middle of connecting from. */
  pendingId?: string | null;

  /** Upstream / downstream trace to emphasise. Everything outside it is faded. */
  trace?: Trace | null;
  /** Amber ring: hidden shared dependencies, protected assets, etc. */
  highlightIds?: Set<string>;
  highlightLabel?: string;
  /** Red: failed assets. */
  failedIds?: Set<string>;
  /** Shows "R2" style badges on failed assets. */
  roundOf?: Map<string, number>;
  /** Dependencies that were failed directly (the provider stops serving that dependent). Drawn cut, with a ✕ marker. */
  failedLinkIds?: Set<string>;
  /** Dependencies that are down right now (failed directly, or their provider has failed). Drawn red. When omitted, a link is red if both ends failed. */
  deadLinkIds?: Set<string>;
  /** Dependencies currently being questioned by a what-if assumption. Drawn with an amber halo. */
  whatIfLinkIds?: Set<string>;
  kindFilter?: AssetKind | 'all';
  /** Dependencies whose status is not in this set are not drawn. */
  visibleStatuses?: Set<LinkStatus>;
  /** Draw a status marker (✓ ~ ?) on every link. */
  linkMarkers?: boolean;
  /** Plain mouse-wheel zooms the canvas. Otherwise only Ctrl/⌘ + wheel (and pinch) zooms, so the page can scroll past it. */
  wheelZoom?: boolean;
  /** Extra controls on the right of the toolbar. */
  toolbar?: ReactNode;
}

interface View {
  k: number;
  x: number;
  y: number;
}

const MIN_K = 0.2;
const MAX_K = 2.5;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const DRAG_THRESHOLD = 5;

function fitView(w: number, h: number, lw: number, lh: number): View {
  const m = 20;
  const k = clampK(Math.min((w - 2 * m) / lw, (h - 2 * m) / lh, 1));
  return { k, x: (w - lw * k) / 2, y: (h - lh * k) / 2 };
}

type Gesture =
  | { kind: 'pending'; sx: number; sy: number; view: View; nodeId?: string }
  | { kind: 'pan'; sx: number; sy: number; view: View }
  | { kind: 'node'; sx: number; sy: number; view: View; nodeId: string; origin: Point }
  | { kind: 'pinch'; dist: number; mid: Point; view: View };

export function GraphView({
  assets,
  dependencies,
  label,
  ref,
  height = 520,
  selectedId,
  selectedLinkId,
  onSelect,
  onSelectLink,
  onBackgroundClick,
  onDeleteRequest,
  onMoveNode,
  pendingId,
  trace,
  highlightIds,
  highlightLabel = 'Highlighted',
  failedIds,
  roundOf,
  failedLinkIds,
  deadLinkIds,
  whatIfLinkIds,
  kindFilter = 'all',
  visibleStatuses,
  linkMarkers = false,
  wheelZoom = false,
  toolbar,
}: Props) {
  const layout = useMemo(() => layoutGraph(assets, dependencies), [assets, dependencies]);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setViewState] = useState<View>({ k: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  // Until the person pans or zooms themselves, the view keeps following the graph as it grows or changes.
  const adjusted = useRef(false);
  const setView = useCallback((v: View, auto = false) => {
    if (!auto) adjusted.current = true;
    viewRef.current = v;
    setViewState(v);
  }, []);

  /* ---- size and initial view ---- */
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (adjusted.current || !size.w || !size.h) return;
    const f = fitView(size.w, size.h, layout.width, layout.height);
    // Open readable: fit the whole graph when it stays legible (55% or more); otherwise start at 80% and let the user pan.
    setView(f.k >= 0.55 ? f : { k: 0.8, x: 16, y: 16 }, true);
  }, [size, layout.width, layout.height, setView]);

  /* ---- node dragging ---- */
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const positions = useMemo(() => {
    if (!drag) return layout.pos;
    const m = new Map(layout.pos);
    m.set(drag.id, { x: drag.x, y: drag.y });
    return m;
  }, [layout.pos, drag]);

  /* ---- zoom helpers ---- */
  const zoomAround = useCallback(
    (factor: number, cx: number, cy: number) => {
      const v = viewRef.current;
      const k = clampK(v.k * factor);
      const r = k / v.k;
      setView({ k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r });
    },
    [setView],
  );
  const zoomCentre = (factor: number) => zoomAround(factor, size.w / 2, size.h / 2);

  const doFit = useCallback(() => {
    if (!size.w || !size.h) return;
    adjusted.current = false;
    setView(fitView(size.w, size.h, layout.width, layout.height), true);
  }, [size, layout.width, layout.height, setView]);

  useImperativeHandle(
    ref,
    () => ({
      fit: doFit,
      centerOn: (id: string) => {
        const p = layout.pos.get(id);
        if (!p || !size.w) return;
        // A small graph that fits comfortably is already fully in view; keep following it rather than zooming in.
        if (!adjusted.current) {
          const f = fitView(size.w, size.h, layout.width, layout.height);
          if (f.k >= 0.7) return setView(f, true);
        }
        const k = Math.min(1.2, Math.max(viewRef.current.k, 0.8));
        setView({ k, x: size.w / 2 - (p.x + NODE_W / 2) * k, y: size.h / 2 - (p.y + NODE_H / 2) * k });
      },
    }),
    [doFit, layout.pos, size, setView],
  );

  /* ---- wheel (native listener so it can be non-passive) ---- */
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(wheelZoom || e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const speed = e.ctrlKey ? 0.01 : 0.0016;
      zoomAround(Math.exp(-e.deltaY * speed), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [wheelZoom, zoomAround]);

  /* ---- pointer gestures: pan, drag node, pinch ---- */
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const justDragged = useRef(false);

  const local = (clientX: number, clientY: number): Point => {
    const r = frameRef.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      gesture.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid, view: viewRef.current };
      for (const id of pointers.current.keys()) {
        try {
          svgRef.current?.setPointerCapture(id);
        } catch {
          /* pointer already gone */
        }
      }
      return;
    }
    const nodeId = (e.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? undefined;
    gesture.current = { kind: 'pending', sx: e.clientX, sy: e.clientY, view: viewRef.current, nodeId };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;

    if (g.kind === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      const k = clampK(g.view.k * (dist / g.dist));
      const wx = (g.mid.x - g.view.x) / g.view.k;
      const wy = (g.mid.y - g.view.y) / g.view.k;
      setView({ k, x: mid.x - wx * k, y: mid.y - wy * k });
      return;
    }

    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (g.kind === 'pending') {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      try {
        svgRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const origin = g.nodeId ? layout.pos.get(g.nodeId) : undefined;
      gesture.current =
        g.nodeId && origin && onMoveNode
          ? { kind: 'node', sx: g.sx, sy: g.sy, view: g.view, nodeId: g.nodeId, origin }
          : { kind: 'pan', sx: g.sx, sy: g.sy, view: g.view };
      return onPointerMove(e);
    }
    if (g.kind === 'pan') {
      setView({ k: g.view.k, x: g.view.x + dx, y: g.view.y + dy });
    } else {
      adjusted.current = true;
      setDrag({ id: g.nodeId, x: g.origin.x + dx / g.view.k, y: g.origin.y + dy / g.view.k });
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    const moved = g.kind !== 'pending';
    if (g.kind === 'node' && dragRef.current && e.type !== 'pointercancel') {
      const d = dragRef.current;
      onMoveNode?.(d.id, Math.max(0, d.x), Math.max(0, d.y));
    }
    if (g.kind === 'node') setDrag(null);
    if (moved) {
      // The browser follows a drag with a click; swallow it so it does not select or clear anything.
      justDragged.current = true;
      window.setTimeout(() => (justDragged.current = false), 0);
    }
    if (pointers.current.size === 0 || g.kind === 'pinch') gesture.current = null;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  /* ---- keyboard ---- */
  const onKeyDown = (e: KeyboardEvent) => {
    const step = 70;
    const v = viewRef.current;
    switch (e.key) {
      case 'ArrowLeft':
        setView({ ...v, x: v.x + step });
        break;
      case 'ArrowRight':
        setView({ ...v, x: v.x - step });
        break;
      case 'ArrowUp':
        setView({ ...v, y: v.y + step });
        break;
      case 'ArrowDown':
        setView({ ...v, y: v.y - step });
        break;
      case '+':
      case '=':
        zoomCentre(1.25);
        break;
      case '-':
      case '_':
        zoomCentre(0.8);
        break;
      case '0':
        doFit();
        break;
      case 'Delete':
      case 'Backspace':
        if (!onDeleteRequest) return;
        onDeleteRequest();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const activate = (e: KeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }
  };

  /* ---- derived drawing state ---- */
  const tracing = !!trace && trace.mode !== 'off';
  const traced = useMemo(() => {
    if (!trace || trace.mode === 'off') return null;
    return new Set([trace.origin, ...trace.upstream.keys(), ...trace.downstream.keys()]);
  }, [trace]);
  const dimmedKind = (a: Asset) => kindFilter !== 'all' && a.kind !== kindFilter;
  const statusSet = visibleStatuses ?? new Set<LinkStatus>(LINK_STATUSES);
  const selectedLink = selectedLinkId ? dependencies.find((d) => d.id === selectedLinkId) : undefined;
  const incident = (d: Dependency) => !!selectedId && (d.providerId === selectedId || d.dependentId === selectedId);
  const nameOf = (id: string) => byId.get(id)?.name ?? 'Unknown';

  const links = dependencies.filter((d) => statusSet.has(d.status) && positions.has(d.providerId) && positions.has(d.dependentId));
  const interactive = !!onSelect;
  const hint = wheelZoom ? 'Drag to pan · scroll to zoom' : 'Drag to pan · Ctrl + scroll to zoom';

  return (
    <div className="graph">
      <div className="graph-toolbar" role="toolbar" aria-label="Graph controls">
        <Button size="sm" variant="ghost" onClick={() => zoomCentre(0.8)} aria-label="Zoom out">
          −
        </Button>
        <span className="graph-zoom mono" aria-live="polite">
          {Math.round(view.k * 100)}%
        </span>
        <Button size="sm" variant="ghost" onClick={() => zoomCentre(1.25)} aria-label="Zoom in">
          +
        </Button>
        <Button size="sm" variant="ghost" onClick={doFit}>
          Fit
        </Button>
        {toolbar}
        <span className="graph-hint">{hint}</span>
      </div>

      <div
        ref={frameRef}
        className="graph-viewport"
        style={{ height }}
        tabIndex={0}
        role="application"
        aria-roledescription="interactive dependency graph"
        aria-label={`${label}. Use arrow keys to pan, plus and minus to zoom, zero to fit.`}
        onKeyDown={onKeyDown}
      >
        <svg
          ref={svgRef}
          className="graph-svg"
          width="100%"
          height="100%"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onClick={(e) => {
            if (justDragged.current) return;
            if ((e.target as Element).closest('[data-node],[data-link]')) return;
            onBackgroundClick?.();
          }}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <g className="g-links">
              {links.map((d) => {
                const from = positions.get(d.providerId)!;
                const to = positions.get(d.dependentId)!;
                const geo = edgeGeometry(from, to);
                const sel = selectedLinkId === d.id;
                const inTrace = trace?.links.has(d.id) ?? false;
                // Upstream side: the dependent is the origin or itself upstream, and the provider is upstream of it.
                const upLink = inTrace && trace!.upstream.has(d.providerId) && (d.dependentId === trace!.origin || trace!.upstream.has(d.dependentId));
                const faded =
                  (tracing && !inTrace) ||
                  (!tracing && !!selectedLink && !sel) ||
                  (!tracing && !selectedLink && !!selectedId && !incident(d)) ||
                  dimmedKind(byId.get(d.providerId)!) ||
                  dimmedKind(byId.get(d.dependentId)!);
                const cut = !!failedLinkIds?.has(d.id);
                const hot = cut || (deadLinkIds ? deadLinkIds.has(d.id) : !!failedIds?.has(d.providerId) && !!failedIds.has(d.dependentId));
                const asked = !!whatIfLinkIds?.has(d.id);
                const proposed = d.id.startsWith('mit-');
                const cls = [
                  'g-link',
                  `st-${d.status}`,
                  d.mode === 'alternate' && 'is-alt',
                  sel && 'is-selected',
                  !sel && !tracing && incident(d) && 'is-touched',
                  inTrace && (upLink ? 'is-up' : 'is-down'),
                  hot && 'is-failed',
                  cut && 'is-cut',
                  asked && 'is-whatif',
                  proposed && 'is-proposed',
                  faded && 'is-faded',
                ]
                  .filter(Boolean)
                  .join(' ');
                const text = `Dependency: ${nameOf(d.dependentId)} relies on ${nameOf(d.providerId)}. ${STATUS_LABEL[d.status]}. ${d.mode === 'alternate' ? 'Alternate provider.' : 'Required.'} ${RELATION_LABEL[d.relation]}.${cut ? ' Failed directly.' : hot ? ' Down.' : ''}${asked ? ' Under a what-if assumption.' : ''}${proposed ? ' Proposed by a mitigation, not built yet.' : ''}`;
                const markerOn = linkMarkers || sel || inTrace || cut || asked || proposed;
                const glyph = cut ? '✕' : proposed ? 'NEW' : STATUS_GLYPH[d.status];
                const pillW = (d.mode === 'alternate' ? 38 : 18) + (proposed ? 14 : 0) + (asked ? 12 : 0);
                return (
                  <g
                    key={d.id}
                    className={cls}
                    data-link={d.id}
                    role={onSelectLink ? 'button' : 'img'}
                    tabIndex={onSelectLink && (sel || incident(d)) ? 0 : undefined}
                    aria-pressed={onSelectLink ? sel : undefined}
                    aria-label={text}
                    onClick={() => !justDragged.current && onSelectLink?.(d.id)}
                    onKeyDown={(e) => onSelectLink && activate(e, () => onSelectLink(d.id))}
                  >
                    <path className="g-link-hit" d={geo.d} />
                    {asked && <path className="g-link-halo" d={geo.d} />}
                    <path className="g-link-line" d={geo.d} markerEnd="url(#gg-arrow)" />
                    {markerOn && (
                      <g className="g-pill" transform={`translate(${geo.mid.x} ${geo.mid.y})`}>
                        <rect x={-pillW / 2} y="-9" width={pillW} height="18" rx="9" />
                        <text y="4" textAnchor="middle">
                          {glyph}
                          {d.mode === 'alternate' ? ' ALT' : ''}
                          {asked ? ' ?' : ''}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>

            <g className="g-nodes">
              {assets.map((a) => {
                const p = positions.get(a.id);
                if (!p) return null;
                const failed = failedIds?.has(a.id);
                const lit = highlightIds?.has(a.id);
                const selected = selectedId === a.id;
                const round = roundOf?.get(a.id);
                const isOrigin = trace?.origin === a.id && tracing;
                const isUp = tracing && trace!.upstream.has(a.id);
                const isDown = tracing && trace!.downstream.has(a.id);
                const faded = dimmedKind(a) || (!!traced && !traced.has(a.id));
                const hops = isUp ? trace!.upstream.get(a.id) : isDown ? trace!.downstream.get(a.id) : undefined;
                return (
                  <g
                    key={a.id}
                    data-node={a.id}
                    transform={`translate(${p.x} ${p.y})`}
                    className={[
                      'g-node',
                      `crit-${a.criticality}`,
                      failed && 'is-failed',
                      lit && 'is-lit',
                      selected && 'is-selected',
                      pendingId === a.id && 'is-pending',
                      isOrigin && 'is-origin',
                      isUp && 'is-up',
                      isDown && 'is-down',
                      drag?.id === a.id && 'is-dragging',
                      faded && 'is-faded',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    role={interactive ? 'button' : 'img'}
                    tabIndex={interactive ? 0 : undefined}
                    aria-pressed={interactive ? selected : undefined}
                    aria-label={`${a.name}. ${KIND_LABEL[a.kind]}, ${CRIT_LABEL[a.criticality]} criticality.${failed ? ' Failed.' : ''}${lit ? ` ${highlightLabel}.` : ''}${isUp ? ` Upstream, ${hops} step${hops === 1 ? '' : 's'}.` : ''}${isDown ? ` Downstream, ${hops} step${hops === 1 ? '' : 's'}.` : ''}`}
                    onClick={() => !justDragged.current && onSelect?.(a.id)}
                    onKeyDown={(e) => interactive && activate(e, () => onSelect?.(a.id))}
                  >
                    <rect className="g-box" width={NODE_W} height={NODE_H} rx="6" />
                    <rect className="g-stripe" width="4" height={NODE_H} rx="2" />
                    <text className="g-name" x="14" y="20">
                      {clip(a.name, 23)}
                    </text>
                    <text className="g-meta" x="14" y="37">
                      {KIND_CODE[a.kind]} · {CRIT_LABEL[a.criticality].toUpperCase()}
                    </text>
                    {failed && round !== undefined ? (
                      <text className="g-round" x={NODE_W - 10} y="37" textAnchor="end">
                        {round === 0 ? 'START' : `R${round}`}
                      </text>
                    ) : hops !== undefined ? (
                      <text className="g-hops" x={NODE_W - 10} y="37" textAnchor="end">
                        {isUp ? '↑' : '↓'}
                        {hops}
                      </text>
                    ) : null}
                    <title>{a.name}</title>
                  </g>
                );
              })}
            </g>
          </g>
          <defs>
            <marker id="gg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 1l9 4-9 4z" fill="context-stroke" />
            </marker>
          </defs>
        </svg>
        {assets.length === 0 && <p className="graph-empty">No assets to draw yet.</p>}
      </div>

      <ul className="graph-legend" aria-label="Legend">
        {LINK_STATUSES.map((st) => (
          <li key={st}>
            <svg className="lg-line" width="30" height="10" aria-hidden="true">
              <line className={`g-link-line st-${st}`} x1="1" y1="5" x2="29" y2="5" />
            </svg>
            <span>
              {STATUS_GLYPH[st]} {STATUS_LABEL[st]}
            </span>
          </li>
        ))}
        <li>
          <i className="lg lg-stripe" /> Stripe = criticality
        </li>
        <li>
          <span className="lg-alt">ALT</span> Alternate provider
        </li>
        {tracing && (
          <>
            <li>
              <i className="lg lg-up" /> Upstream (relied on)
            </li>
            <li>
              <i className="lg lg-down" /> Downstream (relies on it)
            </li>
          </>
        )}
        {failedIds && failedIds.size > 0 && (
          <li>
            <i className="lg lg-fail" /> Failed
          </li>
        )}
        {failedLinkIds && failedLinkIds.size > 0 && (
          <li>
            <span className="lg-cut">✕</span> Link failed directly
          </li>
        )}
        {whatIfLinkIds && whatIfLinkIds.size > 0 && (
          <li>
            <i className="lg lg-lit" /> Under a what-if assumption
          </li>
        )}
        {highlightIds && highlightIds.size > 0 && (
          <li>
            <i className="lg lg-lit" /> {highlightLabel}
          </li>
        )}
      </ul>
    </div>
  );
}
