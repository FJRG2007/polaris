/**
 * The push window: pick the folder and platform, then watch the build, the
 * upload and the deployment in one place.
 */

import { available, byId, say } from "./dom";
import type { PushPhase, PushState } from "@/shared/bridge";

const ORDER: PushPhase[] = ["checking", "building", "saving", "sending", "deploying"];
const RUNNING = new Set<PushPhase>(ORDER);
/** Most of a build's output worth keeping on screen. */
const MAX_LOG = 400_000;

const title = byId<HTMLHeadingElement>("title");
const subtitle = byId<HTMLParagraphElement>("subtitle");
const folder = byId<HTMLParagraphElement>("folder");
const choose = byId<HTMLButtonElement>("choose");
const platform = byId<HTMLSelectElement>("platform");
const steps = byId<HTMLOListElement>("steps");
const progress = byId<HTMLProgressElement>("progress");
const result = byId<HTMLParagraphElement>("result");
const log = byId<HTMLPreElement>("log");
const open = byId<HTMLButtonElement>("open");
const cancel = byId<HTMLButtonElement>("cancel");
const start = byId<HTMLButtonElement>("start");

let state: PushState | null = null;
/** The last step the push was on. */
let reached: PushPhase | null = null;

function render(next: PushState): void {
    state = next;
    const running = RUNNING.has(next.phase);
    title.textContent = `Push ${next.service}`;
    subtitle.textContent = next.server
        ? `Built here with Docker, then deployed to ${new URL(next.server).host} as the next release.`
        : "Built here with Docker, then deployed as the next release.";
    folder.textContent = next.folder || "None chosen";
    folder.title = next.folder;
    if (document.activeElement !== platform) platform.value = next.platform;
    choose.disabled = running;
    platform.disabled = running;
    cancel.hidden = !running;
    cancel.textContent = next.phase === "deploying" ? "Stop following" : "Cancel";
    start.hidden = running;
    start.textContent = next.phase === "ready" ? "Build and deploy" : "Push again";
    available(start, Boolean(next.folder) && !running);
    open.hidden = !(next.phase === "done" || next.phase === "failed" || next.phase === "cancelled");
    progress.hidden = next.phase !== "sending";

    // A push that stopped keeps showing the step it stopped at.
    if (running) reached = next.phase;
    else if (next.phase === "ready") reached = null;
    const at = reached ? ORDER.indexOf(reached) : -1;
    const stopped = next.phase === "failed" || next.phase === "cancelled";
    for (const item of steps.querySelectorAll<HTMLLIElement>("li")) {
        const index = ORDER.indexOf(item.dataset.phase as PushPhase);
        if (next.phase === "done" || index < at) item.dataset.state = "done";
        else if (index === at) item.dataset.state = stopped ? next.phase : "current";
        else item.dataset.state = "";
    }
}

function append(text: string): void {
    const stuck = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    log.textContent = `${log.textContent ?? ""}${text}\n`.slice(-MAX_LOG);
    if (stuck) log.scrollTop = log.scrollHeight;
}

window.polarisLocal.push.onEvent((event) => {
    if (event.kind === "state") render(event.state);
    else if (event.kind === "line") append(event.text);
    else if (event.kind === "progress") {
        progress.max = event.total || 1;
        progress.value = event.sent;
    } else {
        result.className = `banner ${event.ok ? "good" : "bad"}`;
        say(result, event.message);
    }
});

choose.addEventListener("click", () => void window.polarisLocal.push.chooseFolder());

start.addEventListener("click", () => {
    if (!state?.folder || RUNNING.has(state.phase)) return;
    log.textContent = "";
    say(result, null);
    void window.polarisLocal.push.start({ platform: platform.value }).then((outcome) => {
        // A refusal before anything ran (no folder, a push already going) has no
        // result event of its own.
        if (!outcome.ok && state && !RUNNING.has(state.phase) && result.hidden) {
            result.className = "banner bad";
            say(result, outcome.error);
        }
    });
});

cancel.addEventListener("click", () => void window.polarisLocal.push.cancel());
open.addEventListener("click", () => void window.polarisLocal.push.openService());

void window.polarisLocal.push.state().then((initial) => {
    if (initial) render(initial);
});
