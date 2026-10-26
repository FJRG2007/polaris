/**
 * Send a recording to `/api/polar/transcribe` and read the text back. Its own
 * module so a screen that only dictates (the chat composer) does not pull in
 * Polar's voice controls and their translations.
 */

import type { Payer } from "@/lib/polar/shared";
import { VOICE_MAX_SECONDS } from "@/lib/polar/voice-call";

/** Why a transcription did not come back, as a code the screen has words for. */
export type TranscribeError =
    "transcribe_failed" | "rate_limited" | "too_large" | "no_voice_provider" | "usage_limit";

const TRANSCRIBE_ERRORS: readonly TranscribeError[] = [
    "rate_limited",
    "too_large",
    "no_voice_provider",
    "usage_limit"
];

/** Send a recording to be read; the text, or why not. */
export async function transcribeAudio(
    audio: Blob,
    durationMs: number,
    payer: Payer | null = null,
    signal?: AbortSignal,
    /** The model picked in the mic menu; absent, the server's stored pick. */
    model?: string | null
): Promise<{ text: string } | { error: TranscribeError }> {
    const capped = Math.min(Math.max(0, Math.round(durationMs)), VOICE_MAX_SECONDS * 1000);
    const query = new URLSearchParams({ durationMs: String(capped) });
    if (payer) query.set("payer", payer);
    if (model) query.set("model", model);
    try {
        const response = await fetch(`/api/polar/transcribe?${query}`, {
            method: "POST",
            headers: { "Content-Type": audio.type || "audio/webm" },
            body: audio,
            signal
        });
        const data = (await response.json().catch(() => null)) as {
            text?: unknown;
            error?: unknown;
        } | null;
        if (response.ok && typeof data?.text === "string") return { text: data.text };
        const code = data?.error;
        return {
            error: TRANSCRIBE_ERRORS.find((known) => known === code) ?? "transcribe_failed"
        };
    } catch {
        return { error: "transcribe_failed" };
    }
}
