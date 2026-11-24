/**
 * Writes made on this device that the server has not taken yet - one mechanism
 * for every app (a chat message, a note's text, a document, a task).
 *
 * Each entry carries a key made here, which the server stores with what it
 * creates (or uses as its id) and answers a repeat of with what it already has,
 * so sending again after a dropped answer never writes twice. Entries go out
 * oldest first, and one that cannot reach the server stops the rest, so nothing
 * arrives out of order. A refusal (the server answered no) or too many failed
 * attempts marks an entry failed, for the reader to retry or delete.
 *
 * Pure: what stores the entries and what sends them are handed in, so the
 * ordering rules are tested without a browser or a server.
 */

export interface QueuedEntry {
    readonly key: string;
    readonly createdAt: string;
    readonly state: "pending" | "failed";
    readonly attempts: number;
    /** The server's own words when it refused, shown beside the entry. */
    readonly reason?: string;
}

export type QueueSendResult = { readonly sent: string } | { readonly refused: string } | "unreachable";

export type QueueEvent<E extends QueuedEntry> =
    | { readonly entry: E; readonly sent: string }
    | { readonly entry: E; readonly failed: string };

/** Attempts that found no server before an entry is shown as not sent. */
export const OUTBOX_MAX_ATTEMPTS = 5;

export async function drainQueue<E extends QueuedEntry>(
    entries: readonly E[],
    io: {
        send(entry: E): Promise<QueueSendResult>;
        save(entry: E): Promise<void>;
        drop(key: string): Promise<void>;
        notify(event: QueueEvent<E>): void;
    }
): Promise<void> {
    const queue = entries
        .filter((entry) => entry.state === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const entry of queue) {
        const result = await io.send(entry);
        if (result !== "unreachable" && "sent" in result) {
            await io.drop(entry.key);
            io.notify({ entry, sent: result.sent });
            continue;
        }
        if (result !== "unreachable") {
            await io.save({ ...entry, state: "failed", reason: result.refused });
            io.notify({ entry, failed: result.refused });
            continue;
        }
        const attempts = entry.attempts + 1;
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
            await io.save({ ...entry, attempts, state: "failed" });
            io.notify({ entry, failed: "" });
            continue;
        }
        await io.save({ ...entry, attempts });
        // The server is not there: what comes after waits, in order.
        return;
    }
}

/** A version 4 UUID. `crypto.randomUUID` exists only on a secure origin, and
 *  Polaris is often reached over plain HTTP on a home network. */
export function newClientKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
