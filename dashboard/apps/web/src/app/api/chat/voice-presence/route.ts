/**
 * Who is sitting in each of these voice rooms.
 *
 * A route rather than a server action because the chat screen asks it on a
 * timer from a tab that stays open all day: an action is addressed by an id the
 * build that served the page minted, so after an update every ask failed and the
 * names under the voice rooms froze until a reload. Answered only for the rooms
 * the reader can reach, whatever ids the browser sent.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { backgroundUser, sessionCan } from "@/lib/session";
import { reachableChannelIds } from "@/lib/chat/access";
import { voicePresence } from "@/lib/chat/meetings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** More rooms than any rail lists, so a crafted request cannot ask for the
 *  whole table at once. */
const MAX_ROOMS = 200;

const idsSchema = z.array(z.string().uuid()).max(MAX_ROOMS);

export async function GET(request: Request): Promise<Response> {
    const user = await backgroundUser();
    // i18n-ignore: a status body the voice rail never shows
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(user, "chat.use"))) return NextResponse.json({ inRoom: {} });
    const raw = new URL(request.url).searchParams.get("ids") ?? "";
    const parsed = idsSchema.safeParse(raw ? raw.split(",") : []);
    // i18n-ignore: a status body the voice rail never shows
    if (!parsed.success) return NextResponse.json({ error: "Bad ids" }, { status: 400 });
    const reachable = await reachableChannelIds({ id: user.id });
    const found = await voicePresence(parsed.data.filter((id) => reachable.has(id)));
    return NextResponse.json(
        { inRoom: Object.fromEntries(found) },
        { headers: { "cache-control": "no-store" } }
    );
}
