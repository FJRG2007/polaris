/**
 * POST /api/polar/transcribe?durationMs=<n> - what somebody said to Polar, as
 * text: dictation into the composer, and each turn of a voice call. The body is
 * the recording; its Content-Type says what it is. Answers `{ text }`.
 *
 * The recording is held in memory only for the call to the provider and never
 * stored.
 */

import { NextResponse } from "next/server";
import { experimental_transcribe as transcribe } from "ai";
import { apiUser } from "@/lib/api-session";
import { polarTranscriber } from "@/lib/polar/voice";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import {
    acceptedAudioType,
    transcribeQuerySchema,
    VOICE_AUDIO_MAX_BYTES
} from "@/lib/polar/voice-call";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return refuse("view_as", 403);
    const limited = await rateLimit(`polar-transcribe:${user.id}`, 30, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);

    const query = transcribeQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams)
    );
    if (!query.success) return refuse("invalid", 400);
    if (!acceptedAudioType(request.headers.get("content-type"))) {
        return refuse("unsupported_type", 415);
    }
    const bytes = await readCappedBody(request, VOICE_AUDIO_MAX_BYTES);
    if (!bytes) return refuse("too_large", 413);
    if (bytes.byteLength === 0) return refuse("invalid", 400);

    const model = await polarTranscriber(user.id, query.data.payer);
    if (!model) return refuse("no_voice_provider", 409);
    try {
        const result = await transcribe({ model, audio: bytes, abortSignal: request.signal });
        return NextResponse.json({ text: result.text.trim() });
    } catch (error) {
        console.error("polar: transcription failed", error);
        return refuse("transcribe_failed", 502);
    }
}
