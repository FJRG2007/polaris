/**
 * A sync does not undo a flag the mail server has not been told about yet.
 *
 * The report: a message opened went back to unread on its own. Marking read
 * writes the row first and tells the mail server after the answer has gone; a
 * sync pass in between asked the server for flags, heard the old unread one, and
 * wrote it back over the row. The flag is now held from the write until its push
 * has finished, and the sync keeps it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const update = vi.fn(async () => undefined);
vi.mock("@polaris/db", () => ({
    prisma: {
        mailMessage: { findMany, update },
        mailFolder: { update: vi.fn(async () => undefined) }
    }
}));

// What the rest of a sync reaches - the session, the audit trail - is not part
// of reading flags.
vi.mock("@/lib/auth", () => ({}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));

const { reconcileFlags } = await import("@/lib/mailbox/sync");
const { FLAG_HOLD_MS, heldFlags, holdFlag } = await import("@/lib/mailbox/pending-flags");

const FOLDER = {
    id: "f1",
    path: "INBOX",
    role: "inbox",
    uidValidity: 1n,
    uidNext: 10n,
    highestModseq: null,
    keywords: false
};

/** A mail server that still reports these flags for uid 7. */
function server(flags: string[]) {
    return {
        fetch: async function* () {
            yield { uid: 7, flags: new Set(flags) };
        }
    } as never;
}

const row = (seen: boolean) => ({
    id: "m1",
    uid: 7n,
    seen,
    flagged: false,
    answered: false,
    important: false
});

let releases: (() => void)[] = [];
beforeEach(() => {
    findMany.mockReset();
    update.mockClear();
});
afterEach(() => {
    for (const release of releases) release();
    releases = [];
});

describe("a sync while a flag is on its way to the mail server", () => {
    it("keeps a message just marked read, read", async () => {
        releases.push(holdFlag(["m1"], "seen", true));
        findMany.mockResolvedValue([row(true)]);
        await reconcileFlags(server([]), FOLDER, null);
        expect(update).not.toHaveBeenCalled();
    });

    it("still takes every other flag the server changed", async () => {
        releases.push(holdFlag(["m1"], "seen", true));
        findMany.mockResolvedValue([row(true)]);
        await reconcileFlags(server(["\\Flagged"]), FOLDER, null);
        expect(update).toHaveBeenCalledWith({
            where: { id: "m1" },
            data: { seen: true, flagged: true, answered: false, important: false }
        });
    });

    it("believes the server again once the push has finished", async () => {
        const release = holdFlag(["m1"], "seen", true);
        release();
        findMany.mockResolvedValue([row(true)]);
        await reconcileFlags(server([]), FOLDER, null);
        expect(update).toHaveBeenCalledWith({
            where: { id: "m1" },
            data: { seen: false, flagged: false, answered: false, important: false }
        });
    });
});

describe("a hold", () => {
    it("lapses on its own if its push never reports back", () => {
        holdFlag(["m2"], "seen", true, 0);
        expect(heldFlags("m2", FLAG_HOLD_MS - 1)).toEqual({ seen: true });
        expect(heldFlags("m2", FLAG_HOLD_MS + 1)).toEqual({});
    });

    it("is replaced by a newer one, whose release the older one leaves alone", () => {
        const older = holdFlag(["m3"], "seen", true);
        const newer = holdFlag(["m3"], "seen", false);
        older();
        expect(heldFlags("m3")).toEqual({ seen: false });
        newer();
        expect(heldFlags("m3")).toEqual({});
    });
});
