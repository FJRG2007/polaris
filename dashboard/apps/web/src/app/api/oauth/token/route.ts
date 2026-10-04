/**
 * POST /api/oauth/token - the token endpoint (RFC 6749 section 3.2).
 *
 * Two grants: an authorization code with its PKCE verifier, and a refresh
 * token, which is rotated on every use. Both are the app's word against what was
 * stored when the person approved it; see `lib/mcp/oauth/grants.ts` for the
 * rules. Throttled per address, so neither a code nor a verifier can be guessed
 * at speed - not that 256 bits could be.
 */

import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { authenticateClient } from "@/lib/mcp/oauth/clients";
import { exchangeCode, refresh } from "@/lib/mcp/oauth/grants";
import {
    clientCredentials,
    oauthError,
    oauthJson,
    preflight,
    readParameters,
    slowDown
} from "@/lib/mcp/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_MAX = 16 * 1024;
const PER_ADDRESS_PER_MINUTE = 60;

export async function POST(request: Request): Promise<Response> {
    const ip = (await clientIp()) ?? "unknown";
    const throttle = await rateLimit(`oauth-token:${ip}`, PER_ADDRESS_PER_MINUTE, 60_000);
    if (!throttle.ok) return slowDown(throttle.retryAfterMs);

    const params = await readParameters(request, BODY_MAX);
    if (!params)
        return oauthError("invalid_request", "Send the parameters form-encoded, under 16 KB");

    const credentials = clientCredentials(request, params);
    const client = await authenticateClient(credentials);
    if (!client) {
        // RFC 6749 section 5.2: a client that tried HTTP authentication is told
        // which scheme, with a 401.
        const triedBasic = /^basic\s/i.test(request.headers.get("authorization") ?? "");
        return oauthError(
            "invalid_client",
            "Unknown client, or its credentials are wrong",
            401,
            triedBasic ? { "WWW-Authenticate": 'Basic realm="polaris"' } : {}
        );
    }

    const grantType = params.get("grant_type");
    const resource = params.get("resource") ?? null;
    if (grantType === "authorization_code") {
        const outcome = await exchangeCode({
            client,
            code: params.get("code") ?? null,
            redirectUri: params.get("redirect_uri") ?? null,
            verifier: params.get("code_verifier") ?? null,
            resource
        });
        return outcome.ok
            ? oauthJson(outcome.body)
            : oauthError(outcome.error, outcome.description);
    }
    if (grantType === "refresh_token") {
        const outcome = await refresh({
            client,
            refreshToken: params.get("refresh_token") ?? null,
            scope: params.get("scope") ?? null,
            resource
        });
        return outcome.ok
            ? oauthJson(outcome.body)
            : oauthError(outcome.error, outcome.description);
    }
    return oauthError(
        "unsupported_grant_type",
        "grant_type must be authorization_code or refresh_token"
    );
}

export function OPTIONS(): Response {
    return preflight();
}
