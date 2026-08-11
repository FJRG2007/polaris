/**
 * Proving which Minecraft account somebody holds.
 *
 * Four calls in a fixed order, each spending what the last returned: Microsoft,
 * then Xbox Live, then XSTS for Minecraft's own relying party, then Minecraft
 * itself. Nothing about that order is guessable from the outside, and getting one
 * step's body wrong fails at the next with a message about something else - so it
 * is pinned here rather than left to be rediscovered.
 *
 * The two refusals worth naming are the ones that are not faults at all: a child
 * account that has to be added to a family, and an account with no profile yet,
 * which is every Game Pass player who has not opened the launcher. Both are common
 * enough that "Microsoft refused the profile request (404)" would send somebody
 * looking in the wrong place.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => ({ enabled: true, config: { clientId: "client" }, hasSecret: true }),
    getIntegrationSecret: async () => "secret"
}));

const { exchangeMinecraftCode } = await import("@/lib/connections/minecraft");

const CLIENT = { clientId: "client", clientSecret: "secret" };

/** Every call the chain made, in order, with what it sent. */
let calls: { url: string; body: unknown }[] = [];
/** What each step answers, by the host it is asked on. */
let answers: Record<string, { status: number; body: unknown }> = {};

function hostOf(url: string): string {
    return new URL(url).host;
}

beforeEach(() => {
    calls = [];
    answers = {
        "login.microsoftonline.com": { status: 200, body: { access_token: "ms-token" } },
        "user.auth.xboxlive.com": { status: 200, body: { Token: "xbl-token", DisplayClaims: { xui: [{ uhs: "hash" }] } } },
        "xsts.auth.xboxlive.com": { status: 200, body: { Token: "xsts-token", DisplayClaims: { xui: [{ uhs: "hash" }] } } },
        "api.minecraftservices.com": { status: 200, body: { access_token: "mc-token" } }
    };
    vi.stubGlobal("fetch", async (input: string | URL, init?: { body?: unknown }) => {
        const url = String(input);
        calls.push({ url, body: init?.body });
        // The profile is the second call to the same host, so it is answered by
        // path rather than by host alone.
        const answer = url.endsWith("/minecraft/profile")
            ? (answers["profile"] ?? { status: 200, body: { id: "069a79f4", name: "Notch" } })
            : (answers[hostOf(url)] as { status: number; body: unknown });
        return new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json" }
        });
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("exchangeMinecraftCode", () => {
    it("walks Microsoft, Xbox, XSTS and Minecraft in that order and returns the profile", async () => {
        const linked = await exchangeMinecraftCode(CLIENT, "code", "https://polaris.example/callback");

        expect(calls.map((call) => hostOf(call.url))).toEqual([
            "login.microsoftonline.com",
            "user.auth.xboxlive.com",
            "xsts.auth.xboxlive.com",
            "api.minecraftservices.com",
            "api.minecraftservices.com"
        ]);
        // The account id is the UUID, which survives a rename; the label is the
        // name a server is actually told.
        expect(linked).toMatchObject({ accountId: "069a79f4", label: "Notch" });
    });

    it("asks Xbox for Minecraft's relying party, and hands the user hash to Minecraft", async () => {
        await exchangeMinecraftCode(CLIENT, "code", "https://polaris.example/callback");

        const xsts = JSON.parse(String(calls[2]?.body)) as { RelyingParty: string };
        expect(xsts.RelyingParty).toBe("rp://api.minecraftservices.com/");
        const login = JSON.parse(String(calls[3]?.body)) as { identityToken: string };
        expect(login.identityToken).toBe("XBL3.0 x=hash;xsts-token");
    });

    it("says a child account has to be added to a family", async () => {
        answers["xsts.auth.xboxlive.com"] = { status: 401, body: { XErr: 2148916238 } };
        await expect(exchangeMinecraftCode(CLIENT, "code", "https://polaris.example/callback")).rejects.toThrow(
            /family/i
        );
    });

    it("says an account with no profile has to open the launcher once", async () => {
        answers["profile"] = { status: 404, body: {} };
        await expect(exchangeMinecraftCode(CLIENT, "code", "https://polaris.example/callback")).rejects.toThrow(
            /launcher/i
        );
    });
});
