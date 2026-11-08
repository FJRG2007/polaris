// js/build-slice.js
// Cooperative slicing of the start-up builders. The game shares the main thread with the page that frames it (a call,
// the arcade), so a builder that runs for hundreds of milliseconds freezes that page too: each long loop calls
// buildSlice(), which hands the thread back once the current slice has run for the build budget. Yielding is a plain
// task, not scheduler.yield(), whose continuation would run ahead of the host's progress messages. A hidden tab clamps
// chained timers to a second or more, so there the slice yields through a message port, which is not throttled

let budget = 45;
let now = () => performance.now();
let timerTask = () => new Promise((resolve) => setTimeout(resolve, 0));
let portTask = () =>
  new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
let yieldTask = () =>
  typeof document !== 'undefined' && document.hidden && typeof MessageChannel === 'function' ? portTask() : timerTask();
let sliceStart = now();

/** Milliseconds a builder may run before it hands the thread back. */
export function setBuildBudget(ms) {
  budget = ms;
}

/** Swaps the clock and the yield (tests); omitted fields keep their current value. */
export function setBuildScheduler(scheduler = {}) {
  if (scheduler.now) now = scheduler.now;
  if (scheduler.yieldTask) yieldTask = scheduler.yieldTask;
  sliceStart = now();
}

/** Hands the thread back unconditionally and starts a new slice. */
export async function yieldToHost() {
  await yieldTask();
  sliceStart = now();
}

/** Hands the thread back when the current slice has used up the budget. */
export async function buildSlice() {
  if (now() - sliceStart >= budget) await yieldToHost();
}
