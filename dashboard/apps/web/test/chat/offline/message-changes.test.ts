/**
 * Chat edits, reactions and deletes with Polaris out of reach: sent at once
 * when they can be, kept in the chat's line when they cannot, folded into the
 * one waiting for the same message, drawn over the rows with the clock, and
 * sent in order when Polaris answers. The words of what waits are sealed on
 * the device, never kept in the clear, and a sealed message's edit is sealed
 * again when it is sent.
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const editAction = vi.fn();
const reactAction = vi.fn();
const deleteMessageAction = vi.fn();
vi.mock("@/app/(app)/chat/actions", () => ({
    editAction: (input: unknown) => editAction(input),
    reactAction: (input: unknown) => reactAction(input),
    deleteMessageAction: (id: string) => deleteMessageAction(id)
}));
const editSealedMessage = vi.fn();
let sealedOn = false;
vi.mock("@/lib/chat/e2ee/sealed-chat", () => ({
    sealedChatActive: () => sealedOn,
    editSealedMessage: (input: unknown) => editSealedMessage(input),
    sendSealedMessage: async () => "",
    sealedSendFailure: () => "unreachable"
}));
const plainSend = vi.fn(async () => ({}));
vi.mock("@/lib/poll-fetch", () => ({ sendAction: (...args: unknown[]) => plainSend(...(args as [])) }));
vi.mock("@/lib/reachability", () => ({
    noteRequestFailure: () => undefined,
    isNetworkFailure: (caught: unknown) => caught instanceof TypeError,
    reachability: () => ({ reachable: true, recoveries: 0 }),
    subscribeReachability: () => () => undefined
}));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));

const { chatStore, dropChatStore } = await import("@/lib/chat/offline/chat-cache");
const outbox = await import("@/app/(app)/chat/outbox");
const { withChanges } = await import("@/lib/chat/offline/outbox");

const CHANNEL = "0190a1b2-c3d4-7e5f-8a9b-0000000000c1";
const MESSAGE = "0190a1b2-c3d4-7e5f-8a9b-0000000000a1";
const unreachable = () => new TypeError("Failed to fetch");

async function drained(): Promise<void> {
    outbox.flushOutbox();
    await new Promise((resolve) => setTimeout(resolve, 30));
    outbox.flushOutbox();
    await new Promise((resolve) => setTimeout(resolve, 30));
}

beforeEach(async () => {
    await dropChatStore();
    chatStore.setOwner("u1");
    sealedOn = false;
    for (const action of [editAction, reactAction, deleteMessageAction, editSealedMessage]) action.mockReset();
});

describe("chat changes offline", () => {
    it("sends at once when Polaris answers", async () => {
        editAction.mockResolvedValue({});
        const result = await outbox.changeMessage({ op: "edit", channelId: CHANNEL, messageId: MESSAGE, body: "fixed" }, vi.fn());
        expect(result).toEqual({});
        expect(editAction).toHaveBeenCalledWith({ messageId: MESSAGE, body: "fixed" });
        expect(await outbox.readChanges(CHANNEL)).toHaveLength(0);
    });

    it("answers a refusal as it always did, and keeps nothing", async () => {
        editAction.mockResolvedValue({ error: "Too late to edit" });
        const result = await outbox.changeMessage({ op: "edit", channelId: CHANNEL, messageId: MESSAGE, body: "x" }, vi.fn());
        expect(result).toEqual({ error: "Too late to edit" });
        expect(await outbox.readChanges(CHANNEL)).toHaveLength(0);
    });

    it("keeps an unanswered change, sealed on the device, and sends it when Polaris is back", async () => {
        editAction.mockRejectedValueOnce(unreachable()).mockRejectedValueOnce(unreachable());
        const result = await outbox.changeMessage({ op: "edit", channelId: CHANNEL, messageId: MESSAGE, body: "secret words" }, vi.fn());
        expect(result).toEqual({ queued: true });
        await new Promise((resolve) => setTimeout(resolve, 30));

        // As stored: no words in the clear.
        const stored = (await chatStore.readAll<Record<string, unknown>>("outbox")).map((entry) => entry.value);
        expect(stored).toHaveLength(1);
        expect(JSON.stringify(stored)).not.toContain("secret words");
        expect(stored[0]!.rest).toBeDefined();
        // As read: opened.
        const [change] = await outbox.readChanges(CHANNEL);
        expect(change).toMatchObject({ op: "edit", messageId: MESSAGE, body: "secret words", state: "pending" });

        editAction.mockResolvedValue({});
        await drained();
        expect(editAction).toHaveBeenLastCalledWith({ messageId: MESSAGE, body: "secret words" });
        expect(await outbox.readChanges(CHANNEL)).toHaveLength(0);
    });

    it("folds an edit into the waiting one and sends a reaction as a state, not a press", async () => {
        editAction.mockRejectedValue(unreachable());
        reactAction.mockRejectedValue(unreachable());
        await outbox.changeMessage({ op: "edit", channelId: CHANNEL, messageId: MESSAGE, body: "one" }, vi.fn());
        await outbox.changeMessage({ op: "edit", channelId: CHANNEL, messageId: MESSAGE, body: "two" }, vi.fn());
        await outbox.changeMessage({ op: "react", channelId: CHANNEL, messageId: MESSAGE, emoji: "👍", on: true }, vi.fn());
        await outbox.changeMessage({ op: "react", channelId: CHANNEL, messageId: MESSAGE, emoji: "👍", on: false }, vi.fn());
        const waiting = await outbox.readChanges(CHANNEL);
        expect(waiting.map((entry) => [entry.op, "body" in entry ? entry.body : "on" in entry ? entry.on : null])).toEqual([
            ["edit", "two"],
            ["react", false]
        ]);

        editAction.mockReset().mockResolvedValue({});
        reactAction.mockReset().mockResolvedValue({ on: false });
        await drained();
        expect(editAction).toHaveBeenCalledTimes(1);
        expect(reactAction).toHaveBeenCalledWith({ messageId: MESSAGE, emoji: "👍", on: false });
    });

    it("a delete takes what waited for the message with it", async () => {
        editAction.mockRejectedValue(unreachable());
        deleteMessageAction.mockRejectedValue(unreachable());
        await outbox.changeMessage({ op: "edit", channelId: CHANNEL, messageId: MESSAGE, body: "one" }, vi.fn());
        await outbox.changeMessage({ op: "delete", channelId: CHANNEL, messageId: MESSAGE }, vi.fn());
        expect((await outbox.readChanges(CHANNEL)).map((entry) => entry.op)).toEqual(["delete"]);
    });

    it("seals a sealed message's edit again when it is sent, from the version it replaced", async () => {
        sealedOn = true;
        editSealedMessage.mockRejectedValueOnce(unreachable());
        await outbox.changeMessage(
            { op: "edit", channelId: CHANNEL, messageId: MESSAGE, body: "sealed words", sealed: true, editedAt: "2026-11-24T10:00:00.000Z" },
            vi.fn()
        );
        const stored = (await chatStore.readAll<Record<string, unknown>>("outbox")).map((entry) => entry.value);
        expect(JSON.stringify(stored)).not.toContain("sealed words");

        editSealedMessage.mockResolvedValue("2026-11-24T11:00:00.000Z");
        await drained();
        expect(editAction).not.toHaveBeenCalled();
        expect(editSealedMessage).toHaveBeenLastCalledWith({
            channelId: CHANNEL,
            messageId: MESSAGE,
            body: "sealed words",
            editedAt: "2026-11-24T10:00:00.000Z"
        });
        expect(await outbox.readChanges(CHANNEL)).toHaveLength(0);
    });

    it("holds a sealed edit on a page without sealed chat, uncounted, until one with it sends it", async () => {
        sealedOn = true;
        editSealedMessage.mockRejectedValueOnce(unreachable());
        await outbox.changeMessage(
            { op: "edit", channelId: CHANNEL, messageId: MESSAGE, body: "sealed words", sealed: true },
            vi.fn()
        );
        sealedOn = false;
        for (let round = 0; round < 6; round += 1) await drained();
        expect(editAction).not.toHaveBeenCalled();
        const [held] = await outbox.readChanges(CHANNEL);
        expect(held).toMatchObject({ state: "pending" });
        expect(held!.attempts).toBeLessThan(2);

        sealedOn = true;
        editSealedMessage.mockResolvedValue("2026-11-24T11:00:00.000Z");
        await drained();
        expect(editSealedMessage).toHaveBeenCalledTimes(2);
        expect(await outbox.readChanges(CHANNEL)).toHaveLength(0);
    });

    it("never sends a message written under sealed chat in the clear from a page without it", async () => {
        sealedOn = true;
        expect(await outbox.enqueue({ key: "k1", channelId: CHANNEL, body: "secret", replyToId: null })).toBe(true);
        sealedOn = false;
        plainSend.mockClear();
        await drained();
        expect(plainSend).not.toHaveBeenCalled();
        expect(await outbox.readOutbox(CHANNEL)).toEqual([expect.objectContaining({ state: "pending", attempts: 0 })]);
    });

    it("keeps a refused change as not sent, for retry or discard", async () => {
        deleteMessageAction.mockRejectedValueOnce(unreachable());
        await outbox.changeMessage({ op: "delete", channelId: CHANNEL, messageId: MESSAGE }, vi.fn());
        deleteMessageAction.mockResolvedValue({ error: "Not yours" });
        await drained();
        const [failed] = await outbox.readChanges(CHANNEL);
        expect(failed).toMatchObject({ op: "delete", state: "failed", reason: "Not yours" });
        await outbox.discard(failed!.key);
        expect(await outbox.readChanges(CHANNEL)).toHaveLength(0);
    });
});

describe("withChanges", () => {
    const row = {
        id: MESSAGE,
        body: "before",
        edited: false,
        deleted: false,
        reactions: [{ emoji: "👍", count: 1, mine: false }]
    } as unknown as Parameters<typeof withChanges>[0][number];
    const base = { key: "k", channelId: CHANNEL, messageId: MESSAGE, attempts: 0 } as const;

    it("draws waiting changes over the row, with the clock, and leaves failed ones off", () => {
        const [drawn] = withChanges(
            [row],
            [
                { ...base, key: "a", createdAt: "1", state: "pending", op: "edit", body: "after" },
                { ...base, key: "b", createdAt: "2", state: "pending", op: "react", emoji: "👍", on: true },
                { ...base, key: "c", createdAt: "3", state: "failed", op: "delete" }
            ]
        );
        expect(drawn).toMatchObject({ body: "after", edited: true, changeWaiting: true, deleted: false });
        expect(drawn!.reactions).toEqual([{ emoji: "👍", count: 2, mine: true }]);
    });

    it("returns the same list when nothing waits", () => {
        const list = [row];
        expect(withChanges(list, [])).toBe(list);
    });
});
