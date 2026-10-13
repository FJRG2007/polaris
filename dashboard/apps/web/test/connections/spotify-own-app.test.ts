/**
 * A Spotify app of one's own, for linking past the deployment app's five.
 *
 * What is pinned:
 * - a link is refreshed with the app that issued it, whichever that was; a link
 *   from before anybody had their own app is the deployment's;
 * - a new link uses the person's own app when they have one;
 * - the pasted pair is checked against the schema both sides share, and with
 *   Spotify itself before it is stored;
 * - the credential a code is exchanged for says which app it belongs to.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    replies: [] as Array<{ status: number; body?: unknown }>,
    requests: [] as Array<{ url: string; body?: string; headers: Record<string, string> }>
};

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => ({
        enabled: true,
        config: { clientId: "deploymentclientid0001" }
    }),
    getIntegrationSecret: async () => "deployment-secret"
}));

vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const next = state.replies.shift();
    if (!next) throw new Error(`no reply queued for ${String(input)}`);
    state.requests.push({
        url: String(input),
        body: init?.body === undefined ? undefined : String(init.body),
        headers: (init?.headers as Record<string, string>) ?? {}
    });
    const reply = {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        headers: new Headers(),
        json: async () => next.body,
        text: async () => JSON.stringify(next.body ?? ""),
        clone: () => reply
    };
    return reply as unknown as Response;
});

const own = await import("@/lib/connections/own-oauth-app");
const spotify = await import("@/lib/connections/spotify");

const DEPLOYMENT = { clientId: "deploymentclientid0001", clientSecret: "deployment-secret" };
const MINE = { clientId: "personalclientid000001", clientSecret: "personal-secret" };

beforeEach(() => {
    state.replies = [];
    state.requests = [];
});

describe("which app a link speaks through", () => {
    it("is the one that issued it", () => {
        expect(
            own.pickOAuthClient({ own: MINE, deployment: DEPLOYMENT, issuedTo: MINE.clientId })
        ).toBe(MINE);
        expect(
            own.pickOAuthClient({
                own: MINE,
                deployment: DEPLOYMENT,
                issuedTo: DEPLOYMENT.clientId
            })
        ).toBe(DEPLOYMENT);
    });

    it("is the deployment's for a link older than anybody's own app", () => {
        expect(
            own.pickOAuthClient({
                own: MINE,
                deployment: DEPLOYMENT,
                issuedTo: undefined,
                existing: true
            })
        ).toBe(DEPLOYMENT);
    });

    it("is their own for a new link, and the deployment's when they have none", () => {
        expect(own.pickOAuthClient({ own: MINE, deployment: DEPLOYMENT })).toBe(MINE);
        expect(own.pickOAuthClient({ own: null, deployment: DEPLOYMENT })).toBe(DEPLOYMENT);
        expect(own.pickOAuthClient({ own: null, deployment: null })).toBeNull();
    });

    it("is nothing when the app that issued it is gone", () => {
        expect(
            own.pickOAuthClient({ own: null, deployment: DEPLOYMENT, issuedTo: MINE.clientId })
        ).toBeNull();
    });
});

describe("the pasted pair", () => {
    it("is trimmed and bounded", () => {
        expect(
            own.ownOAuthAppSchema.parse({
                clientId: ` ${MINE.clientId} `,
                clientSecret: " abcdef0123456789 "
            })
        ).toEqual({
            clientId: MINE.clientId,
            clientSecret: "abcdef0123456789"
        });
        expect(own.ownOAuthAppSchema.safeParse({ clientId: "", clientSecret: "x" }).success).toBe(
            false
        );
        expect(
            own.ownOAuthAppSchema.safeParse({
                clientId: "has space in it 000",
                clientSecret: "abcdef0123456789"
            }).success
        ).toBe(false);
    });

    it("is asked of Spotify before it is kept", async () => {
        state.replies.push({
            status: 200,
            body: { access_token: "t", token_type: "bearer", expires_in: 3600 }
        });
        expect(await spotify.verifySpotifyClient(MINE)).toBe(true);
        expect(state.requests[0]?.body).toBe("grant_type=client_credentials");
        state.replies.push({ status: 400, body: { error: "invalid_client" } });
        expect(await spotify.verifySpotifyClient(MINE)).toBe(false);
    });
});

describe("a new link", () => {
    it("remembers which app it was issued to", async () => {
        state.replies.push({
            status: 200,
            body: { access_token: "a", refresh_token: "r", expires_in: 3600, scope: "x" }
        });
        state.replies.push({ status: 200, body: { id: "account-1", display_name: "Listener" } });
        const linked = await spotify.exchangeSpotifyCode(MINE, "code", "https://example.test/cb");
        expect(linked.credential.clientId).toBe(MINE.clientId);
    });
});
