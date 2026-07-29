/**
 * Connecting a Cloudflare API token. The case that matters is the one the domains
 * setup produces: its pre-filled link asks Cloudflare for zone permissions only,
 * which is all writing DNS records needs - and precisely less than listing accounts
 * requires. A connect that insisted on an account rejected the very token it had
 * just told the operator to create, so the guided setup could never finish.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();
let accounts: Array<{ id: string; name: string }> = [];
let zones: Array<{ id: string; name: string }> = [];
let accountsThrow = false;

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findUnique: async ({ where }: { where: { key: string } }) => {
                const value = settings.get(where.key);
                return value === undefined ? null : { value };
            },
            upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
                settings.set(where.key, update.value);
                return { key: where.key, value: update.value };
            },
            deleteMany: async ({ where }: { where: { key: string } }) => {
                settings.delete(where.key);
                return { count: 1 };
            }
        }
    }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "test-master-key" }) }));

// The encryption itself is covered where it lives; here it only has to round-trip so
// a stored token reads back as the one that was connected.
vi.mock("@polaris/storage", () => ({
    encryptSecret: (value: string) => ({ ciphertext: Buffer.from(value), nonce: Buffer.from("n"), keyId: "k" }),
    decryptSecret: ({ ciphertext }: { ciphertext: Buffer }) => ciphertext.toString()
}));

vi.mock("../../src/lib/integrations/cloudflare-api", () => ({
    verifyToken: async () => undefined,
    listAccounts: async () => {
        if (accountsThrow) throw new Error("Authentication error");
        return accounts;
    },
    listZones: async () => zones
}));

const { connectCloudflareAccount, getCloudflareAccountStatus, loadCloudflareToken, requireCloudflareAccount } =
    await import("../../src/lib/integrations/cloudflare-account-service");

beforeEach(() => {
    settings.clear();
    accounts = [];
    zones = [];
    accountsThrow = false;
});

describe("connectCloudflareAccount", () => {
    it("stores a zone-scoped token that reaches no account", async () => {
        zones = [{ id: "zone-1", name: "fjrg2007.com" }];

        const result = await connectCloudflareAccount("dns-only-token");

        expect(result.connected).toBe(true);
        expect(result.accounts).toEqual([]);
        expect(await loadCloudflareToken()).toBe("dns-only-token");
    });

    it("stores it when Cloudflare refuses the account call outright", async () => {
        accountsThrow = true;
        zones = [{ id: "zone-1", name: "fjrg2007.com" }];

        await expect(connectCloudflareAccount("dns-only-token")).resolves.toMatchObject({ connected: true });
    });

    it("refuses a token that reaches neither an account nor a domain", async () => {
        await expect(connectCloudflareAccount("useless-token")).rejects.toThrow(/no account and no domain/);
        expect(await loadCloudflareToken()).toBeNull();
    });

    it("still auto-selects the only account a full token reaches", async () => {
        accounts = [{ id: "acc-1", name: "Personal" }];

        const result = await connectCloudflareAccount("full-token");

        expect(result).toMatchObject({ connected: true, accountName: "Personal" });
        expect((await getCloudflareAccountStatus()).accountId).toBe("acc-1");
    });

    it("asks which account when a token reaches several, storing nothing yet", async () => {
        accounts = [
            { id: "acc-1", name: "Personal" },
            { id: "acc-2", name: "Work" }
        ];

        const result = await connectCloudflareAccount("full-token");

        expect(result.connected).toBe(false);
        expect(result.accounts).toHaveLength(2);
        expect(await loadCloudflareToken()).toBeNull();
    });

    it("drops the previous account when a DNS-only token replaces a full one", async () => {
        accounts = [{ id: "acc-1", name: "Personal" }];
        await connectCloudflareAccount("full-token");

        accounts = [];
        zones = [{ id: "zone-1", name: "fjrg2007.com" }];
        await connectCloudflareAccount("dns-only-token");

        // Left behind, the old id would aim every tunnel call at an account the new
        // token cannot touch.
        expect(await getCloudflareAccountStatus()).toMatchObject({ accountId: null, connected: false });
    });
});

describe("what the connected token can do", () => {
    it("reports a DNS-only token as able to write records but not to run tunnels", async () => {
        zones = [{ id: "zone-1", name: "fjrg2007.com" }];
        await connectCloudflareAccount("dns-only-token");

        expect(await getCloudflareAccountStatus()).toMatchObject({ dnsReady: true, connected: false });
        await expect(requireCloudflareAccount()).rejects.toThrow(/no account access/);
    });

    it("reports a full token as able to do both", async () => {
        accounts = [{ id: "acc-1", name: "Personal" }];
        await connectCloudflareAccount("full-token");

        expect(await getCloudflareAccountStatus()).toMatchObject({ dnsReady: true, connected: true });
        await expect(requireCloudflareAccount()).resolves.toMatchObject({ accountId: "acc-1" });
    });

    it("reports nothing connected when no token is stored", async () => {
        expect(await getCloudflareAccountStatus()).toMatchObject({ dnsReady: false, connected: false });
    });
});
