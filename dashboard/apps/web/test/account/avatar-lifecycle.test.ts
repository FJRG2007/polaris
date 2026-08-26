/**
 * What happens to the file when a photo stops being somebody's photo.
 *
 * A photo is written under a name of its own every time, so nothing is ever
 * overwritten in place - which means every one of these paths has to remove the
 * file itself, and the ones that did not were leaving pictures on the disk with
 * nothing left anywhere pointing at them.
 *
 * The one worth pinning hardest: deleting an account cascades its photo rows
 * away, and a cascade removes rows, not bytes. Without the pass below, somebody's
 * face outlived their account - and unfindably, because the only record of where
 * it had been written went with the row.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The photo rows, as the database would hold them. */
let rows: Record<string, { connectionId: string | null; path: string } | null>;
/** Paths the storage was asked to delete, and the ones it refused. */
let deleted: string[];
let refuse: Set<string>;
/** Rows the upsert is told to reject, to stand for a database that gives out. */
let rejectWrite: boolean;

vi.mock("@polaris/db", () => {
    const table = (key: string) => ({
        findUnique: async () => rows[key] ?? null,
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
            if (rejectWrite) throw new Error("the row would not write");
            rows[key] = {
                connectionId: (create.connectionId as string | null) ?? null,
                path: create.path as string
            };
            return rows[key];
        },
        delete: async () => {
            rows[key] = null;
        }
    });
    return {
        prisma: {
            userAvatar: table("user"),
            userBanner: table("banner"),
            organizationAvatar: table("org"),
            chatSpaceAvatar: table("space"),
            chatChannelAvatar: table("channel"),
            user: { findUnique: async () => ({ email: "ada@example.com" }) }
        }
    };
});

vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
    setSetting: async () => undefined
}));

vi.mock("@/lib/storage-target", () => ({
    AUTOMATIC_TARGET: "auto",
    LOCAL_TARGET: "local",
    resolveStorageTarget: async () => ({ id: "local" }),
    safeName: (value: string) => value,
    storageTargetOptions: async () => [],
    placeFile: async ({ path }: { path: string }) => ({ targetId: "local", path }),
    driverForTarget: async () => ({
        delete: async (path: string) => {
            if (refuse.has(path)) throw new Error("the storage is away");
            deleted.push(path);
        },
        dispose: async () => undefined
    })
}));

const { discardAvatars, storeAvatar } = await import("@/lib/avatar-service");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

beforeEach(() => {
    rows = {};
    deleted = [];
    refuse = new Set();
    rejectWrite = false;
});

/** Give a subject a photo, and answer with where it went. */
async function give(kind: "user" | "banner" | "org" | "space" | "channel"): Promise<string> {
    await storeAvatar({ kind, id: "ada" }, PNG, "image/png");
    const row = rows[kind];
    if (!row) throw new Error(`no ${kind} row was written`);
    return row.path;
}

describe("deleting the thing a photo is of", () => {
    it("takes an account's photo and its banner with it", async () => {
        const face = await give("user");
        const banner = await give("banner");

        await expect(discardAvatars("user", "ada")).resolves.toEqual([]);

        expect(deleted).toContain(face);
        expect(deleted).toContain(banner);
    });

    it("takes an organization's, a space's and a channel's", async () => {
        for (const kind of ["org", "space", "channel"] as const) {
            const path = await give(kind);
            await discardAvatars(kind, "ada");
            expect(deleted).toContain(path);
        }
    });

    it("says which files the storage would not give up, rather than losing them quietly", async () => {
        // A NAS that is away, or a connection that has been removed. Nothing
        // retries, so the caller recording this is the only way anybody finds out
        // that a deleted person's face is still on a disk.
        const face = await give("user");
        refuse.add(face);

        await expect(discardAvatars("user", "ada")).resolves.toEqual([face]);
        expect(deleted).not.toContain(face);
    });

    it("does not fail for a subject that never had one", async () => {
        await expect(discardAvatars("org", "nobody")).resolves.toEqual([]);
        expect(deleted).toEqual([]);
    });
});

describe("replacing a photo", () => {
    it("removes the one it replaced", async () => {
        const first = await give("user");
        const second = await give("user");

        expect(second).not.toBe(first);
        expect(deleted).toEqual([first]);
    });

    it("takes its own bytes back when the row will not write", async () => {
        // The file is already on the disk and nothing points at it yet; if the row
        // never lands, nothing ever will.
        await give("user");
        deleted = [];
        rejectWrite = true;

        await expect(storeAvatar({ kind: "user", id: "ada" }, PNG, "image/png")).rejects.toThrow();

        expect(deleted).toHaveLength(1);
        // The one it just wrote, not the one still being used.
        expect(deleted[0]).not.toBe(rows.user?.path);
    });

    it("leaves the photo in place when the new one will not write", async () => {
        const first = await give("user");
        rejectWrite = true;

        await expect(storeAvatar({ kind: "user", id: "ada" }, PNG, "image/png")).rejects.toThrow();

        expect(rows.user?.path).toBe(first);
        expect(deleted).not.toContain(first);
    });
});

/**
 * The rule, pinned where it can be broken.
 *
 * Every one of these deletions cascades a photo row away, and each one is in a
 * different service written by whoever needed it - which is how three of the four
 * came to be missing this at once. A new subject with a picture will be added by
 * somebody who has never read this file, so the rule is asserted rather than left
 * to a comment.
 */
describe("every subject that can be deleted drops its photos first", () => {
    /** How far back the drop may be and still be this deletion's own. Roomy
     *  enough for a comment and a loop, far short of the next function. */
    const NEARBY = 600;

    const SITES = [
        { file: "src/lib/user-admin-service.ts", call: "prisma.user.delete(" },
        { file: "src/lib/orgs/org-service.ts", call: "prisma.organization.delete(" },
        { file: "src/lib/chat/chat-service.ts", call: "prisma.chatSpace.delete(" },
        { file: "src/lib/chat/chat-service.ts", call: "prisma.chatChannel.delete(" }
    ];

    for (const site of SITES) {
        it(`${site.call} is preceded by the photos going`, () => {
            const source = readFileSync(join(process.cwd(), site.file), "utf8");
            const deletes = source.indexOf(site.call);
            expect(deletes, `${site.call} is no longer in ${site.file}`).toBeGreaterThan(-1);
            const drops = source.lastIndexOf("discardAvatars(", deletes);
            // Before it, not after: afterwards the row naming the file is gone and
            // there is nothing left to read the path from. And close before it -
            // one file holds two of these deletions, and the first one's call
            // would otherwise stand in for the second one having none.
            expect(drops, `${site.file} deletes without dropping its photos`).toBeGreaterThan(-1);
            expect(
                deletes - drops,
                `${site.call} drops photos, but somewhere else entirely`
            ).toBeLessThan(NEARBY);
        });
    }
});
