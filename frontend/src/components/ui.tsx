import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { CRIT_LABEL, type Criticality } from '../lib/types';

/* ---------------------------------------------------------------- buttons */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'sm' | 'lg';
const cls = (variant: Variant, size: Size, extra?: string) =>
  ['btn', variant !== 'secondary' && `btn-${variant}`, size !== 'md' && `btn-${size}`, extra].filter(Boolean).join(' ');

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', loading, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cls(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: LinkProps & { variant?: Variant; size?: Size }) {
  return <Link {...rest} className={cls(variant, size, className)} />;
}

/* ----------------------------------------------------------------- fields */

interface FieldShell {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
}

function Shell({ label, hint, error, className, id, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className={`field ${className ?? ''}`} data-invalid={error ? 'true' : undefined}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <p className="field-error" id={`${id}-err`}>
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const describe = (id: string, error?: string, hint?: string) => (error ? `${id}-err` : hint ? `${id}-hint` : undefined);

export function TextField({ label, hint, error, className, ...rest }: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} className={className}>
      <input {...rest} id={id} className="input" aria-invalid={error ? true : undefined} aria-describedby={describe(id, error, hint)} />
    </Shell>
  );
}

export function TextAreaField({ label, hint, error, className, ...rest }: FieldShell & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} className={className}>
      <textarea {...rest} id={id} className="textarea" aria-invalid={error ? true : undefined} aria-describedby={describe(id, error, hint)} />
    </Shell>
  );
}

export function SelectField({ label, hint, error, className, children, ...rest }: FieldShell & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} className={className}>
      <select {...rest} id={id} className="select" aria-invalid={error ? true : undefined} aria-describedby={describe(id, error, hint)}>
        {children}
      </select>
    </Shell>
  );
}

export function Checkbox({ label, ...rest }: { label: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="check">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

/* ------------------------------------------------------------ small parts */

export function Badge({ tone, children }: { tone?: 'signal' | 'ghost' | 'danger' | 'crit' | 'high' | 'medium'; children: ReactNode }) {
  return <span className={`badge ${tone ? `badge-${tone}` : ''}`}>{children}</span>;
}

export function CritBadge({ level }: { level: Criticality }) {
  const tone = level === 'critical' ? 'crit' : level === 'high' ? 'high' : level === 'medium' ? 'medium' : undefined;
  return <Badge tone={tone}>{CRIT_LABEL[level]}</Badge>;
}

function useCountUp(target: number) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (document.documentElement.dataset.motion === 'reduce' || target === 0) { setV(target); return; }
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min((t - t0) / 900, 1);
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

export function StatTile({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'ghost' | 'danger' | 'signal'; hint?: string }) {
  const counted = useCountUp(typeof value === 'number' ? value : 0);
  return (
    <div className="stat" data-tone={tone}>
      <span className="stat-value">{typeof value === 'number' ? counted : value}</span>
      <span className="stat-label">{label}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <div>{children}</div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state state-loading" role="status">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="state">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="state-actions">{actions}</div>}
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      {onRetry && (
        <div className="state-actions">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · GhostGrid`;
  }, [title]);
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/* ----------------------------------------------------------------- dialog */

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog-body">
          <h2 className="dialog-title" id={titleId}>
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onClose={onCancel} title={title}>
      <div className="dim">{children}</div>
      <div className="dialog-foot">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
