/**
 * Chunks an event holds loaded beyond its own place - the ground round a
 * defense point, the chunks a meteor lies across - and only the ones nobody
 * held before it: a chunk the operator keeps loaded for a farm stays loaded
 * after the event, because the event never took it on.
 */

/** A chunk, by its chunk coordinates. */
export interface Chunk {
    readonly x: number;
    readonly z: number;
}

/** Every chunk loaded in the Overworld, asked once before the event holds any. */
export const READ_FORCED = "execute in minecraft:overworld run forceload query";

/**
 * The chunks already held, out of a `READ_FORCED` answer - `3 force loaded
 * chunks were found in minecraft:overworld at: [0, 0], [1, 0], [4, -2]` - as
 * `x,z` keys. Empty when there are none; null when the answer could not be
 * read, and so nothing is known.
 */
export function readForced(output: string): Set<string> | null {
    if (/no force loaded chunks/i.test(output)) return new Set();
    const at = /\bat:\s*(.*)$/is.exec(output);
    if (!at) return null;
    const found = new Set<string>();
    for (const match of (at[1] as string).matchAll(/\[(-?\d+),\s*(-?\d+)\]/g)) {
        found.add(`${match[1]},${match[2]}`);
    }
    return found.size > 0 ? found : null;
}

/** The chunks a square of `reach` blocks each way round a point touches. */
export function chunksAround(x: number, z: number, reach: number): Chunk[] {
    const chunks: Chunk[] = [];
    for (let cx = (x - reach) >> 4; cx <= (x + reach) >> 4; cx += 1) {
        for (let cz = (z - reach) >> 4; cz <= (z + reach) >> 4; cz += 1)
            chunks.push({ x: cx, z: cz });
    }
    return chunks;
}

/** Of `wanted`, the ones not held already. None when that is not known: a
 *  chunk that might be the operator's is never taken on, or let go of. */
export function notHeld(wanted: readonly Chunk[], held: ReadonlySet<string> | null): Chunk[] {
    if (!held) return [];
    return wanted.filter((chunk) => !held.has(`${chunk.x},${chunk.z}`));
}

export function holdChunk(chunk: Chunk): string {
    return `execute in minecraft:overworld run forceload add ${chunk.x * 16} ${chunk.z * 16}`;
}

export function releaseChunk(chunk: Chunk): string {
    return `execute in minecraft:overworld run forceload remove ${chunk.x * 16} ${chunk.z * 16}`;
}

const REMOVE =
    /^(?:execute in minecraft:overworld run )?forceload remove (-?\d+) (-?\d+)(?: (-?\d+) (-?\d+))?$/;

/**
 * A `forceload remove` that would let go of a chunk somebody else holds loaded,
 * rewritten to let go of only the rest - chunk by chunk - or of nothing.
 *
 * Finding a place loads the ground it judges and lets it go again, a chest's or
 * an arena's chunks are let go at the end, and each of those is one command over
 * a point or an area. The game's `forceload remove` does not know who loaded a
 * chunk: over an area that took in a chunk the operator keeps loaded for a farm,
 * it unloaded that too, and the farm stopped. Every other line is left as it is.
 */
export function spareHeld(line: string, keep: ReadonlySet<string> | null): string[] {
    const match = REMOVE.exec(line);
    if (!match || !keep || keep.size === 0) return [line];
    const [x1, z1] = [Number(match[1]), Number(match[2])];
    const [x2, z2] = [Number(match[3] ?? match[1]), Number(match[4] ?? match[2])];
    const covered: Chunk[] = [];
    for (let cx = Math.min(x1, x2) >> 4; cx <= Math.max(x1, x2) >> 4; cx += 1) {
        for (let cz = Math.min(z1, z2) >> 4; cz <= Math.max(z1, z2) >> 4; cz += 1)
            covered.push({ x: cx, z: cz });
    }
    if (!covered.some((chunk) => keep.has(`${chunk.x},${chunk.z}`))) return [line];
    return covered.filter((chunk) => !keep.has(`${chunk.x},${chunk.z}`)).map(releaseChunk);
}

/** A server whose `forceload remove` lines never let go of the chunks in `keep`
 *  (see `spareHeld`), asked for anew on every line. */
export function sparing<
    T extends {
        say(argv: readonly string[]): Promise<string>;
        sayAll(lines: readonly string[]): Promise<void>;
    }
>(server: T, keep: () => ReadonlySet<string> | null): T {
    return {
        ...server,
        say: async (argv: readonly string[]) => {
            const line = argv.join(" ");
            const lines = spareHeld(line, keep());
            if (lines.length === 1 && lines[0] === line) return server.say(argv);
            let output = "";
            for (const one of lines) output += await server.say([one]);
            return output;
        },
        sayAll: (lines: readonly string[]) =>
            server.sayAll(lines.flatMap((line) => spareHeld(line, keep())))
    };
}

/** The chunks held before an event touched any, as `x,z` keys; null when unread. */
export function heldBefore(run: {
    readonly keepForced: readonly string[] | null;
}): ReadonlySet<string> | null {
    return run.keepForced ? new Set(run.keepForced) : null;
}
