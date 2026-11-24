// @vitest-environment jsdom
/**
 * Text typed in the pause before a save, with the tab closing: kept
 * synchronously as the page goes away, moved into the queue when Polaris next
 * opens, superseded by a later save of the same thing, and dropped on sign-out.
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshWebStorage } from "../helpers/memory-storage";

vi.mock("@/app/(app)/notes/actions", () => ({ saveNoteTextAction: vi.fn() }));
vi.mock("@/lib/reachability", () => ({ noteRequestFailure: () => undefined }));

const writes = await import("@/lib/offline/app-writes");
const { NOTE_TEXT, keepNoteTextOnUnload, saveNoteText, waitingNoteText } = await import(
    "@/app/(app)/notes/offline-writes"
);

const NOTE = "0190a1b2-c3d4-7e5f-8a9b-000000000002";
const SEEN = "2026-11-20T10:00:00.000Z";
const KEY = "polaris-offline-unload:u1";

beforeEach(async () => {
    freshWebStorage();
    writes.offlineStore.setOwner("u1");
    await writes.dropOfflineStore();
    writes.offlineStore.setOwner("u1");
});

describe("unsaved text when the page goes away", () => {
    it("is kept synchronously on pagehide and only while something is unsaved", () => {
        let unsaved: { noteId: string; title: string; body: string; base: string } | null = null;
        const stop = keepNoteTextOnUnload(() => unsaved);
        window.dispatchEvent(new Event("pagehide"));
        expect(window.localStorage.getItem(KEY)).toBeNull();
        unsaved = { noteId: NOTE, title: "Last", body: "<p>typed just now</p>", base: SEEN };
        window.dispatchEvent(new Event("pagehide"));
        const kept = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
        expect(kept).toHaveLength(1);
        expect(kept[0]).toMatchObject({ kind: NOTE_TEXT, target: NOTE, payload: { body: "<p>typed just now</p>" } });
        stop();
    });

    it("keeps one entry per note, the newest", () => {
        let body = "<p>one</p>";
        const stop = keepNoteTextOnUnload(() => ({ noteId: NOTE, title: "T", body, base: SEEN }));
        window.dispatchEvent(new Event("pagehide"));
        body = "<p>two</p>";
        window.dispatchEvent(new Event("pagehide"));
        const kept = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
        expect(kept).toHaveLength(1);
        expect(kept[0].payload.body).toBe("<p>two</p>");
        stop();
    });

    it("is the note's waiting text when Polaris next opens", async () => {
        const stop = keepNoteTextOnUnload(() => ({ noteId: NOTE, title: "T", body: "<p>closing</p>", base: SEEN }));
        window.dispatchEvent(new Event("pagehide"));
        stop();
        const waiting = await waitingNoteText(NOTE);
        expect(waiting?.state).toBe("pending");
        expect(waiting?.payload).toMatchObject({ body: "<p>closing</p>", base: SEEN });
        // Moved, not copied: the next page does not queue it again.
        expect(window.localStorage.getItem(KEY)).toBeNull();
    });

    it("never brings back older text over a later save", async () => {
        const stop = keepNoteTextOnUnload(() => ({ noteId: NOTE, title: "T", body: "<p>older</p>", base: SEEN }));
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        expect(window.localStorage.getItem(KEY)).not.toBeNull();
        stop();
        // Back in the tab, the reader typed on and the save went through.
        await saveNoteText({ noteId: NOTE, title: "T", body: "<p>newer</p>", base: SEEN });
        expect(window.localStorage.getItem(KEY)).toBeNull();
        const all = (await writes.appWrites.readAll()).filter((entry) => entry.target === NOTE);
        expect(all.map((entry) => (entry.payload as { body: string }).body)).toEqual(["<p>newer</p>"]);
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    });

    it("is dropped on sign-out", async () => {
        const stop = keepNoteTextOnUnload(() => ({ noteId: NOTE, title: "T", body: "<p>x</p>", base: SEEN }));
        window.dispatchEvent(new Event("pagehide"));
        stop();
        await writes.dropOfflineStore();
        expect(window.localStorage.getItem(KEY)).toBeNull();
    });
});
