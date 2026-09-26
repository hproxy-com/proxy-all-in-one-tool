import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  CHECK_INTERVAL_MS,
  QUIET_INSTALL_EVERY_MS,
  checkForUpdate,
  dismissUpdate,
  getUpdateState,
  installWhileNobodyUses,
  openManualDownload,
  pillLabel,
  restartToUpdate,
  retryUpdate,
  subscribeUpdateState,
} from "../lib/updater";
import { isCheckRunning, subscribeCheckRunning } from "../lib/runState";
import { channelWay, checkVersions, getVersionNotice, skipNotice, subscribeVersionNotice, type Notice } from "../lib/versions";
import { Button } from "./ui";

/* The update surface.
 *
 * Nothing renders until a newer version is downloaded and ready. No modal on
 * launch, no toast, no "you're up to date" dialog, nothing during the download.
 * Interrupting someone to report an absence of news is how update prompts
 * become the thing people dismiss without reading, and then they dismiss the
 * one that mattered too.
 *
 * When the bytes are ready: one pill in the title bar opens a sheet that says
 * what changed and offers one button, Restart to update. The restart is always
 * the person's click, and a running check is named before they take it. */
export default function UpdatePanel() {
  const state = useSyncExternalStore(subscribeUpdateState, getUpdateState, getUpdateState);
  const notice = useSyncExternalStore(subscribeVersionNotice, getVersionNotice, getVersionNotice);
  const running = useSyncExternalStore(subscribeCheckRunning, isCheckRunning, () => false);
  const [open, setOpen] = useState(false);

  // The download from hproxy.com updates itself; every copy also reads the version list, which
  // is how a store's copy learns of a new version and any copy learns it is below the minimum.
  const look = useCallback(() => {
    void checkForUpdate();
    void checkVersions();
  }, []);

  useEffect(() => {
    // Delayed so the check never competes with first paint, then repeated:
    // this app stays open all day, and a launch-only check means a long session
    // never learns a fix exists.
    const first = window.setTimeout(look, 2500);
    const repeat = window.setInterval(look, CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, [look]);

  // A downloaded update installs itself while nobody is using the app (the
  // window in the tray, nothing connected, no check, no AI assistant's tool).
  // Not at once: someone who just closed the window may open it again.
  const downloaded = state.stage === "ready";
  useEffect(() => {
    if (!downloaded) return;
    const attempt = () => void installWhileNobodyUses(isCheckRunning());
    const first = window.setTimeout(attempt, 60_000);
    const repeat = window.setInterval(attempt, QUIET_INSTALL_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, [downloaded]);

  const label = pillLabel(state);
  const info = state.info;
  if (!label || !info) return notice && notice.channel !== "hproxy.com" ? <ChannelNotice notice={notice} /> : null;

  const ready = state.stage === "ready";
  const installing = state.stage === "installing";
  const failed = state.stage === "failed";
  // Below the version list's minimum this update cannot be skipped.
  const required = notice?.channel === "hproxy.com" && notice.verdict.required;

  return (
    <div className="relative">
      <Button
        size="sm"
        variant={failed ? "danger" : "solid"}
        onClick={() => setOpen((v) => !v)}
        title={`Version ${info.version} is ready to install`}
      >
        {required && ready ? "Update required" : label}
      </Button>

      {open && (
        <>
          {/* Click-away. A panel you cannot dismiss by looking elsewhere is a
              modal wearing a disguise. */}
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div className="ux-sheet rise-in absolute right-0 top-11 z-50 w-[380px] !rounded-[1.1em] p-5">
            <p className="text-[17px] font-black text-ink">
              {failed ? "The update could not be installed" : `Version ${info.version} is ready`}
            </p>
            <p className="num mt-1 text-[13px] font-bold text-ink-mute">
              You have {info.currentVersion}
              {info.date ? ` · released ${info.date.slice(0, 10)}` : ""}
              {ready || installing ? " · downloaded and verified" : ""}
            </p>

            {/* What changed. Asking someone to restart their tool for an
                unspecified reason is how updates get postponed forever. */}
            {info.notes && !failed && (
              <p className="ux-divider mt-4 max-h-44 overflow-y-auto whitespace-pre-wrap border-t pt-4 text-[14px] font-semibold leading-relaxed text-ink-mute">
                {info.notes}
              </p>
            )}

            {failed && <p className="mt-4 text-[14px] font-bold text-danger">{state.error}</p>}

            {/* THE guard. Restarting mid-run throws away every result the person
                has been waiting on. Say so, and let them finish first. */}
            {ready && running && (
              <p className="mt-4 text-[14px] font-bold text-warn">A check is still running. Restarting now would discard its results.</p>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {(ready || installing) && (
                <>
                  <Button variant={running ? "danger" : "solid"} disabled={installing} onClick={() => void restartToUpdate()}>
                    {installing ? "Restarting" : running ? "Restart anyway" : "Restart to update"}
                  </Button>
                  {!installing && (
                    <>
                      <Button onClick={() => setOpen(false)}>Later</Button>
                      {!required && (
                        <span className="ml-auto">
                          <Button
                            variant="text"
                            size="sm"
                            onClick={() => {
                              setOpen(false);
                              void dismissUpdate();
                            }}
                          >
                            Skip this version
                          </Button>
                        </span>
                      )}
                    </>
                  )}
                </>
              )}

              {failed && (
                <>
                  <Button variant="solid" onClick={() => void retryUpdate()}>
                    Try again
                  </Button>
                  <Button onClick={() => void openManualDownload()}>Download it manually</Button>
                  {!required && (
                    <span className="ml-auto">
                      <Button
                        variant="text"
                        size="sm"
                        onClick={() => {
                          setOpen(false);
                          void dismissUpdate();
                        }}
                      >
                        Not now
                      </Button>
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* A newer version for a copy that its store or its owner updates (lib/versions.ts): the same
   pill, and a sheet that says what changed and gives this channel's own way to get it. Below
   the version list's minimum the update is required: the pill turns red, says so, and the
   sheet has nothing to skip it with. On a phone the pill says just "Update" and the sheet
   spans the screen. */
function ChannelNotice({ notice }: { notice: Notice }) {
  const [open, setOpen] = useState(false);
  const way = channelWay(notice.channel);
  const { verdict } = notice;
  if (!way || !verdict.newer) return null;

  return (
    <div className="relative">
      <Button
        size="sm"
        variant={verdict.required ? "danger" : "solid"}
        onClick={() => setOpen((v) => !v)}
        title={`Version ${verdict.newer} is out`}
      >
        <span className="max-sm:hidden">{verdict.required ? "Update required" : "Update available"}</span>
        <span className="sm:hidden">Update</span>
      </Button>

      {open && (
        <>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div className="ux-sheet rise-in absolute right-0 top-11 z-50 w-[380px] !rounded-[1.1em] p-5 max-sm:fixed max-sm:inset-x-3 max-sm:top-[58px] max-sm:w-auto">
            <p className="text-[17px] font-black text-ink">
              {verdict.required ? `Version ${verdict.newer} is required` : `Version ${verdict.newer} is out`}
            </p>
            <p className="num mt-1 text-[13px] font-bold text-ink-mute">
              You have {verdict.current}
              {verdict.date ? ` · released ${verdict.date.slice(0, 10)}` : ""}
            </p>

            {verdict.required && (
              <p className="mt-4 text-[14px] font-bold text-danger">Your version no longer works as it should. Update to keep using HProxy.</p>
            )}

            {verdict.notes && (
              <p className="ux-divider mt-4 max-h-44 overflow-y-auto whitespace-pre-wrap border-t pt-4 text-[14px] font-semibold leading-relaxed text-ink-mute">
                {verdict.notes}
              </p>
            )}

            <p className="mt-4 text-[14px] font-semibold text-ink-mute">{way.line}</p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button variant="solid" onClick={() => void way.run()}>
                {way.button}
              </Button>
              {!verdict.required && (
                <>
                  <Button onClick={() => setOpen(false)}>Later</Button>
                  <span className="ml-auto">
                    <Button
                      variant="text"
                      size="sm"
                      onClick={() => {
                        setOpen(false);
                        skipNotice();
                      }}
                    >
                      Skip this version
                    </Button>
                  </span>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
