/**
 * GET /.well-known/oauth-authorization-server - Authorization Server Metadata
 * (RFC 8414) for the issuer that is this instance.
 *
 * The issuer has no path, so the document lives at the root. A suffixed request
 * is a client looking for a different issuer and is told there is none.
 */

import { originOf } from "@/lib/mcp/oauth/origin";
import { mcpScopes } from "@/lib/mcp/oauth/scopes";
import { metadataJson, preflight } from "@/lib/mcp/oauth/http";
import { authorizationServerMetadata } from "@/lib/mcp/oauth/urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
    const { path } = await params;
    if (path?.length) {
        // i18n-ignore read by a machine, not shown to a person
        return Response.json({ error: "No authorization server here" }, { status: 404 });
    }
    return metadataJson(authorizationServerMetadata(originOf(request), mcpScopes()));
}

export function OPTIONS(): Response {
    return preflight();
}
