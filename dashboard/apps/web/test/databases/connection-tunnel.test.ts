/**
 * Saving and opening a connection that is reached over SSH.
 *
 * The rules worth pinning: a server is only usable if it is this account's, the
 * SSH server's key is captured when the connection is saved and checked on every
 * open, an edit that touched nothing about the login does not ask for the secret
 * again, and a tunnel whose server has been removed is refused rather than
 * quietly opened as a direct connection to whatever answers here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "99999999-9999-4999-8999-999999999999";
const SERVER = "22222222-2222-4222-8222-222222222222";
const BASTION = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";

let saved: Record<string, unknown>[] = [];
let written: Record<string, unknown> | null = null;
const captured: { target: Record<string, unknown>; jump: Record<string, unknown> | null }[] = [];
let captureFails = false;

vi.mock("@polaris/db", () => ({
    prisma: {
        dataConnection: {
            findMany: async () => saved,
            findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
                saved.find((row) => row.id === where.id && row.ownerId === where.ownerId) ?? null,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                written = data;
                return { id: CONNECTION };
            },
            update: async ({ data }: { data: Record<string, unknown> }) => {
                written = data;
                return { id: CONNECTION };
            }
        },
        managedDatabase: { findMany: async () => [], findFirst: async () => null }
    }
}));
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({
        POLARIS_DB_PROVIDER: "sqlite",
        POLARIS_DATABASE_URL: "file:./polaris.db",
        POLARIS_MASTER_KEY: "0".repeat(64)
    })
}));
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));
vi.mock("@polaris/storage", () => ({
    encryptCredentials: (secret: unknown) => ({
        ciphertext: Buffer.from(JSON.stringify(secret)),
        nonce: Buffer.from("nonce"),
        keyId: "k1"
    }),
    decryptCredentials: (blob: { ciphertext: Buffer }) => JSON.parse(blob.ciphertext.toString("utf8"))
}));
vi.mock("@/lib/database-service", () => ({ databaseCredentials: async () => ({}) }));
vi.mock("@/lib/host-service", () => ({
    getHostConnection: async (hostId: string, ownerId: string) => {
        if (ownerId !== ALICE) throw new Error("Host not found");
        if (hostId === SERVER) {
            return {
                id: SERVER,
                name: "lirio-0",
                address: "10.0.0.2",
                port: 22,
                username: "polaris",
                auth: { method: "key", privateKey: "server-key" },
                hostKey: "SERVERKEY",
                sudo: false
            };
        }
        if (hostId === BASTION) {
            return {
                id: BASTION,
                name: "bastion",
                address: "10.0.0.9",
                port: 22,
                username: "polaris",
                auth: { method: "key", privateKey: "bastion-key" },
                hostKey: "BASTIONKEY",
                sudo: false
            };
        }
        throw new Error("Host not found");
    }
}));
vi.mock("@/lib/data/tunnel", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/data/tunnel")>();
    return {
        ...real,
        captureHostKey: async (target: Record<string, unknown>, jump: Record<string, unknown> | null) => {
            captured.push({ target, jump });
            if (captureFails) throw new Error("no route to host");
            return "SSHKEY";
        }
    };
});

const { addressOf, listConnections, saveConnection } = await import("@/lib/data/connections");

const base = {
    name: "Production",
    engine: "postgres" as const,
    host: "127.0.0.1",
    port: 5432,
    username: "app",
    password: "app-secret"
};

/** A stored row, as the tunnel columns leave it. */
function row(over: Record<string, unknown> = {}) {
    return {
        id: CONNECTION,
        ownerId: ALICE,
        name: "Production",
        engine: "postgres",
        managedDatabaseId: null,
        host: "127.0.0.1",
        port: 5432,
        database: null,
        username: "app",
        encryptedCredential: Buffer.from(JSON.stringify({ password: "app-secret" })),
        credentialNonce: Buffer.from("nonce"),
        credentialKeyId: "k1",
        tls: false,
        readOnly: false,
        sshMode: null,
        sshHostId: null,
        sshHost: null,
        sshPort: null,
        sshUsername: null,
        sshAuthMethod: null,
        sshEncryptedCredential: null,
        sshCredentialNonce: null,
        sshCredentialKeyId: null,
        sshHostKey: null,
        sshJumpHostId: null,
        lastUsedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        ...over
    };
}

