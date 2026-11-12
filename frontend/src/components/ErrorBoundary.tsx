import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './ui';

interface Props {
  children: ReactNode;
  /** Changing this value clears a caught error (pass the pathname so navigating away recovers the page). */
  resetKey?: unknown;
}

/**
 * Catches render errors below it so one broken page shows a recoverable message instead of a blank screen.
 * Saved data lives on the server, so reloading is always safe.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('GhostGrid render error:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorState
        title="This page hit a problem"
        message="Something unexpected broke while drawing this page. Your saved scenarios are safe on the server. Try again, or reload the app."
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}
