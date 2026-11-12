import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ScenarioGate } from '../components/ScenarioGate';
import { SystemMap, type MapFocus } from '../components/SystemMap';
import { Badge, ButtonLink, EmptyState, StatTile } from '../components/ui';
import { findSharedDependencies } from '../lib/graph';
import type { Scenario } from '../lib/types';
import { WORKFLOW } from '../nav';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Inner({ s }: { s: Scenario }) {
  const shared = useMemo(() => findSharedDependencies(s.assets, s.dependencies), [s.assets, s.dependencies]);
  const hiddenShared = useMemo(() => shared.filter((x) => x.isHiddenShared), [shared]);
  const hasAssets = s.assets.length > 0;
  const hasDeps = s.dependencies.length > 0;

  const top = shared[0];
  const [hovered, setHovered] = useState<string | null>(null);
  // The map always shows a failure: the one under the pointer, otherwise the largest hidden exposure.
  const focusItem = shared.find((x) => x.asset.id === hovered) ?? top;
  const focus: MapFocus | null = focusItem ? { originId: focusItem.asset.id, reachedIds: new Set(focusItem.reached) } : null;
  const hiddenOriginIds = useMemo(() => new Set(hiddenShared.map((x) => x.asset.id)), [hiddenShared]);
  const maxScore = Math.max(1, ...shared.slice(0, 5).map((x) => x.score));

  const status: Record<string, string> = {
    '/app/scenarios': hasAssets ? `${s.assets.length} assets, ${s.dependencies.length} dependencies` : 'Start here: add your first assets',
    '/app/graph': hasAssets ? 'View the whole system' : 'Needs assets first',
    '/app/investigation': hasDeps ? `${hiddenShared.length} hidden shared found` : 'Needs mapped dependencies',
    '/app/simulation': s.runs.length ? plural(s.runs.length, 'saved run') : 'No saved runs yet',
    '/app/mitigation': s.strategies.length ? plural(s.strategies.length, 'strategy', 'strategies') + ' defined' : 'No strategies yet',
    '/app/reports': 'Export Markdown, JSON or print',
  };

  const headline = !hasAssets
    ? 'Nothing is mapped yet.'
    : !hasDeps
      ? 'Assets are listed, but nothing depends on anything yet.'
      : top && top.isHiddenShared
        ? `Failing ${top.asset.name} takes down ${top.reached.length} other assets, and only ${top.direct.length} of them list it as a dependency.`
        : hiddenShared.length === 0
          ? 'No hidden shared dependencies found. Every failure reaches only assets that list it directly.'
          : `${plural(hiddenShared.length, 'asset')} hide shared dependencies.`;

  return (
    <>
      <section className="stage" aria-labelledby="stage-title">
        <div className="stage-copy">
          <h1 id="stage-title" className="stage-title">{s.isSample ? s.name.replace(/\s*\(simulated sample\)\s*$/i, '') : s.name}</h1>
          {s.isSample && <Badge tone="ghost">Simulated sample</Badge>}
          <p className="stage-lede">{headline}</p>
          <div className="stage-actions">
            {top && top.isHiddenShared ? (
              <ButtonLink to={`/app/investigation?asset=${encodeURIComponent(top.asset.id)}`} variant="primary">
                Investigate {top.asset.name}
              </ButtonLink>
            ) : (
              <ButtonLink to="/app/scenarios" variant="primary">
                {hasAssets ? 'Edit scenario' : 'Add assets'}
              </ButtonLink>
            )}
            {hasAssets && <ButtonLink to="/app/graph">Open dependency graph</ButtonLink>}
          </div>
        </div>

        <figure className="stage-map" data-empty={!hasAssets}>
          {hasAssets ? (
            <>
              <SystemMap
                assets={s.assets}
                dependencies={s.dependencies}
                focus={focus}
                hiddenOriginIds={hiddenOriginIds}
                label={`Map of ${s.name}: ${s.assets.length} assets and ${s.dependencies.length} dependencies.${focusItem ? ` Showing the failure of ${focusItem.asset.name}.` : ''}`}
              />
              <figcaption className="stage-caption">
                {focusItem ? (
                  <>
                    <span className="swatch swatch-origin" aria-hidden="true" /> {focusItem.asset.name}
                    <span className="swatch swatch-reached" aria-hidden="true" /> {plural(focusItem.reached.length, 'asset')} fail with it
                  </>
                ) : (
                  'Every asset and dependency in this scenario.'
                )}
              </figcaption>
            </>
          ) : (
            <p className="dim">The map appears once you add assets.</p>
          )}
        </figure>
      </section>

      <div className="stat-grid">
        <StatTile label="Assets mapped" value={s.assets.length} />
        <StatTile label="Dependencies mapped" value={s.dependencies.length} />
        <StatTile label="Hidden shared dependencies" value={hiddenShared.length} tone={hiddenShared.length ? 'ghost' : undefined} />
        <StatTile label="Saved failure runs" value={s.runs.length} />
      </div>

      <div className="dash-grid">
        <section aria-labelledby="top-title" className="dash-col">
          <h2 id="top-title" className="section-title">Largest hidden exposure</h2>
          {!hasDeps ? (
            <EmptyState title="Nothing to analyse yet" actions={<ButtonLink to="/app/scenarios">Map dependencies</ButtonLink>}>
              Exposure is calculated from the dependencies you map. Add some to see which assets matter most.
            </EmptyState>
          ) : shared.length === 0 ? (
            <EmptyState title="No hidden exposure found">
              Every failure in this scenario reaches only assets that list the failed asset as a direct dependency.
            </EmptyState>
          ) : (
            <ul className="exposure">
              {shared.slice(0, 5).map((x) => (
                <li key={x.asset.id} onMouseEnter={() => setHovered(x.asset.id)} onMouseLeave={() => setHovered(null)}>
                  <Link
                    to={`/app/investigation?asset=${encodeURIComponent(x.asset.id)}`}
                    className="exposure-item"
                    data-active={focusItem?.asset.id === x.asset.id}
                    onFocus={() => setHovered(x.asset.id)}
                    onBlur={() => setHovered(null)}
                  >
                    <span className="exposure-name">{x.asset.name}</span>
                    <span className="exposure-meta">
                      {x.hidden.length} hidden, {x.direct.length} direct
                      {x.criticalReached.length > 0 && <Badge tone="danger">{x.criticalReached.length} critical</Badge>}
                    </span>
                    <span className="exposure-bar" aria-hidden="true">
                      <i style={{ width: `${Math.max(6, (x.score / maxScore) * 100)}%` }} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="flow-title" className="dash-col">
          <h2 id="flow-title" className="section-title">Workflow</h2>
          <ol className="flow">
            {WORKFLOW.map((w) => (
              <li key={w.path}>
                <Link to={w.path} className="flow-item">
                  <span className="flow-icon" aria-hidden="true"><Icon name={w.icon} size={18} /></span>
                  <span className="flow-body">
                    <span className="flow-title">{w.label}</span>
                    <span className="flow-sum">{status[w.path] ?? w.summary}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}

export default function Dashboard() {
  return (
    <ScenarioGate title="Dashboard" description="Where your active scenario stands.">
      {(s) => <Inner s={s} />}
    </ScenarioGate>
  );
}
