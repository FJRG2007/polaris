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
import { closeDetection, recordDetection } from "@/lib/home/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A frame at the size the worker sends is tens of kilobytes. The ceiling is
 *  what stops a wrong (or hostile) worker filling the disk one event at a time. */
const MAX_STILL_BYTES = 2_000_000;

/** A corner of the frame, as a fraction of it. Bounded rather than free: a box
 *  outside the picture is a worker that has misread its own model, and it must
 *  not be drawn over a still. */
const fractionSchema = z.coerce.number().min(0).max(1);

const bodySchema = z.object({
    cameraId: z.string().uuid(),
    kind: z.enum(["motion", "person", "vehicle", "animal", "face", "tamper"]),
    label: z.string().trim().max(64).nullish(),
    score: z.coerce.number().int().min(0).max(100).nullish(),
    /** JPEG bytes, base64. Optional: the movement rung keeps no picture. */
    still: z.string().max(Math.ceil(MAX_STILL_BYTES * 1.4)).nullish(),
    /** Where in the picture it was: [x1, y1, x2, y2]. */
    box: z.tuple([fractionSchema, fractionSchema, fractionSchema, fractionSchema]).nullish(),
    /** The areas it was standing in, by the name the camera gave them. */
    zones: z.array(z.string().trim().max(64)).max(32).default([]),
    /** The worker's handle on the thing it is following, when it follows one. */
    trackId: z.string().trim().max(64).nullish(),
    /** Set when this report is the end of something rather than the start. */
    ended: z.boolean().default(false)
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

    // The end of something is only ever an update to the event its beginning
    // opened, so it costs no picture and no storage.
    if (parsed.data.ended) {
        if (parsed.data.trackId) await closeDetection(camera.id, parsed.data.trackId, new Date());
        return Response.json({ recorded: false, eventId: null });
    }

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
        stillKey,
        box: parsed.data.box
            ? { x1: parsed.data.box[0], y1: parsed.data.box[1], x2: parsed.data.box[2], y2: parsed.data.box[3] }
            : null,
        zones: parsed.data.zones,
        trackId: parsed.data.trackId ?? null
    });
    // A report folded into the one before it is a normal outcome, not a failure:
    // the worker is told so it can stop doing the expensive part for a while.
    return Response.json({ recorded: event !== null, eventId: event?.id ?? null });
}
