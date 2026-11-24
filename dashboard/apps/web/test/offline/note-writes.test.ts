/**
 * A note written with Polaris out of reach: kept on the device (and readable
 * again after a reload), only its newest text waiting, sent in order when the
 * server answers, with the version the device last saw - its own earlier write
 * included - and the server's "kept both" or "conflict" answers carried to the
 * screen. Signing out drops all of it.
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveNoteTextAction = vi.fn();
vi.mock("@/app/(app)/notes/actions", () => ({ saveNoteTextAction: (input: unknown) => saveNoteTextAction(input) }));
vi.mock("@/lib/reachability", () => ({ noteRequestFailure: () => undefined }));

const { appWrites, dropOfflineStore, offlineStore, registerWriteKind } = await import("@/lib/offline/app-writes");
const { NOTE_CONFLICT, NOTE_TEXT, newestVersion, readNoteSent, saveNoteText, waitingNoteText } = await import(
    "@/app/(app)/notes/offline-writes"
);

const NOTE = "0190a1b2-c3d4-7e5f-8a9b-000000000001";
const SEEN = "2026-11-20T10:00:00.000Z";

async function drained(): Promise<void> {
    appWrites.flush();
    // The flush runs on its own; a second call queues behind it, so two settle it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    appWrites.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(async () => {
    await dropOfflineStore();
    offlineStore.setOwner("u1");
    saveNoteTextAction.mockReset();
});

describe("a note's offline writes", () => {
    it("keeps the text on the device while the server cannot be reached", async () => {
        saveNoteTextAction.mockRejectedValue(new TypeError("Failed to fetch"));
        const outcome = await saveNoteText({ noteId: NOTE, title: "Train", body: "<p>one</p>", base: SEEN });
        expect(outcome).toHaveProperty("queued");
        await drained();
        const waiting = await waitingNoteText(NOTE);
        expect(waiting?.state).toBe("pending");
        expect(waiting?.attempts).toBeGreaterThan(0);
        expect(waiting?.payload).toMatchObject({ title: "Train", body: "<p>one</p>" });
    });

    it("keeps only the newest text of a note waiting", async () => {
        saveNoteTextAction.mockRejectedValue(new TypeError("Failed to fetch"));
        await saveNoteText({ noteId: NOTE, title: "T", body: "<p>one</p>", base: SEEN });
        await drained();
        await saveNoteText({ noteId: NOTE, title: "T", body: "<p>two</p>", base: SEEN });
        await drained();
        const all = (await appWrites.readAll()).filter((entry) => entry.target === NOTE);
        expect(all).toHaveLength(1);
        expect(all[0]?.payload).toMatchObject({ body: "<p>two</p>" });
    });

    it("sends when the server answers, and the next save starts from that version", async () => {
        saveNoteTextAction.mockResolvedValueOnce({ updatedAt: "2026-11-20T10:05:00.000Z" });
        await saveNoteText({ noteId: NOTE, title: "T", body: "<p>one</p>", base: SEEN });
        await drained();
        expect(await waitingNoteText(NOTE)).toBeNull();

        saveNoteTextAction.mockResolvedValueOnce({ updatedAt: "2026-11-20T10:06:00.000Z" });
        // The screen has not caught up yet: it still says the version it was drawn at.
        await saveNoteText({ noteId: NOTE, title: "T", body: "<p>two</p>", base: SEEN });
        await drained();
        expect(saveNoteTextAction).toHaveBeenCalledTimes(2);
        expect(saveNoteTextAction.mock.calls[1]?.[0]).toMatchObject({
            noteId: NOTE,
            body: "<p>two</p>",
            baseUpdatedAt: "2026-11-20T10:05:00.000Z"
        });
    });

    it("hands the screen the copy kept when the note changed elsewhere, made under the write's own key", async () => {
        const events: unknown[] = [];
        const unsubscribe = appWrites.subscribe((event) => events.push(event));
        saveNoteTextAction.mockImplementation(async (input: { copyId: string }) => ({ copyId: input.copyId }));
        const outcome = await saveNoteText({ noteId: NOTE, title: "T", body: "<p>mine</p>", base: SEEN });
        await drained();
        unsubscribe();
        const key = "queued" in outcome ? outcome.queued : "";
        const sent = events.find((event) => event && typeof event === "object" && "sent" in event) as {
            sent: string;
        };
        expect(readNoteSent(sent.sent)).toEqual({ copyId: key });
        expect(await waitingNoteText(NOTE)).toBeNull();
    });

    it("marks a conflict it could not keep both of as failed, and keeping mine sends with no version", async () => {
        saveNoteTextAction.mockResolvedValueOnce({ conflict: true });
        await saveNoteText({ noteId: NOTE, title: "T", body: "<p>mine</p>", base: SEEN });
        await drained();
        const failed = await waitingNoteText(NOTE);
        expect(failed?.state).toBe("failed");
        expect(failed?.reason).toBe(NOTE_CONFLICT);

        saveNoteTextAction.mockResolvedValueOnce({ updatedAt: "2026-11-20T11:00:00.000Z" });
        await appWrites.retry(failed!, { payload: { ...(failed!.payload as object), base: null } });
        await drained();
        expect(saveNoteTextAction.mock.calls[1]?.[0]).toMatchObject({ baseUpdatedAt: null });
        expect(await waitingNoteText(NOTE)).toBeNull();
    });

    it("never lets a kind this build does not know hold up the writes after it", async () => {
        registerWriteKind("test.known", async () => ({ sent: "ok" }));
        await appWrites.enqueue({ key: "a", kind: "test.gone", target: "x", payload: null });
        await appWrites.enqueue({ key: "b", kind: "test.known", target: "y", payload: null });
        await drained();
        const left = await appWrites.readAll();
        expect(left.map((entry) => [entry.key, entry.state])).toEqual([["a", "failed"]]);
    });

    it("forgets every unsent write on sign-out", async () => {
        saveNoteTextAction.mockRejectedValue(new TypeError("Failed to fetch"));
        await saveNoteText({ noteId: NOTE, title: "T", body: "<p>one</p>", base: SEEN });
        await dropOfflineStore();
        offlineStore.setOwner("u1");
        expect(await appWrites.readAll()).toEqual([]);
    });

    it("reads a newer version from either side", () => {
        expect(newestVersion(SEEN, null)).toBe(SEEN);
        expect(newestVersion(SEEN, "2026-11-20T09:00:00.000Z")).toBe(SEEN);
        expect(newestVersion(SEEN, "2026-11-21T09:00:00.000Z")).toBe("2026-11-21T09:00:00.000Z");
        expect(readNoteSent("2026-11-21T09:00:00.000Z")).toEqual({ updatedAt: "2026-11-21T09:00:00.000Z" });
        expect(NOTE_TEXT).toBe("note.text");
    });
});
