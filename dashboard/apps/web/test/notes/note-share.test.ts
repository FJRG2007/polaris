/**
 * A note handed to somebody with no account here.
 *
 * The things asserted are the ones that make a public URL safe to hand out: the
 * token is stored as a hash and never in the clear, publishing needs more than
 * reading does, a cap on opens is spent by the database rather than by a read
 * followed by a write, and an archived note is not served whatever the link says.
 *
 * The guards themselves - expiry, revocation, addresses, the password - are
 * `lib/link-guards`, which is tested where it lives. What matters here is that a
 * note goes through them rather than around them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface ShareRow {
    id: string;
    noteId: string;
    ownerId: string;
    tokenHash: string;
    includeChildren: boolean;
    passwordHash: string | null;
    maxViews: number | null;
    viewCount: number;
    allowedCidrs: string;
    allowedCountries: string;
    allowedContinents: string;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
    encryptedToken: Buffer | null;
    tokenNonce: Buffer | null;
    tokenKeyId: string | null;
}

let shares: ShareRow[] = [];
let note: { title: string; body: string; updatedAt: Date; archived: boolean; } | null = null;
let children: { title: string; body: string; }[] = [];

/** What `requireNote` was last asked for, so the permission a call needs can be
 *  asserted rather than assumed. */
const required: string[] = [];

const created: Record<string, unknown>[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        noteShare: {
            findUnique: async ({ where }: { where: { noteId?: string; tokenHash?: string; id?: string; }; }) =>
                shares.find(
                    (row) =>
                        (where.noteId !== undefined && row.noteId === where.noteId) ||
                        (where.tokenHash !== undefined && row.tokenHash === where.tokenHash) ||
                        (where.id !== undefined && row.id === where.id)
                ) ?? null,
            create: async ({ data }: { data: Record<string, unknown>; }) => {
                created.push(data);
                const row = { ...(data as unknown as ShareRow), id: "s1", viewCount: 0, createdAt: new Date() };
                shares.push(row);
                return row;
            },
            update: async ({ data }: { data: Record<string, unknown>; }) => {
                const row = shares[0]!;
                Object.assign(row, data);
                if ((data as { viewCount?: { increment: number; }; }).viewCount?.increment) {
                    row.viewCount += 1;
                }
                return row;
            },
            updateMany: async ({ where }: { where: { viewCount?: { lt: number; }; }; }) => {
                const row = shares[0]!;
                if (where.viewCount && row.viewCount >= where.viewCount.lt) return { count: 0 };
                row.viewCount += 1;
                return { count: 1 };
            },
            deleteMany: async () => {
                shares = [];
                return { count: 1 };
            }
        },
        note: {
            findUnique: async () => note,
            findMany: async () => children
        }
    }
}));

vi.mock("@/lib/notes/access", () => ({
    NoteActor: class {},
    NoteAccessError: class NoteAccessError extends Error {},
    requireNote: async (_actor: unknown, noteId: string, role: string) => {
        required.push(role);
        return { id: noteId, spaceId: null };
    }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://links.example" }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: (value: string) => ({
        ciphertext: Buffer.from(value),
        nonce: Buffer.from("n"),
        keyId: "k1"
    }),
    decryptSecret: ({ ciphertext }: { ciphertext: Buffer; }) => ciphertext.toString()
}));
vi.mock("@polaris/core/link-password", () => ({
    hashLinkPassword: async (value: string) => `hashed:${value}`,
    verifyLinkPassword: async (value: string, hash: string) => hash === `hashed:${value}`
}));

const share = await import("../../src/lib/notes/share-service");
const { hashToken } = await import("@polaris/core/tokens");

const me = { id: "u1", isAdmin: false };

const empty = {
    includeChildren: true,
    clearPassword: false,
    clearMaxViews: false,
    clearExpiry: false,
    allowedCidrs: [],
    allowedCountries: [],
    allowedContinents: []
};

beforeEach(() => {
    shares = [];
    created.length = 0;
    required.length = 0;
    children = [];
    note = { title: "Runbook", body: "Restart it", updatedAt: new Date("2026-09-04"), archived: false };
});

