/**
 * GET /api/openapi.json - the OpenAPI 3.1 document for every route an API key
 * can call.
 *
 * Public on purpose: it describes request and response shapes and nothing about
 * this instance's data, and a client generator or an editor plugin fetching it
 * holds no session. The server address is the configured one, so a document
 * read on the LAN still names the address a key is used from.
 */

import { appBaseUrl } from "@/lib/domain-service";
import { buildOpenApi } from "@/lib/api-docs/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const base = (await appBaseUrl()).replace(/\/+$/, "");
    return Response.json(buildOpenApi(base), {
        headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" }
    });
}
