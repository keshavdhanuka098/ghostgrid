import { ButtonLink, EmptyState, PageHeader } from '../components/ui';

export default function NotFound() {
  return (
    <div className="content-narrow">
      <PageHeader title="Page not found" />
      <EmptyState
        title="That page does not exist"
        actions={
          <>
            <ButtonLink to="/app/dashboard" variant="primary">
              Go to dashboard
            </ButtonLink>
            <ButtonLink to="/">Back to home</ButtonLink>
          </>
        }
      >
        The address may be mistyped, or the page may have moved.
      </EmptyState>
    </div>
  );
}
