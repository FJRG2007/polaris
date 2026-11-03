/**
 * DeepL's text translation, for the Translate app.
 *
 * Billed per character, so every request goes through `whileServing`: a refused
 * key or an account out of characters pauses DeepL for everybody instead of
 * being asked again on every keystroke. `test/access/metered-gate.test.ts`
 * fails on a request that goes around it.
 *
 * Request and answer as documented at
 * https://developers.deepl.com/api-reference/translate - POST /v2/translate with
 * `Authorization: DeepL-Auth-Key <key>`, a JSON body of `text[]`, `target_lang`
 * and an optional `source_lang`, answered with `translations[]` in the same
 * order, each `{ detected_source_language, text }`. A Free key ends in `:fx` and
 * is served from api-free.deepl.com
 * (https://developers.deepl.com/docs/getting-started/auth).
 *
 * Server-only.
 */

import { z } from "zod";
import { billedChars, whileServing } from "@/lib/integrations/provider-pause";

/** The whole request may be 128 KiB; texts are capped well under it upstream. */
const TIMEOUT_MS = 20_000;

/** HTTP 456 is DeepL's "quota exceeded": the same as out of credits here. */
const QUOTA_EXCEEDED = 456;

const answerSchema = z.object({
    translations: z.array(
        z.object({ detected_source_language: z.string().optional(), text: z.string() })
    )
});

/** Where a key is served from: Free keys carry the `:fx` suffix. */
export function deeplEndpoint(key: string): string {
    return key.trim().endsWith(":fx")
        ? "https://api-free.deepl.com/v2/translate"
        : "https://api.deepl.com/v2/translate";
}

/** A failure carrying its status, so the gate can tell a bad key from an outage. */
function failure(status: number): Error {
    return Object.assign(new Error(`DeepL answered ${status}`), {
        status: status === QUOTA_EXCEEDED ? 402 : status
    });
}

export interface DeeplAnswer {
    texts: string[];
    /** The source language DeepL read, lower case (`en`), or null. */
    detected: string | null;
}

/**
 * Translate `texts` into `target` (DeepL's code, `EN-US`), from `source` or from
 * whatever DeepL detects when it is null. One request for every text.
 */
export async function deeplTranslate(
    key: string,
    texts: readonly string[],
    target: string,
    source: string | null = null
): Promise<DeeplAnswer> {
    return whileServing(
        "deepl",
        "DeepL",
        async () => {
            const response = await fetch(deeplEndpoint(key), {
                method: "POST",
                headers: {
                    authorization: `DeepL-Auth-Key ${key.trim()}`,
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    text: texts,
                    target_lang: target,
                    ...(source ? { source_lang: source } : {})
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            if (!response.ok) throw failure(response.status);
            const parsed = answerSchema.safeParse(await response.json());
            if (!parsed.success || parsed.data.translations.length !== texts.length) {
                throw failure(502);
            }
            const first = parsed.data.translations[0]?.detected_source_language;
            return {
                texts: parsed.data.translations.map((entry) => entry.text),
                detected: first ? first.toLowerCase() : null
            };
        },
        billedChars(texts)
    );
}