describe("publishing", () => {
    it("hands back an address, and stores the token only as a hash", async () => {
        const published = await share.publishNote(me, "n1", empty);
        expect(published.url).toMatch(/^https:\/\/links\.example\/n\/[A-Za-z0-9_-]+$/);

        const token = published.url.split("/n/")[1]!;
        const stored = created[0] as { tokenHash: string; };
        expect(stored.tokenHash).toBe(hashToken(token));
        // The token itself is nowhere in the row in the clear.
        expect(JSON.stringify(created[0])).not.toContain(token);
    });

    it("costs more than reading does", async () => {
        // Somebody who may read a notebook must not be able to put its pages on
        // the internet.
        await share.publishNote(me, "n1", empty);
        expect(required).toContain("member");

        required.length = 0;
        await share.getNoteShare(me, "n1");
        expect(required).toEqual(["guest"]);
    });

    it("keeps the address when the settings change", async () => {
        // Turning a password on must not invalidate the URL people already have.
        const first = await share.publishNote(me, "n1", empty);
        const second = await share.publishNote(me, "n1", { ...empty, password: "hunter2" });
        expect(second.url).toBe(first.url);
        expect(second.share.hasPassword).toBe(true);
    });

    it("leaves a password alone when neither setting is sent", async () => {
        await share.publishNote(me, "n1", { ...empty, password: "hunter2" });
        const again = await share.publishNote(me, "n1", { ...empty, maxViews: 5 });
        // Saving the other settings must not quietly unlock the link.
        expect(again.share.hasPassword).toBe(true);
        expect(again.share.maxViews).toBe(5);
    });

    it("takes a password off when asked to", async () => {
        await share.publishNote(me, "n1", { ...empty, password: "hunter2" });
        const opened = await share.publishNote(me, "n1", { ...empty, clearPassword: true });
        expect(opened.share.hasPassword).toBe(false);
    });
});

describe("the link itself", () => {
    it("resolves by its token and by nothing else", async () => {
        const published = await share.publishNote(me, "n1", empty);
        const token = published.url.split("/n/")[1]!;
        expect(await share.resolveNoteShareByToken(token)).not.toBeNull();
        expect(await share.resolveNoteShareByToken("not-a-token")).toBeNull();
        expect(await share.resolveNoteShareByToken("")).toBeNull();
    });

    it("is gone once it is taken down", async () => {
        const published = await share.publishNote(me, "n1", empty);
        const token = published.url.split("/n/")[1]!;
        await share.unpublishNote(me, "n1");
        expect(await share.resolveNoteShareByToken(token)).toBeNull();
    });

    it("says why it cannot be opened", async () => {
        const past = new Date(Date.now() - 1000);
        expect(
            share.noteShareUsability({ revokedAt: null, expiresAt: past, maxViews: null, viewCount: 0 })
        ).toEqual({ ok: false, reason: "expired" });
        expect(
            share.noteShareUsability({ revokedAt: null, expiresAt: null, maxViews: 2, viewCount: 2 })
        ).toEqual({ ok: false, reason: "exhausted" });
        expect(
            share.noteShareUsability({ revokedAt: null, expiresAt: null, maxViews: null, viewCount: 900 })
        ).toEqual({ ok: true });
    });
});

describe("counting an opening", () => {
    it("spends the last permitted view once, not twice", async () => {
        await share.publishNote(me, "n1", { ...empty, maxViews: 1 });
        expect(await share.registerNoteShareView("s1")).toBe(true);
        // The second caller loses, because the database decided and not a read
        // followed by a write.
        expect(await share.registerNoteShareView("s1")).toBe(false);
    });

    it("counts without a cap when there is none", async () => {
        await share.publishNote(me, "n1", empty);
        expect(await share.registerNoteShareView("s1")).toBe(true);
        expect(await share.registerNoteShareView("s1")).toBe(true);
    });
});

describe("what a visitor is given", () => {
    it("is the note, and the pages under it when the link carries them", async () => {
        children = [{ title: "Rollback", body: "Put it back" }];
        const withChildren = await share.readPublishedNote({ noteId: "n1", includeChildren: true });
        expect(withChildren?.children).toHaveLength(1);

        const alone = await share.readPublishedNote({ noteId: "n1", includeChildren: false });
        expect(alone?.children).toEqual([]);
    });

    it("is nothing at all once the note is archived", async () => {
        // Archiving is how somebody takes a page out of circulation, whatever
        // the link still says.
        note = { ...note!, archived: true };
        expect(await share.readPublishedNote({ noteId: "n1", includeChildren: true })).toBeNull();
    });

    it("carries no ids, no shelf and no author", async () => {
        const published = await share.readPublishedNote({ noteId: "n1", includeChildren: true });
        expect(Object.keys(published ?? {}).sort()).toEqual([
            "body",
            "children",
            "title",
            "updatedAt"
        ]);
    });
});
