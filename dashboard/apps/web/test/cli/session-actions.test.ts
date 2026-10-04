/**
 * Ending a CLI sign-in from the sessions screen, and the key check that makes
 * the CLI find out.
 *
 * The action revokes the API key behind the row, behind the same new-device gate
 * as every other device action there; the next request the CLI makes with that
 * key is refused, which the CLI turns into "signed out from Polaris, run plr
 * login" (pinned in the CLI's own tests). And a CLI key is held to the address
 * lock on every request before its use is recorded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADA = "11111111-1111-4111-8111-111111111111";
const KEY = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

let blocked: string | null = null;
const revoked: { userId: string; id: string }[] = [];
const pinned: { id: string; pinned: boolean | null }[] = [];
const audits: { action: string }[] = [];
let allowsAddress = true;
const touched: string[] = [];

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: ADA, sessionId: "s1", isAdmin: false })
}));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => blocked }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// The rest of the sessions actions' world, which these two never reach.
vi.mock("@/lib/session-directory", () => ({}));
vi.mock("@/lib/extension/sessions", () => ({}));
vi.mock("@/lib/notifications/session-events", () => ({}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (entry: { action: string }) => void audits.push(entry)
}));
vi.mock("@/lib/cli/sessions", () => ({
    revokeCliSession: async (userId: string, id: string) => {
        revoked.push({ userId, id });
        return id === KEY;
    },
    pinCliSession: async (_userId: string, id: string, value: boolean | null) => {
        pinned.push({ id, pinned: value });
        return id === KEY;
    },
    cliAddressAllows: async () => allowsAddress
}));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "198.51.100.7",
    clientUserAgent: async () => "polaris-cli/0.4.6 (linux; x64; node 22.0.0)"
}));
vi.mock("@/lib/network-rules", () => ({ evaluateAccountAccess: async () => ({ allowed: true }) }));
vi.mock("@polaris/auth", async (original) => ({
    ...(await original<object>()),
    verifyApiKey: async () => ({
        id: KEY,
        userId: ADA,
        scopes: ["deploy.read"],
        rules: {},
        clients: { allowedUserAgents: [], deniedUserAgents: [] },
        projectId: null,
        kind: "cli",
        lastUsedIp: "203.0.113.4",
        pinToAddress: true,
        clientOs: "Linux"
    }),
    touchApiKey: async (id: string) => void touched.push(id)
}));

const { pinCliSessionAction, signOutCliSessionAction } = await import(
    "@/app/(app)/account/sessions/actions"
);
const { authenticateApiKey } = await import("@/lib/api-key-auth");

beforeEach(() => {
    blocked = null;
    revoked.length = 0;
    pinned.length = 0;
    audits.length = 0;
    touched.length = 0;
    allowsAddress = true;
});

describe("signing a CLI sign-in out from the sessions screen", () => {
    it("revokes its key and records it", async () => {
        expect(await signOutCliSessionAction(KEY)).toEqual({});
        expect(revoked).toEqual([{ userId: ADA, id: KEY }]);
        expect(audits.map((entry) => entry.action)).toEqual(["account.cli.signedOut"]);
    });

    it("says so when it had already ended", async () => {
        const result = await signOutCliSessionAction("0190a1b2-c3d4-7e5f-8a9b-000000000000");
        expect(result.error).toBe("That command-line sign-in has already ended.");
        expect(audits).toEqual([]);
    });

    it("refuses anything that is not an id", async () => {
        expect((await signOutCliSessionAction("../other")).error).toBeTruthy();
        expect(revoked).toEqual([]);
    });

    it("waits behind the new-device gate like every other device action", async () => {
        blocked = "This browser was only just signed in.";
        expect((await signOutCliSessionAction(KEY)).error).toBeTruthy();
        expect(revoked).toEqual([]);
    });

    it("locks it to its address, or hands it back to the account's rule", async () => {
        expect(await pinCliSessionAction(KEY, true)).toEqual({});
        expect(await pinCliSessionAction(KEY, null)).toEqual({});
        expect(pinned).toEqual([
            { id: KEY, pinned: true },
            { id: KEY, pinned: null }
        ]);
        expect((await pinCliSessionAction(KEY, "yes")).error).toBeTruthy();
    });
});

describe("a CLI key on a request", () => {
    const request = () =>
        new Request("https://polaris.example/api/v1/me", {
            headers: { authorization: "Bearer plk_x.y" }
        });

    it("is let through, and its use recorded, when the address lock allows it", async () => {
        expect((await authenticateApiKey(request()))?.kind).toBe("cli");
        expect(touched).toEqual([KEY]);
    });

    it("is refused, and its use not recorded, when the lock signed it out", async () => {
        allowsAddress = false;
        expect(await authenticateApiKey(request())).toBeNull();
        expect(touched).toEqual([]);
    });
});
