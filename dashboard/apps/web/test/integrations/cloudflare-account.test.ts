/**
 * Connecting Cloudflare API tokens. Two things are easy to get wrong here and both
 * cost the operator a working setup.
 *
 * The first is insisting on an account. The domains setup's own link asks Cloudflare
 * for zone permissions, which is what writing records needs and precisely less than
 * listing accounts requires - so a connect that demanded an account rejected the very
 * token it had just told the operator to create.
 *
 * The second is holding one token for two jobs. DNS and tunnels need different
 * permissions, so a single slot makes them evict each other: pointing a domain would
 * quietly take working tunnels offline.
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

const {
    connectCloudflareToken,
    disconnectCloudflareToken,
    getCloudflareAccountStatus,
    loadCloudflareToken,
    loadCloudflareTunnelToken,
    requireCloudflareAccount
} = await import("../../src/lib/integrations/cloudflare-account-service");

/** A token reaching one account and one zone: the "everything" case. */
function full() {
    accounts = [{ id: "acc-1", name: "Personal" }];
    zones = [{ id: "zone-1", name: "fjrg2007.com" }];
}

/** A zone-scoped token: reaches a domain, no account. */
function dnsOnly() {
    accounts = [];
    zones = [{ id: "zone-1", name: "fjrg2007.com" }];
}

beforeEach(() => {
    settings.clear();
    accounts = [];
    zones = [];
    accountsThrow = false;
});

describe("connecting for DNS", () => {
    it("takes a zone-scoped token that reaches no account", async () => {
        dnsOnly();

        const result = await connectCloudflareToken("dns-token", { scope: "dns" });

        expect(result).toMatchObject({ connected: true, stored: ["dns"] });
        expect(await loadCloudflareToken()).toBe("dns-token");
    });

    it("never asks Cloudflare for an account it does not need", async () => {
        dnsOnly();
        accountsThrow = true;

        await expect(connectCloudflareToken("dns-token", { scope: "dns" })).resolves.toMatchObject({ connected: true });
    });

    it("refuses a token that reaches no domain", async () => {
        await expect(connectCloudflareToken("useless", { scope: "dns" })).rejects.toThrow(/no domain/);
        expect(await loadCloudflareToken()).toBeNull();
    });
});

describe("connecting for tunnels", () => {
    it("auto-selects the only account the token reaches", async () => {
        full();

        const result = await connectCloudflareToken("tunnel-token", { scope: "tunnel" });

        expect(result).toMatchObject({ connected: true, accountName: "Personal", stored: ["tunnel"] });
        expect(await requireCloudflareAccount()).toMatchObject({ token: "tunnel-token", accountId: "acc-1" });
    });

    it("asks which account when the token reaches several, storing nothing yet", async () => {
        accounts = [
            { id: "acc-1", name: "Personal" },
            { id: "acc-2", name: "Work" }
        ];

        const result = await connectCloudflareToken("tunnel-token", { scope: "tunnel" });

        expect(result.connected).toBe(false);
        expect(result.accounts).toHaveLength(2);
        expect(await loadCloudflareTunnelToken()).toBeNull();
    });

    it("refuses a token that reaches no account, since tunnels live on one", async () => {
        dnsOnly();

        await expect(connectCloudflareToken("dns-token", { scope: "tunnel" })).rejects.toThrow(/no Cloudflare account/);
    });
});

describe("connecting one token for everything", () => {
    it("fills both slots", async () => {
        full();

        const result = await connectCloudflareToken("full-token", { scope: "all" });

        expect(result.stored).toEqual(["dns", "tunnel"]);
        expect(await getCloudflareAccountStatus()).toMatchObject({
            dnsReady: true,
            connected: true,
            slots: { dns: true, tunnel: true }
        });
    });

    it("keeps a token that turns out to reach no account, for DNS", async () => {
        dnsOnly();

        const result = await connectCloudflareToken("half-token", { scope: "all" });

        // Refusing it would tell the operator a working token is useless.
        expect(result.stored).toEqual(["dns"]);
        expect(await getCloudflareAccountStatus()).toMatchObject({ dnsReady: true, connected: false });
    });
});

describe("the two slots stay independent", () => {
    it("leaves working tunnels alone when a DNS token is connected", async () => {
        full();
        await connectCloudflareToken("tunnel-token", { scope: "tunnel" });

        dnsOnly();
        await connectCloudflareToken("dns-token", { scope: "dns" });

        // The whole reason there are two slots: pointing a domain must not take the
        // tunnels offline.
        expect(await requireCloudflareAccount()).toMatchObject({ token: "tunnel-token", accountId: "acc-1" });
        expect(await loadCloudflareToken()).toBe("dns-token");
    });

    it("disconnects one without touching the other", async () => {
        full();
        await connectCloudflareToken("full-token", { scope: "all" });

        await disconnectCloudflareToken("dns");

        expect(await getCloudflareAccountStatus()).toMatchObject({ connected: true, slots: { dns: false, tunnel: true } });
        // The tunnel slot still answers for DNS, which is what a full token means.
        expect(await loadCloudflareToken()).toBe("full-token");
    });

    it("forgets everything when asked for both", async () => {
        full();
        await connectCloudflareToken("full-token", { scope: "all" });

        await disconnectCloudflareToken("all");

        expect(await getCloudflareAccountStatus()).toMatchObject({
            connected: false,
            dnsReady: false,
            accountId: null
        });
    });
});

describe("what the connected tokens can do", () => {
    it("reports a DNS token as unable to run tunnels, and says what is missing", async () => {
        dnsOnly();
        await connectCloudflareToken("dns-token", { scope: "dns" });

        expect(await getCloudflareAccountStatus()).toMatchObject({ dnsReady: true, connected: false });
        await expect(requireCloudflareAccount()).rejects.toThrow(/Cloudflare Tunnel: Edit/);
    });

    it("keeps answering for installs whose only token predates the split", async () => {
        full();
        await connectCloudflareToken("legacy-token", { scope: "tunnel" });

        // Stored in the tunnel slot alone, exactly as an older Polaris left it.
        expect(await loadCloudflareToken()).toBe("legacy-token");
        expect(await getCloudflareAccountStatus()).toMatchObject({ dnsReady: true, connected: true });
    });

    it("reports nothing connected when no token is stored", async () => {
        expect(await getCloudflareAccountStatus()).toMatchObject({
            dnsReady: false,
            connected: false,
            slots: { dns: false, tunnel: false }
        });
    });
});
