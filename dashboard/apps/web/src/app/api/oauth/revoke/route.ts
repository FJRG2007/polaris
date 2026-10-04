/**
 * POST /api/oauth/revoke - token revocation (RFC 7009).
 *
 * How an app disconnects itself. Answered 200 whether or not the token existed
 * or was this app's, as the RFC requires, so the endpoint tells nobody which
 * tokens are live. People disconnect an app from Account > API keys instead.
 */

import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { revokeToken } from "@/lib/mcp/oauth/grants";
import { authenticateClient } from "@/lib/mcp/oauth/clients";
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
    const throttle = await rateLimit(`oauth-revoke:${ip}`, PER_ADDRESS_PER_MINUTE, 60_000);
    if (!throttle.ok) return slowDown(throttle.retryAfterMs);

    const params = await readParameters(request, BODY_MAX);
    if (!params)
        return oauthError("invalid_request", "Send the parameters form-encoded, under 16 KB");
    const client = await authenticateClient(clientCredentials(request, params));
    if (!client)
        return oauthError("invalid_client", "Unknown client, or its credentials are wrong", 401);

    const token = params.get("token");
    if (!token) return oauthError("invalid_request", "token is required");
    await revokeToken(client, token);
    return oauthJson({});
}

export function OPTIONS(): Response {
    return preflight();
}
