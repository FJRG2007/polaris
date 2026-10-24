/**
 * One piece of somebody's voice, on its way to a camera's speaker.
 *
 * The body is raw 16-bit little-endian PCM at 8 kHz, at most a second of it,
 * for the talk named by `?talk=`. Only the person who started that talk, and
 * only while they still hold `home.control`, can feed it; the talk itself was
 * opened, rate limited and audited by its action.
 *
 * 409 when the talk is over (the screen stops), 429 when it is being fed
 * faster than anybody speaks (the piece is dropped).
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { feedTalk } from "../../../../../../lib/talk";
import { HomeError } from "../../../../../../lib/home-error";
import { MAX_CHUNK_BYTES } from "../../../../../../lib/talk-audio";

const { apiUser } = host.apiSession;
const { sessionCan } = host.session;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

/** The body, refused past `MAX_CHUNK_BYTES` without reading the rest. */
async function readCapped(request: Request): Promise<Uint8Array | null> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_CHUNK_BYTES) return null;
    if (!request.body) return new Uint8Array(0);
    const reader = request.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CHUNK_BYTES) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        parts.push(value);
    }
    const body = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
        body.set(part, at);
        at += part.byteLength;
    }
    return body;
}

export async function POST(
    request: Request,
    context: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!(await sessionCan(user, "home.control"))) return new Response("Forbidden", { status: 403 });

    const { id } = await context.params;
    const camera = idSchema.safeParse(id);
    const talk = idSchema.safeParse(new URL(request.url).searchParams.get("talk"));
    if (!camera.success || !talk.success) return new Response("Bad request", { status: 400 });

    const pcm = await readCapped(request);
    if (!pcm) return new Response("Too large", { status: 413 });
    try {
        const fed = feedTalk(camera.data, user.id, talk.data, pcm);
        return new Response(null, { status: fed ? 204 : 429 });
    } catch (caught) {
        if (caught instanceof HomeError) return new Response("Gone", { status: 409 });
        throw caught;
    }
}
