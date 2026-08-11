/**
 * Asking Google whether the application an operator just pasted in would work,
 * before everybody here is given a Connect button for it.
 *
 * Half a setup looks exactly like a finished one from the Integrations screen: a
 * secret copied from a different client, or a redirect URI never pasted into the
 * console, stores and switches on just as happily. The person who finds out is
 * whoever presses Connect, and they cannot fix any of it.
 *
 * Only an explicit refusal counts. A request that never arrived says nothing about
 * the credentials, and refusing to save on a momentary network failure would be a
 * check the operator cannot argue with.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integration-service", () => ({
    getIntegrationSecret: async () => null,
    getIntegrationState: async () => null,
    upsertIntegration: async () => undefined
}));

const { verifyGoogleOAuthClient } = await import("@/lib/google-calendar/service");

const CLIENT = { clientId: "1234-abc.apps.googleusercontent.com", clientSecret: "secret" };
const REDIRECT = "https://polaris.example.com/api/connections/google/callback";

const TOKEN = "https://oauth2.googleapis.com/token";
const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google's two endpoints, each answering what this deployment asked it. */
function googleAnswering(answers: { token?: Response | Error; authorize?: Response | Error }): void {
    vi.stubGlobal("fetch", async (input: string | URL) => {
        const url = String(input);
        const answer = url.startsWith(TOKEN) ? answers.token : answers.authorize;
        if (answer instanceof Error) throw answer;
        // Not asked for: the first refusal ends the check, so the second endpoint
        // is only reached when the first said nothing.
        return answer ?? new Response(null, { status: 302 });
    });
}

const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("verifyGoogleOAuthClient", () => {
    it("says nothing when Google would show the consent screen", async () => {
        googleAnswering({
            token: json({ error: "invalid_grant" }, 400),
            authorize: new Response(null, { status: 302 })
        });

        expect(await verifyGoogleOAuthClient(CLIENT, REDIRECT)).toBeNull();
    });

    it("names an id and a secret that are not a pair", async () => {
        googleAnswering({ token: json({ error: "invalid_client" }, 401) });

        expect(await verifyGoogleOAuthClient(CLIENT, REDIRECT)).toMatch(/client ID and secret/i);
    });

    it("names a redirect URI Google will not authorize anybody with", async () => {
        // What a deployment behind a proxy hits: Google declines to show a consent
        // screen at all, which is what everybody pressing Connect would get.
        googleAnswering({
            token: json({ error: "invalid_grant" }, 400),
            authorize: new Response("Error 400: invalid_request", { status: 400 })
        });

        const refused = await verifyGoogleOAuthClient(CLIENT, REDIRECT);
        expect(refused).toContain(REDIRECT);
    });

    it("holds nothing against an operator when Google could not be reached", async () => {
        googleAnswering({ token: new Error("ENOTFOUND"), authorize: new Error("ENOTFOUND") });

        expect(await verifyGoogleOAuthClient(CLIENT, REDIRECT)).toBeNull();
    });

    it("holds nothing against them when Google itself is failing", async () => {
        googleAnswering({
            token: json({ error: "internal_failure" }, 500),
            authorize: new Response(null, { status: 503 })
        });

        expect(await verifyGoogleOAuthClient(CLIENT, REDIRECT)).toBeNull();
    });
});
