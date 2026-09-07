/**
 * The connection that was made before connections had a table.
 *
 * An installed Polaris is updated from a button, and whoever runs it is never
 * asked for anything - so a house whose locks worked before the update has to
 * have them working after it, with the same credential, the same names and the
 * same history. Nothing here can be verified by looking at a migration: the
 * credential is encrypted with a key SQL does not have, so the adoption is code
 * that runs once on the first read, and this is that once.
 *
 * The encryption is stubbed. What is being checked is that the old setting is
 * found, that a row is written for it, that the devices are pointed at that row,
 * and that the setting is cleared so it never happens twice - not that AES works.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface AccountRow {
    id: string;
    installedAppId: string;
    brand: string;
    connection: string;
    label: string;
    secret: string;
    status: string;
    statusNote: string | null;
    lastSyncedAt: Date | null;
}

let settings: Record<string, string> = {};
let accountRows: AccountRow[] = [];
let devicesPointedAt: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
let deletedSettings: string[] = [];

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "test-key" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: (plaintext: string) => ({
        ciphertext: Buffer.from(plaintext, "utf8"),
        nonce: Buffer.from("nonce", "utf8"),
        keyId: "key-1"
    }),
    decryptSecret: (blob: { ciphertext: Buffer }) => blob.ciphertext.toString("utf8")
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findUnique: async ({ where }: { where: { key: string } }) =>
                settings[where.key] === undefined ? null : { value: settings[where.key] },
            deleteMany: async ({ where }: { where: { key: { in: string[] } } }) => {
                deletedSettings.push(...where.key.in);
                for (const key of where.key.in) delete settings[key];
                return { count: where.key.in.length };
            }
        },
        placeDeviceAccount: {
            create: async ({ data }: { data: Omit<AccountRow, "id"> }) => {
                const row = { id: `account-${accountRows.length + 1}`, ...data } as AccountRow;
                accountRows.push(row);
                return row;
            },
            findMany: async () =>
                accountRows.map((row) => ({ ...row, _count: { devices: 0 } })),
            findFirst: async () => accountRows[0] ?? null
        },
        placeDevice: {
            updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                devicesPointedAt.push(args);
                return { count: 1 };
            }
        }
    }
}));

const { listAccounts } = await import("@/lib/home/device-accounts");

/** The old setting as it was actually stored: the encrypted envelope, base64, as
 *  one JSON string. */
function legacyToken(token: string): string {
    return JSON.stringify({
        c: Buffer.from(token, "utf8").toString("base64"),
        n: Buffer.from("nonce", "utf8").toString("base64"),
        k: "key-1"
    });
}

describe("a Nuki connection made before accounts had a table", () => {
    beforeEach(() => {
        settings = {
            "places.nuki.token": legacyToken("the-old-token"),
            "places.nuki.label": "Home",
            "places.nuki.status": "ok"
        };
        accountRows = [];
        devicesPointedAt = [];
        deletedSettings = [];
    });

    it("becomes an account on the first read, keeping what it was called", async () => {
        const found = await listAccounts("install-1");
        expect(accountRows).toHaveLength(1);
        expect(accountRows[0]?.connection).toBe("nuki-web");
        expect(accountRows[0]?.label).toBe("Home");
        expect(found[0]?.label).toBe("Home");
    });

    it("carries the credential over rather than asking for it again", async () => {
        await listAccounts("install-1");
        expect(accountRows[0]?.secret).toContain(
            Buffer.from(JSON.stringify({ token: "the-old-token" }), "utf8").toString("base64")
        );
    });

    it("points the devices it already had at the new row", async () => {
        await listAccounts("install-1");
        expect(devicesPointedAt[0]?.where).toEqual({
            installedAppId: "install-1",
            accountId: null,
            vendor: "nuki"
        });
        expect(devicesPointedAt[0]?.data).toEqual({ accountId: "account-1" });
    });

    it("remembers a token that was being refused, rather than presenting it as well", async () => {
        settings["places.nuki.status"] = "unauthorized";
        await listAccounts("install-1");
        expect(accountRows[0]?.status).toBe("unauthorized");
    });

    it("clears the old setting so it cannot be adopted twice", async () => {
        await listAccounts("install-1");
        expect(deletedSettings).toContain("places.nuki.token");
        await listAccounts("install-1");
        expect(accountRows).toHaveLength(1);
    });

    it("clears a credential it could not read, instead of trying again on every read", async () => {
        // A master key that has changed under a stored token. Nothing can recover
        // it, and leaving it in place would mean attempting this on every request
        // for the life of the deployment.
        settings["places.nuki.token"] = "not json at all";
        await listAccounts("install-1");
        expect(accountRows).toHaveLength(0);
        expect(deletedSettings).toContain("places.nuki.token");
    });

    it("does nothing at all where nothing was ever connected", async () => {
        settings = {};
        await listAccounts("install-1");
        expect(accountRows).toHaveLength(0);
        expect(deletedSettings).toHaveLength(0);
    });
});
