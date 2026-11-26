/**
 * The published device plugin catalog, for a page with no desktop app behind it
 * (the search in a plain browser lists what can be installed). Signed-in callers
 * only; it carries nothing about any device. Node runtime for `node:crypto`.
 */

import { apiUser } from "@/lib/api-session";
import { publishedPluginCatalog } from "@/lib/device-plugins-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const catalog = await publishedPluginCatalog();
    return Response.json({ catalog }, { headers: { "cache-control": "private, max-age=300" } });
}
