/**
 * Steam accounts, for the game servers that are closed by a Steam id.
 *
 * The odd one out among the services here: Steam does not do OAuth. It speaks
 * OpenID 2.0 - the protocol OpenID Connect replaced - so there is no application
 * to register, no client id and no secret. Somebody is sent to Steam, Steam sends
 * them back with a signed assertion, and the assertion is proved by handing it
 * straight back to Steam and asking whether it minted it. That is the whole trip,
 * and it means this provider works on a fresh install with nothing configured.
 *
 * What the optional Web API key buys is the name and the avatar. Without one a
 * linked account is a seventeen-digit number, which is correct but unreadable, so
 * the key is offered in Integrations and its absence changes nothing else.
 *
 * The one thing never taken on trust is the URL somebody came back on. Every
 * parameter in it is the browser's to forge; only Steam's own answer to
 * `check_authentication` decides whether the id is real.
 */

import { getIntegrationSecret } from "@/lib/integration-service";

export const STEAM_PROVIDER = "steam";

/** Steam's OpenID endpoint, used both to send somebody and to check what came
 *  back. Hardcoded rather than read from the response: `op_endpoint` arrives in
 *  the URL, and believing it would let anybody nominate their own verifier. */
const OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";

/** What the claimed identity looks like when Steam has vouched for somebody. */
const CLAIMED_ID = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

const PLAYER_SUMMARIES = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/";

/** How long to wait on Steam before giving up, for both calls. A person is
 *  watching a redirect resolve, so this is short. */
const TIMEOUT_MS = 8000;

/**
 * Where to send somebody to prove they hold a Steam account.
 *
 * `identifier_select` is what makes Steam ask which account rather than being
 * told; the realm is the site asking, and Steam shows it on its own screen.
 */
export function steamAuthorizeUrl(returnTo: string, realm: string): string {
    const url = new URL(OPENID_ENDPOINT);
    url.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
    url.searchParams.set("openid.mode", "checkid_setup");
    url.searchParams.set("openid.return_to", returnTo);
    url.searchParams.set("openid.realm", realm);
    url.searchParams.set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select");
    url.searchParams.set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select");
    return url.toString();
}

/**
 * The Steam id somebody came back with, or null when Steam does not own the
 * assertion.
 *
 * Nothing in the URL is evidence by itself - it arrived through a browser and any
 * of it can be written by hand. It is evidence once Steam has been handed it back
 * unchanged and has answered `is_valid:true`, which is what this does.
 */
export async function verifySteamReturn(params: URLSearchParams): Promise<string | null> {
    if (params.get("openid.mode") !== "id_res") return null;
    const claimed = CLAIMED_ID.exec(params.get("openid.claimed_id") ?? "");
    if (!claimed) return null;

    const body = new URLSearchParams();
    for (const [key, value] of params) {
        if (key.startsWith("openid.")) body.set(key, value);
    }
    body.set("openid.mode", "check_authentication");

    const answer = await fetch(OPENID_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS)
    }).catch(() => null);
    if (!answer?.ok) return null;
    const said = await answer.text().catch(() => "");
    // The answer is a small key:value document; only one line of it matters.
    return /(^|\n)is_valid\s*:\s*true/i.test(said) ? (claimed[1] as string) : null;
}

export interface SteamPersona {
    readonly name: string;
    readonly avatarUrl: string | null;
}

/**
 * What to call an account, when the operator has given Polaris a Web API key.
 *
 * Null whenever there is no key or Steam does not answer: the link is recorded
 * either way, because who somebody is was already proved - this is only what the
 * row is labelled with.
 */
export async function readSteamPersona(steamId: string): Promise<SteamPersona | null> {
    const key = await getIntegrationSecret(STEAM_PROVIDER).catch(() => null);
    if (!key) return null;
    const url = new URL(PLAYER_SUMMARIES);
    url.searchParams.set("key", key);
    url.searchParams.set("steamids", steamId);
    const answer = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!answer?.ok) return null;
    const body = (await answer.json().catch(() => null)) as {
        response?: { players?: { personaname?: unknown; avatarfull?: unknown }[] };
    } | null;
    const player = body?.response?.players?.[0];
    if (!player || typeof player.personaname !== "string") return null;
    return {
        name: player.personaname,
        avatarUrl: typeof player.avatarfull === "string" ? player.avatarfull : null
    };
}
