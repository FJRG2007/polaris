/**
 * Public analytics links: an embed never carries a password (in the schema and
 * in what is stored), a site holds a bounded number of links, a removal is
 * scoped to its site, an expired link is not usable, and the unlock cookie is
 * bound to the link and the password it was solved against.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Record<string, unknown>[] = [];
let linkCount = 0;
const deleteMany = vi.fn(async (_args: unknown) => ({ count: 1 }));

vi.mock("@polaris/db", () => ({
    prisma: {
        analyticsShareLink: {
            count: async () => linkCount,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                created.push(data);
                return {
                    id: "link-1",
                    label: data.label,
                    encryptedToken: new Uint8Array(),
                    tokenNonce: new Uint8Array(),
                    tokenKeyId: "",
                    passwordHash: data.passwordHash,
                    range: data.range,
                    allowEmbed: data.allowEmbed,
                    expiresAt: data.expiresAt,
                    viewCount: 0,
                    lastViewedAt: null,
                    createdAt: new Date(0)
                };
            },
            deleteMany: (args: unknown) => deleteMany(args)
        }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: () => ({ ciphertext: Buffer.from("c"), nonce: Buffer.from("n"), keyId: "key" }),
    decryptSecret: () => "the-token"
}));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://share.example.test/" }));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => true }));

const share = await import("@/lib/analytics-share");

beforeEach(() => {
    created.length = 0;
    linkCount = 0;
    deleteMany.mockClear();
});

describe("the link input", () => {
    it("refuses an embed with a password", () => {
        expect(share.shareLinkInputSchema.safeParse({ password: "secret", allowEmbed: true }).success).toBe(false);
        expect(share.shareLinkInputSchema.safeParse({ allowEmbed: true }).success).toBe(true);
    });

    it("offers only the listed lifetimes and ranges", () => {
        expect(share.shareLinkInputSchema.safeParse({ expiresInDays: 14 }).success).toBe(false);
        expect(share.shareLinkInputSchema.safeParse({ range: "5y" }).success).toBe(false);
        expect(share.shareLinkInputSchema.parse({ expiresInDays: 90 }).expiresInDays).toBe(90);
    });

    it("reads an unknown stored range as the default", () => {
        expect(share.storedRange("7d")).toBe("7d");
        expect(share.storedRange("nonsense")).toBe("30d");
    });
});

describe("making a link", () => {
    it("stores a hash and a password hash, never the token or the password", async () => {
        const now = Date.UTC(2026, 0, 1);
        const view = await share.createShareLink(
            "site-1",
            "user-1",
            share.shareLinkInputSchema.parse({ password: "hunter22", expiresInDays: 7 }),
            now
        );
        const row = created[0] as Record<string, unknown>;
        expect(JSON.stringify(row)).not.toContain("hunter22");
        expect(String(row.passwordHash)).toMatch(/^scrypt\$/);
        expect((row.expiresAt as Date).getTime()).toBe(now + 7 * 86_400_000);
        expect(view?.url).toBe("https://share.example.test/sa/the-token");
        expect(view?.embedUrl).toBeNull();
        expect(view?.hasPassword).toBe(true);
    });

    it("gives an embeddable link its embed address", async () => {
        const view = await share.createShareLink("site-1", "user-1", share.shareLinkInputSchema.parse({ allowEmbed: true }));
        expect(view?.embedUrl).toBe("https://share.example.test/sa/embed/the-token");
    });

    it("stops at the per-site ceiling", async () => {
        linkCount = share.SHARE_LINKS_PER_SITE;
        expect(await share.createShareLink("site-1", "user-1", share.shareLinkInputSchema.parse({}))).toBeNull();
        expect(created).toHaveLength(0);
    });

    it("removes only within its own site", async () => {
        await share.deleteShareLink("site-1", "link-9");
        expect(deleteMany).toHaveBeenCalledWith({ where: { id: "link-9", siteId: "site-1" } });
    });
});

describe("the gate", () => {
    it("treats a past expiry as unusable", () => {
        expect(share.shareLinkUsability({ expiresAt: new Date(Date.now() - 1000) }).ok).toBe(false);
        expect(share.shareLinkUsability({ expiresAt: null }).ok).toBe(true);
    });

    it("checks the password against the stored hash", async () => {
        const { hashLinkPassword } = await import("@polaris/core/link-password");
        const passwordHash = await hashLinkPassword("hunter22");
        expect(await share.verifySharePassword({ passwordHash }, "hunter22")).toBe(true);
        expect(await share.verifySharePassword({ passwordHash }, "hunter23")).toBe(false);
        expect(await share.verifySharePassword({ passwordHash: null }, "anything")).toBe(false);
    });

    it("binds the unlock cookie to the link and its password", () => {
        const secret = "s".repeat(32);
        const cookie = share.signShareUnlock("link-1", "hash-a", secret);
        expect(share.verifyShareUnlock("link-1", cookie, "hash-a", secret)).toBe(true);
        expect(share.verifyShareUnlock("link-2", cookie, "hash-a", secret)).toBe(false);
        expect(share.verifyShareUnlock("link-1", cookie, "hash-b", secret)).toBe(false);
    });
});
