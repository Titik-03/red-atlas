import { Component, type ReactNode } from "react";

/** Catches render/load errors (e.g. a texture that fails to download) so the app never goes blank. */
export class ErrorBoundary extends Component<{ fallback: (e: Error) => ReactNode; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("RED ATLAS view error:", error); }
  render() { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}
