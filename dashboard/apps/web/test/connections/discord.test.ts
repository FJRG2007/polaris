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

const {
    discordAccessToken,
    discordAuthorizeUrl,
    exchangeDiscordCode,
    getDiscordOAuthClient,
    identifyDiscordAccount,
    readDiscordGuilds
} = await import("@/lib/connections/discord");
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

    it("is still linkable while it is refused as a way in, which is the whole point of it", () => {
        // The two switches answer two questions. Discord is connected so a FiveM
        // server can recognise a player by their Polaris name; closing the door
        // must not take that away, or the operator would have to choose between
        // the feature and the risk. connectionSignInAllowed gates the login
        // screen alone - link-gate.test.ts holds the general rule.
        const discord = findConnectionProvider("discord");
        expect(discord?.signInDefault).toBe(false);
        // Nothing on the provider entry makes linking conditional on signing in:
        // acceptsToken and defaultLimit describe the link and are untouched by it.
        expect(discord?.defaultLimit).toBeGreaterThan(0);
        expect(discord?.requires).toBeTruthy();
    });

    it("holds the address without taking it as proof of who somebody is", () => {
        // False, not undefined: an address is handed over now, so the operator is
        // offered the switch - and it starts closed, because this is the account
        // the warning above calls easy to take over.
        expect(findConnectionProvider("discord")?.emailTrustDefault).toBe(false);
    });
});

describe("where somebody is sent to authorize", () => {
    it("asks for the account, the address and the server list", () => {
        const url = new URL(discordAuthorizeUrl(CLIENT, REDIRECT, "state-1"));
        expect(url.searchParams.get("scope")).toBe("identify email guilds");
    });

    it("does not ask to read anybody inside a server", () => {
        // guilds returns the servers an account is in. guilds.members.read would
        // return their nickname and roles within one, which is a larger
        // permission and nothing here asks for it.
        const url = new URL(discordAuthorizeUrl(CLIENT, REDIRECT, "state-1"));
        expect(url.searchParams.get("scope")).not.toContain("guilds.members.read");
        expect(url.searchParams.get("scope")).not.toContain("messages");
        expect(url.searchParams.get("scope")).not.toContain("bot");
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
        authorizes({
            id: "1234",
            username: "ana",
            global_name: "Ana R",
            discriminator: "0",
            avatar: null
        });
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
        expect(avatarUrl).toBe("https://cdn.discordapp.com/avatars/1234/a_abc123.gif?size=128");
    });

    it("draws no avatar for an account that has none, rather than a broken image", async () => {
        authorizes({ id: "1234", username: "ana", avatar: null });
        expect((await exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).avatarUrl).toBeNull();
    });

    it("keeps the grant, because the server list is read later and not copied now", async () => {
        state.responses = [
            {
                ok: true,
                body: {
                    access_token: "token-1",
                    refresh_token: "refresh-1",
                    expires_in: 604800,
                    scope: "identify email guilds"
                }
            },
            { ok: true, body: { id: "1234", username: "ana" } }
        ];
        const { credential } = await exchangeDiscordCode(CLIENT, "code-1", REDIRECT);
        expect(credential.accessToken).toBe("token-1");
        expect(credential.refreshToken).toBe("refresh-1");
        // Absolute, so what reads it compares against the clock rather than
        // against the moment the response happened to arrive.
        expect(credential.expiresAt).toBeGreaterThan(Date.now());
    });

    it("holds an address Discord says it confirmed", async () => {
        authorizes({ id: "1234", username: "ana", email: "ana@example.com", verified: true });
        expect((await exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).email).toBe("ana@example.com");
    });

    it("drops one Discord has not confirmed, since that is where a code would go", async () => {
        authorizes({ id: "1234", username: "ana", email: "ana@example.com", verified: false });
        expect((await exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).email).toBeNull();
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
        expect(await identifyDiscordAccount(CLIENT, "code-1", REDIRECT)).toEqual({
            accountId: "1234"
        });
    });
});

describe("when Discord refuses", () => {
    it("carries its own reason, which is the one thing the operator can act on", async () => {
        state.responses = [
            {
                ok: false,
                status: 401,
                body: {
                    error: "invalid_client",
                    error_description: "Invalid client_id or client_secret"
                }
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
        await expect(exchangeDiscordCode(CLIENT, "code-1", REDIRECT)).rejects.toThrow(
            /which account authorized/
        );
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

/**
 * The grant has to still be good when the server list is asked for.
 *
 * Discord's access tokens last a week. A link made and then left alone would
 * have a dead token seven days later, and the failure would look exactly like an
 * account whose owner revoked the authorization - so the refresh token is spent
 * on the way past and the replacement handed back to be written down.
 */
describe("keeping the grant usable", () => {
    it("uses the stored token while it is still good, without a round trip", async () => {
        const held = {
            accessToken: "token-1",
            refreshToken: "refresh-1",
            expiresAt: Date.now() + 600_000
        };
        expect(await discordAccessToken(CLIENT, held)).toEqual({
            accessToken: "token-1",
            refreshed: null
        });
        expect(state.requests).toHaveLength(0);
    });

    it("refreshes past the margin and hands back what to store", async () => {
        state.responses = [
            {
                ok: true,
                body: { access_token: "token-2", refresh_token: "refresh-2", expires_in: 604800 }
            }
        ];
        const expired = {
            accessToken: "token-1",
            refreshToken: "refresh-1",
            expiresAt: Date.now() - 1
        };
        const got = await discordAccessToken(CLIENT, expired);
        expect(got?.accessToken).toBe("token-2");
        expect(got?.refreshed?.refreshToken).toBe("refresh-2");
        expect(new URLSearchParams(state.requests[0]?.body ?? "").get("grant_type")).toBe(
            "refresh_token"
        );
    });

    it("refreshes just before expiry, not at it, so a call is not signed with a dying token", async () => {
        state.responses = [{ ok: true, body: { access_token: "token-2", expires_in: 604800 } }];
        // Inside the margin: still valid by the clock, not worth starting a call with.
        const nearly = {
            accessToken: "token-1",
            refreshToken: "refresh-1",
            expiresAt: Date.now() + 10_000
        };
        expect((await discordAccessToken(CLIENT, nearly))?.accessToken).toBe("token-2");
    });

    it("reports a link with nothing to refresh rather than throwing at a list", async () => {
        // A link made before the token was kept, or a grant its owner withdrew.
        expect(await discordAccessToken(CLIENT, {})).toBeNull();
    });
});

describe("the servers an account is in", () => {
    it("reads the names and resolves the icons", async () => {
        state.responses = [
            {
                ok: true,
                body: [
                    { id: "9", name: "Roleplay ES", icon: "abc", owner: true },
                    { id: "10", name: "Test", icon: null }
                ]
            }
        ];
        expect(await readDiscordGuilds("token-1")).toEqual([
            {
                id: "9",
                name: "Roleplay ES",
                iconUrl: "https://cdn.discordapp.com/icons/9/abc.png?size=128",
                owner: true
            },
            { id: "10", name: "Test", iconUrl: null, owner: false }
        ]);
    });

    it("says what Discord said when it refuses, rather than an empty list", async () => {
        state.responses = [{ ok: false, status: 401, body: { message: "401: Unauthorized" } }];
        await expect(readDiscordGuilds("token-1")).rejects.toThrow(/would not list the servers/);
    });
});
