/**
 * Which finished scans the history keeps. A kind that scans one subject among
 * many - an image by its id, an app's image or dependencies by the app - keeps
 * its newest scans per subject, so one busy subject never pushes a quiet one's
 * only scan out. Every other kind keeps its newest scans per server. Pure.
 */

/** Newest scans kept per server for a kind with no subject. */
export const KEEP_PER_KIND = 30;
/** Newest scans kept per subject (an image, an app) for the kinds that have one. */
export const KEEP_PER_SUBJECT = 5;

export interface HistoryRow {
    readonly id: string;
    readonly kind: string;
    readonly imageId: string | null;
    readonly input: string;
}

/** What one scan was of, for the kinds whose history is kept per subject. */
export function subjectOf(row: HistoryRow): string | null {
    if (row.kind !== "image" && row.kind !== "deps") return null;
    if (row.imageId) return `image:${row.imageId}`;
    try {
        const input: unknown = JSON.parse(row.input);
        const app =
            input && typeof input === "object"
                ? (input as Record<string, unknown>).applicationId
                : null;
        return typeof app === "string" && app ? `app:${app}` : null;
    } catch {
        return null;
    }
}

/** The ids to delete from one server's finished scans of one kind, given newest first. */
export function pruneVictims(rows: readonly HistoryRow[]): string[] {
    const seen = new Map<string, number>();
    const victims: string[] = [];
    for (const row of rows) {
        const key = subjectOf(row) ?? `kind:${row.kind}`;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > (key.startsWith("kind:") ? KEEP_PER_KIND : KEEP_PER_SUBJECT))
            victims.push(row.id);
    }
    return victims;
}
