/**
 * The launcher's one ranking of what somebody uses: often and lately first.
 * Every surface that remembers choices (Polaris Desktop's launcher today, the
 * dashboard's palette and the extension next) keeps a list of these records and
 * orders by `frecency`, so a command climbs the same way everywhere.
 *
 * Exponential decay, the scheme Firefox's frecency rework settled on: each use
 * adds 1 to a score that halves every `FRECENCY_HALF_LIFE_MS`. Storing the
 * score with the moment it was last brought up to date keeps a record to two
 * numbers and makes ranking one multiplication, with no list of visits to keep.
 */

/** One thing chosen: its stable key, its score at `at`, and when that was (ms). */
export interface UseRecord {
    readonly key: string;
    readonly score: number;
    readonly at: number;
}

/** A week: something used daily for a while outranks a one-off from yesterday. */
export const FRECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
/** The most records kept; the lowest ranked are dropped past it. */
export const MAX_USE_RECORDS = 300;
/** The longest key kept, so a stored list stays small. */
export const MAX_USE_KEY = 500;

/** The record's score now: its stored score halved once per half-life since `at`. */
export function frecency(record: UseRecord, now: number): number {
    const elapsed = Math.max(0, now - record.at);
    return record.score * Math.pow(2, -elapsed / FRECENCY_HALF_LIFE_MS);
}

/** `records` with one more use of `key` at `now`, pruned to `MAX_USE_RECORDS`. */
export function recordUse(records: readonly UseRecord[], key: string, now: number): UseRecord[] {
    if (!key || key.length > MAX_USE_KEY) return [...records];
    const old = records.find((record) => record.key === key);
    const used: UseRecord = { key, score: (old ? frecency(old, now) : 0) + 1, at: now };
    return [used, ...records.filter((record) => record.key !== key)]
        .sort((a, b) => frecency(b, now) - frecency(a, now))
        .slice(0, MAX_USE_RECORDS);
}

/** Each key's score now, for ranking many rows without searching the list per row. */
export function frecencyByKey(records: readonly UseRecord[], now: number): Map<string, number> {
    return new Map(records.map((record) => [record.key, frecency(record, now)]));
}

/**
 * `items` ordered by how much their key has been used, the unused after in
 * their own order. A stable sort: two items with the same score keep theirs.
 */
export function byFrecency<T>(items: readonly T[], keyOf: (item: T) => string, scores: ReadonlyMap<string, number>): T[] {
    return items
        .map((item, index) => ({ item, index, score: scores.get(keyOf(item)) ?? 0 }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => entry.item);
}

/** A stored list, read total: anything malformed is dropped, the rest kept. */
export function readUseRecords(raw: unknown): UseRecord[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const records: UseRecord[] = [];
    for (const one of raw) {
        if (typeof one !== "object" || one === null) continue;
        const { key, score, at } = one as Record<string, unknown>;
        if (typeof key !== "string" || !key || key.length > MAX_USE_KEY || seen.has(key)) continue;
        if (typeof score !== "number" || !Number.isFinite(score) || score <= 0) continue;
        if (typeof at !== "number" || !Number.isFinite(at) || at < 0) continue;
        seen.add(key);
        records.push({ key, score, at });
        if (records.length === MAX_USE_RECORDS) break;
    }
    return records;
}
