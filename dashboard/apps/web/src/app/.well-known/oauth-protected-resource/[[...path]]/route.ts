/**
 * GET /.well-known/oauth-protected-resource[/api/mcp] - Protected Resource
 * Metadata (RFC 9728) for the MCP endpoint.
 *
 * The first thing an assistant reads after its first call to /api/mcp is
 * refused: it says which authorization server issues tokens for the endpoint
 * (this instance) and which scopes there are. Answered both at the root and
 * with the endpoint's path appended, because the MCP spec has clients try the
 * second first and fall back to the first.
 *
 * Only for the MCP endpoint, under either transport: the SSE one at
 * `/api/mcp/sse` is the same resource, so it is described by the same metadata
 * and takes the same tokens. Any other suffix is a resource this instance does
 * not protect with OAuth, and saying otherwise would invite a client to try.
 */

import { originOf } from "@/lib/mcp/oauth/origin";
import { mcpScopes } from "@/lib/mcp/oauth/scopes";
import { metadataJson, preflight } from "@/lib/mcp/oauth/http";
import { MCP_PATH, SSE_PATH, protectedResourceMetadata } from "@/lib/mcp/oauth/urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
    const { path } = await params;
    const suffix = path?.length ? `/${path.join("/")}` : "";
    if (suffix !== "" && suffix !== MCP_PATH && suffix !== SSE_PATH) {
        // i18n-ignore read by a machine, not shown to a person
        return Response.json({ error: "No protected resource here" }, { status: 404 });
    }
    return metadataJson(protectedResourceMetadata(originOf(request), mcpScopes()));
}

export function OPTIONS(): Response {
    return preflight();
}
