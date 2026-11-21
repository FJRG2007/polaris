/**
 * Messages written on this device that the server has not taken yet.
 *
 * Each carries a key made here, which the server stores with the message and
 * answers a repeat of with the message it already has - so sending again after
 * a dropped answer never posts twice. Entries go out oldest first, and one that
 * cannot reach the server stops the rest, so a conversation never arrives out
 * of order. A refusal (the server answered no) or too many failed attempts marks
 * an entry failed, for the reader to retry or delete.
 */

import type * as core from "@polaris/core";

export interface OutboxEntry {
    readonly key: string;
    readonly channelId: string;
    readonly body: string;
    readonly replyToId: string | null;
    readonly translation?: core.ChatSentTranslation;
    readonly createdAt: string;
    readonly state: "pending" | "failed";
    readonly attempts: number;
    /** The server's own words when it refused, shown beside the entry. */
    readonly reason?: string;
}

export type OutboxSendResult = { readonly sent: string } | { readonly refused: string } | "unreachable";

export type OutboxEvent =
    | { readonly key: string; readonly channelId: string; readonly sent: string }
    | { readonly key: string; readonly channelId: string; readonly failed: string };

/** Attempts that found no server before an entry is shown as not sent. */
export const OUTBOX_MAX_ATTEMPTS = 5;

export async function drainOutbox(
    entries: readonly OutboxEntry[],
    io: {
        send(entry: OutboxEntry): Promise<OutboxSendResult>;
        save(entry: OutboxEntry): Promise<void>;
        drop(key: string): Promise<void>;
        notify(event: OutboxEvent): void;
    }
): Promise<void> {
    const queue = entries
        .filter((entry) => entry.state === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const entry of queue) {
        const result = await io.send(entry);
        if (result !== "unreachable" && "sent" in result) {
            await io.drop(entry.key);
            io.notify({ key: entry.key, channelId: entry.channelId, sent: result.sent });
            continue;
        }
        if (result !== "unreachable") {
            await io.save({ ...entry, state: "failed", reason: result.refused });
            io.notify({ key: entry.key, channelId: entry.channelId, failed: result.refused });
            continue;
        }
        const attempts = entry.attempts + 1;
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
            await io.save({ ...entry, attempts, state: "failed" });
            io.notify({ key: entry.key, channelId: entry.channelId, failed: "" });
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
