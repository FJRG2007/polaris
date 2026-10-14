/**
 * Remembering in process memory without growing forever.
 *
 * A Map keyed by something a caller chooses - an address, a domain - holds one
 * entry per key anybody ever asked for until the process restarts. `setBounded`
 * writes like `Map.set` and then forgets the entries written longest ago until
 * the map is back under its limits. A Map iterates in insertion order, so the
 * oldest entry is always the first one.
 */

export interface MapLimits<V> {
    readonly maxEntries: number;
    /** A budget for the values together, measured by `sizeOf`. */
    readonly maxBytes?: number;
    readonly sizeOf?: (value: V) => number;
}

export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limits: MapLimits<V>): void {
    // Written again counts as written now: it moves to the end.
    map.delete(key);
    map.set(key, value);
    const sizeOf = limits.sizeOf;
    let bytes = 0;
    if (limits.maxBytes !== undefined && sizeOf)
        for (const held of map.values()) bytes += sizeOf(held);
    for (const [oldest, held] of map) {
        const over =
            map.size > limits.maxEntries ||
            (limits.maxBytes !== undefined && bytes > limits.maxBytes);
        if (!over || oldest === key) break;
        if (sizeOf) bytes -= sizeOf(held);
        map.delete(oldest);
    }
}