beforeEach(() => {
    saved = [];
    written = null;
    captured.length = 0;
    captureFails = false;
});

describe("saving a tunnel through a registered server", () => {
    it("stores the server and nothing of its login", async () => {
        await saveConnection(ALICE, { ...base, ssh: { mode: "server", hostId: SERVER } });

        expect(written).toMatchObject({ sshMode: "server", sshHostId: SERVER, sshHostKey: null });
        expect(written).not.toHaveProperty("sshEncryptedCredential", expect.anything());
        expect(captured).toHaveLength(0);
    });

    it("refuses a server that belongs to somebody else", async () => {
        await expect(
            saveConnection(BOB, { ...base, ssh: { mode: "server", hostId: SERVER } })
        ).rejects.toThrow(/not one of yours/);
    });
});

describe("saving a tunnel through a login typed in the form", () => {
    const manual = {
        mode: "manual" as const,
        host: "ssh.example.com",
        port: 2222,
        username: "root",
        authMethod: "password" as const,
        password: "hunter2"
    };

    it("signs in once to pin the server's key, and keeps the secret encrypted", async () => {
        await saveConnection(ALICE, { ...base, ssh: manual });

        expect(captured[0]?.target).toMatchObject({ host: "ssh.example.com", port: 2222, username: "root" });
        expect(written).toMatchObject({
            sshMode: "manual",
            sshHost: "ssh.example.com",
            sshPort: 2222,
            sshUsername: "root",
            sshAuthMethod: "password",
            sshHostKey: "SSHKEY",
            sshJumpHostId: null
        });
        const stored = JSON.parse((written?.sshEncryptedCredential as Buffer).toString("utf8"));
        expect(stored).toEqual({ method: "password", password: "hunter2" });
    });

    it("goes through the jump server when one is named", async () => {
        await saveConnection(ALICE, { ...base, ssh: { ...manual, jumpHostId: BASTION } });

        expect(captured[0]?.jump).toMatchObject({ host: "10.0.0.9", pinnedHostKey: ["BASTIONKEY"] });
        expect(written).toMatchObject({ sshMode: "manual-jump", sshJumpHostId: BASTION });
    });

    it("says the login did not work rather than storing one that cannot open", async () => {
        captureFails = true;
        const failed = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(saveConnection(ALICE, { ...base, ssh: manual })).rejects.toThrow(
            /could not sign in to ssh.example.com:2222/
        );
        expect(written).toBeNull();
        failed.mockRestore();
    });

    it("asks for the secret when there is none to keep", async () => {
        await expect(
            saveConnection(ALICE, { ...base, ssh: { ...manual, password: null } })
        ).rejects.toThrow(/Enter the password/);
    });

    it("keeps the stored secret and the pinned key when nothing about the login changed", async () => {
        saved = [
            row({
                sshMode: "manual",
                sshHost: "ssh.example.com",
                sshPort: 2222,
                sshUsername: "root",
                sshAuthMethod: "password",
                sshEncryptedCredential: Buffer.from(JSON.stringify({ method: "password", password: "hunter2" })),
                sshCredentialNonce: Buffer.from("nonce"),
                sshCredentialKeyId: "k1",
                sshHostKey: "SSHKEY"
            })
        ];

        await saveConnection(ALICE, {
            ...base,
            id: CONNECTION,
            name: "Renamed",
            ssh: { ...manual, password: null }
        });

        expect(captured).toHaveLength(0);
        expect(written).toMatchObject({ name: "Renamed", sshHostKey: "SSHKEY" });
    });

    it("signs in again when the address moved", async () => {
        saved = [
            row({
                sshMode: "manual",
                sshHost: "old.example.com",
                sshPort: 22,
                sshUsername: "root",
                sshAuthMethod: "password",
                sshEncryptedCredential: Buffer.from(JSON.stringify({ method: "password", password: "hunter2" })),
                sshCredentialNonce: Buffer.from("nonce"),
                sshCredentialKeyId: "k1",
                sshHostKey: "OLDKEY"
            })
        ];

        await saveConnection(ALICE, { ...base, id: CONNECTION, ssh: { ...manual, password: null } });

        expect(captured).toHaveLength(1);
        expect(written).toMatchObject({ sshHostKey: "SSHKEY" });
    });
});

