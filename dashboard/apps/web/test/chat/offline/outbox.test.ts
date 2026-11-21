/**
 * The outbox sends in order, stops at the first message that finds no server,
 * marks a refusal or too many attempts as not sent, and makes keys the server's
 * uuid check accepts.
 */

import { describe, expect, it } from "vitest";
import {
    OUTBOX_MAX_ATTEMPTS,
    drainOutbox,
    newClientKey,
    type OutboxEntry,
    type OutboxEvent,
    type OutboxSendResult
} from "@/lib/chat/offline/outbox";

const entry = (key: string, createdAt: string, attempts = 0): OutboxEntry => ({
    key,
    channelId: "c1",
    body: key,
    replyToId: null,
    createdAt,
    state: "pending",
    attempts
});

function run(entries: OutboxEntry[], answers: Record<string, OutboxSendResult>) {
    const sentOrder: string[] = [];
    const saved: OutboxEntry[] = [];
    const dropped: string[] = [];
    const events: OutboxEvent[] = [];
    const done = drainOutbox(entries, {
        send: async (item) => {
            sentOrder.push(item.key);
            return answers[item.key] ?? "unreachable";
        },
        save: async (item) => void saved.push(item),
        drop: async (key) => void dropped.push(key),
        notify: (event) => void events.push(event)
    });
    return done.then(() => ({ sentOrder, saved, dropped, events }));
}

describe("outbox", () => {
    it("sends oldest first and drops what the server took", async () => {
        const result = await run([entry("b", "2026-01-02"), entry("a", "2026-01-01")], {
            a: { sent: "m1" },
            b: { sent: "m2" }
        });
        expect(result.sentOrder).toEqual(["a", "b"]);
        expect(result.dropped).toEqual(["a", "b"]);
    });

    it("stops at the first message that finds no server, keeping the rest in order", async () => {
        const result = await run([entry("a", "1"), entry("b", "2")], {});
        expect(result.sentOrder).toEqual(["a"]);
        expect(result.saved).toEqual([{ ...entry("a", "1"), attempts: 1 }]);
    });

    it("marks a refusal and a last attempt as not sent, and carries on", async () => {
        const result = await run([entry("a", "1"), entry("b", "2", OUTBOX_MAX_ATTEMPTS - 1), entry("c", "3")], {
            a: { refused: "Not allowed" },
            c: { sent: "m3" }
        });
        expect(result.saved.map((item) => [item.key, item.state, item.reason])).toEqual([
            ["a", "failed", "Not allowed"],
            ["b", "failed", undefined]
        ]);
        expect(result.dropped).toEqual(["c"]);
    });

    it("makes version 4 uuids", () => {
        const key = newClientKey();
        expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(newClientKey()).not.toBe(key);
    });
});
