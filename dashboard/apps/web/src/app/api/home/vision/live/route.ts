/**
 * Where the vision worker says things are, this instant.
 *
 * Separate from the events route next door because it is the opposite kind of
 * message. An event is a record: it is written down, it keeps a picture, and it
 * is meant to be read tomorrow. This is a position, it is true for about two
 * hundred milliseconds, and its only reader is a screen someone is looking at
 * right now - so it touches no storage at all and is answered as fast as it can
 * be refused or accepted.
 *
 * The camera is still checked against this house. A worker is trusted to report
 * on the cameras it was given, never on an id it can think of - the same rule as
 * the events route, and it costs one indexed lookup.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { homeInstall } from "@/lib/home/access";
import { authorizeWorker } from "@/lib/home/vision";
import { publishLiveBoxes } from "@/lib/home/live-boxes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A corner of the frame, as a fraction of it. A box outside the picture is a
 *  worker that has misread its own model, and must not be drawn over a camera. */
const fractionSchema = z.coerce.number().min(0).max(1);

/**
 * How many things one frame may carry.
 *
 * A view with more than this many people in it is a crowd, and a screen with
 * thirty two rectangles on it is not showing anybody anything - so this is both
 * a bound on the message and the point past which the drawing stops being
 * useful anyway.
 */
const MAX_BOXES = 32;

const bodySchema = z.object({
    cameraId: z.string().uuid(),
    boxes: z
        .array(
            z.object({
                id: z.string().trim().min(1).max(64),
                label: z.string().trim().min(1).max(64),
                score: z.coerce.number().int().min(0).max(100),
                box: z.object({
                    x1: fractionSchema,
                    y1: fractionSchema,
                    x2: fractionSchema,
                    y2: fractionSchema
                })
            })
        )
        .max(MAX_BOXES)
        .default([])
});

export async function POST(request: Request): Promise<Response> {
    const worker = await authorizeWorker(request);
    if (!worker) return Response.json({ error: "Not authorized." }, { status: 401 });
    const install = await homeInstall();
    if (!install) return Response.json({ error: "Home is not set up." }, { status: 404 });

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Malformed report." }, { status: 400 });

    const camera = await prisma.camera.findFirst({
        where: { id: parsed.data.cameraId, installedAppId: install.id },
        select: { id: true }
    });
    if (!camera) return Response.json({ error: "No such camera." }, { status: 404 });

    publishLiveBoxes(
        camera.id,
        // A box with no width or height is not somewhere: it is a line, and
        // drawn it is a one-pixel scratch nobody can read.
        parsed.data.boxes.filter((entry) => entry.box.x2 > entry.box.x1 && entry.box.y2 > entry.box.y1)
    );
    return Response.json({ ok: true });
}
