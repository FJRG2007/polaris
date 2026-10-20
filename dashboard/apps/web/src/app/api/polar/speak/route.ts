/**
 * POST /api/polar/speak - one sentence of Polar's answer, said out loud. The
 * body is `{ text }`; the answer is the audio itself. A voice call asks for
 * each sentence as soon as it is written, so a long answer starts playing
 * before it has finished.
 */

import { NextResponse } from "next/server";
import { experimental_generateSpeech as generateSpeech } from "ai";
import { polarCaller } from "@/lib/polar/access";
import { polarSpeaker } from "@/lib/polar/voice";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { speakBodySchema } from "@/lib/polar/voice-call";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A sentence and its JSON, with room to spare. */
const BODY_MAX = 8 * 1024;

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return refuse("view_as", 403);
    // A sentence a request: a long answer is a few dozen of them.
    const limited = await rateLimit(`polar-speak:${user.id}`, 120, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);

    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const body = speakBodySchema.safeParse(raw);
    if (!body.success) return refuse("invalid", 400);

    const speaker = await polarSpeaker(user.id, body.data.payer);
    if (!speaker) return refuse("no_voice_provider", 409);
    try {
        const result = await generateSpeech({
            model: speaker.model,
            text: body.data.text,
            voice: speaker.voice,
            outputFormat: speaker.format,
            abortSignal: request.signal
        });
        const audio = result.audio.uint8Array;
        return new Response(new Uint8Array(audio), {
            headers: {
                "Content-Type": result.audio.mediaType || speaker.mediaType,
                "Cache-Control": "no-store"
            }
        });
    } catch (error) {
        console.error("polar: speech failed", error);
        return refuse("speak_failed", 502);
    }
}
