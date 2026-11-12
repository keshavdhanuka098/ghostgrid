import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IntegrationsSummary } from '../components/integrations/IntegrationsSummary';
import { Alert, Button, ConfirmDialog, PageHeader, SelectField } from '../components/ui';
import { describeError, useScenarios } from '../state/ScenarioContext';
import { useSettings, type Density, type MotionPref } from '../state/SettingsContext';
import { useToast } from '../state/ToastContext';

export default function Settings() {
  const s = useSettings();
  const { scenarios, status, resetAll, reload } = useScenarios();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const wipe = async () => {
    setBusy(true);
    try {
      await resetAll();
      toast.success('All scenarios deleted.');
      setConfirm(false);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" description="Preferences are saved in this browser. Scenario data is saved by the local GhostGrid server." />

      <div className="settings-grid">
        <section className="card" aria-labelledby="set-display">
          <h2 id="set-display" className="card-title">
            Display
          </h2>
          <div className="stack">
            <SelectField
              label="Motion"
              value={s.motion}
              hint={s.reducedMotion ? 'Animations are currently reduced.' : 'Animations are currently on.'}
              onChange={(e) => {
                s.setMotion(e.target.value as MotionPref);
                toast.success('Motion preference saved.');
              }}
            >
              <option value="system">Follow system setting</option>
              <option value="reduce">Reduce motion</option>
              <option value="full">Allow all motion</option>
            </SelectField>
            <SelectField
              label="Density"
              value={s.density}
              hint="Compact tightens spacing and control height."
              onChange={(e) => {
                s.setDensity(e.target.value as Density);
                toast.success('Density saved.');
              }}
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </SelectField>
            <div className="row-actions">
              <Button
                onClick={() => {
                  s.resetPrefs();
                  toast.success('Display preferences reset.');
                }}
              >
                Reset display preferences
              </Button>
              <Button
                onClick={() => {
                  s.replayIntro();
                  navigate('/');
                }}
              >
                Replay intro animation
              </Button>
            </div>
          </div>
        </section>

        <section className="card" aria-labelledby="set-data">
          <h2 id="set-data" className="card-title">
            Data
          </h2>
          <div className="stack">
            {status === 'error' ? (
              <Alert tone="error">
                The server could not be reached, so saved scenarios are unavailable.{' '}
                <button className="link-btn" onClick={() => void reload()}>
                  Retry
                </button>
              </Alert>
            ) : (
              <p>
                {status === 'loading' ? 'Loading…' : `${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} stored`} in the SQLite database (<code>data/ghostgrid.db</code> by default) on the machine running GhostGrid.
              </p>
            )}
            <Button variant="danger" onClick={() => setConfirm(true)} disabled={status !== 'ready' || scenarios.length === 0}>
              Delete all scenarios
            </Button>
          </div>
        </section>

        <IntegrationsSummary />

        <section className="card" aria-labelledby="set-about">
          <h2 id="set-about" className="card-title">
            About
          </h2>
          <p>
            GhostGrid is a prototype decision-support tool for exploring infrastructure dependencies. It is <strong>not a certified safety system</strong>. Results reflect only the dependencies that have been mapped and a simplified failure model, and should inform, not replace, engineering review.
          </p>
          <p className="dim">Version 0.2 · Part 2 of 4: data model, persistence and dependency graph.</p>
        </section>
      </div>

      <ConfirmDialog open={confirm} danger busy={busy} title="Delete all scenarios?" confirmLabel="Delete everything" onCancel={() => setConfirm(false)} onConfirm={() => void wipe()}>
        <p>
          This permanently deletes {scenarios.length} scenario{scenarios.length === 1 ? '' : 's'}, including their assets, dependencies, saved runs and strategies. This cannot be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
