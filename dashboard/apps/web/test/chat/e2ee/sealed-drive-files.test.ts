/**
 * A file picked from a Drive in an end-to-end encrypted conversation is copied
 * into the browser and sealed like a picked file (docs/chat-e2ee-mls.md,
 * "Sealed files"): it is never lent as a reference the server reads.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    uploads: [] as string[],
    sealed: [] as string[],
    sent: [] as { files: { id: string }[] }[],
    fetched: [] as string[],
    fetchFails: false
}));

vi.mock("@/app/(app)/chat/video-poster", () => ({ posterFor: async () => null }));
vi.mock("@/app/(app)/chat/media-measure", () => ({ measureMedia: async () => null }));
vi.mock("@/components/transfers/move-file", () => ({
    sendFile: async (url: string) => {
        state.uploads.push(url);
        return { ok: true, status: 200, body: JSON.stringify({ id: `00000000-0000-4000-8000-00000000000${state.uploads.length}` }) };
    }
}));
vi.mock("@/lib/chat/e2ee/sealed-files", () => ({
    sealForUpload: async (file: File) => {
        state.sealed.push(file.name);
        return { blob: new Blob(["sealed"]), ref: (id: string) => ({ id, name: file.name }) };
    },
    keepLocalFile: () => undefined
}));
vi.mock("@/lib/chat/e2ee/sealed-chat", () => ({
    sealsSendsIn: async () => true,
    sendSealedMessage: async (input: { files: { id: string }[] }) => {
        state.sent.push(input);
        return "message-id";
    }
}));

import { sendWithFiles } from "@/app/(app)/chat/send-with-files";

const base = {
    channelId: "11111111-1111-4111-8111-111111111111",
    body: "here",
    notUploaded: () => "not uploaded",
    notSent: "not sent"
};

beforeEach(() => {
    state.uploads = [];
    state.sealed = [];
    state.sent = [];
    state.fetched = [];
    state.fetchFails = false;
    vi.stubGlobal("fetch", async (url: string) => {
        state.fetched.push(url);
        if (state.fetchFails) return new Response(JSON.stringify({ error: "gone" }), { status: 404 });
        return new Response(new Blob(["drive bytes"], { type: "text/plain" }), { headers: { "x-polaris-filename": "report.txt" } });
    });
});

describe("Drive files in a sealed conversation", () => {
    it("copies the Drive file in, seals it and sends it with the picked one", async () => {
        const outcome = await sendWithFiles({
            ...base,
            files: [new File(["mine"], "photo.png", { type: "image/png" })],
            fromDrive: [{ connectionId: "22222222-2222-4222-8222-222222222222", path: "/docs/report.txt", name: "report.txt", size: 11 }]
        });
        expect(outcome).toBe("sent");
        expect(state.fetched).toHaveLength(1);
        expect(state.sealed).toEqual(["photo.png", "report.txt"]);
        // Every upload is a sealed one; nothing names the Drive path to the message.
        expect(state.uploads.every((url) => url.includes("sealed=1"))).toBe(true);
        expect(state.sent[0]!.files).toHaveLength(2);
    });

    it("sends nothing when the Drive file cannot be fetched", async () => {
        state.fetchFails = true;
        const outcome = await sendWithFiles({
            ...base,
            files: [],
            fromDrive: [{ connectionId: "22222222-2222-4222-8222-222222222222", path: "/docs/report.txt", name: "report.txt", size: 11 }]
        });
        expect(outcome).toEqual({ error: "gone" });
        expect(state.uploads).toHaveLength(0);
        expect(state.sent).toHaveLength(0);
    });

    it("still refuses a file sent to be seen once", async () => {
        const outcome = await sendWithFiles({
            ...base,
            files: [new File(["x"], "a.png", { type: "image/png" })],
            viewOnce: [{ index: 0, seconds: 10 }]
        });
        expect(outcome).toEqual({ error: "not sent" });
        expect(state.sent).toHaveLength(0);
    });
});
