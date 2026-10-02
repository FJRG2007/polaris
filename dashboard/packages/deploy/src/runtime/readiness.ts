/**
 * Whether a release that just started is actually serving.
 *
 * `docker compose up` returns as soon as the container exists. A container that
 * exists and then exits on a missing variable, or crash-loops on a bad migration,
 * used to be recorded as a successful deploy and promoted - so the edge moved to
 * it and the service went down. The deploy now waits for the container to prove
 * itself before it counts: healthy by its own healthcheck where it has one, and
 * otherwise running for a few seconds without being restarted.
 *
 * When the release runs beside the one before it (see `sideBySide` in the
 * dashboard), a failure here leaves the previous release serving and nothing is
 * lost. When it replaced it in place, the failure is at least named, with the
 * lines the container printed, instead of a green badge over a dead service.
 */

import { parseContainerState } from "./status.js";
import type { AppDeployPlan, RuntimeContext } from "./driver.js";

/** How long a container without a healthcheck has to stay up to count. */
const STEADY_MS = 5_000;

/** How often the container is asked how it is. */
const POLL_MS = 1_500;

/** The longest any wait goes on, whatever a healthcheck's own timings say. */
const CEILING_MS = 10 * 60_000;

/** How long to wait for one release: its healthcheck's own worst case, or a
 *  short window for a container that only has to stay up. */
export function readinessDeadlineMs(plan: Pick<AppDeployPlan, "healthcheck">): number {
    const health = plan.healthcheck;
    if (!health) return 45_000;
    const interval = (health.intervalSeconds ?? 30) * 1000;
    const retries = health.retries ?? 3;
    const start = (health.startPeriodSeconds ?? 0) * 1000;
    return Math.min(CEILING_MS, start + interval * (retries + 1) + 15_000);
}

export type Readiness = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Wait for `container` to be serving, or say why it is not.
 *
 * A machine that cannot be asked - the inspect answers nothing a container
 * would - is taken at its word, the same as before this existed. `sleep` and
 * `now` are injectable so the waiting can be tested without waiting.
 */
export async function waitUntilServing(
    ctx: RuntimeContext,
    container: string,
    plan: Pick<AppDeployPlan, "healthcheck">,
    clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    }
): Promise<Readiness> {
    // A port that cannot inspect at all has nothing to judge the release by.
    if (typeof ctx.ports.inspect !== "function") return { ok: true };
    const deadline = clock.now() + readinessDeadlineMs(plan);
    let firstRestarts: number | null = null;
    let seen = false;
    for (;;) {
        const state = await Promise.resolve()
            .then(() => ctx.ports.inspect(container))
            .then(parseContainerState)
            .catch(() => null);
        if (state && state.status !== "unknown") {
            seen = true;
            if (firstRestarts === null) firstRestarts = state.restartCount;
            if (state.status === "exited" || state.status === "dead") {
                return {
                    ok: false,
                    reason: `the new version stopped${state.exitCode !== undefined ? ` with exit code ${state.exitCode}` : ""} as soon as it started`
                };
            }
            if (state.restartCount > firstRestarts || state.restarting) {
                return { ok: false, reason: "the new version keeps restarting" };
            }
            if (state.health === "unhealthy") {
                return { ok: false, reason: "the new version's healthcheck reports it unhealthy" };
            }
            if (state.health === "healthy") return { ok: true };
            if (state.health === undefined && state.status === "running") {
                const started = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
                if (Number.isFinite(started) && clock.now() - started >= STEADY_MS) return { ok: true };
            }
        } else if (state && !seen) {
            // Not a container's answer at all: an engine or a stand-in that does not
            // report state. Nothing here can judge it, so it is not held up.
            return { ok: true };
        }
        if (clock.now() >= deadline) {
            if (state?.health === "starting") {
                return {
                    ok: false,
                    reason: `the new version did not report healthy within ${Math.round(readinessDeadlineMs(plan) / 1000)} seconds`
                };
            }
            if (!seen) return { ok: false, reason: "the new version's container never appeared" };
            // Running, with no healthcheck to say more: that is all anybody can ask of it.
            return { ok: true };
        }
        await clock.sleep(POLL_MS);
    }
}

