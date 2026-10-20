/**
 * POST /api/polar/attachments/item - something from another app dragged onto
 * Polar: `{ item }`, as `lib/polar/dropped-items.ts` describes it. Looked up
 * again as the caller and stored as one of their attachments; answers the
 * address a message names it by, as an upload does.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { droppedItemSchema } from "@/lib/polar/dropped-items";
import { attachDroppedItem, ItemRefused } from "@/lib/polar/item-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ item: droppedItemSchema });
/** An item names a thing; it is never more than a path's worth of JSON. */
const BODY_MAX_BYTES = 16 * 1024;

const STATUS = { not_found: 404, unsupported_type: 415, too_large: 413 } as const;

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    // The same budget as uploads: either way it is a file stored for a message.
    const limited = await rateLimit(`polar-upload:${user.id}`, 30, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const raw = await readCappedBody(request, BODY_MAX_BYTES);
    if (!raw) return NextResponse.json({ error: "invalid" }, { status: 400 });
    let json: unknown;
    try {
        json = JSON.parse(new TextDecoder().decode(raw));
    } catch {
        return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
    const body = bodySchema.safeParse(json);
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

    try {
        const file = await attachDroppedItem(user, body.data.item);
        return NextResponse.json({ file });
    } catch (caught) {
        if (caught instanceof ItemRefused) {
            return NextResponse.json({ error: caught.code }, { status: STATUS[caught.code] });
        }
        console.error("polar: could not attach a dropped item", caught);
        return NextResponse.json({ error: "storage_failed" }, { status: 503 });
    }
}
