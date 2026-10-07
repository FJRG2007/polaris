/**
 * The public half of a saved SSH key, and only that.
 *
 * The connection form shows a stored key's public line so it can be put in
 * another server's `authorized_keys`. What is pinned here is what keeps that
 * safe: the private key is decrypted on the server and never sent back, a
 * connection somebody else saved is refused like any other, and a connection
 * with no key of its own says so instead of answering with something else.
 */

import { ed25519Pair } from "./fixtures/ed25519";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CONN = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => ({
    caller: "",
    rows: [] as Record<string, unknown>[],
    /** What the stored credential decrypts to, by row id. */
    secrets: new Map<string, unknown>()
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));
vi.mock("@/lib/session", () => ({
    requirePermission: async () => ({ id: state.caller })
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: true, retryAfterMs: 0 })
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/host-service", () => ({ listHosts: async () => [] }));
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_DB_PROVIDER: "postgresql", POLARIS_MASTER_KEY: "0".repeat(64) })
}));
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));
vi.mock("@/lib/database-service", () => ({ databaseCredentials: async () => ({}) }));
vi.mock("@polaris/storage", () => ({
    encryptCredentials: () => ({ ciphertext: Buffer.from(""), nonce: Buffer.from(""), keyId: "k" }),
    decryptCredentials: (envelope: { ciphertext: Buffer }) =>
        state.secrets.get(envelope.ciphertext.toString())
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        dataConnection: {
            findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
                state.rows.find((row) => row.id === where.id && row.ownerId === where.ownerId) ??
                null
        }
    }
}));

const { sshPublicKeyAction } = await import("@/app/(app)/apps/databases/actions");

/** A saved connection reached over SSH with its own login. */
function savedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: CONN,
        ownerId: ALICE,
        engine: "postgres",
        sshMode: "manual",
        sshHost: "bastion.example.test",
        sshPort: 22,
        sshUsername: "deploy",
        sshAuthMethod: "key",
        sshHostKey: "AAAAC3NzaC1lZDI1NTE5AAAAIFixtureHostKeyFixtureHostKeyFixture",
        sshKeySummary: "ssh-ed25519 SHA256:fixture",
        sshEncryptedCredential: Buffer.from(CONN),
        sshCredentialNonce: Buffer.from("nonce"),
        sshCredentialKeyId: "k",
        ...overrides
    };
}

beforeEach(() => {
    state.caller = ALICE;
    state.rows = [];
    state.secrets.clear();
});

describe("showing a saved SSH key", () => {
    it("answers with the public line and never the private key", async () => {
        const pair = ed25519Pair();
        state.rows = [savedRow()];
        state.secrets.set(CONN, { method: "key", privateKey: pair.private });

        const result = await sshPublicKeyAction(CONN);

        expect(result.error).toBeUndefined();
        // The same line ssh2 wrote for the pair, without its comment.
        const [type, blob] = pair.public.split(" ");
        expect(result.publicKey).toBe(`${type} ${blob}`);
        const sent = JSON.stringify(result);
        expect(sent).not.toContain("PRIVATE KEY");
        expect(sent).not.toContain(pair.private.split("\n")[1] ?? "unreachable");
    });

    it("reads a key locked with a passphrase on the server", async () => {
        const pair = ed25519Pair({ passphrase: "fixture-pass", cipher: "aes256-ctr", rounds: 4 });
        state.rows = [savedRow()];
        state.secrets.set(CONN, {
            method: "key",
            privateKey: pair.private,
            passphrase: "fixture-pass"
        });

        const result = await sshPublicKeyAction(CONN);

        expect(result.publicKey?.startsWith("ssh-ed25519 ")).toBe(true);
        expect(JSON.stringify(result)).not.toContain("fixture-pass");
    });

    it("refuses a connection another account saved", async () => {
        const pair = ed25519Pair();
        state.rows = [savedRow({ ownerId: BOB })];
        state.secrets.set(CONN, { method: "key", privateKey: pair.private });

        const result = await sshPublicKeyAction(CONN);

        expect(result.publicKey).toBeUndefined();
        expect(result.error).toBe("refusals.connectionGone");
    });

    it("says there is no key when the login is a password", async () => {
        state.rows = [savedRow({ sshAuthMethod: "password", sshKeySummary: null })];
        state.secrets.set(CONN, { method: "password", password: "fixture-password" });

        const result = await sshPublicKeyAction(CONN);

        expect(result).toEqual({ error: "refusals.noStoredKey" });
    });

    it("says there is no key when the connection is not tunnelled", async () => {
        state.rows = [savedRow({ sshMode: null })];

        expect(await sshPublicKeyAction(CONN)).toEqual({ error: "refusals.noStoredKey" });
    });

    it("refuses an id that is not a connection id before reading anything", async () => {
        for (const bad of ["../etc", "", 42, null, { id: CONN }]) {
            const result = await sshPublicKeyAction(bad);
            expect(result.publicKey).toBeUndefined();
            expect(result.error).toBe("refusals.connectionGone");
        }
    });
});
