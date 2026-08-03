/**
 * Linking outside accounts. Three things here decide whether one person's private
 * repositories stay theirs, and each has a way of going wrong that is invisible
 * until it has already happened.
 *
 * An account claimed by somebody else must be refused rather than moved: taking
 * it would change which repositories a runner pool serves on the word of whoever
 * authorized second. Re-authorizing an account somebody already holds must not
 * spend one of their slots, or a routine re-consent locks them out of their own
 * link. And the operator's limit has to be counted per provider, so raising the
 * GitHub allowance never quietly raises the Google one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    provider: string;
    accountId: string;
    label: string;
    avatarUrl: string | null;
    method: string;
    scope: string;
    signInEnabled: boolean;
    linkedAt: Date;
    encryptedToken: Buffer | null;
    tokenNonce: Buffer | null;
    tokenKeyId: string | null;
}

let rows: Row[] = [];
const settings = new Map<string, string>();
const banned = new Set<string>();
let nextId = 1;

const key = (provider: string, accountId: string): string => `${provider}:${accountId}`;

vi.mock("@polaris/db", () => ({
    prisma: {
        userConnection: {
            findMany: async ({ where }: { where: { userId?: string; provider?: string } }) =>
                rows.filter(
                    (row) =>
                        (where.userId === undefined || row.userId === where.userId) &&
                        (where.provider === undefined || row.provider === where.provider)
                ),
            findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
                rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null,
            findUnique: async ({ where }: { where: { provider_accountId?: { provider: string; accountId: string }; id?: string } }) => {
                const found = where.id
                    ? rows.find((row) => row.id === where.id)
                    : where.provider_accountId
                      ? rows.find(
                            (row) =>
                                key(row.provider, row.accountId) ===
                                key(where.provider_accountId!.provider, where.provider_accountId!.accountId)
                        )
                      : undefined;
                // The sign-in lookup reads the owner's standing alongside the row.
                return found ? { ...found, user: { bannedAt: banned.has(found.userId) ? new Date() : null } } : null;
            },
            count: async ({ where }: { where: { userId: string; provider: string } }) =>
                rows.filter((row) => row.userId === where.userId && row.provider === where.provider).length,
            upsert: async ({
                where,
                create,
                update
            }: {
                where: { provider_accountId: { provider: string; accountId: string } };
                create: Record<string, unknown>;
                update: Record<string, unknown>;
            }) => {
                const wanted = key(where.provider_accountId.provider, where.provider_accountId.accountId);
                const existing = rows.find((row) => key(row.provider, row.accountId) === wanted);
                if (existing) {
                    Object.assign(existing, update);
                    return existing;
                }
                const row = {
                    id: `row-${nextId++}`,
                    avatarUrl: null,
                    method: "oauth",
                    scope: "",
                    linkedAt: new Date(),
                    encryptedToken: null,
                    tokenNonce: null,
                    tokenKeyId: null,
                    ...create
                } as Row;
                rows.push(row);
                return row;
            },
            update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                const row = rows.find((entry) => entry.id === where.id);
                if (!row) throw new Error("no such row");
                Object.assign(row, data);
                return row;
            },
            delete: async ({ where }: { where: { id: string } }) => {
                rows = rows.filter((row) => row.id !== where.id);
                return { id: where.id };
            }
        }
    }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "test-key" }) }));

vi.mock("@polaris/storage", () => ({
    // Reversible stand-in for the envelope: the test cares that a payload survives
    // the round trip, not how AES-GCM frames it.
    encryptSecret: (value: string) => ({ ciphertext: Buffer.from(value, "utf8"), nonce: Buffer.alloc(12), keyId: "k1" }),
    decryptSecret: (blob: { ciphertext: Buffer }) => blob.ciphertext.toString("utf8"),
    CredentialDecryptError: class CredentialDecryptError extends Error {}
}));

vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (name: string) => settings.get(name) ?? null,
    setSetting: async (name: string, value: string | null) => {
        if (value === null) settings.delete(name);
        else settings.set(name, value);
    }
}));

const {
    ConnectionClaimedError,
    ConnectionLimitError,
    connectionLimit,
    connectionSignInAllowed,
    deleteConnection,
    listConnections,
    readCredential,
    saveConnection,
    setConnectionSignIn,
    signInConnection
} = await import("@/lib/connections/store");

const account = (accountId: string, label: string) => ({
    provider: "github",
    accountId,
    label,
    method: "oauth" as const
});

beforeEach(() => {
    rows = [];
    nextId = 1;
    settings.clear();
    banned.clear();
});

describe("how many accounts one person may link", () => {
    it("allows one of each provider when the operator has set nothing", async () => {
        expect(await connectionLimit("github")).toBe(1);
        expect(await connectionLimit("google")).toBe(1);
    });

    it("takes the operator's number for that provider only", async () => {
        settings.set("connections.github.limit", "3");
        expect(await connectionLimit("github")).toBe(3);
        expect(await connectionLimit("google")).toBe(1);
    });

    it("falls back to the default rather than trusting an unreadable setting", async () => {
        settings.set("connections.github.limit", "not a number");
        expect(await connectionLimit("github")).toBe(1);
    });

    it("refuses a second account at the default limit", async () => {
        await saveConnection("ana", account("1", "ana"));
        await expect(saveConnection("ana", account("2", "ana-work"))).rejects.toBeInstanceOf(ConnectionLimitError);
    });

    it("allows the second once the operator raises it", async () => {
        settings.set("connections.github.limit", "2");
        await saveConnection("ana", account("1", "ana"));
        await saveConnection("ana", account("2", "ana-work"));
        expect(await listConnections("ana", "github")).toHaveLength(2);
    });

    it("turns linking off entirely at zero", async () => {
        settings.set("connections.github.limit", "0");
        await expect(saveConnection("ana", account("1", "ana"))).rejects.toBeInstanceOf(ConnectionLimitError);
    });

    it("does not spend a slot re-authorizing an account already held", async () => {
        await saveConnection("ana", account("1", "ana"));
        await saveConnection("ana", { ...account("1", "ana-renamed"), scope: "repo" });
        const held = await listConnections("ana", "github");
        expect(held).toHaveLength(1);
        expect(held[0]?.label).toBe("ana-renamed");
    });
});

describe("who an outside account belongs to", () => {
    it("refuses an account already linked by somebody else", async () => {
        await saveConnection("ana", account("1", "ana"));
        await expect(saveConnection("bruno", account("1", "ana"))).rejects.toBeInstanceOf(ConnectionClaimedError);
    });

    it("leaves the first person's link untouched when the second is refused", async () => {
        await saveConnection("ana", account("1", "ana"));
        await saveConnection("bruno", account("1", "ana")).catch(() => undefined);
        expect(await listConnections("ana", "github")).toHaveLength(1);
        expect(await listConnections("bruno", "github")).toHaveLength(0);
    });

    it("will not unlink an account that is not the caller's", async () => {
        const linked = await saveConnection("ana", account("1", "ana"));
        expect(await deleteConnection("bruno", linked.id)).toBeNull();
        expect(await listConnections("ana", "github")).toHaveLength(1);
    });
});

describe("whether a linked account may sign its owner in", () => {
    it("takes the provider's own default until the operator says otherwise", async () => {
        expect(await connectionSignInAllowed("github")).toBe(true);
        settings.set("connections.github.signin", "false");
        expect(await connectionSignInAllowed("github")).toBe(false);
        // A provider nobody has heard of is never a way in.
        expect(await connectionSignInAllowed("myspace")).toBe(false);
    });

    it("names the owner of an account that is allowed to sign in", async () => {
        await saveConnection("ana", account("1", "ana"));
        expect(await signInConnection("github", "1")).toMatchObject({ userId: "ana", label: "ana" });
    });

    it("says nothing at all about an account whose owner has closed it", async () => {
        const linked = await saveConnection("ana", account("1", "ana"));
        await setConnectionSignIn("ana", linked.id, false);
        expect(await signInConnection("github", "1")).toBeNull();
    });

    it("does not reopen a closed account when it is authorized again", async () => {
        const linked = await saveConnection("ana", account("1", "ana"));
        await setConnectionSignIn("ana", linked.id, false);
        await saveConnection("ana", { ...account("1", "ana"), scope: "repo" });
        expect(await signInConnection("github", "1")).toBeNull();
    });

    it("reports a suspended owner rather than pretending the link is not there", async () => {
        await saveConnection("ana", account("1", "ana"));
        banned.add("ana");
        expect(await signInConnection("github", "1")).toMatchObject({ userId: "ana", banned: true });
    });

    it("will not let one person open or close another person's account", async () => {
        const linked = await saveConnection("ana", account("1", "ana"));
        expect(await setConnectionSignIn("bruno", linked.id, false)).toBeNull();
        expect(await signInConnection("github", "1")).toMatchObject({ userId: "ana" });
    });
});

describe("the credential behind a link", () => {
    it("survives the round trip as a payload rather than a bare string", async () => {
        const linked = await saveConnection("ana", {
            ...account("1", "ana"),
            credential: { accessToken: "gho_live", refreshToken: "ghr_renew", expiresAt: 1_700_000_000_000 }
        });
        expect(await readCredential(linked.id)).toEqual({
            accessToken: "gho_live",
            refreshToken: "ghr_renew",
            expiresAt: 1_700_000_000_000
        });
    });

    it("reads a link carried over from the calendar table as a refresh token", async () => {
        rows.push({
            id: "legacy",
            userId: "ana",
            provider: "google",
            accountId: "sub-1",
            label: "ana@example.com",
            avatarUrl: null,
            method: "oauth",
            scope: "",
            linkedAt: new Date(),
            // What the old table stored: the token itself, with no payload around it.
            encryptedToken: Buffer.from("1//old-refresh-token", "utf8"),
            tokenNonce: Buffer.alloc(12),
            tokenKeyId: "k1"
        });
        expect(await readCredential("legacy")).toEqual({ refreshToken: "1//old-refresh-token" });
    });

    it("is never returned for a link that has none", async () => {
        const linked = await saveConnection("ana", account("1", "ana"));
        expect(await readCredential(linked.id)).toBeNull();
    });
});
