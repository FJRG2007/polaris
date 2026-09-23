/**
 * How much heap a game server is given, and who decides.
 *
 * The number was settled once, when the server was created, from how many people
 * were expected on it - and then never looked at again. That is survivable for a
 * vanilla server and wrong for every other kind: a mod loader alone costs about a
 * gigabyte before a single mod is installed, and each mod after that brings its
 * own registries, models and world data. A server created for five friends and
 * later given six mods is a server that runs out of memory in the middle of
 * generating the world, and what that looks like from inside the game is not an
 * error - it is chunks that stop appearing and mobs that stop moving, while the
 * tick rate reads a perfect twenty because the main thread has nothing left to
 * do. Nobody could be expected to diagnose that, and nobody should have to watch
 * a number in a settings screen to avoid it.
 *
 * So the heap can be planned rather than typed. The plan is this file: a figure
 * derived from what the server actually is - its loader, the mods on its list,
 * the people who actually play on it - bounded by a ceiling the operator sets and
 * by what the machine can really spare. It is applied at the restarts Polaris was
 * going to do anyway, so a planned server never restarts for this alone unless it
 * has run out of memory, which is the one case where restarting is the repair.
 *
 * Pure: every figure here is computed from its inputs. What reads the machine and
 * writes the setting lives with the service that already does both.
 */

import { formatMemory } from "./blueprints";
import { findSoftware } from "@polaris/core";
import type { BlueprintWeight } from "./blueprints";

/** Where the mode is kept on the install: "auto" plans it, "fixed" leaves whatever
 *  was typed alone. Absent means fixed, so a server that predates this keeps the
 *  heap it has until somebody asks for otherwise. */
export const MEMORY_MODE_KEY = "memoryMode";

/** The most a planned heap may reach, in megabytes. Absent means the default
 *  ceiling below. */
export const MEMORY_CEILING_KEY = "memoryCeilingMb";

/** How far back a busy evening still counts as evidence about a server. One that
 *  was full in March is not a busy server in September, and planning for the crowd
 *  it had once takes memory from whatever else the machine runs. The readings
 *  themselves are the once-a-minute samples Polaris already keeps - nothing is
 *  written down twice to answer this. */
export const PEAK_DAYS = 14;

/** What a planned heap never goes over unless the operator raises it. Past this
 *  the answer is a second server, not a bigger heap - the pauses a collector takes
 *  on a heap this size are felt in the game. */
export const DEFAULT_CEILING_MB = 8192;

/** The lowest a planned heap goes. Below this even a vanilla server spends its
 *  time collecting garbage. */
export const FLOOR_MB = 1536;

/** What the machine keeps for itself and everything else on it. A plan that eats
 *  this is a plan that takes the whole box down with the server it was helping. */
export const MACHINE_RESERVE_MB = 2048;

/** How much a plan goes up by when the server has actually run out. Enough to be
 *  worth the restart, small enough not to swallow the machine in two steps. */
export const RAISE_STEP_MB = 1024;

export type MemoryMode = "auto" | "fixed";

export interface MemoryPlanInput {
    /** How many people are actually on it at once, at its busiest lately. Not the
     *  slot count: a server with twenty slots and three friends on it is a
     *  three-player server, and sizing it for twenty takes memory from whatever
     *  else the machine runs. */
    readonly concurrentPlayers: number;
    readonly weight?: BlueprintWeight;
    /** What it runs: "" or "vanilla" for a server that loads nothing, "paper" and
     *  the rest for plugins, "fabric" / "forge" / "neoforge" for mods. */
    readonly loader?: string;
    /**
     * The `TYPE` the server runs, which answers this better than the loader does
     * wherever the two disagree.
     *
     * They disagree on the hybrids. Arclight loads Bukkit plugins, so what it
     * looks for on Modrinth is `bukkit` - and it is NeoForge underneath, so it
     * costs what a mod loader costs. Priced off the loader alone it would be
     * given a plugin server's quarter of a gigabyte and run out of memory while
     * merging its registries.
     */
    readonly software?: string;
    /** How many projects its list carries. Dependencies are not counted - they are
     *  not on the list - which is part of why the per-mod figure is as generous as
     *  it is. */
    readonly mods?: number;
}

const LOADERS_WITH_MODS = new Set(["fabric", "forge", "neoforge", "quilt"]);
const LOADERS_WITH_PLUGINS = new Set(["paper", "spigot", "purpur", "bukkit", "folia"]);

/** What this server costs before anything is installed on it: the software's own
 *  answer where there is one, the loader's otherwise - a server stored before the
 *  catalogue existed still has a loader to go on. */
function costClass(input: MemoryPlanInput): "mods" | "plugins" | "vanilla" {
    const known = findSoftware(input.software);
    if (known) return known.weight;
    const loader = (input.loader ?? "").trim().toLowerCase();
    if (LOADERS_WITH_MODS.has(loader)) return "mods";
    return LOADERS_WITH_PLUGINS.has(loader) ? "plugins" : "vanilla";
}

/**
 * The heap this server wants, before any ceiling is applied.
 *
 * The figures: a gigabyte carries the world and the server itself; each player
 * costs about 50 MB of chunks and entities; a mod loader costs a gigabyte before
 * anything is installed on it, because it holds every registry twice while it
 * merges them, and a plugin server a quarter of that; and each mod on the list
 * costs about 64 MB once its own dependencies, models and data are in. Rounded up
 * to half a gigabyte, which is the granularity anybody reasons in.
 */
