import { Component, type ReactNode } from "react";

interface LazyLoadBoundaryProps {
	children: ReactNode;
	fallback: ReactNode;
	resetKey?: string | boolean | null;
}

interface LazyLoadBoundaryState {
	hasError: boolean;
}

/** Keeps a failed deferred feature local so the rest of the mailbox stays usable. */
export default class LazyLoadBoundary extends Component<
	LazyLoadBoundaryProps,
	LazyLoadBoundaryState
> {
	state: LazyLoadBoundaryState = { hasError: false };

	static getDerivedStateFromError(): LazyLoadBoundaryState {
		return { hasError: true };
	}

	componentDidUpdate(previousProps: LazyLoadBoundaryProps) {
		if (
			this.state.hasError &&
			previousProps.resetKey !== this.props.resetKey
		) {
			this.setState({ hasError: false });
		}
	}

	render() {
		return this.state.hasError ? this.props.fallback : this.props.children;
	}
}
