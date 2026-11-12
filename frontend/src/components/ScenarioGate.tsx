import type { ReactNode } from 'react';
import { useScenarios } from '../state/ScenarioContext';
import type { Scenario } from '../lib/types';
import { ButtonLink, EmptyState, ErrorState, LoadingBlock, PageHeader } from './ui';

/** Renders its children once a scenario is loaded and selected; otherwise the matching loading, error or empty state. */
export function ScenarioGate({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: (scenario: Scenario) => ReactNode;
}) {
  const { status, error, reload, active } = useScenarios();

  if (status === 'loading')
    return (
      <>
        <PageHeader title={title} description={description} />
        <LoadingBlock label="Loading your scenarios…" />
      </>
    );
  if (status === 'error')
    return (
      <>
        <PageHeader title={title} description={description} />
        <ErrorState title="Could not load scenarios" message={error ?? 'Unknown error.'} onRetry={() => void reload()} />
      </>
    );
  if (!active)
    return (
      <>
        <PageHeader title={title} description={description} />
        <EmptyState
          title="No scenario yet"
          actions={
            <>
              <ButtonLink to="/app/scenarios" variant="primary">
                Create a scenario
              </ButtonLink>
            </>
          }
        >
          Every GhostGrid screen works on a scenario: a set of assets and the dependencies between them. Create one in the workspace, or load the illustrative sample from there.
        </EmptyState>
      </>
    );
  return <>{children(active)}</>;
}
