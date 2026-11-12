import { useMemo } from 'react';
import { NODE_H, NODE_W, layoutGraph } from '../lib/graph';
import type { Asset, Dependency } from '../lib/types';

const RADIUS: Record<Asset['criticality'], number> = { low: 4.5, medium: 6, high: 7.5, critical: 9.5 };

export interface MapFocus {
  /** The asset whose failure is being shown. */
  originId: string;
  /** Assets that fail with it. */
  reachedIds: ReadonlySet<string>;
}

/**
 * The whole scenario as a quiet constellation. With a focus it shows one failure: the origin glows and everything it
 * takes down turns red while the rest recedes. It is a picture for orientation; the list beside it is the accessible
 * way to read the same facts.
 */
export function SystemMap({ assets, dependencies, focus, hiddenOriginIds, label }: {
  assets: Asset[];
  dependencies: Dependency[];
  focus: MapFocus | null;
  hiddenOriginIds: ReadonlySet<string>;
  label: string;
}) {
  const layout = useMemo(() => layoutGraph(assets, dependencies), [assets, dependencies]);

  // Re-space the automatic layout onto a fixed 2:1 canvas so the map reads as a picture, not a strip.
  // Only the relative position of each asset is kept, so dragged (pinned) assets still land in the right place.
  const W = 640;
  const H = 330;
  const M = 36;
  const pt = (id: string) => {
    const p = layout.pos.get(id);
    if (!p) return null;
    const fx = (p.x + NODE_W / 2) / Math.max(1, layout.width);
    const fy = (p.y + NODE_H / 2) / Math.max(1, layout.height);
    return { x: M + fx * (W - 2 * M), y: M + fy * (H - 2 * M) };
  };
  // Crop the canvas to where the assets actually are, so a short graph is not drawn small in empty space.
  const pts = assets.map((a) => pt(a.id)).filter((p): p is { x: number; y: number } => !!p);
  const pad = 34;
  const minX = Math.min(...pts.map((p) => p.x)) - pad;
  const maxX = Math.max(...pts.map((p) => p.x)) + pad;
  const minY = Math.min(...pts.map((p) => p.y)) - pad;
  const maxY = Math.max(...pts.map((p) => p.y)) + pad;
  const vbH = Math.max(maxY - minY, 170);
  const vb = pts.length ? `${minX} ${(minY + maxY) / 2 - vbH / 2} ${maxX - minX} ${vbH}` : `0 0 ${W} ${H}`;
  const originName = focus ? assets.find((a) => a.id === focus.originId)?.name : undefined;

  return (
    <svg className="sysmap" viewBox={vb} role="img" aria-label={label} data-focus={focus ? 'on' : 'off'}>
      <g className="sysmap-links">
        {dependencies.map((d) => {
          const a = pt(d.providerId);
          const b = pt(d.dependentId);
          if (!a || !b) return null;
          const dx = (b.x - a.x) / 2;
          const hot = focus && (focus.reachedIds.has(d.dependentId) || d.dependentId === focus.originId) && (focus.reachedIds.has(d.providerId) || d.providerId === focus.originId);
          return (
            <path
              key={d.id}
              d={`M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`}
              className={`sysmap-link${hot ? ' is-hot' : ''}${d.mode === 'alternate' ? ' is-alt' : ''}`}
            />
          );
        })}
      </g>
      <g className="sysmap-nodes">
        {assets.map((a) => {
          const p = pt(a.id);
          if (!p) return null;
          const isOrigin = focus?.originId === a.id;
          const isReached = !!focus?.reachedIds.has(a.id);
          const cls = ['sysmap-node', `crit-${a.criticality}`, isOrigin && 'is-origin', isReached && 'is-reached', hiddenOriginIds.has(a.id) && 'is-hidden-origin']
            .filter(Boolean)
            .join(' ');
          return (
            <g key={a.id} className={cls} transform={`translate(${p.x} ${p.y})`}>
              {isOrigin && <circle className="sysmap-pulse" r={RADIUS[a.criticality] + 4} />}
              <circle className="sysmap-dot" r={RADIUS[a.criticality]} />
              {a.criticality === 'critical' && <circle className="sysmap-crit-ring" r={RADIUS[a.criticality] + 3} />}
              <title>{a.name}</title>
            </g>
          );
        })}
      </g>
      {focus && originName && (
        <g className="sysmap-tag">
          {(() => {
            const p = pt(focus.originId);
            if (!p) return null;
            const flip = p.x > minX + (maxX - minX) * 0.6;
            return (
              <text x={p.x + (flip ? -22 : 22)} y={p.y + 4} textAnchor={flip ? 'end' : 'start'}>
                {originName}
              </text>
            );
          })()}
        </g>
      )}
    </svg>
  );
}
