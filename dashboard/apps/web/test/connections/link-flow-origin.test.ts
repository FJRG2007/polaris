/**
 * The address a connection round trip runs on.
 *
 * This is the regression it exists for: the flow built every URL from the request
 * it arrived on, and behind the bundled proxy that is the socket the Next server
 * binds rather than the name somebody typed. So Polaris sent Google a redirect URI
 * of `https://0.0.0.0:3000/api/connections/google/callback` while the Integrations
 * screen was telling the operator to register their domain, and Google refused the
 * authorization outright - a raw IP address breaks its rules whatever is
 * registered, so no amount of pasting URIs into the console fixed it. GitHub
 * refused the same trip with "the redirect_uri is not associated with this
 * application".
 *
 * One address, from `connectionFlowOrigin`, and the same one the screen displays.
 * The trip moves onto it before the state cookie is written, because that cookie
 * and the session only exist on the host the browser is on - and the provider
 * comes back to the host that was registered, not to the one it was started from.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The address the operator registered, and the one the flow must use. */
const REGISTERED = "https://polaris.example.com";
/** What the request looks like on the way out of the proxy. */
const BIND = "https://0.0.0.0:3000";

const sent = { redirectUri: "", state: "" };

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "user-1", isAdmin: true }) }));
vi.mock("@/lib/connections/proven", () => ({ markConnectionProven: async () => undefined }));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.7" }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@polaris/auth", () => ({ signInWithConnection: async () => ({ challenged: false, cookies: [] }) }));

// The real one is covered in domains/browser-origin; here it only has to answer
// where the browser is, which is what decides whether the trip has to move.
vi.mock("@/lib/domain-service", () => ({
    requestOrigin: (request: Request) => `https://${request.headers.get("host") ?? "0.0.0.0:3000"}`
}));

vi.mock("@/lib/connections/store", () => ({
    ConnectionClaimedError: class extends Error {},
    ConnectionLimitError: class extends Error {},
    connectionSignInAllowed: async () => true,
    saveConnection: async () => undefined,
    signInConnection: async () => null
}));

vi.mock("@/lib/connections/steam", () => ({
    STEAM_PROVIDER: "steam",
    readSteamPersona: async () => null,
    steamAuthorizeUrl: (returnTo: string) => `https://steamcommunity.com/openid/login?return=${returnTo}`,
    verifySteamReturn: async () => null
}));

vi.mock("@/lib/connections/oauth", () => ({
    connectionFlowOrigin: async () => REGISTERED,
    connectionCallbackUrl: (provider: string, baseUrl: string) => `${baseUrl}/api/connections/${provider}/callback`,
    connectionOAuthClient: async () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    connectionLinkAvailable: async () => true,
    connectionSignInOffered: async () => true,
    connectionAuthorizeUrl: (_provider: string, _client: unknown, redirectUri: string, state: string) => {
        sent.redirectUri = redirectUri;
        sent.state = state;
        return `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(redirectUri)}`;
    },
    connectionIdentity: async () => ({ accountId: "google-1" }),
    exchangeConnectionCode: async () => ({
        accountId: "google-1",
        label: "somebody@example.com",
        avatarUrl: null,
        email: null,
        scope: "",
        credential: {}
    })
}));

const { startConnectionLink, startConnectionSignIn } = await import("../../src/lib/connections/link-flow");

/** A request as this route sees it: the proxy's internal address, with the name
 *  the browser used carried in the headers. */
function arriving(path: string, host: string): Request {
    return new Request(`${BIND}${path}`, { headers: { host, "x-forwarded-proto": "https" } });
}

describe("where a link is sent", () => {
    beforeEach(() => {
        sent.redirectUri = "";
        sent.state = "";
    });

    it("asks the provider to return to the registered address, never to the bind address", async () => {
        await startConnectionLink(arriving("/api/connections/google/link", "polaris.example.com"), "google");

        expect(sent.redirectUri).toBe(`${REGISTERED}/api/connections/google/callback`);
    });

    it("sets the state cookie on that address, since that is where the callback lands", async () => {
        const response = await startConnectionLink(
            arriving("/api/connections/google/link", "polaris.example.com"),
            "google"
        );

        const cookie = response.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("polaris_connection_state=");
        // The registered address is https, so a cookie the browser would drop on it
        // would lose the round trip.
        expect(cookie).toContain("Secure");
        expect(JSON.parse(decodeURIComponent(cookie.split("polaris_connection_state=")[1]!.split(";")[0]!)).state).toBe(
            sent.state
        );
    });

    it("moves a browser on another of this deployment's names before anything is written", async () => {
        const response = await startConnectionLink(arriving("/api/connections/google/link", "polaris.local"), "google");

        expect(response.headers.get("location")).toBe(`${REGISTERED}/api/connections/google/link?moved=1`);
        expect(response.headers.get("set-cookie")).toBeNull();
        // Nothing was started, so no code exists that a half-moved trip could spend.
        expect(sent.redirectUri).toBe("");
    });

    it("carries what the trip was started for across the move", async () => {
        const response = await startConnectionLink(
            arriving("/api/connections/google/link?scope=storage", "polaris.local"),
            "google"
        );

        expect(response.headers.get("location")).toBe(
            `${REGISTERED}/api/connections/google/link?scope=storage&moved=1`
        );
    });

    it("moves once and then proceeds, since the proxy keeps showing the same address", async () => {
        // What the second pass looks like: still the internal address, because the
        // proxy does not pass the browser's host through. Comparing again would loop.
        const response = await startConnectionLink(
            arriving("/api/connections/google/link?moved=1", "0.0.0.0:3000"),
            "google"
        );

        expect(sent.redirectUri).toBe(`${REGISTERED}/api/connections/google/callback`);
        expect(response.headers.get("set-cookie")).toContain("polaris_connection_state=");
    });

    it("sends a sign-in to the same address a link goes to, which is the one registered", async () => {
        await startConnectionSignIn(arriving("/api/connections/google/signin", "polaris.example.com"), "google");

        expect(sent.redirectUri).toBe(`${REGISTERED}/api/connections/google/callback`);
    });
});