export function plannedHeapMb(input: MemoryPlanInput): number {
    const weight = input.weight ?? "normal";
    const base = weight === "heavy" ? 2048 : weight === "light" ? 768 : 1024;
    const perPlayer = weight === "heavy" ? 80 : weight === "light" ? 35 : 50;
    const cost = costClass(input);
    const loaderCost = cost === "mods" ? 1024 : cost === "plugins" ? 256 : 0;
    const mods = Math.max(0, Math.trunc(input.mods ?? 0));
    const perMod = cost === "mods" ? 64 : 32;
    const raw =
        base + Math.max(0, input.concurrentPlayers) * perPlayer + loaderCost + mods * perMod;
    return Math.max(FLOOR_MB, Math.ceil(raw / 512) * 512);
}

/** The plan in the words the screen uses: what it is counting, in the order it
 *  matters. Never a formula - an operator reading this wants to know why the
 *  number moved, not how to recompute it. */
export function planReason(input: MemoryPlanInput): string {
    const cost = costClass(input);
    const mods = Math.max(0, Math.trunc(input.mods ?? 0));
    const parts: string[] = [];
    if (cost === "mods") parts.push("a mod loader");
    else if (cost === "plugins") parts.push("a plugin server");
    if (mods > 0) parts.push(`${mods} ${mods === 1 ? "mod" : "mods"}`);
    const players = Math.max(0, Math.trunc(input.concurrentPlayers));
    parts.push(players === 1 ? "one player at a time" : `${players} players at a time`);
    return parts.join(", ");
}

export interface HeapBounds {
    /** What the operator said it must never pass. */
    readonly ceilingMb?: number | null;
    /** What the machine has in total, and what its other game servers are already
     *  promised. Both optional: a machine Polaris cannot measure bounds nothing,
     *  which is better than refusing to plan at all. */
    readonly machineTotalMb?: number | null;
    readonly otherServersMb?: number | null;
}

/**
 * The plan as it can actually be applied here.
 *
 * Two bounds and they are not the same promise. The ceiling is the operator's -
 * it is what they said this server may cost. The machine's is arithmetic: what it
 * has, less what its other servers are already promised, less what the machine
 * itself needs to stay alive. A plan that ignores the second is how a host ends up
 * promising more heap than it has and taking everything on it down at once.
 */
export function clampHeapMb(planned: number, bounds: HeapBounds): number {
    const ceiling =
        bounds.ceilingMb && bounds.ceilingMb > 0 ? bounds.ceilingMb : DEFAULT_CEILING_MB;
    let limit = Math.min(planned, ceiling);
    const total = bounds.machineTotalMb ?? 0;
    if (total > 0) {
        const spare = total - (bounds.otherServersMb ?? 0) - MACHINE_RESERVE_MB;
        // A machine with nothing left to give bounds the plan at the floor rather
        // than being ignored: the server it is about is already running, so the
        // floor is what it keeps, and a plan that fell back to the unbounded
        // figure here is exactly how a host ends up promising memory it has not
        // got. Nothing is ever taken away by this - what applies a plan only ever
        // raises a heap.
        limit = Math.min(limit, Math.max(FLOOR_MB, Math.floor(spare / 512) * 512));
    }
    return Math.max(FLOOR_MB, limit);
}

/** The heap a server that has just run out should be started with next: a step up
 *  from what it had, bounded the same way as any other plan. Returns null when
 *  there is nothing left to give, which is a thing to say rather than a thing to
 *  retry. */
export function raisedHeapMb(currentMb: number, bounds: HeapBounds): number | null {
    const raised = clampHeapMb(Math.max(currentMb, FLOOR_MB) + RAISE_STEP_MB, bounds);
    return raised > currentMb ? raised : null;
}

/** How many players to plan for: what the server actually holds at once, never
 *  below a handful (a server nobody has joined yet still has to let people in)
 *  and never above the slots it offers. */
export function playersToPlanFor(peak: number, maxPlayers: number): number {
    const slots = maxPlayers > 0 ? maxPlayers : 20;
    return Math.max(1, Math.min(slots, Math.max(peak, 4)));
}

/** The mode an install is in, defaulting to what a server that predates the plan
 *  is in: whatever was typed. */
export function memoryMode(value: unknown): MemoryMode {
    return value === "auto" ? "auto" : "fixed";
}

/** The ceiling an install carries, or the default. */
export function memoryCeilingMb(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= FLOOR_MB
        ? Math.trunc(value)
        : DEFAULT_CEILING_MB;
}

/** What a machine bounds a server's heap by: all it has, less what its other
 *  servers are promised. `ownMb` is the heap this server already holds there, taken
 *  back out because the plan replaces it rather than adding to it. A machine that
 *  is not listed, or not measured, bounds nothing. */
export function machineHeapBounds(
    machine: { readonly memoryTotalBytes: number | null; readonly committedMb: number } | undefined,
    ownMb = 0
): { machineTotalMb: number | null; otherServersMb: number } {
    if (!machine) return { machineTotalMb: null, otherServersMb: 0 };
    return {
        machineTotalMb:
            machine.memoryTotalBytes !== null
                ? Math.floor(machine.memoryTotalBytes / (1024 * 1024))
                : null,
        otherServersMb: Math.max(0, machine.committedMb - ownMb)
    };
}

/** The figure as the image wants it, for the caller that writes the environment. */
export { formatMemory };

/** A heap the plan moved, as a save reports it back. */
export interface MemoryChange {
    readonly fromMb: number;
    readonly toMb: number;
    readonly reason: string;
}

/** The sentence a screen shows after a save moved the heap. */
export function memoryChangeSentence(change: MemoryChange, restarted: boolean): string {
    return `Memory went from ${formatMemory(change.fromMb)} to ${formatMemory(change.toMb)} for ${change.reason}. ${
        restarted ? "The restart applies it." : "It applies at the next restart."
    }`;
}
