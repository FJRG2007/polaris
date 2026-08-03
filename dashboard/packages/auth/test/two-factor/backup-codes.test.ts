/**
 * Backup codes - the way into an account whose authenticator is gone.
 *
 * Polaris does not store or encrypt them itself; better-auth mints them, keeps
 * them encrypted under this instance's secret and strikes each one off as it is
 * spent. What is pinned here is the seam Polaris owns around that:
 *
 *   - the Security page is told how many are left and never what they are, so a
 *     stolen session cannot read the account's spare keys off a page;
 *   - an account with no set reads as "none", not as an error, because that is
 *     what it is for anybody who has not armed the factor;
 *   - a wrong password comes back as a refusal rather than an exception, since
 *     it arrives through a server action that has to answer either way;
 *   - an empty set is a failure, not a successful mint of nothing - handing that
 *     to the dialog would show somebody an empty box and call it their codes.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-1111-1111-111111111111";
const CODES = ["abcde-fghij", "klmno-pqrst", "uvwxy-z0123"];

vi.mock("@polaris/db", () => ({ prisma: {} }));

/** What the last call to each endpoint was handed, so the pass-through can be
 *  checked rather than assumed. */
let generateCalls: { body: { password: string }; headers: Headers }[] = [];
let viewCalls: { body: { userId: string } }[] = [];

/** A stand-in for the two-factor endpoints better-auth exposes on auth.api,
 *  answering however the test under way needs it to. */
function authWith(answers: {
    view?: () => Promise<{ backupCodes?: unknown }>;
    generate?: () => Promise<{ backupCodes?: unknown }>;
}) {
    return {
        api: {
            viewBackupCodes: async (input: { body: { userId: string } }) => {
                viewCalls.push(input);
                if (!answers.view) throw new Error("no set");
                return answers.view();
            },
            generateBackupCodes: async (input: { body: { password: string }; headers: Headers }) => {
                generateCalls.push(input);
                if (!answers.generate) throw new Error("invalid password");
                return answers.generate();
            }
        }
    } as unknown as Parameters<TwoFactorModule["backupCodesRemaining"]>[0];
}

type TwoFactorModule = typeof import("../../src/two-factor.js");
let twoFactor: TwoFactorModule;

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
    process.env.POLARIS_AUTH_SECRET = "test-secret-value-0123456789";
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = "https://polaris.example.com";
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    twoFactor = await import("../../src/two-factor.js");
});

beforeEach(() => {
    generateCalls = [];
    viewCalls = [];
});

describe("counting what is left", () => {
    it("reports the number of unspent codes", async () => {
        const auth = authWith({ view: async () => ({ backupCodes: CODES }) });
        await expect(twoFactor.backupCodesRemaining(auth, USER)).resolves.toBe(3);
    });

    it("asks for the account it was given, and nobody else's", async () => {
        const auth = authWith({ view: async () => ({ backupCodes: CODES }) });
        await twoFactor.backupCodesRemaining(auth, USER);
        expect(viewCalls).toEqual([{ body: { userId: USER } }]);
    });

    it("counts a spent set down to zero rather than calling it absent", async () => {
        const auth = authWith({ view: async () => ({ backupCodes: [] }) });
        await expect(twoFactor.backupCodesRemaining(auth, USER)).resolves.toBe(0);
    });

    it("reads an account with no armed factor as no set, not as a failure", async () => {
        await expect(twoFactor.backupCodesRemaining(authWith({}), USER)).resolves.toBeNull();
    });

    it("refuses to guess at an answer that is not a list of codes", async () => {
        const auth = authWith({ view: async () => ({}) });
        await expect(twoFactor.backupCodesRemaining(auth, USER)).resolves.toBeNull();
    });
});

describe("minting a fresh set", () => {
    it("hands back the codes it was given", async () => {
        const auth = authWith({ generate: async () => ({ backupCodes: CODES }) });
        await expect(twoFactor.regenerateBackupCodes(auth, new Headers(), "correct horse")).resolves.toEqual({
            codes: CODES
        });
    });

    it("passes the password and the caller's headers to better-auth, which checks both", async () => {
        const headers = new Headers({ cookie: "polaris.session_token=abc" });
        const auth = authWith({ generate: async () => ({ backupCodes: CODES }) });
        await twoFactor.regenerateBackupCodes(auth, headers, "correct horse");
        expect(generateCalls).toHaveLength(1);
        expect(generateCalls[0]?.body).toEqual({ password: "correct horse" });
        expect(generateCalls[0]?.headers.get("cookie")).toBe("polaris.session_token=abc");
    });

    it("turns a refused password into an error rather than throwing", async () => {
        const result = await twoFactor.regenerateBackupCodes(authWith({}), new Headers(), "wrong");
        expect(result.codes).toBeUndefined();
        expect(result.error).toBeTruthy();
    });

    it("treats an empty set as a failed mint, not as a set of no codes", async () => {
        const auth = authWith({ generate: async () => ({ backupCodes: [] }) });
        const result = await twoFactor.regenerateBackupCodes(auth, new Headers(), "correct horse");
        expect(result.codes).toBeUndefined();
        expect(result.error).toBeTruthy();
    });
});
