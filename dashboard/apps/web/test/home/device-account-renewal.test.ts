/**
 * A sign-in that ages, renewed where credentials are handed out.
 *
 * A Tuya app sign-in lasts a couple of hours and is traded for a new one before
 * it lapses. The trade is the driver's; storing what comes back is the account
 * layer's, and it has to happen before anything uses the credential - otherwise
 * the next read decrypts the old token, trades a refresh token Tuya has already
 * spent, and a good account is marked signed out.
 *
 * The driver and the encryption are stubbed: what is checked is the order of
 * things - renewed, stored, handed out - and what a refused renewal does to the
 * account.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DriverError } from "@polaris-app/places/src/lib/drivers/contract";

let stored: {
    id: string;
    installedAppId: string;
    connection: string;
    secret: string;
    status: string;
    statusNote: string | null;
};
const writes: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
let renew: (credentials: Record<string, string>) => Promise<Record<string, string> | null>;

const seal = (fields: Record<string, string>) =>
    JSON.stringify({
        c: Buffer.from(JSON.stringify(fields)).toString("base64"),
        n: "",
        k: "key-1"
    });

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "test-key" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: (plaintext: string) => ({
        ciphertext: Buffer.from(plaintext, "utf8"),
        nonce: Buffer.from("", "utf8"),
        keyId: "key-1"
    }),
    decryptSecret: (blob: { ciphertext: Buffer }) => blob.ciphertext.toString("utf8")
}));
vi.mock("@polaris-app/places/src/lib/drivers/tuya-app", () => ({
    TUYA_APP: "tuya-app",
    tuyaAppDriver: {
        connection: "tuya-app",
        verify: async () => undefined,
        list: async () => [],
        act: async () => undefined,
        renew: (credentials: Record<string, string>) => renew(credentials)
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        setting: { findUnique: async () => null, deleteMany: async () => ({ count: 0 }) },
        placeDeviceAccount: {
            findFirst: async () => ({
                ...stored,
                brand: "Tuya",
                label: "Home",
                lastSyncedAt: null
            }),
            updateMany: async (args: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            }) => {
                writes.push(args);
                if (typeof args.data.secret === "string") stored.secret = args.data.secret;
                if (typeof args.data.status === "string") stored.status = args.data.status;
                return { count: 1 };
            }
        }
    }
}));

const { accountWithCredentials } = await import("@polaris-app/places/src/lib/device-accounts");

beforeEach(() => {
    writes.length = 0;
    stored = {
        id: "account-1",
        installedAppId: "install-1",
        connection: "tuya-app",
        secret: seal({ userCode: "code", accessToken: "old", refreshToken: "r-old" }),
        status: "ok",
        statusNote: null
    };
});

describe("credentials that age", () => {
    it("are handed out as stored while they are still good", async () => {
        renew = async () => null;
        const { credentials } = await accountWithCredentials("install-1", "account-1");
        expect(credentials.accessToken).toBe("old");
        expect(writes).toHaveLength(0);
    });

    it("are renewed, stored, and only then handed out", async () => {
        renew = async (credentials) => ({
            ...credentials,
            accessToken: "new",
            refreshToken: "r-new"
        });
        const { credentials } = await accountWithCredentials("install-1", "account-1");
        expect(credentials.accessToken).toBe("new");
        const saved = JSON.parse(
            Buffer.from((JSON.parse(stored.secret) as { c: string }).c, "base64").toString("utf8")
        ) as Record<string, string>;
        expect(saved).toMatchObject({
            accessToken: "new",
            refreshToken: "r-new",
            userCode: "code"
        });
        expect(writes[0]?.where).toEqual({ id: "account-1" });
    });

    it("mark the account signed out when the renewal is refused", async () => {
        renew = async () => {
            throw new DriverError(
                "Tuya no longer accepts this sign-in. Scan a new code from the app.",
                "unauthorized"
            );
        };
        const before = stored.secret;
        await expect(accountWithCredentials("install-1", "account-1")).rejects.toThrow(
            "Tuya no longer accepts this sign-in"
        );
        expect(stored.status).toBe("unauthorized");
        // The old credential is left where it was: nothing replaced it.
        expect(stored.secret).toBe(before);
    });

    it("leave the account as it was when the renewal could not get through", async () => {
        renew = async () => {
            throw new DriverError(
                "Tuya could not be reached. Try again in a moment.",
                "unreachable"
            );
        };
        await expect(accountWithCredentials("install-1", "account-1")).rejects.toThrow();
        expect(stored.status).toBe("unreachable");
    });
});
