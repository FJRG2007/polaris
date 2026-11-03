/**
 * Google Cloud Translation (Basic, v2), for the Translate app.
 *
 * Billed per character, so every request goes through `whileServing`, like
 * every other paid provider (`test/access/metered-gate.test.ts`).
 *
 * Requests as documented at
 * https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate and
 * https://docs.cloud.google.com/translate/docs/reference/rest/v2/detect: `q`
 * (up to 128 strings), `target`, optional `source`, and `format: "text"` so the
 * text is not read as HTML; answered with `data.translations[]` in order, each
 * `{ translatedText, detectedSourceLanguage }`, and `data.detections[][]` of
 * `{ language }`. The key travels in the `x-goog-api-key` header
 * (https://docs.cloud.google.com/docs/authentication/api-keys-use) rather than
 * the address, so it never lands in a log line.
 *
 * Server-only.
 */

import { z } from "zod";
import { billedChars, whileServing } from "@/lib/integrations/provider-pause";

const BASE = "https://translation.googleapis.com/language/translate/v2";
const TIMEOUT_MS = 20_000;

const translateSchema = z.object({
    data: z.object({
        translations: z.array(
            z.object({ translatedText: z.string(), detectedSourceLanguage: z.string().optional() })
        )
    })
});

const detectSchema = z.object({
    data: z.object({ detections: z.array(z.array(z.object({ language: z.string() }))) })
});

function failure(status: number): Error {
    return Object.assign(new Error(`Google Cloud Translation answered ${status}`), { status });
}

async function post(key: string, path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "x-goog-api-key": key.trim(), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw failure(response.status);
    return response.json();
}

export interface GoogleAnswer {
    texts: string[];
    /** The source language Google read, or null when one was given. */
    detected: string | null;
}

/** Translate `texts` into `target`, from `source` or from what Google detects. */
export async function googleTranslate(
    key: string,
    texts: readonly string[],
    target: string,
    source: string | null = null
): Promise<GoogleAnswer> {
    return whileServing(
        "google-translate",
        "Google Cloud Translation",
        async () => {
            const answer = await post(key, "", {
                q: texts,
                target,
                format: "text",
                ...(source ? { source } : {})
            });
            const parsed = translateSchema.safeParse(answer);
            if (!parsed.success || parsed.data.data.translations.length !== texts.length) {
                throw failure(502);
            }
            const translations = parsed.data.data.translations;
            return {
                texts: translations.map((entry) => entry.translatedText),
                detected: translations[0]?.detectedSourceLanguage ?? null
            };
        },
        billedChars(texts)
    );
}

/** The language `text` is written in, or null when Google cannot tell. */
export async function googleDetect(key: string, text: string): Promise<string | null> {
    return whileServing(
        "google-translate",
        "Google Cloud Translation",
        async () => {
            const parsed = detectSchema.safeParse(await post(key, "/detect", { q: [text] }));
            if (!parsed.success) throw failure(502);
            const language = parsed.data.data.detections[0]?.[0]?.language;
            return language && language !== "und" ? language : null;
        },
        billedChars([text])
    );
}