describe("opening one", () => {
    it("reads the server's login fresh and pins its key", async () => {
        saved = [row({ sshMode: "server", sshHostId: SERVER })];

        const address = await addressOf(ALICE, CONNECTION);

        expect(address.tunnel).toMatchObject({
            target: { host: "10.0.0.2", port: 22, username: "polaris", pinnedHostKey: ["SERVERKEY"] },
            jump: null,
            label: "lirio-0"
        });
        // The database's own address is untouched: it is what the SSH server sees.
        expect(address).toMatchObject({ host: "127.0.0.1", port: 5432 });
    });

    it("pins the SSH server's captured key on a typed login", async () => {
        saved = [
            row({
                sshMode: "manual",
                sshHost: "ssh.example.com",
                sshPort: 2222,
                sshUsername: "root",
                sshAuthMethod: "key",
                sshEncryptedCredential: Buffer.from(JSON.stringify({ method: "key", privateKey: "PRIVATE" })),
                sshCredentialNonce: Buffer.from("nonce"),
                sshCredentialKeyId: "k1",
                sshHostKey: "SSHKEY"
            })
        ];

        const address = await addressOf(ALICE, CONNECTION);

        expect(address.tunnel).toMatchObject({
            target: {
                host: "ssh.example.com",
                port: 2222,
                auth: { method: "key", privateKey: "PRIVATE" },
                pinnedHostKey: ["SSHKEY"]
            }
        });
    });

    it("refuses a tunnel whose server was removed instead of connecting directly", async () => {
        saved = [row({ sshMode: "server", sshHostId: null })];

        await expect(addressOf(ALICE, CONNECTION)).rejects.toThrow(/removed from Servers/);
        const [listed] = await listConnections(ALICE);
        expect(listed?.unreachable).toBe(true);
        expect(listed?.note).toContain("removed from Servers");
    });

    it("refuses a typed login with no pinned key rather than trusting what answers", async () => {
        saved = [
            row({
                sshMode: "manual",
                sshHost: "ssh.example.com",
                sshPort: 22,
                sshUsername: "root",
                sshAuthMethod: "password",
                sshEncryptedCredential: Buffer.from(JSON.stringify({ method: "password", password: "x" })),
                sshCredentialNonce: Buffer.from("nonce"),
                sshCredentialKeyId: "k1",
                sshHostKey: null
            })
        ];

        await expect(addressOf(ALICE, CONNECTION)).rejects.toThrow(/incomplete/);
    });

    it("opens a connection with no tunnel exactly as before", async () => {
        saved = [row()];

        const address = await addressOf(ALICE, CONNECTION);

        expect(address.tunnel).toBeNull();
        expect(address).toMatchObject({ host: "127.0.0.1", port: 5432, password: "app-secret" });
    });
});

describe("the list", () => {
    it("says where a tunnelled connection is reached through", async () => {
        saved = [row({ sshMode: "server", sshHostId: SERVER, sshServer: { name: "lirio-0" } })];

        const [listed] = await listConnections(ALICE);

        expect(listed?.where).toBe("127.0.0.1:5432 via lirio-0");
        expect(listed?.tunnel).toMatchObject({ mode: "server", hostId: SERVER, hostName: "lirio-0" });
    });
});
