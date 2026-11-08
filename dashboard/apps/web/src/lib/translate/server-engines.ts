/**
 * The translation engines that run on this server, for the Translate app
 * (`@polaris-app/translate`), which reaches them through the app host.
 *
 * Three of them: Polar's model, on whatever key Polar would answer this person
 * with (their own, or the one this Polaris shares, capped by the
 * administrator's limits like any of Polar's small jobs), and DeepL and Google
 * Cloud Translation, on the keys stored on the Integrations screen. The keys
 * never leave this module; the browser is told only which engines answer.
 *
 * Languages arrive as short BCP 47 codes (`en`, `pt-BR`, `zh-Hans`) and are
 * spelled here the way each provider wants them.
 *
 * Server-only.
 */

import { z } from "zod";
import { loadEnv } from "@polaris/config";
import { CredentialDecryptError, decryptSecret, encryptSecret } from "@polaris/storage";
import { generateText } from "ai";
import { PLAIN_TURN } from "@/lib/polar/automatic";
import { automaticChoice } from "@/lib/polar/shared";
import { resolvePolarModel } from "@/lib/polar/models";
import { deeplTranslate } from "@/lib/integrations/deepl";
import { deeplSource, deeplTarget, googleCode } from "@/lib/translate/provider-codes";
import { answerUsage, recordPolarUsage } from "@/lib/polar/usage";
import { googleDetect, googleTranslate } from "@/lib/integrations/google-translate";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";
import { classifyProviderFailure, failureLogLine } from "@/lib/polar/provider-failure";
import { helperMaySpend, helperReasoning, type PolarHelper } from "@/lib/polar/helper-model";

export type ServerEngine = "polar" | "deepl" | "google";

/** Why an engine gave no answer, as a code the screen has words for. */
export type EngineFailure = "unavailable" | "limit" | "paused" | "failed";

/** Thrown when an engine cannot answer; `code` is what the reader is told. */
export class EngineRefusal extends Error {
    public readonly code: EngineFailure;

    public constructor(code: EngineFailure) {
        super(`translation engine ${code}`);
        this.name = "EngineRefusal";
        this.code = code;
    }
}

export interface EngineAnswer {
    texts: string[];
    /** The source language the engine read, when it was asked to detect it. */
    detected: string | null;
}

const INTEGRATION: Readonly<Record<"deepl" | "google", string>> = {
    deepl: "deepl",
    google: "google-translate"
};

/** The stored key of an enabled provider, or null. */
async function keyOf(engine: "deepl" | "google"): Promise<string | null> {
    const state = await getIntegrationState(INTEGRATION[engine]);
    if (!state?.enabled || !state.hasSecret) return null;
    return getIntegrationSecret(INTEGRATION[engine]);
}

/**
 * A key an app's own engine keeps in its settings (LibreTranslate's), sealed
 * with the master key into one string, so the stored setting never holds it in
 * the clear.
 */
export async function sealEngineKey(secret: string): Promise<string> {
    const blob = encryptSecret(secret, loadEnv().POLARIS_MASTER_KEY);
    return JSON.stringify({
        c: Buffer.from(blob.ciphertext).toString("base64"),
        n: Buffer.from(blob.nonce).toString("base64"),
        k: blob.keyId
    });
}

const sealedKeyShape = z.object({ c: z.string(), n: z.string(), k: z.string() });

