/**
 * A prune and a pull must never overlap on one machine.
 *
 * Written after the vision worker failed to deploy for a month, every time its
 * image had changed, with this and nothing else:
 *
 *   failed to extract layer ... to overlayfs: failed to Lchown
 *   ".../snapshots/135780/fs/usr/lib/x86_64-linux-gnu/libSvtAv1Enc.so.1.4.1"
 *   for UID 0, GID 0: lchown ...: no such file or directory
 *
 * The layer was fine. Updating Places deploys the camera relay and the vision
 * worker at the same moment; the relay is small and was up in ten seconds, and
 * every finished deploy hands back the images nothing is using. The vision
 * worker's image was still being unpacked, so nothing was using it yet - and
 * the prune took the directory it was being unpacked into. An image store is
 * shared by everything on the machine, and "unused" is only true of it while
 * nothing is being fetched or built.
 *
 * So everything that brings an image onto a machine - a pull, a build, a
 * compose up that pulls what it is missing, an import - holds the store open,
 * and a prune waits until nobody does. A prune that is waiting also holds back
 * anything that arrives after it, or a busy machine would never be swept.
 *
 * Kept in this process, which is where every deploy, sweep and button press on
 * a machine starts. Keyed per machine: a prune on one server has no business
 * holding up a pull on another.
 *
 * Server-only.
 */

/** The machine the dashboard's own daemon runs on. */
export const LOCAL_MACHINE = "local";

/** An enrolled server, by the address Polaris reaches it on. */
export function sshMachine(address: string, port: number): string {
    return `ssh:${address.toLowerCase()}:${port}`;
}

/** Thrown when a prune was asked for only if the machine was idle, and it was
 *  not - or when it waited as long as it was willing to. Nothing was removed. */
export class ImageStoreBusy extends Error {
    public constructor() {
        super("An image is being downloaded or built on this machine right now.");
        this.name = "ImageStoreBusy";
    }
}

/**
 * How long a prune that has to happen waits for the machine to go quiet.
 *
 * Long enough to outlast a large pull on a slow line. A pull that is still
 * going after this is more likely stuck than slow, and the prune gives up
 * rather than holding every deploy behind it.
 */
export const PRUNE_WAIT_MS = 15 * 60_000;

interface MachineState {
    using: number;
    pruning: boolean;
    /** Prunes waiting their turn. Anything new waits behind them. */
    waitingPrunes: number;
    wake: Array<() => void>;
}

const machines = new Map<string, MachineState>();

function stateOf(machine: string): MachineState {
    let state = machines.get(machine);
    if (!state) {
        state = { using: 0, pruning: false, waitingPrunes: 0, wake: [] };
        machines.set(machine, state);
    }
    return state;
}

function wakeAll(machine: string, state: MachineState): void {
    const waiting = state.wake;
    state.wake = [];
    for (const wake of waiting) wake();
    if (state.using === 0 && !state.pruning && state.waitingPrunes === 0 && state.wake.length === 0) {
        machines.delete(machine);
    }
}

function nextChange(state: MachineState): Promise<void> {
    return new Promise((resolve) => state.wake.push(resolve));
}

/** Run something that brings an image onto the machine. Waits while a prune is
 *  running or waiting there, and holds any new one off until it is done. */
export async function withImageUse<T>(machine: string, work: () => Promise<T>): Promise<T> {
    const state = stateOf(machine);
    while (state.pruning || state.waitingPrunes > 0) await nextChange(state);
    state.using += 1;
    try {
        return await work();
    } finally {
        state.using -= 1;
        wakeAll(machine, state);
    }
}

/**
 * Run a prune once nothing is fetching or building on the machine.
 *
 * `whenIdle` is for the prunes that are housekeeping rather than rescue - after
 * a deploy, before a pull on a tight disk, on the timer, from the button: when
 * the machine is busy they are skipped rather than queued, since the deploy
 * keeping it busy tidies up after itself when it finishes. Without it the prune
 * waits, up to `waitMs`, which is for the one that a deploy cannot go on
 * without. Either way it throws ImageStoreBusy instead of running over a pull.
 */
export async function withImagePrune<T>(
    machine: string,
    prune: () => Promise<T>,
    options: { whenIdle?: boolean; waitMs?: number } = {}
): Promise<T> {
    const state = stateOf(machine);
    const busy = () => state.using > 0 || state.pruning;
    if (busy() && options.whenIdle) throw new ImageStoreBusy();

    const deadline = Date.now() + (options.waitMs ?? PRUNE_WAIT_MS);
    state.waitingPrunes += 1;
    try {
        while (busy()) {
            const left = deadline - Date.now();
            if (left <= 0) throw new ImageStoreBusy();
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                nextChange(state),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, left);
                })
            ]);
            clearTimeout(timer);
        }
    } catch (error) {
        // Giving up releases whatever queued behind this prune.
        state.waitingPrunes -= 1;
        wakeAll(machine, state);
        throw error;
    }
    state.waitingPrunes -= 1;

    state.pruning = true;
    try {
        return await prune();
    } finally {
        state.pruning = false;
        wakeAll(machine, state);
    }
}
