/**
 * Linking a Discord account, and the two things about it that are security
 * decisions rather than plumbing.
 *
 * The first is that a Discord account arrives closed as a way in. It is the
 * account most likely to be shared with a friend or phished in a game chat, it
 * is linked here to name a player on a FiveM server, and an operator who
 * connects the application to get that must not thereby have opened a second
 * door into Polaris without deciding to. Both halves have to arrive closed - the
 * deployment's switch and each new link's own - because either one left open is
 * the whole gate.
 *
 * The second is the consent screen. `identify` and nothing else: no address, no
 * messages, no list of the servers somebody is in. A scope that creeps into this
 * URL is a scope every person on the deployment is asked to grant, and nobody
 * re-reads a consent screen they have seen before.
 *
 * The rest is the name, which Discord spells two ways because it has had two
 * account systems, and both have to end up as something their owner recognises.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    integration: { enabled: true, config: { clientId: "client-id" } } as {
        enabled: boolean;
        config: Record<string, unknown>;
    } | null,
    settings: new Map<string, string>(),
    /** Queued replies, in the order the module calls out: token, then user. */
    responses: [] as Array<{ ok: boolean; status?: number; body: unknown }>,
    requests: [] as Array<{ url: string; body?: string; headers: Record<string, string> }>
};

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => state.integration,
    getIntegrationSecret: async () => "client-secret"
}));

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => state.settings.get(key) ?? null
}));

vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const next = state.responses.shift();
    if (!next) throw new Error(`no reply queued for ${String(input)}`);
    state.requests.push({
        url: String(input),
        body: typeof init?.body === "object" ? String(init.body) : undefined,
        headers: (init?.headers as Record<string, string>) ?? {}
    });
    return {
        ok: next.ok,
        status: next.status ?? (next.ok ? 200 : 400),
        json: async () => next.body,
        text: async () => JSON.stringify(next.body)
    } as Response;
});

const { discordAuthorizeUrl, exchangeDiscordCode, getDiscordOAuthClient, identifyDiscordAccount } = await import(
    "@/lib/connections/discord"
);
const { connectionSignInAllowed } = await import("@/lib/connections/store");
const { findConnectionProvider } = await import("@polaris/core");

const CLIENT = { clientId: "client-id", clientSecret: "client-secret" };
const REDIRECT = "https://polaris.example.com/api/connections/discord/callback";

/** A token reply and a `/users/@me` reply, which is the pair every exchange makes. */
function authorizes(user: Record<string, unknown>, scope = "identify"): void {
    state.responses = [
        { ok: true, body: { access_token: "token-1", token_type: "Bearer", scope } },
        { ok: true, body: user }
    ];
}

beforeEach(() => {
    state.integration = { enabled: true, config: { clientId: "client-id" } };
    state.settings = new Map();
    state.responses = [];
    state.requests = [];
});

describe("a Discord account is not a way in until somebody says so", () => {
    it("arrives closed on the deployment's switch, with no setting stored", async () => {
        expect(await connectionSignInAllowed("discord")).toBe(false);
    });

    it("opens only when the operator sets it, and closes again when they clear it", async () => {
        state.settings.set("connections.discord.signin", "true");
        expect(await connectionSignInAllowed("discord")).toBe(true);
        state.settings.set("connections.discord.signin", "false");
        expect(await connectionSignInAllowed("discord")).toBe(false);
    });

    it("arrives closed on each new link too, which is the half the operator does not control", () => {
        // `saveConnection` writes this onto the row on its first write, so a
        // default of true here would open every link ever made regardless of the
        // switch above.
        expect(findConnectionProvider("discord")?.signInDefault).toBe(false);
    });

    it("says why beside both switches, so nobody opens it without reading the reason", () => {
        expect(findConnectionProvider("discord")?.signInWarning).toBeTruthy();
    });

    it("holds no address, so nothing here can be taken as proof of who somebody is", () => {
        // Undefined rather than false: Polaris never asks Discord for an address,
        // so there is nothing for an operator to be offered a switch about.
        expect(findConnectionProvider("discord")?.emailTrustDefault).toBeUndefined();
    });
});

describe("where somebody is sent to authorize", () => {
    it("asks for identify and nothing else", () => {
        const url = new URL(discordAuthorizeUrl(CLIENT, REDIRECT, "state-1"));
        expect(url.searchParams.get("scope")).toBe("identify");
        expect(url.searchParams.get("scope")).not.toContain("email");
        expect(url.searchParams.get("scope")).not.toContain("guilds");
    });

    it("carries the application, the registered redirect and the state to echo back", () => {
        const url = new URL(discordAuthorizeUrl(CLIENT, REDIRECT, "state-1"));
        expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
        expect(url.searchParams.get("client_id")).toBe("client-id");
        expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("state")).toBe("state-1");
    });

    it("shows the screen every time, so a sign-in cannot be silently bounced back as whoever the browser holds", () => {
        const url = new URL(discordAuthorizeUrl(CLIENT, REDIRECT, "state-1"));
        expect(url.searchParams.get("prompt")).toBe("consent");
    });
});

