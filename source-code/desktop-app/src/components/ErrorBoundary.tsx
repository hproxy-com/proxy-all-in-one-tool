import { Component, type ErrorInfo, type ReactNode } from "react";

/* Catches a render crash and shows something a human can act on.
 *
 * Without this, an exception anywhere in the tree unmounts the whole app and
 * leaves a BLANK WINDOW. Not an error, not a hint, just an empty frame the user
 * has to force-quit. In a browser you would at least have devtools; in a
 * shipped desktop app there is nothing, and the bug report reads "it went
 * white", which is unactionable.
 *
 * So: say what happened, write it to the log file so it can actually be
 * diagnosed, and offer a way back that does not involve restarting. */

type Props = { children: ReactNode };
type State = { error: Error | null; info: string | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack ?? null });
    // Into the rotating log file, so a user can send something useful.
    void import("@tauri-apps/plugin-log")
      .then(({ error: logError }) =>
        logError(`UI crash: ${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`),
      )
      .catch(() => {
        /* running in a plain browser, or the plugin is unavailable */
      });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const report = `${error.message}\n\n${error.stack ?? ""}\n${info ?? ""}`.trim();

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas px-6 py-10 text-center">
        <div className="w-full max-w-[560px] rounded-xl border border-hairline bg-surface p-6 text-left">
          <h1 className="text-[17px] font-bold text-ink">Something in the interface crashed</h1>
          <p className="mt-1.5 text-[14px] font-medium text-ink-mute">
            Your proxies and results were not sent anywhere. The details below are also written to
            the app&rsquo;s log file.
          </p>

          <pre className="num mt-4 max-h-52 overflow-auto rounded-lg border border-hairline bg-canvas p-3 text-[12px] leading-relaxed text-ink-mute">
            {report}
          </pre>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null, info: null })}
              className="rounded-lg bg-digi px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-digi-deep"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-hairline px-4 py-2 text-[13px] font-bold text-ink/70 transition-colors hover:border-digi hover:text-digi"
            >
              Reload the app
            </button>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(report).catch(() => {})}
              className="rounded-lg border border-hairline px-4 py-2 text-[13px] font-bold text-ink/70 transition-colors hover:border-digi hover:text-digi"
            >
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
