import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { APP_NAV } from '../nav';

/** Ctrl/Cmd+K jump-anywhere palette. Keyboard first: type to filter, arrows to move, Enter to go, Esc to close. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    return APP_NAV.filter((n) => !s || `${n.label} ${n.summary}`.toLowerCase().includes(s));
  }, [q]);

  useEffect(() => {
    if (open) { setQ(''); setI(0); requestAnimationFrame(() => input.current?.focus()); }
  }, [open]);
  useEffect(() => setI(0), [q]);
  if (!open) return null;

  const go = (p: string) => { onClose(); nav(p); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setI((v) => Math.min(v + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((v) => Math.max(v - 1, 0)); }
    else if (e.key === 'Enter' && items[i]) go(items[i].path);
  };

  return (
    <div className="cmdk-back" onMouseDown={onClose}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Jump to" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input ref={input} className="cmdk-input" placeholder="Jump to a page…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search pages" />
        <ul className="cmdk-list" role="listbox">
          {items.map((n, k) => (
            <li key={n.path} role="option" aria-selected={k === i} className={k === i ? 'on' : ''} onMouseEnter={() => setI(k)} onClick={() => go(n.path)}>
              <Icon name={n.icon} size={18} />
              <span><b>{n.label}</b><small>{n.summary}</small></span>
            </li>
          ))}
          {!items.length && <li className="cmdk-empty">No page matches “{q}”.</li>}
        </ul>
        <p className="cmdk-foot"><kbd>↑↓</kbd> move <kbd>Enter</kbd> open <kbd>Esc</kbd> close</p>
      </div>
    </div>
  );
}
