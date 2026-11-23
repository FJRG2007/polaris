// @vitest-environment jsdom

/**
 * The places a sealed message is shown besides its own row: the list's last
 * line, pins and search hits, the preview text, and the pencil.
 *
 * Pinned here: a sealed entry is opened on the device and drawn with what it
 * opened to, an unopened one says nothing (never "an attachment"), an entry
 * that is not sealed passes through untouched, and a sealed row is not offered
 * for rewriting.
 */

import { rewritable } from "@/app/(app)/chat/rewritable";
import { previewText } from "@/app/(app)/chat/phone-chat";
import type { ChatMessageView } from "@/lib/chat/messages";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sealed = vi.hoisted(() => ({
    active: true,
    opened: new Map<string, { body: string } | null>(),
    // What a call to `openSealed` would open to, by id.
    pending: new Map<string, { body: string }>(),
    calls: [] as { channelId: string; ids: readonly string[] }[]
}));

vi.mock("@/lib/chat/e2ee/sealed-chat", () => ({
    sealedChatActive: () => sealed.active,
    openedContent: (id: string) => sealed.opened.get(id),
    openSealed: async (channelId: string, ids: readonly string[]) => {
        sealed.calls.push({ channelId, ids });
        for (const id of ids) sealed.opened.set(id, sealed.pending.get(id) ?? null);
        return new Map(ids.map((id) => [id, sealed.opened.get(id) ?? null]));
    }
}));

const { useOpenedLast, useOpenedWithin, withOpened } = await import("@/app/(app)/chat/opened-sealed");

function row(id: string, extra: Partial<ChatMessageView> = {}): ChatMessageView {
    return { id, channelId: "channel-1", kind: "text", body: "", sealed: true, ...extra } as ChatMessageView;
}

const t = (key: string) => key;

beforeEach(() => {
    sealed.active = true;
    sealed.opened.clear();
    sealed.pending.clear();
    sealed.calls = [];
});

describe("withOpened", () => {
    it("draws a sealed row with what it opened to and leaves the rest alone", () => {
        const plain = row("plain", { sealed: false, body: "hello" });
        const out = withOpened([plain, row("s1"), row("s2")], (id) => (id === "s1" ? { body: "secret" } : null));
        expect(out[0]).toBe(plain);
        expect(out[1]!.body).toBe("secret");
        expect(out[2]!.body).toBe("");
    });

    it("returns the same list when nothing opened", () => {
        const list = [row("s1")];
        expect(withOpened(list, () => undefined)).toBe(list);
    });
});

describe("useOpenedWithin", () => {
    it("opens the sealed messages of pins or hits and keeps the entries that were not sealed", async () => {
        sealed.pending.set("s1", { body: "pinned words" });
        const plain = { pinId: "p0", message: row("plain", { sealed: false, body: "hi" }) };
        const entries = [plain, { pinId: "p1", message: row("s1") }];
        const { result } = renderHook(() => useOpenedWithin(entries));
        await waitFor(() => expect(result.current?.[1]?.message.body).toBe("pinned words"));
        expect(result.current?.[0]).toBe(plain);
        expect(result.current?.[1]?.pinId).toBe("p1");
        expect(sealed.calls).toEqual([{ channelId: "channel-1", ids: ["s1"] }]);
    });

    it("passes null through", () => {
        const { result } = renderHook(() => useOpenedWithin(null));
        expect(result.current).toBeNull();
    });

    it("opens nothing while sealed chat is off", () => {
        sealed.active = false;
        const entries = [{ message: row("s1") }];
        const { result } = renderHook(() => useOpenedWithin(entries));
        expect(result.current).toBe(entries);
        expect(sealed.calls).toEqual([]);
    });
});

describe("useOpenedLast", () => {
    it("opens a conversation's sealed last line and cuts it to one row", async () => {
        sealed.pending.set("s1", { body: `first line\n\nsecond ${"x".repeat(400)}` });
        const last = { body: "", sealedId: "s1" };
        const { result } = renderHook(() => useOpenedLast("channel-1", last));
        await waitFor(() => expect(result.current?.body.startsWith("first line")).toBe(true));
        // One row (PREVIEW_CHARS and its ellipsis), not the 400-odd characters it opened to.
        expect(result.current!.body.length).toBeLessThan(170);
        expect(result.current!.body).not.toContain("\n");
    });

    it("stays empty when it does not open, and leaves a plain line alone", async () => {
        const sealedLast = { body: "", sealedId: "s1" };
        const { result } = renderHook(() => useOpenedLast("channel-1", sealedLast));
        await waitFor(() => expect(sealed.calls).toHaveLength(1));
        expect(result.current).toBe(sealedLast);
        const plain = { body: "hello" };
        expect(renderHook(() => useOpenedLast("channel-1", plain)).result.current).toBe(plain);
    });

    it("does not ask again for a message this page already opened", () => {
        sealed.opened.set("s1", { body: "known" });
        const { result } = renderHook(() => useOpenedLast("channel-1", { body: "", sealedId: "s1" }));
        expect(result.current?.body).toBe("known");
        expect(sealed.calls).toEqual([]);
    });
});

describe("previewText", () => {
    it("says nothing for a sealed line not opened, rather than claim a file", () => {
        expect(previewText({ deleted: false, kind: "text", body: "", sealed: true }, t)).toBe("");
        expect(previewText({ deleted: false, kind: "text", body: " ", sealedId: "s1" }, t)).toBe("");
    });

    it("shows an opened sealed line, and still names a plain attachment", () => {
        expect(previewText({ deleted: false, kind: "text", body: "opened  words", sealedId: "s1" }, t)).toBe("opened words");
        expect(previewText({ deleted: false, kind: "text", body: "" }, t)).toBe("listView.attachment");
    });
});

describe("rewritable", () => {
    it("offers the pencil on a plain message and not on a sealed one or a poll", () => {
        expect(rewritable({ kind: "text", body: "hi", sealed: false })).toBe(true);
        expect(rewritable({ kind: "text", body: "hi" })).toBe(true);
        expect(rewritable({ kind: "text", body: "hi", sealed: true })).toBe(false);
        expect(rewritable({ kind: "poll", body: "Lunch?" })).toBe(false);
    });
});
