/**
 * Chunks an event holds loaded beyond its own place - the ground round a
 * defence point, the chunks a meteor lies across - and only the ones nobody
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

/** Of `wanted`, the ones not held already. All of them when that is not known. */
export function notHeld(wanted: readonly Chunk[], held: ReadonlySet<string> | null): Chunk[] {
    return wanted.filter((chunk) => !held?.has(`${chunk.x},${chunk.z}`));
}

export function holdChunk(chunk: Chunk): string {
    return `execute in minecraft:overworld run forceload add ${chunk.x * 16} ${chunk.z * 16}`;
}

export function releaseChunk(chunk: Chunk): string {
    return `execute in minecraft:overworld run forceload remove ${chunk.x * 16} ${chunk.z * 16}`;
}
