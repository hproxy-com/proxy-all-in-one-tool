/* A one-bit store: is a check currently running?
 *
 * The updater needs this. Installing an update relaunches the app, and doing
 * that while a run is in flight throws away every result the user has been
 * waiting on — potentially an hour of checking. An updater that can destroy
 * your work because you clicked the wrong thing at the wrong moment is worse
 * than no updater.
 *
 * Deliberately a module-level store rather than context: exactly one producer
 * (the checker console) and one consumer (the update panel), sitting on opposite
 * sides of the tree. Threading a provider through the whole app to carry a
 * boolean would be more machinery than the problem deserves.
 */

let running = false;
const listeners = new Set<() => void>();

export function setCheckRunning(value: boolean): void {
  if (running === value) return;
  running = value;
  listeners.forEach((fn) => fn());
}

export function isCheckRunning(): boolean {
  return running;
}

export function subscribeCheckRunning(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
