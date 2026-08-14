/**
 * The one entry point for everything a Bitwarden client asks for.
 *
 * Clients reach these paths as `<origin>/vault/api/...`, `<origin>/vault/identity/...`
 * and so on; a rewrite in next.config.mjs brings them here, and the route table
 * in lib/vault/api/routes decides what answers. The reason it is one handler is
 * in that module: the surface is a foreign spec of some fifty paths, and a
 * folder tree per path would hide the shape it has to match.
 *
 * Node runtime for Prisma and node:crypto. Never cached: every response here is
 * either somebody's vault or a token.
 */

import { VAULT_ROUTES } from "@/lib/vault/api/routes";
import { dispatchVault } from "@/lib/vault/api/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: RouteParams): Promise<Response> {
    const { path } = await params;
    return dispatchVault(VAULT_ROUTES, request, path ?? []);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
