/**
 * Reading a pool's labels back off the row.
 *
 * They are stored as a JSON string because the schema keeps no scalar arrays, and
 * they are read in three places that have nothing else in common - the pool list,
 * the reconciler, and the webhook that decides whether a queued job is one this
 * pool could take - so the reading lives here rather than in whichever of them
 * happened to need it first.
 */

/** A row that somehow holds something else reads as no labels rather than taking
 *  the page, or the pass, down with it. */
export function parseLabels(raw: string): string[] {
    try {
        const value: unknown = JSON.parse(raw);
        return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

/** Labels GitHub puts on every runner by itself. A workflow naming one of them is
 *  not asking for something a pool has to have declared. */
const IMPLIED_LABELS = new Set(["self-hosted", "linux", "macos", "windows", "x64", "arm", "arm64"]);

/**
 * Whether a pool with these labels would be given a job that asked for those.
 *
 * GitHub's own rule: a runner takes a job when it carries every label the job
 * named. It is here because getting it wrong is quiet - a pool that believes it
 * can take a job it has no label for records demand it will never satisfy, and
 * from the outside that looks exactly like a pool that has stopped working.
 */
export function servesLabels(poolLabels: readonly string[], jobLabels: readonly string[]): boolean {
    const held = new Set(poolLabels.map((label) => label.trim().toLowerCase()));
    return jobLabels.every((label) => {
        const clean = label.trim().toLowerCase();
        return held.has(clean) || IMPLIED_LABELS.has(clean);
    });
}