describe("reading back who authorized", () => {
    it("takes the display name a migrated account shows", async () => {
        authorizes({ id: "1234", username: "ana", global_name: "Ana R", discriminator: "0", avatar: null });
        expect(await exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).toMatchObject({
            accountId: "1234",
            label: "Ana R"
        });
    });

    it("falls back to the handle when no display name is set", async () => {
        authorizes({ id: "1234", username: "ana", global_name: null, discriminator: "0" });
        expect((await exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).label).toBe("ana");
    });

    it("keeps the four digits an old account is only unique with", async () => {
        authorizes({ id: "1234", username: "ana", discriminator: "4821" });
        expect((await exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).label).toBe("ana#4821");
    });

    it("falls back to the id rather than labelling a link with nothing", async () => {
        authorizes({ id: "1234" });
        expect((await exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).label).toBe("1234");
    });

    it("builds the avatar off the account id and the hash", async () => {
        authorizes({ id: "1234", username: "ana", avatar: "abc123" });
        const { avatarUrl } = await exchangeDiscordCode(CLIENT, "code-1", REDIRECT);
        expect(avatarUrl).toBe("https://cdn.discordapp.com/avatars/1234/abc123.png?size=128");
    });

    it("asks for an animated avatar the one way Discord serves one", async () => {
        authorizes({ id: "1234", username: "ana", avatar: "a_abc123" });
        const { avatarUrl } = await exchangeDiscordCode(CLIENT, "code-1", REDIRECT);
        expect(avatarUrl).toBe("https://cdn.discordapp.com/avatars/1234/a_abc123.webp?size=128&animated=true");
    });

    it("draws no avatar for an account that has none, rather than a broken image", async () => {
        authorizes({ id: "1234", username: "ana", avatar: null });
        expect((await exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).avatarUrl).toBeNull();
    });

    it("keeps no credential: proving who they are was the whole errand", async () => {
        authorizes({ id: "1234", username: "ana" });
        expect((await exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).credential).toEqual({});
    });

    it("spends the code against the same redirect it was minted for", async () => {
        authorizes({ id: "1234", username: "ana" });
        await exchangeDiscordCode(CLIENT, "code-1", REDIRECT);
        const token = new URLSearchParams(state.requests[0]?.body ?? "");
        expect(state.requests[0]?.url).toBe("https://discord.com/api/oauth2/token");
        expect(token.get("grant_type")).toBe("authorization_code");
        expect(token.get("code")).toBe("code-1");
        expect(token.get("redirect_uri")).toBe(REDIRECT);
    });

    it("reports the account and nothing else when the trip was a sign-in", async () => {
        authorizes({ id: "1234", username: "ana", global_name: "Ana R", avatar: "abc123" });
        expect(await identifyDiscordAccount(CLIENT, "code-1", REDIRECT)).toEqual({ accountId: "1234" });
    });
});

describe("when Discord refuses", () => {
    it("carries its own reason, which is the one thing the operator can act on", async () => {
        state.responses = [
            {
                ok: false,
                status: 401,
                body: { error: "invalid_client", error_description: "Invalid client_id or client_secret" }
            }
        ];
        await expect(exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).rejects.toThrow(
            /Discord refused the token request \(401\).*invalid_client/
        );
    });

    it("does not pass off a token it could not resolve to an account as a link", async () => {
        state.responses = [
            { ok: true, body: { access_token: "token-1" } },
            { ok: false, status: 401, body: { message: "401: Unauthorized" } }
        ];
        await expect(exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).rejects.toThrow(/which account authorized/);
    });
});

describe("the application an operator connected", () => {
    it("is there when it is switched on and both halves are stored", async () => {
        expect(await getDiscordOAuthClient()).toEqual(CLIENT);
    });

    it("is absent while the integration is switched off", async () => {
        state.integration = { enabled: false, config: { clientId: "client-id" } };
        expect(await getDiscordOAuthClient()).toBeNull();
    });

    it("is absent with no client id, rather than a half-built one nobody can use", async () => {
        state.integration = { enabled: true, config: {} };
        expect(await getDiscordOAuthClient()).toBeNull();
    });
});
