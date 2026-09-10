/**
 * Who reaches a mail server, and the credential Polaris uses on it.
 *
 * Somebody's own server is theirs alone; an organization's is anybody the
 * organization lets deploy. "Not yours" reads exactly like "not there", so an
 * id cannot be used to learn a server exists. And the credential follows setup:
 * the recovery administrator until Polaris's own account exists, that account
 * after.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, Record<string, unknown>>();
const orgAllows = new Set<string>();

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: (secret: string) => ({ ciphertext: Buffer.from(secret), nonce: Buffer.from("n"), keyId: "k" }),
    decryptSecret: (sealed: { ciphertext: Buffer }) => sealed.ciphertext.toString()
}));
vi.mock("@/lib/orgs/org-service", () => ({
    requireOrgPermission: vi.fn(async (actor: { id: string }, orgId: string) => {
        if (!orgAllows.has(`${actor.id}:${orgId}`)) throw new Error("no");
    })
}));
vi.mock("@polaris/db", () => ({
    prisma: { mailServer: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null) } }
}));

const access = await import("@/lib/mail-server/access");

beforeEach(() => {
    rows.clear();
    orgAllows.clear();
    rows.set("own", { id: "own", ownerId: "alice", orgId: null });
    rows.set("org", { id: "org", ownerId: "carol", orgId: "acme" });
});

describe("reaching a server", () => {
    it("lets the owner reach their own and nobody else", async () => {
        await expect(access.requireServer({ id: "alice", isAdmin: false }, "own")).resolves.toMatchObject({ id: "own" });
        await expect(access.requireServer({ id: "bob", isAdmin: true }, "own")).rejects.toThrow("That mail server was not found.");
    });

    it("lets whoever the organization lets deploy reach its server", async () => {
        orgAllows.add("bob:acme");
        await expect(access.requireServer({ id: "bob", isAdmin: false }, "org")).resolves.toMatchObject({ id: "org" });
        await expect(access.requireServer({ id: "dave", isAdmin: false }, "org")).rejects.toThrow("That mail server was not found.");
    });

    it("says the same about a server that does not exist", async () => {
        await expect(access.requireServer({ id: "alice", isAdmin: false }, "missing")).rejects.toThrow("That mail server was not found.");
    });
});

describe("the credential", () => {
    const sealed = access.seal("s3cret-password");
    const server = (step: string) =>
        ({
            primaryDomain: "example.com",
            step,
            adminSecret: sealed.ciphertext,
            adminSecretNonce: sealed.nonce,
            adminSecretKeyId: sealed.keyId
        }) as never;

    it("is the recovery administrator until Polaris's own account exists", () => {
        expect(access.adminCredentials(server("bootstrap"))).toEqual({ username: "polaris-setup", password: "s3cret-password" });
    });

    it("is Polaris's own account from then on, with the same password", () => {
        expect(access.adminCredentials(server("admin"))).toEqual({ username: "polaris-admin@example.com", password: "s3cret-password" });
        expect(access.adminCredentials(server("done")).username).toBe("polaris-admin@example.com");
    });
});