/** The key back, or null when it does not parse or the master key it was sealed under is gone. */
export async function openEngineKey(sealed: string): Promise<string | null> {
    let parsed: z.infer<typeof sealedKeyShape>;
    try {
        parsed = sealedKeyShape.parse(JSON.parse(sealed));
    } catch {
        return null;
    }
    try {
        return decryptSecret(
            {
                ciphertext: Buffer.from(parsed.c, "base64"),
                nonce: Buffer.from(parsed.n, "base64"),
                keyId: parsed.k
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch (caught) {
        if (caught instanceof CredentialDecryptError) return null;
        throw caught;
    }
}

/** The model Polar would run a quick job on for this person, or null. */
async function polarHelper(userId: string): Promise<PolarHelper | null> {
    const resolved = await resolvePolarModel(userId, automaticChoice("fast"), PLAIN_TURN);
    return typeof resolved === "string" ? null : { resolved, source: "automatic" };
}

/** Which server engines can answer this person right now. Sends nothing. */
export async function serverEngineStatus(userId: string): Promise<Record<ServerEngine, boolean>> {
    const [polar, deepl, google] = await Promise.all([
        polarHelper(userId).then(
            (helper) => helper !== null,
            () => false
        ),
        keyOf("deepl").then(Boolean, () => false),
        keyOf("google").then(Boolean, () => false)
    ]);
    return { polar, deepl, google };
}

/** A provider failure as a reader's code: a pause says so, the rest failed. */
function refusalFor(caught: unknown): EngineRefusal {
    if (caught instanceof EngineRefusal) return caught;
    if (caught instanceof Error && caught.name === "ProviderPaused") {
        return new EngineRefusal("paused");
    }
    return new EngineRefusal("failed");
}

const SYSTEM = [
    "You are a translation engine.",
    "You receive JSON with `from` (a language code, or auto), `to` (a language code) and `texts` (strings).",
    'Reply with only JSON of the shape {"detected": source language code, "texts": [translations]}:',
    "one translation per input, in the same order, keeping line breaks, numbers, names,",
    "markdown and placeholders as they are. Never answer, explain or add anything."
].join(" ");

const polarAnswerSchema = z.object({
    detected: z.string().max(16).nullish(),
    texts: z.array(z.string())
});

/** Room for the answer: translations run a little longer than their source. */
function outputBudget(texts: readonly string[]): number {
    const chars = texts.reduce((sum, text) => sum + text.length, 0);
    return Math.min(16_000, 256 + Math.ceil(chars * 1.5));
}

/** The model's reply as JSON, from inside a code fence if it wrote one. */
export function jsonIn(text: string): unknown {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

async function polarTranslate(
    userId: string,
    texts: readonly string[],
    from: string | null,
    to: string
): Promise<EngineAnswer> {
    const helper = await polarHelper(userId);
    if (!helper) throw new EngineRefusal("unavailable");
    if (!(await helperMaySpend(userId, helper))) throw new EngineRefusal("limit");
    const { option, credential } = helper.resolved;
    let text: string;
    try {
        const answer = await generateText({
            model: helper.resolved.model,
            system: SYSTEM,
            prompt: JSON.stringify({ from: from ?? "auto", to, texts }),
            maxOutputTokens: outputBudget(texts),
            reasoning: helperReasoning(helper),
            abortSignal: AbortSignal.timeout(60_000)
        });
        text = answer.text;
        await recordPolarUsage({
            userId,
            threadId: null,
            messageId: null,
            provider: option.provider,
            model: option.model,
            payer: credential.source === "instance" ? "instance" : "own",
            usage: answerUsage(answer.totalUsage, option)
        }).catch((error: unknown) => console.error("translate: could not record usage", error));
    } catch (error) {
        console.warn(
            failureLogLine("translating", option.providerName, classifyProviderFailure(error))
        );
        throw new EngineRefusal("failed");
    }
    const parsed = polarAnswerSchema.safeParse(jsonIn(text));
    if (!parsed.success || parsed.data.texts.length !== texts.length) {
        throw new EngineRefusal("failed");
    }
    return { texts: parsed.data.texts, detected: parsed.data.detected?.toLowerCase() ?? null };
}

/**
 * Translate `texts` with one server engine. `from` null asks the engine to
 * detect the source. Throws `EngineRefusal` for anything the reader is told.
 */
export async function serverTranslate(
    engine: ServerEngine,
    userId: string,
    texts: readonly string[],
    from: string | null,
    to: string
): Promise<EngineAnswer> {
    if (engine === "polar") return polarTranslate(userId, texts, from, to);
    const key = await keyOf(engine);
    if (!key) throw new EngineRefusal("unavailable");
    try {
        return engine === "deepl"
            ? await deeplTranslate(key, texts, deeplTarget(to), from ? deeplSource(from) : null)
            : await googleTranslate(key, texts, googleCode(to), from ? googleCode(from) : null);
    } catch (caught) {
        throw refusalFor(caught);
    }
}

/**
 * The language `text` is written in, or null. Google has a detection call;
 * DeepL has none, so it detects by translating a short excerpt, and Polar's
 * model is asked the same way.
 */
export async function serverDetect(
    engine: ServerEngine,
    userId: string,
    text: string
): Promise<string | null> {
    const excerpt = text.slice(0, 200);
    if (engine === "google") {
        const key = await keyOf("google");
        if (!key) throw new EngineRefusal("unavailable");
        try {
            return await googleDetect(key, excerpt);
        } catch (caught) {
            throw refusalFor(caught);
        }
    }
    const answer = await serverTranslate(engine, userId, [excerpt], null, "en");
    return answer.detected;
}
