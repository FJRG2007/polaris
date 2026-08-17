/**
 * What the vision worker saw.
 *
 * The worker decides; this records. Two things are checked before anything is
 * written: that the caller is one of this instance's workers, and that the camera
 * it names belongs to this house - a worker is trusted to report on the cameras
 * it was given, not on any id it can think of.
 *
 * The still comes as base64 rather than as a second request, because the picture
 * and the event are worth nothing apart: an event with no picture is a line
 * nobody can judge, and a picture with no event is a file nothing points at.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { storeStill } from "@/lib/home/stills";
import { homeInstall } from "@/lib/home/access";
import { authorizeWorker } from "@/lib/home/vision";
import { recordDetection } from "@/lib/home/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A frame at the size the worker sends is tens of kilobytes. The ceiling is
 *  what stops a wrong (or hostile) worker filling the disk one event at a time. */
const MAX_STILL_BYTES = 2_000_000;

const bodySchema = z.object({
    cameraId: z.string().uuid(),
    kind: z.enum(["motion", "person", "vehicle", "animal", "face", "tamper"]),
    label: z.string().trim().max(64).nullish(),
    score: z.coerce.number().int().min(0).max(100).nullish(),
    /** JPEG bytes, base64. Optional: the movement rung keeps no picture. */
    still: z.string().max(Math.ceil(MAX_STILL_BYTES * 1.4)).nullish()
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
        select: { id: true, storageTarget: true }
    });
    if (!camera) return Response.json({ error: "No such camera." }, { status: 404 });

    let stillKey: string | null = null;
    if (parsed.data.still) {
        const bytes = Buffer.from(parsed.data.still, "base64");
        if (bytes.byteLength > MAX_STILL_BYTES) {
            return Response.json({ error: "That picture is too large." }, { status: 413 });
        }
        stillKey = await storeStill(camera, bytes).catch(() => null);
    }

    const event = await recordDetection({
        cameraId: camera.id,
        kind: parsed.data.kind,
        label: parsed.data.label ?? null,
        score: parsed.data.score ?? null,
        stillKey
    });
    // A report folded into the one before it is a normal outcome, not a failure:
    // the worker is told so it can stop doing the expensive part for a while.
    return Response.json({ recorded: event !== null, eventId: event?.id ?? null });
}
