import { NextResponse } from "next/server";
import { requireGameServer } from "@/lib/apps/install-access";
import { serverModItems } from "@/lib/apps/minecraft/mod-items-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The items this server's mods add, for the picker.
 *
 * Asked for when the picker opens rather than kept warm: the answer is only
 * needed by somebody looking at one, and a server with no mods answers with
 * nothing before it touches a network. The vanilla catalogue is a static file and
 * is untouched by this, so the picker draws its grid at once either way and these
 * arrive alongside.
 *
 * Gated on reading the server, the same as the bag this hands items into.
 * Answering with an empty catalogue rather than an error when the mods cannot be
 * resolved: the picker still hands out vanilla items and still takes a typed id,
 * which is where it was before this existed.
 */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    const { access } = await requireGameServer("games.read", id);
    const read = await serverModItems(access.ownerId, id).catch(() => null);
    // `complete` is false when the budget ran out with mods still to read, and the
    // panel needs it: what it does with an answer is keep it for a few minutes,
    // and keeping a half-read one that long is the rest of the list not appearing
    // until somebody reloads the tab.
    return NextResponse.json(read ?? { items: [], unread: [], complete: false });
}
