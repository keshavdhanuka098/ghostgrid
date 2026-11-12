import { Alert, Badge, Button, Checkbox } from '../ui';
import type { IntegrationInfo, IntegrationState } from '../../lib/integrations';

const TONE: Record<IntegrationState, 'signal' | 'ghost' | 'danger' | undefined> = {
  connected: 'signal',
  not_configured: undefined,
  disabled: undefined,
  rate_limited: 'ghost',
  connection_failed: 'danger',
  pending: 'ghost',
};
const GLYPH: Record<IntegrationState, string> = { connected: '●', not_configured: '○', disabled: '–', rate_limited: '◐', connection_failed: '✕', pending: '…' };

/** State is always spelled out in words and a glyph, never colour alone. */
export function StateBadge({ item }: { item: Pick<IntegrationInfo, 'state' | 'stateLabel'> }) {
  return (
    <Badge tone={TONE[item.state]}>
      <span aria-hidden="true">{GLYPH[item.state]}</span> {item.stateLabel}
    </Badge>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

export function IntegrationCard({ item, onToggle, busy }: { item: IntegrationInfo; onToggle: (enabled: boolean) => void; busy?: boolean }) {
  return (
    <article className="integ-card card" aria-label={item.label} data-state={item.state}>
      <header className="integ-head">
        <span className="integ-mark" aria-hidden="true">{item.label.slice(0, 1)}</span>
        <div className="integ-title">
          <h3>{item.label}</h3>
          <p className="dim">{item.description}</p>
        </div>
        <StateBadge item={item} />
      </header>

      {item.detail && (item.state === 'connection_failed' || item.state === 'rate_limited' ? <Alert tone={item.state === 'rate_limited' ? 'warn' : 'error'}>{item.detail}</Alert> : <p className="dim integ-detail">{item.detail}</p>)}

      {item.features.length > 0 && (
        <ul className="integ-features">
          {item.features.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}

      <dl className="integ-meta">
        {item.envVars.length > 0 && (
          <>
            <dt>Credentials</dt>
            <dd>{item.envVars.map((v) => <code key={v.name} className="integ-env">{v.name}: {v.set ? 'set' : 'not set'}</code>)}</dd>
          </>
        )}
        <dt>Last successful check</dt>
        <dd>{when(item.lastOkAt)}</dd>
      </dl>

      <footer className="integ-foot">
        <Checkbox label="Enabled" checked={item.enabled} disabled={!item.toggleable || busy} onChange={(e) => onToggle(e.target.checked)} />
        {!item.toggleable && <span className="dim">Cannot be enabled in this version.</span>}
      </footer>
    </article>
  );
}

export function IntegrationHealth({ items, checking, onCheck, onToggle }: { items: IntegrationInfo[]; checking: boolean; onCheck: () => void; onToggle: (id: string, enabled: boolean) => Promise<void> }) {
  return (
    <div className="stack">
      <div className="row-actions">
        <Button onClick={onCheck} loading={checking}>Check connections now</Button>
        <span className="dim">Status comes from real requests to each provider. A key being present is not shown as “Connected”.</span>
      </div>
      <div className="integ-grid">
        {items.map((i) => <IntegrationCard key={i.id} item={i} busy={checking} onToggle={(e) => void onToggle(i.id, e)} />)}
      </div>
    </div>
  );
}
