/**
 * What each camera's pipeline has been doing, from the worker that runs it.
 *
 * Every camera on one worker in one request, twice a minute, because the answer
 * is four numbers each and a request per camera would scale the cost with how
 * many cameras a house has.
 *
 * The cameras are checked against this house in one query rather than one each:
 * a worker is trusted to report on the cameras it was given, not on any id it
 * can think of, and that rule should not cost a round trip per camera.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { homeInstall } from "@/lib/home/access";
import { authorizeWorker } from "@/lib/home/vision";
import { publishActivity } from "@/lib/home/vision-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** More cameras than a house has, on one worker. */
const MAX_CAMERAS = 128;

const bodySchema = z.object({
    cameras: z
        .array(
            z.object({
                cameraId: z.string().uuid(),
                watching: z.boolean(),
                motionAt: z.number().int().nullish(),
                lookedAt: z.number().int().nullish(),
                foundAt: z.number().int().nullish(),
                found: z.string().trim().max(64).nullish(),
                limitedTo: z.string().trim().max(200).nullish()
            })
        )
        .max(MAX_CAMERAS)
        .default([])
});

export async function POST(request: Request): Promise<Response> {
    const worker = await authorizeWorker(request);
    if (!worker) return Response.json({ error: "Not authorized." }, { status: 401 });
    const install = await homeInstall();
    if (!install) return Response.json({ error: "Home is not set up." }, { status: 404 });

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Malformed report." }, { status: 400 });
    if (parsed.data.cameras.length === 0) return Response.json({ ok: true });

    const ours = await prisma.camera.findMany({
        where: {
            id: { in: parsed.data.cameras.map((camera) => camera.cameraId) },
            installedAppId: install.id
        },
        select: { id: true }
    });
    const allowed = new Set(ours.map((camera) => camera.id));

    for (const camera of parsed.data.cameras) {
        if (!allowed.has(camera.cameraId)) continue;
        publishActivity(camera.cameraId, {
            watching: camera.watching,
            motionAt: camera.motionAt ?? null,
            lookedAt: camera.lookedAt ?? null,
            foundAt: camera.foundAt ?? null,
            found: camera.found ?? null,
            limitedTo: camera.limitedTo ?? null
        });
    }
    return Response.json({ ok: true });
}
