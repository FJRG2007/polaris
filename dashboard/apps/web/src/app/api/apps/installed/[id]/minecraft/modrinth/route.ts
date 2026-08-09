import { z } from "zod";
import { NextResponse } from "next/server";
import { requireGameServer } from "@/lib/apps/install-access";
import { searchModrinth } from "@/lib/apps/minecraft/modrinth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The loaders a server can be running; anything else is not a search we can make
 *  sense of, and is refused rather than passed on to Modrinth. */
const querySchema = z.object({
    query: z.string().trim().min(1).max(80),
    loader: z.enum(["paper", "spigot", "fabric", "forge", "neoforge"])
});

/** Search Modrinth for mods and plugins that fit this server. Proxied so the
 *  browser never calls a third party directly, and gated on the same permission
 *  as the rest of the app - the results end up in an install. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    // Against the server the search is for, not against the instance: the results
    // end up in one install's mod list, so the grant that matters is the one on it.
    const { id } = await params;
    await requireGameServer("games.manage", id);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
        query: url.searchParams.get("query") ?? "",
        loader: url.searchParams.get("loader") ?? ""
    });
    if (!parsed.success) {
        return NextResponse.json({ error: "Search for a mod or plugin by name" }, { status: 400 });
    }
    return NextResponse.json({ projects: await searchModrinth(parsed.data.query, parsed.data.loader) });
}
