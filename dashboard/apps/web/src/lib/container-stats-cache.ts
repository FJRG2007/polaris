/**
 * The last usage sample taken from every container, kept in the server so a
 * screen never has to wait for one.
 *
 * Docker answers `stats?stream=false` by holding the request open for about a
 * second: a CPU percentage is the comparison between two samples and the daemon
 * takes the second one before it replies. That is per container, so a host with
 * a dozen running ones costs seconds of waiting before a listing can be sent -
 * on every poll, for numbers that were read five seconds earlier.
 *
 * So sampling comes off the request path. A request answers with whatever was
 * last sampled and how old it is, and starts a refresh when that has aged out;
 * the fresh numbers arrive on a later poll. One refresh runs per host at a time,
 * because a pass that is slower than the poll interval would otherwise stack up
 * passes against the same engine.
 *
 * Nothing here is an authorization decision. The cache is keyed by connection
 * id, and a caller has established that it may reach that connection - through
 * `authorizeConnection`, which settles ownership whether or not the route goes
 * on to open a driver - before it ever asks for a sample.
 */

import type { ContainerStats } from "@polaris/docker";
import { withDockerDriver } from "@/lib/container-service";

export interface StatsSample {
    readonly stats: ContainerStats;
    /** When the engine answered, so a reader can say how old the number is. */
    readonly at: number;
}

/** How old a sample may be before a read starts a refresh behind it. Just under
 *  the five-second poll, so a watching screen keeps one pass in flight without
 *  ever waiting for it. */
export const STATS_TTL_MS = 4_000;

/** A host nobody has looked at for this long is dropped, so a machine that was
 *  visited once does not hold its containers' samples for the process's life. */
const IDLE_EVICT_MS = 10 * 60_000;

/** One container as the sampler needs it: what to ask the engine for, and the
 *  names a reader may come back with. */
export interface StatsTarget {
    readonly id: string;
    readonly name?: string;
}

interface HostSamples {
    /** Keyed by container id AND by name: a listing knows the id, a container's
     *  own page is addressed by name, and both must hit the same sample. */
    samples: Map<string, StatsSample>;
    /** The pass in flight, if there is one. */
    refreshing: Promise<void> | null;
    touched: number;
}

/**
 * Held on globalThis rather than in a module binding: a dev server re-evaluates
 * the module on edit, and a fresh Map would throw away every sample taken so far
 * on each save.
 */
const REGISTRY = Symbol.for("polaris.containers.stats");

function registry(): Map<string, HostSamples> {
    const holder = globalThis as { [REGISTRY]?: Map<string, HostSamples> };
    if (!holder[REGISTRY]) holder[REGISTRY] = new Map();
    return holder[REGISTRY];
}

function hostSamples(connectionId: string): HostSamples {
    const all = registry();
    evictIdle(all);
    const existing = all.get(connectionId);
    if (existing) {
        existing.touched = Date.now();
        return existing;
    }
    const created: HostSamples = { samples: new Map(), refreshing: null, touched: Date.now() };
    all.set(connectionId, created);
    return created;
}

function evictIdle(all: Map<string, HostSamples>): void {
    const cutoff = Date.now() - IDLE_EVICT_MS;
    for (const [connectionId, entry] of all) {
        if (entry.touched < cutoff && !entry.refreshing) all.delete(connectionId);
    }
}

/** Every sample held for a host, keyed by container id and by name. */
export function cachedSamples(connectionId: string): ReadonlyMap<string, StatsSample> {
    return hostSamples(connectionId).samples;
}

/** The last sample for one container, by id or by name. */
export function cachedSample(connectionId: string, ref: string): StatsSample | null {
    return hostSamples(connectionId).samples.get(ref) ?? null;
}

/** Record a sample under every name the container answers to. */
export function rememberSample(connectionId: string, aliases: readonly string[], stats: ContainerStats): void {
    const entry = hostSamples(connectionId);
    const sample: StatsSample = { stats, at: Date.now() };
    for (const alias of aliases) {
        if (alias) entry.samples.set(alias, sample);
    }
}

/**
 * How old a set of samples is, as one instant: when the oldest of them was
 * taken, and null as soon as one of them is missing.
 *
 * The oldest rather than the freshest, because this answers "is any of this out
 * of date" for the whole set. Keying off the freshest lets one warm container -
 * a container page polling its own sample, say - stand in for every other one on
 * the host, so the refresh never runs and numbers nobody has re-read pass for
 * live. A ref with no sample at all is older than any instant, so it is null:
 * a container that has just started has nothing to be fresh about.
 *
 * An instant rather than an age: a reader may be holding this answer from a
 * previous visit, and only an instant stays true when it does.
 */
export function oldestSampleAt(samples: ReadonlyMap<string, StatsSample>, refs: readonly string[]): number | null {
    let oldest: number | null = null;
    for (const ref of refs) {
        const at = samples.get(ref)?.at;
        if (at === undefined) return null;
        if (oldest === null || at < oldest) oldest = at;
    }
    return oldest;
}

/**
 * Sample a host's containers, off the request that asked for it.
 *
 * Single-flight per host: a second caller while a pass is running joins nothing
 * and starts nothing, because the pass already in flight is about to write the
 * numbers it would have asked for. A failure is swallowed - the samples on
 * screen stay as they were, and the listing call that runs beside this one is
 * what tells a watcher the engine has stopped answering.
 *
 * `prune` drops the samples of containers the caller no longer lists, so a host
 * that has been running for weeks does not accumulate the dead.
 */
export function refreshSamples(
    connectionId: string,
    userId: string,
    targets: readonly StatsTarget[],
    options: { prune?: boolean } = {}
): void {
    const entry = hostSamples(connectionId);
    if (entry.refreshing) return;
    if (targets.length === 0) {
        if (options.prune) entry.samples.clear();
        return;
    }

    entry.refreshing = withDockerDriver(connectionId, userId, async (driver) => {
        const byId = await driver.statsMany(targets.map((target) => target.id));
        if (options.prune) {
            const live = new Set(targets.flatMap((target) => [target.id, target.name ?? ""]));
            for (const alias of [...entry.samples.keys()]) {
                if (!live.has(alias)) entry.samples.delete(alias);
            }
        }
        for (const target of targets) {
            const stats = byId.get(target.id);
            // A container that stopped mid-pass has no sample. Its last one is
            // left alone: the listing already reports it as not running, and the
            // number it was at when it stopped is more use than a blank.
            if (stats) rememberSample(connectionId, [target.id, target.name ?? ""], stats);
        }
    })
        .catch(() => undefined)
        .finally(() => {
            entry.refreshing = null;
            entry.touched = Date.now();
        });
}
