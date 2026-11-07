/**
 * GET /api/account/tv/catalog-shot?name=<theme|addon>-<id>.jpg - a screenshot of
 * the newest TV release's catalog, for the picker on /account/tv. Any signed-in
 * account: the catalog is the same public release for everybody. Served from the
 * copy this instance verified for its TVs, never fetched by the browser itself.
 */

import { readFile } from "node:fs/promises";
import { guardedUser } from "@/lib/session";
import { preparedTvCatalogFile } from "@/lib/tv/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHOT = /^(?:theme|addon)-[a-z0-9][a-z0-9_-]{0,63}\.jpg$/;

export async function GET(request: Request): Promise<Response> {
    if (!(await guardedUser())) return new Response(null, { status: 401 });
    const name = new URL(request.url).searchParams.get("name") ?? "";
    if (!SHOT.test(name)) return new Response(null, { status: 404 });
    const file = await preparedTvCatalogFile(name).catch(() => null);
    if (!file) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(await readFile(file.path)), {
        headers: {
            "content-type": "image/jpeg",
            "cache-control": "private, max-age=3600",
            etag: `"${file.sha256}"`
        }
    });
}