/** How long a release has to start listening on its port, on top of coming up. A
 *  cold JVM or a first migration can take a couple of minutes; a wedge cannot hide
 *  behind this for longer. */
export const PORT_DEADLINE_MS = 3 * 60_000;

/** What the container's own socket tables say about one port. */
export type PortState = "listening" | "loopback" | "closed";

/** Hex `0100007F` / `00000000000000000000000001000000` -> whether it is a loopback
 *  address, as `/proc/net/tcp{,6}` writes them (each 32-bit word little-endian). */
function isLoopbackHex(address: string): boolean {
    if (address.length === 8) return address.endsWith("7F");
    if (address.length === 32) {
        // ::1, and ::ffff:127.x.x.x (an IPv4 loopback seen through the v6 table).
        if (address === "00000000000000000000000001000000") return true;
        return address.startsWith("0000000000000000FFFF0000") && address.endsWith("7F");
    }
    return false;
}

/**
 * Whether `/proc/net/tcp` and `/proc/net/tcp6` (concatenated, as `cat` prints them)
 * hold a listening socket on `port` that a peer on the network can reach. A socket
 * bound to loopback only is reported apart, because it is the one failure that
 * looks like success from inside: the program says it is serving, and nothing
 * outside the container can open it.
 */
export function portStateFrom(table: string, port: number): PortState {
    const wanted = port.toString(16).toUpperCase().padStart(4, "0");
    let loopback = false;
    for (const line of table.split("\n")) {
        const fields = line.trim().split(/\s+/);
        // sl local_address rem_address st ...; 0A is LISTEN.
        if (fields.length < 4 || fields[3] !== "0A") continue;
        const [address, hexPort] = (fields[1] ?? "").split(":");
        if (!address || hexPort?.toUpperCase() !== wanted) continue;
        if (!isLoopbackHex(address.toUpperCase())) return "listening";
        loopback = true;
    }
    return loopback ? "loopback" : "closed";
}

export type PortReadiness = Readiness | { readonly ok: true; readonly unchecked: true };

/**
 * Wait until `container` accepts connections on `port`, read from the container's
 * own socket tables - no network position needed, so it is the same check on this
 * host and on a server reached over SSH, and it needs nothing in the image beyond
 * `cat`. An image without one (distroless, scratch) cannot be looked into; that is
 * said, and the release is taken as up on the checks it has already passed.
 */
export async function waitUntilListening(
    ctx: RuntimeContext,
    container: string,
    port: number,
    clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    },
    deadlineMs = PORT_DEADLINE_MS
): Promise<PortReadiness> {
    if (typeof ctx.ports.runIn !== "function") return { ok: true, unchecked: true };
    const deadline = clock.now() + deadlineMs;
    let last: PortState = "closed";
    for (;;) {
        const read = await Promise.resolve()
            .then(() => ctx.ports.runIn(container, ["cat", "/proc/net/tcp", "/proc/net/tcp6"]))
            .catch(() => null);
        // `cat` exits 1 when one of the two tables is missing (no IPv6) but still
        // prints the other, so the output is what decides, not the code.
        if (!read || !/\blocal_address\b/.test(read.output)) {
            return { ok: true, unchecked: true };
        }
        last = portStateFrom(read.output, port);
        if (last === "listening") return { ok: true };
        if (clock.now() >= deadline) break;
        await clock.sleep(POLL_MS);
    }
    return {
        ok: false,
        reason:
            last === "loopback"
                ? `the new version listens on port ${port} on localhost only, so nothing outside its container can reach it - have it listen on 0.0.0.0`
                : `the new version did not start listening on port ${port} within ${Math.round(deadlineMs / 1000)} seconds - check the port it serves on`
    };
}

/** The last lines a container printed, into the deploy log, so a release that
 *  did not come up says why in the place somebody is already reading. */
export async function tailIntoLog(ctx: RuntimeContext, container: string, lines = 40): Promise<void> {
    ctx.log(Buffer.from(`==> The last ${lines} lines it printed:\n`));
    await ctx.ports.logs(container, (chunk) => ctx.log(chunk), { tail: lines }).catch(() => {
        ctx.log(Buffer.from("(its output could not be read)\n"));
    });
}
