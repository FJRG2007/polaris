/**
 * A message still opens when the sanitizer could not be downloaded.
 *
 * The store cleans a body before keeping it, but the server already answered:
 * a failed download of the sanitizer's chunk must not turn that answer into
 * "could not be opened". The raw answer goes to the pane, which cleans it on
 * the way into its frame, and nothing uncleaned is kept on the device.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const write = vi.fn();

vi.mock("@/lib/mailbox/mail-cache", () => ({
    mailCache: { write, read: vi.fn(async () => null) }
}));

vi.mock("@/app/(app)/mail/sanitize", () => ({
    sanitizeMail: vi.fn(async () => {
        throw new Error("chunk failed to load");
    })
}));

const answer = {
    readable: { html: "<p>hello</p>" },
    envelope: { accountId: "fixture-account" }
};

afterEach(() => {
    vi.unstubAllGlobals();
    write.mockClear();
});

describe("opening a message without the sanitizer", () => {
    it("answers with the message and keeps nothing on the device", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }))
        );
        const { readMessage } = await import("@/app/(app)/mail/message-store");
        const opened = await readMessage("fixture-message");
        expect(opened.readable.html).toBe("<p>hello</p>");
        expect(write).not.toHaveBeenCalled();
    });
});
