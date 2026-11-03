/**
 * `/api/translate/transcribe?durationMs=<n>`: what was said in a recording,
 * for the screen to translate - an audio file, or what the microphone heard
 * where the browser cannot transcribe it itself. POST the recording (WebM,
 * Ogg, WAV, MP3 or MP4 audio, read from its bytes) and get `{ text }`.
 *
 * Transcribed by the model Polar dictates with, on Polar's keys and limits.
 * Signed in, rate limited per person, size capped; never stored.
 */

import { z } from "zod";
import { translateT } from "../../../../lib/i18n";
import { transcribeAudio } from "../../../../lib/media";
import { bytes, caller } from "../../../../lib/route";
import { failureResponse } from "../../../../lib/serve";
import { AUDIO_MAX_BYTES, AUDIO_MAX_SECONDS, sniffAudio } from "../../../../model/media";

const query = z
    .object({
        durationMs: z.coerce
            .number()
            .int()
            .min(0)
            .max(AUDIO_MAX_SECONDS * 1000)
    })
    .strict();

export async function POST(request: Request): Promise<Response> {
    const user = await caller();
    if (user instanceof Response) return user;
    const t = await translateT();
    const asked = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!asked.success) {
        return Response.json(
            { error: "invalid", message: t("errors.audioTooLong") },
            { status: 400 }
        );
    }
    const body = await bytes(request, AUDIO_MAX_BYTES);
    if (body instanceof Response) return body;
    if (!sniffAudio(body)) {
        return Response.json(
            { error: "unsupported", message: t("errors.audioType") },
            { status: 415 }
        );
    }
    const heard = await transcribeAudio(user.id, body, asked.data.durationMs);
    if (!heard.ok) return failureResponse(heard.failure, user.isAdmin);
    return Response.json({ text: heard.text });
}
