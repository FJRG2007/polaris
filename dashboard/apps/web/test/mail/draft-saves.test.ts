/**
 * The composer's draft-saves queue.
 *
 * Before this, a Close or a Send pressed while the first autosave was still on
 * its way wrote a second draft, or queued a message while its draft stayed
 * behind in Drafts - because each caller asked the server on its own, with
 * whatever id the screen held at that moment. This pins that every save now
 * waits for the one before it, and that Send holds the queue rather than
 * racing it.
 */

import { describe, expect, it } from "vitest";
import { draftSaves, type DraftFields, type DraftWriter } from "@/app/(app)/mail/draft-saves";

const SEED: DraftFields = {
    accountId: "a1",
    identityId: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    attachmentIds: []
};

function withBody(body: string): DraftFields {
    return { ...SEED, body };
}

/** A promise whose settlement is controlled from outside it, created before
 *  the call that will observe it - so nothing races the queue's own
 *  microtask scheduling the way reassigning a closure from inside the writer
 *  would. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("a save pressed while the first is still on its way", () => {
    it("writes one draft, not two, and the second save starts from the id the first left", async () => {
        const calls: Array<{ fields: DraftFields; id: string | null }> = [];
        const firstWrite = deferred<string>();
        const write: DraftWriter = (fields, id) => {
            calls.push({ fields, id });
            return calls.length === 1 ? firstWrite.promise : Promise.resolve(id);
        };

        const saves = draftSaves(SEED, null, write);

        const first = saves.save(withBody("Hello"));
        // Pressed before the first save has answered - the exact window that
        // used to write a second, orphaned draft.
        const second = saves.save(withBody("Hello there"));

        await flushMicrotasks();
        // The second save has not written anything yet: it is waiting its turn.
        expect(calls).toHaveLength(1);
        firstWrite.resolve("draft-1");

        await expect(first).resolves.toBe("draft-1");
        await expect(second).resolves.toBe("draft-1");
        expect(calls).toHaveLength(2);
        // The second write used the id the first one left, not null.
        expect(calls[1]?.id).toBe("draft-1");
    });
});

describe("a draft that says the same thing already written", () => {
    it("is not written again", async () => {
        const calls: DraftFields[] = [];
        const write: DraftWriter = (fields) => {
            calls.push(fields);
            return Promise.resolve("draft-1");
        };
        const saves = draftSaves(withBody("Hello"), "draft-1", write);

        await saves.save(withBody("Hello"));
        expect(calls).toHaveLength(0);

        await saves.save(withBody("Hello, changed"));
        expect(calls).toHaveLength(1);
    });

    it("a fresh composer opened and closed with nothing typed writes nothing", async () => {
        const calls: DraftFields[] = [];
        const write: DraftWriter = (fields) => {
            calls.push(fields);
            return Promise.resolve("draft-1");
        };
        const saves = draftSaves(SEED, null, write);

        await saves.save(SEED);
        expect(calls).toHaveLength(0);
    });
});

describe("a send", () => {
    it("holds the queue so a save landing after it does not put the message back in Drafts", async () => {
        const calls: DraftFields[] = [];
        const write: DraftWriter = (fields) => {
            calls.push(fields);
            return Promise.resolve("draft-1");
        };
        const saves = draftSaves(SEED, null, write);

        saves.hold();
        const result = await saves.save(withBody("Sent while held"));
        expect(calls).toHaveLength(0);
        expect(result).toBeNull();

        saves.release();
        await saves.save(withBody("Sent while held"));
        expect(calls).toHaveLength(1);
    });

    it("adopts the id a send answers with, so the next save writes over that draft", async () => {
        const calls: Array<{ fields: DraftFields; id: string | null }> = [];
        const write: DraftWriter = (fields, id) => {
            calls.push({ fields, id });
            return Promise.resolve(id ?? "unexpected");
        };
        const saves = draftSaves(SEED, null, write);

        saves.adopt("sent-draft", withBody("Queued message"));
        await saves.save(withBody("Queued message, edited"));

        expect(calls).toHaveLength(1);
        expect(calls[0]?.id).toBe("sent-draft");
    });

    it("after() runs once every save already asked for has settled, with the id they left", async () => {
        const firstWrite = deferred<string>();
        const write: DraftWriter = (_fields, id) => (id === null ? firstWrite.promise : Promise.resolve(id));
        const saves = draftSaves(SEED, null, write);

        const pending = saves.save(withBody("Still typing"));
        const after = saves.after((id) => Promise.resolve(id));

        await flushMicrotasks();
        firstWrite.resolve("draft-9");
        await pending;

        await expect(after).resolves.toBe("draft-9");
    });
});
