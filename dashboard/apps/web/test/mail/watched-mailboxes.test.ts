/**
 * A mailbox somebody is looking at is asked far more often than one nobody is.
 *
 * Mail read in another client - a phone, Thunderbird, the provider's own web
 * page - took up to five minutes to stop being bold here, because that is the
 * interval a mailbox nobody has open deserves and it was the only interval
 * there was.
 *
 * The counting is the part worth testing. The timer belongs to the person, not
 * to the tab: four tabs must be one pass over the mailbox rather than four, and
 * the last one closing has to stop it - a stream is torn down twice, by its
 * abort signal and by its own cancel, and a release that ran twice would take
 * somebody else's tab off the count and leave a timer running for nobody.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchMailboxes, watchedReaders } from "@/lib/mailbox/watch";

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("who counts as watching", () => {
    it("is watching while a tab is open and not after", () => {
        expect(watchedReaders().has("usr_1")).toBe(false);
        const stop = watchMailboxes("usr_1");
        expect(watchedReaders().has("usr_1")).toBe(true);
        stop();
        expect(watchedReaders().has("usr_1")).toBe(false);
    });

    it("holds one watch for however many tabs one person has", () => {
        const first = watchMailboxes("usr_2");
        const second = watchMailboxes("usr_2");
        const third = watchMailboxes("usr_2");
        expect(watchedReaders().has("usr_2")).toBe(true);

        first();
        second();
        // Two closed, one still open: still watching.
        expect(watchedReaders().has("usr_2")).toBe(true);
        third();
        expect(watchedReaders().has("usr_2")).toBe(false);
    });

    it("ignores a release that happens twice", () => {
        const first = watchMailboxes("usr_3");
        const second = watchMailboxes("usr_3");
        first();
        first();
        first();
        // The other tab is still open, and three releases of the same one must
        // not have taken it off the count.
        expect(watchedReaders().has("usr_3")).toBe(true);
        second();
        expect(watchedReaders().has("usr_3")).toBe(false);
    });

    it("keeps people apart", () => {
        const one = watchMailboxes("usr_4");
        const two = watchMailboxes("usr_5");
        expect([...watchedReaders()].sort()).toEqual(["usr_4", "usr_5"]);
        one();
        expect([...watchedReaders()]).toEqual(["usr_5"]);
        two();
    });
});
