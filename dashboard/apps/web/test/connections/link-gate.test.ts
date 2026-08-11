/**
 * Who is offered an outside service, and when.
 *
 * This is the regression it exists for: an operator pasted a Google client id and
 * secret that were a genuine pair, registered the redirect URI exactly as the
 * screen asked, switched it on - and everybody who pressed Connect landed on
 * `Error 403: access_denied`, because the client was in Testing and only the
 * accounts on its test-user list may authorize. Nothing about that is visible in
 * the credentials, and nothing about it can be asked of Google from this server:
 * it is decided per person, after they have signed in, in a console this
 * deployment cannot read.
 *
 * So the proof is an authorization that actually completed here. Until one has,
 * the service is offered to administrators alone - they are the only ones who can
 * change what it refuses - and everybody else is told it is not ready instead of
 * being sent to somebody else's error page. A deployment where accounts are
 * already linked is proven by those accounts, so this never takes away a service
 * that has been working for months.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    integration: null as { enabled: boolean; config: Record<string, unknown>; hasSecret: boolean } | null,
    linked: false,
    written: [] as Array<Record<string, unknown>>
};

vi.mock("@polaris/db", () => ({
    prisma: {
        userConnection: {
            findFirst: async ({ where }: { where: { provider: string; method: string } }) =>
                state.linked && where.method === "oauth" ? { id: "connection-1" } : null
        }
    }
}));

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => state.integration,
    getIntegrationSecret: async () => "client-secret",
    upsertIntegration: async (_provider: string, input: { config?: Record<string, unknown> }) => {
        state.written.push(input.config ?? {});
        if (state.integration && input.config) state.integration.config = input.config;
    }
}));

// The application exists and is switched on; what is in question is whether it
// works, which is a different thing entirely.
vi.mock("@/lib/google-calendar/service", () => ({
    CALENDAR_PROVIDER: "google",
    GOOGLE_SCOPES: [],
    getGoogleOAuthClient: async () =>
        state.integration?.enabled ? { clientId: "client-id", clientSecret: "client-secret" } : null,
    googleAuthorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    exchangeGoogleCode: async () => ({}),
    identifyGoogleAccount: async () => ({ accountId: "google-1" }),
    verifyGoogleOAuthClient: async () => null
}));

vi.mock("@/lib/connections/store", () => ({ connectionSignInAllowed: async () => true }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.com" }));

const { connectionLinkAvailable, connectionSignInOffered } = await import("@/lib/connections/oauth");
const { connectionProven, markConnectionProven } = await import("@/lib/connections/proven");

describe("offering a service nobody has been through yet", () => {
    beforeEach(() => {
        state.integration = { enabled: true, config: { clientId: "client-id" }, hasSecret: true };
        state.linked = false;
        state.written = [];
    });

    it("refuses everybody but an administrator", async () => {
        expect(await connectionLinkAvailable("google")).toBe(false);
        expect(await connectionLinkAvailable("google", { admin: true })).toBe(true);
    });

    it("is not offered as a way in at all, to anybody", async () => {
        // Not even to an administrator: a sign-in button is on the login screen,
        // where nobody has said yet who they are.
        expect(await connectionSignInOffered("google")).toBe(false);
    });

    it("opens to everybody once one authorization has completed", async () => {
        await markConnectionProven("google");

        expect(await connectionProven("google")).toBe(true);
        expect(await connectionLinkAvailable("google")).toBe(true);
        expect(await connectionSignInOffered("google")).toBe(true);
    });

    it("keeps the client id it was recording against", async () => {
        await markConnectionProven("google");

        expect(state.written[0]).toMatchObject({ clientId: "client-id" });
    });

    it("records the moment once and does not keep rewriting it", async () => {
        await markConnectionProven("google");
        await markConnectionProven("google");

        expect(state.written).toHaveLength(1);
    });

    it("counts an account already linked here as the proof", async () => {
        // The deployment that has been running this for months, where asking an
        // operator to authorize again would take a working service away.
        state.linked = true;

        expect(await connectionProven("google")).toBe(true);
        expect(await connectionLinkAvailable("google")).toBe(true);
    });

    it("still refuses when there is no application at all", async () => {
        state.integration = { enabled: false, config: {}, hasSecret: false };

        expect(await connectionLinkAvailable("google", { admin: true })).toBe(false);
        expect(await connectionSignInOffered("google")).toBe(false);
    });
});
