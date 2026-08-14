/**
 * The small endpoints a client calls to orient itself, plus the two services it
 * expects a server to run: website icons, and a notifications hub.
 *
 * They look trivial and are not optional. A client that gets nothing from
 * `/api/config` decides the server is an old version and turns features off; one
 * that cannot reach `/notifications/hub` retries it forever in the background.
 */

import { loadEnv } from "@polaris/config";
import { vaultError } from "@/lib/vault/auth";
import { domainsResponse } from "@/lib/vault/sync";
import { rateLimit } from "@/lib/rate-limit-service";
import { configResponse } from "@/lib/vault/api/identity";
import { type VaultContext } from "@/lib/vault/api/router";
import { clientIp, hashForLog } from "@/lib/request-context";
import { cachedSiteIcon, fetchSiteIcon } from "@/lib/vault/icons";

/** The Polaris version reported to clients, read once at module load. */
const VERSION = process.env.npm_package_version ?? "2026.8.0";

/** Icons one address may send this server out for, and the window. Only a miss
 *  is counted: a cached icon costs nothing to hand back. */
const ICON_LIMIT = 120;
const ICON_WINDOW_MS = 5 * 60 * 1000;

export async function config(): Promise<Response> {
    return Response.json(configResponse(loadEnv().POLARIS_APP_URL, VERSION));
}

/** Bare strings, which is what these three endpoints return. */
export async function version(): Promise<Response> {
    return new Response(JSON.stringify(VERSION), {
        headers: { "content-type": "application/json" }
    });
}

export async function alive(): Promise<Response> {
    return new Response(JSON.stringify(new Date().toISOString()), {
        headers: { "content-type": "application/json" }
    });
}

/** The domains a client treats as one site. */
export async function domains(): Promise<Response> {
    return Response.json(domainsResponse());
}

/**
 * A website's icon, for the list a client draws.
 *
 * Fetched and cached by Polaris rather than proxied to Bitwarden's service,
 * which is the point: a client asking a third party for an icon per saved login
 * is a client telling a third party which sites somebody has accounts on.
 *
 * Reachable without a token, like everything else clients ask before they have
 * one, and the only one of those that answers by making a request of its own -
 * so it caps how often it will do that for one address. What is capped is the
 * going out, not the answering: a domain already in the cache is served either
 * way, and a caller that has run out is told to come back rather than handed a
 * missing icon it would remember as missing.
 */
export async function icon(context: VaultContext): Promise<Response> {
    const domain = context.params.domain ?? "";
    let icon = cachedSiteIcon(domain);
    if (icon === undefined) {
        const limitKey = `vault-icon:${hashForLog(await clientIp()) ?? "unknown"}`;
        if (!(await rateLimit(limitKey, ICON_LIMIT, ICON_WINDOW_MS)).ok) {
            return vaultError("Too many icon lookups. Try again in a few minutes.", 429);
        }
        icon = await fetchSiteIcon(domain);
    }
    if (!icon) return vaultError("Not found", 404);
    return new Response(new Uint8Array(icon.bytes), {
        headers: {
            "content-type": icon.contentType,
            // Long, because a favicon does not move and the alternative is a
            // request per site on every vault open.
            "cache-control": "public, max-age=86400, immutable"
        }
    });
}

/**
 * The notifications hub's negotiate step.
 *
 * Answered so clients stop asking, and answered honestly: Polaris pushes nothing
 * over this yet, and a client told that long polling is available will fall back
 * to it and sync on its own schedule. Advertising a WebSocket that never sends
 * anything would leave every client holding an idle connection open instead.
 */
export async function negotiate(): Promise<Response> {
    return Response.json({
        connectionId: "",
        availableTransports: [],
        negotiateVersion: 0
    });
}

/** Events, which Polaris records in its own activity log rather than here. */
export async function events(): Promise<Response> {
    return Response.json({ object: "list", continuationToken: null, data: [] });
}

/**
 * The three lists a client polls for features Polaris does not run.
 *
 * Security tasks are an organization telling members to change a password;
 * auth requests are signing in on one device by approving it on another. Neither
 * exists here, and an empty list is how a client is told so - a 404 makes the
 * extension log an error on a timer and retry it forever.
 */
export async function emptyList(): Promise<Response> {
    return Response.json({ object: "list", continuationToken: null, data: [] });
}

/**
 * Whether an organization enrolls its members in password reset automatically.
 *
 * Polaris does not: an administrator who could reset a member's master password
 * could open their vault, which is the one thing this whole feature exists to
 * make impossible.
 */
export async function autoEnrollStatus(context: VaultContext): Promise<Response> {
    return Response.json({
        id: context.params.orgId ?? "",
        resetPasswordEnabled: false
    });
}
