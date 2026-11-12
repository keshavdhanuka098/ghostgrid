import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { CommandPalette } from '../components/CommandPalette';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { LoadingBlock } from '../components/ui';
import { APP_NAV, DASHBOARD, INTEGRATIONS, SETTINGS, WORKFLOW } from '../nav';
import { useScenarios } from '../state/ScenarioContext';

function Nav({ onNavigate }: { onNavigate: () => void }) {
  const link = (item: (typeof APP_NAV)[number]) => (
    <li key={item.path}>
      <NavLink to={item.path} className="nav-link" onClick={onNavigate}>
        <Icon name={item.icon} />
        <span>{item.label}</span>
      </NavLink>
    </li>
  );
  return (
    <nav aria-label="Main">
      <ul className="nav-list">{link(DASHBOARD)}</ul>
      <p className="nav-group eyebrow">Workflow</p>
      <ol className="nav-list nav-numbered">{WORKFLOW.map(link)}</ol>
      <p className="nav-group eyebrow">System</p>
      <ul className="nav-list">{link(INTEGRATIONS)}{link(SETTINGS)}</ul>
    </nav>
  );
}

function ScenarioPicker() {
  const { scenarios, active, setActiveId, status } = useScenarios();
  if (status === 'loading') return <span className="topbar-note dim">Loading scenarios…</span>;
  if (!scenarios.length)
    return (
      <Link className="btn btn-sm" to="/app/scenarios">
        Create your first scenario
      </Link>
    );
  return (
    <div className="picker">
      <label htmlFor="scenario-picker" className="eyebrow">
        Scenario
      </label>
      <select id="scenario-picker" className="select" value={active?.id ?? ''} onChange={(e) => setActiveId(e.target.value)}>
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function AppShell() {
  const [open, setOpen] = useState(false);
  const [cmd, setCmd] = useState(false);
  const { status } = useScenarios();
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Close the drawer and move focus to the page after navigating (not on first load).
  useEffect(() => {
    setOpen(false);
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmd((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const crumb = [DASHBOARD, ...WORKFLOW, INTEGRATIONS, SETTINGS].find((n) => pathname.startsWith(n.path))?.label ?? 'Workspace';

  return (
    <div className="shell">
      <div className="ambient" aria-hidden="true"><i /><i /><i /></div>
      <CommandPalette open={cmd} onClose={() => setCmd(false)} />
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
        Skip to content
      </a>
      <aside className="sidebar" id="sidebar" data-open={open} aria-label="Sidebar">
        <div className="sidebar-head">
          <Link to="/" aria-label="GhostGrid home">
            <Logo />
          </Link>
          <button className="btn btn-ghost btn-icon sidebar-close" onClick={() => setOpen(false)} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>
        <Nav onNavigate={() => setOpen(false)} />
        <p className="sidebar-note">Prototype decision-support tool. Not a certified safety system.</p>
      </aside>
      {open && <button className="scrim" aria-label="Close menu" tabIndex={-1} onClick={() => setOpen(false)} />}

      <div className="shell-main">
        <header className="topbar">
          <button
            className="btn btn-ghost btn-icon menu-btn"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="sidebar"
          >
            <Icon name="menu" />
          </button>
          <Link to="/" className="topbar-logo" aria-label="GhostGrid home">
            <Logo size={26} />
          </Link>
          <p className="crumb" aria-hidden="true"><span>Ghostgrid</span><i>/</i><b key={crumb}>{crumb}</b></p>
          <ScenarioPicker />
          <button type="button" className="cmdk-btn" onClick={() => setCmd(true)} aria-label="Open command palette">
            <Icon name="investigate" size={15} /><span>Jump to…</span><kbd>Ctrl K</kbd>
          </button>
          <span className="topbar-status" data-state={status}>
            <i aria-hidden="true" />
            {status === 'ready' ? 'Local server connected' : status === 'error' ? 'Server unreachable' : 'Connecting…'}
          </span>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1} className="content">
          <ErrorBoundary resetKey={pathname}>
            <Suspense fallback={<LoadingBlock label="Loading page…" />}>
              <div key={pathname} className="page-enter"><Outlet /></div>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
