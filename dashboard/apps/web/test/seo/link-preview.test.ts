/**
 * What a pasted link's preview may say. A chat app's crawler fetches it with no
 * session and shows the answer to the whole conversation, so only a link anybody
 * could open right now may name its item - and an unknown token must look exactly
 * like a refused one, and reading it must never write anything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Record<string, unknown> = {};
const writes: string[] = [];

function model(name: string) {
    return {
        findUnique: async () => rows[name] ?? null,
        update: async () => void writes.push(`${name}.update`),
        updateMany: async () => void writes.push(`${name}.updateMany`),
        create: async () => void writes.push(`${name}.create`),
        upsert: async () => void writes.push(`${name}.upsert`)
    };
}

vi.mock("@polaris/db", () => ({
    prisma: new Proxy({}, { get: (_target, name: string) => model(name) })
}));
vi.mock("@/lib/profile-service", () => ({
    publicProfile: async () => rows.profile ?? null,
    orgProfile: async () => rows.org ?? null
}));

const { mayDisclose, previewText, PREVIEW_KINDS } = await import("@/lib/link-preview/policy");
const { resolveLinkPreview } = await import("@/lib/link-preview/resolve");

const NOW = new Date("2026-06-01T12:00:00Z");
const LATER = new Date("2026-07-01T00:00:00Z");
const EARLIER = new Date("2026-05-01T00:00:00Z");

const open = {
    limits: { revokedAt: null, expiresAt: null, startsAt: null, maxUses: null, useCount: 0 },
    passwordHash: null,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    requireLogin: false,
    allowedUsers: "[]",
    linkSchedule: ""
};

describe("mayDisclose", () => {
    it("names an open, live link", () => {
        expect(mayDisclose("share", open, NOW)).toBe(true);
        expect(mayDisclose("share", { ...open, limits: { ...open.limits, maxUses: 5, useCount: 2 } }, NOW)).toBe(true);
        expect(mayDisclose("share", { ...open, limits: { ...open.limits, expiresAt: LATER } }, NOW)).toBe(true);
    });

    it("treats an unknown token like every refused state", () => {
        expect(mayDisclose("share", null, NOW)).toBe(false);
    });

    const refused: [string, object][] = [
        ["password-protected", { passwordHash: "hash" }],
        ["revoked", { limits: { ...open.limits, revokedAt: EARLIER } }],
        ["expired", { limits: { ...open.limits, expiresAt: EARLIER } }],
        ["not started", { limits: { ...open.limits, startsAt: LATER } }],
        ["exhausted", { limits: { ...open.limits, maxUses: 3, useCount: 3 } }],
        ["single-use", { limits: { ...open.limits, maxUses: 1, useCount: 0 } }],
        ["burn after reading", { oneTime: true }],
        ["browser-sealed", { sealed: true }],
        ["disabled", { disabled: true }],
        ["IP-restricted", { allowedCidrs: '["10.0.0.0/8"]' }],
        ["country-restricted", { allowedCountries: '["ES"]' }],
        ["continent-restricted", { allowedContinents: '["EU"]' }],
        ["sign-in required", { requireLogin: true }],
        ["invite-only", { allowedUsers: '["someone"]' }],
        ["opening hours", { linkSchedule: '{"days":127,"start":540,"end":1020}' }]
    ];
    for (const [state, change] of refused) {
        it(`hides the name of a ${state} link`, () => {
            expect(mayDisclose("share", { ...open, ...change }, NOW)).toBe(false);
        });
    }

    it("never names an encrypted Send or a Places link, however open", () => {
        expect(mayDisclose("send", open, NOW)).toBe(false);
        expect(mayDisclose("places", open, NOW)).toBe(false);
    });
});

describe("previewText", () => {
    it("cuts a long name with an ASCII ellipsis", () => {
        const out = previewText("a".repeat(500));
        expect(out).toHaveLength(80);
        expect(out?.endsWith("...")).toBe(true);
    });

    it("drops control characters and glyphs the face cannot draw", () => {
        expect(previewText("Report\u0000\n2026 \u{1F600}.pdf")).toBe("Report 2026 .pdf");
        expect(previewText("Informe año")).toBe("Informe año");
        expect(previewText("\u{1F600}\u{1F600}")).toBeUndefined();
        expect(previewText("   ")).toBeUndefined();
    });
});

describe("resolveLinkPreview", () => {
    beforeEach(() => {
        for (const key of Object.keys(rows)) delete rows[key];
        writes.length = 0;
    });

    const share = {
        ...open,
        path: "/Projects/Quarterly report.pdf",
        kind: "public",
        maxDownloads: null,
        downloadCount: 0,
        expiresAt: null,
        revokedAt: null,
        startsAt: null
    };

    it("names an open share by its file", async () => {
        rows.share = share;
        expect(await resolveLinkPreview("share", "token")).toEqual({
            kind: "share",
            title: "Quarterly report.pdf",
            detail: undefined
        });
    });

    it("answers an unknown token exactly like a protected or revoked one", async () => {
        const unknown = await resolveLinkPreview("share", "token");
        rows.share = { ...share, passwordHash: "hash" };
        const locked = await resolveLinkPreview("share", "token");
        rows.share = { ...share, revokedAt: EARLIER };
        const revoked = await resolveLinkPreview("share", "token");
        rows.share = { ...share, kind: "invite" };
        const invited = await resolveLinkPreview("share", "token");
        expect(unknown).toEqual({ kind: "share" });
        expect([locked, revoked, invited]).toEqual([unknown, unknown, unknown]);
    });

    it("hides a burn-after-reading or sealed snippet", async () => {
        const snippet = {
            ...open,
            title: "Secret",
            visibility: "public",
            maxViews: null,
            viewCount: 0,
            expiresAt: null,
            revokedAt: null,
            startsAt: null,
            burnAfterRead: false,
            clientSealed: false
        };
        rows.snippet = snippet;
        expect((await resolveLinkPreview("snippet", "token")).title).toBe("Secret");
        rows.snippet = { ...snippet, burnAfterRead: true };
        expect(await resolveLinkPreview("snippet", "token")).toEqual({ kind: "snippet" });
        rows.snippet = { ...snippet, clientSealed: true };
        expect(await resolveLinkPreview("snippet", "token")).toEqual({ kind: "snippet" });
    });

    it("never writes, whatever it reads", async () => {
        rows.share = share;
        for (const kind of PREVIEW_KINDS) await resolveLinkPreview(kind, "token");
        expect(writes).toEqual([]);
    });

    it("falls back to the kind when a read throws", async () => {
        rows.share = undefined;
        Object.defineProperty(rows, "note", {
            configurable: true,
            get() {
                throw new Error("database down");
            }
        });
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await resolveLinkPreview("note", "token")).toEqual({ kind: "note" });
        spy.mockRestore();
        delete rows.note;
    });

    it("shows a profile only as a signed-out reader would see it", async () => {
        expect(await resolveLinkPreview("profile", "ana")).toEqual({ kind: "profile" });
        rows.profile = { name: "Ana Example", username: "ana" };
        expect(await resolveLinkPreview("profile", "ana")).toEqual({
            kind: "profile",
            title: "Ana Example",
            detail: "@ana"
        });
    });
});
