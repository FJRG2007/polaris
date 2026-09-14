/**
 * Asking the background worker, when the worker is not there to ask.
 *
 * Under manifest v3 the worker is recycled whenever the browser decides to, and
 * `sendMessage` to one that has gone rejects rather than answering. Every screen
 * in the popup does the same three things - press, await this, turn its own
 * "busy" back off - so a rejection skipped the third, and the button sat reading
 * "Asking the browser" for as long as the popup stayed open with nothing
 * anywhere saying why. From the outside it was a button wired to nothing.
 *
 * What is pinned here is the guarantee that makes every one of those screens
 * safe: this never throws, whichever way the worker fails, and what comes back
 * is the refusal shape they all already handle.
 */

import { askBackground } from "../src/lib/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A worker that answers however the test says it does. */
function answering(reply: () => unknown): void {
    vi.stubGlobal("browser", { runtime: { sendMessage: async () => reply() } });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("asking the background worker", () => {
    it("hands back what the worker actually said", async () => {
        answering(() => ({ ok: true, items: [] }));
        expect(await askBackground({ kind: "items", query: "" })).toEqual({ ok: true, items: [] });
    });

    it("answers rather than throwing when the worker has gone", async () => {
        // The browser's own wording for it, near enough: what matters is that it
        // rejects, which is what every caller was not prepared for.
        answering(() => {
            throw new Error("Could not establish connection. Receiving end does not exist.");
        });
        expect((await askBackground({ kind: "status" })).ok).toBe(false);
    });

    it("answers rather than throwing when nothing comes back at all", async () => {
        // A worker torn down part way through resolves with undefined instead of
        // rejecting. Read as a Reply, that is an object whose `ok` never arrives -
        // a screen waiting on a field that does not exist.
        answering(() => undefined);
        expect((await askBackground({ kind: "status" })).ok).toBe(false);
    });

    it("refuses an answer that is not one", async () => {
        answering(() => "pardon?");
        expect((await askBackground({ kind: "status" })).ok).toBe(false);
    });

    it("says something the reader can act on", async () => {
        // Opening the popup again starts a worker, so that is what the sentence
        // asks for. A refusal with nothing to do about it would be the same dead
        // end in different words.
        answering(() => undefined);
        const reply = await askBackground({ kind: "status" });

        expect(reply.ok).toBe(false);
        if (!reply.ok) expect(reply.error).toMatch(/again/i);
    });
});
