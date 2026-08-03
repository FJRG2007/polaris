/**
 * The hook that watches how each sign-in proved itself.
 *
 * It is registered as the instance's own after-hook rather than on a plugin, and
 * both halves of that matter. The methods it covers belong to four different
 * plugins, so no single plugin is the right place; and it has to run before every
 * plugin hook, because on a credential sign-in the two-factor plugin takes the
 * session back again when a challenge is due, and this needs to see the session
 * while it is still there.
 *
 * What is pinned here is the behaviour, not the wiring: which paths are watched,
 * what each one is recorded as, and - the one that would be silently wrong - that
 * a password sign-in on an account with the factor armed is recorded as having
 * skipped it, since at that point in the request nobody knows yet whether the
 * challenge will be raised.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-1111-1111-111111111111";

interface SecurityRow {
    userId: string;
    pendingSignInMethod: string | null;
    pendingSignInFactor: string | null;
    pendingSignInAt: Date | null;
}

let rows: SecurityRow[] = [];

const prisma = {
    userSecurity: {
        findUnique: async ({ where }: { where: { userId: string } }) => {
            const row = rows.find((entry) => entry.userId === where.userId);
            return row ? { ...row } : null;
        },
        update: async ({ where, data }: { where: { userId: string }; data: Partial<SecurityRow> }) => {
            const row = rows.find((entry) => entry.userId === where.userId);
            if (!row) throw new Error("no such account");
            Object.assign(row, data);
            return { ...row };
        },
        upsert: async ({
            where,
            create,
            update
        }: {
            where: { userId: string };
            create: Partial<SecurityRow>;
            update: Partial<SecurityRow>;
        }) => {
            const row = rows.find((entry) => entry.userId === where.userId);
            if (row) {
                Object.assign(row, update);
                return { ...row };
            }
            const created: SecurityRow = {
                userId: where.userId,
                pendingSignInMethod: null,
                pendingSignInFactor: null,
                pendingSignInAt: null,
                ...create
            };
            rows.push(created);
            return { ...created };
        }
    }
};

vi.mock("@polaris/db", () => ({ prisma }));

type AuthModule = typeof import("../../src/auth.js");
let authModule: AuthModule;

/** The instance's own after-hook, as a plain callable. */
type Hook = (input: {
    path: string;
    context: { newSession: { user: { id: string; twoFactorEnabled?: boolean } } | null };
}) => Promise<unknown>;

function recorder(): Hook {
    const hook = authModule.createAuth().options.hooks?.after;
    if (!hook) throw new Error("the sign-in recorder is not registered");
    return hook as unknown as Hook;
}

/** Drive one request through the hook and read back what it noted. */
async function reached(
    path: string,
    user: { id: string; twoFactorEnabled?: boolean } | null = { id: USER }
): Promise<SecurityRow | undefined> {
    await recorder()({ path, context: { newSession: user ? { user } : null } });
    return rows.find((row) => row.userId === USER);
}

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = "https://polaris.example.com";
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    authModule = await import("../../src/auth.js");
});

beforeEach(() => {
    rows = [];
});

describe("what each way in is recorded as", () => {
    it("records a password sign-in", async () => {
        expect(await reached("/sign-in/email")).toMatchObject({
            pendingSignInMethod: "password",
            pendingSignInFactor: null
        });
    });

    it("records an emailed link as the way in it is, not as a password", async () => {
        expect(await reached(authModule.MAGIC_LINK_VERIFY_PATH)).toMatchObject({
            pendingSignInMethod: "email-link"
        });
    });

    it("records a passkey", async () => {
        expect(await reached("/passkey/verify-authentication")).toMatchObject({
            pendingSignInMethod: "passkey",
            pendingSignInFactor: null
        });
    });

    it("records a scanned code", async () => {
        expect(await reached("/device/token")).toMatchObject({
            pendingSignInMethod: "qr-code",
            pendingSignInFactor: null
        });
    });
});

describe("the second step", () => {
    it("records an authenticator code without losing the password before it", async () => {
        await reached("/sign-in/email", { id: USER, twoFactorEnabled: true });
        expect(await reached("/two-factor/verify-totp")).toMatchObject({
            pendingSignInMethod: "password",
            pendingSignInFactor: "totp"
        });
    });

    it("records a backup code as itself, since it is the spare key being spent", async () => {
        await reached("/sign-in/email", { id: USER, twoFactorEnabled: true });
        expect(await reached("/two-factor/verify-backup-code")).toMatchObject({
            pendingSignInFactor: "backup-code"
        });
    });

    it("keeps the channel a sent code went out on rather than overwriting it", async () => {
        await reached("/sign-in/email", { id: USER, twoFactorEnabled: true });
        rows[0]!.pendingSignInFactor = "email-code";
        expect(await reached("/two-factor/verify-otp")).toMatchObject({
            pendingSignInMethod: "password",
            pendingSignInFactor: "email-code"
        });
    });
});

describe("a challenge that never happened", () => {
    // The account has the factor armed and was let in on the password alone,
    // which is the browser's thirty-day pass being spent. Answering a challenge
    // overwrites this, so it only survives to the sign-in it describes.
    it("records a remembered device when the factor is armed and nothing was asked", async () => {
        expect(await reached("/sign-in/email", { id: USER, twoFactorEnabled: true })).toMatchObject({
            pendingSignInMethod: "password",
            pendingSignInFactor: "trusted-device"
        });
    });

    it("says nothing of the sort for an account that never armed one", async () => {
        expect(await reached("/sign-in/email", { id: USER, twoFactorEnabled: false })).toMatchObject({
            pendingSignInFactor: null
        });
    });

    // A passkey and a scanned code are never challenged, so an armed factor says
    // nothing about how either of them got in.
    it("does not claim a passkey skipped a challenge it was never offered", async () => {
        expect(await reached("/passkey/verify-authentication", { id: USER, twoFactorEnabled: true })).toMatchObject({
            pendingSignInFactor: null
        });
    });
});

describe("what it leaves alone", () => {
    it("records nothing for a request that issued no session", async () => {
        expect(await reached("/sign-in/email", null)).toBeUndefined();
    });

    it("records nothing for the paths that are not a sign-in", async () => {
        expect(await reached("/two-factor/send-otp")).toBeUndefined();
        expect(await reached("/sign-out")).toBeUndefined();
        expect(await reached("/get-session")).toBeUndefined();
    });
});
