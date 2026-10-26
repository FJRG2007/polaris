/**
 * GET /api/polar/transcribe - whether this person can be heard at all:
 * `{ available }`, which the chat composer asks before offering private
 * dictation. A person Polar is closed to is answered `false`, not refused, so
 * the composer has one shape to read.
 *
 * POST /api/polar/transcribe?durationMs=<n> - what somebody said to Polar, as
 * text: dictation into the composer, and each turn of a voice call. The body is
 * the recording; its Content-Type says what it is. Answers `{ text }`.
 *
 * The model is the one picked in the mic menu (`model`, else the stored pick),
 * or the fastest one a key is held for. On the key this Polaris shares, the
 * administrator's ceilings apply as they do to a chat answer, and every
 * transcription is recorded in `PolarUsage` with its length in seconds.
 *
 * The recording is held in memory only for the call to the provider and never
 * stored.
 */

import { NextResponse } from "next/server";
import { experimental_transcribe as transcribe } from "ai";
import { polarCaller } from "@/lib/polar/access";
import { polarTranscriber, polarVoiceAvailability } from "@/lib/polar/voice";
import { polarLimitReached, recordPolarUsage } from "@/lib/polar/usage";
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

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) {
        return user.status === 403 ? NextResponse.json({ available: false }) : user;
    }
    if (user.viewingAs) return NextResponse.json({ available: false });
    const limited = await rateLimit(`polar-transcribe-check:${user.id}`, 60, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);
    const voice = await polarVoiceAvailability(user.id);
    return NextResponse.json(
        { available: voice.dictation },
        { headers: { "Cache-Control": "private, max-age=60" } }
    );
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
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

    const transcriber = await polarTranscriber(user.id, query.data.payer, query.data.model);
    if (!transcriber) return refuse("no_voice_provider", 409);
    if (transcriber.source === "instance" && (await polarLimitReached(user.id))) {
        return refuse("usage_limit", 429);
    }
    try {
        const result = await transcribe({
            model: transcriber.model,
            audio: bytes,
            abortSignal: request.signal
        });
        // The provider's own length when it reports one, the browser's otherwise.
        const seconds =
            typeof result.durationInSeconds === "number" &&
            Number.isFinite(result.durationInSeconds)
                ? result.durationInSeconds
                : query.data.durationMs / 1000;
        await recordPolarUsage({
            userId: user.id,
            threadId: null,
            messageId: null,
            provider: transcriber.option.provider,
            model: transcriber.option.model,
            payer: transcriber.source,
            usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
            audioSeconds: Math.ceil(seconds)
        }).catch((error) => console.error("polar: could not record a transcription", error));
        return NextResponse.json({ text: result.text.trim() });
    } catch (error) {
        console.error("polar: transcription failed", error);
        return refuse("transcribe_failed", 502);
    }
}
