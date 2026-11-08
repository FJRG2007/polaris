/**
 * LibreTranslate, a translation server the administrator runs or picks, as one
 * of Translate's server engines. Off until an address is set on Translate's
 * settings; the optional API key is sealed with the master key and never
 * reaches a browser.
 *
 * The API (libretranslate.com/docs): `POST /translate` `{ q, source, target,
 * format, api_key }` answers `{ translatedText, detectedLanguage? }` - arrays
 * when `q` is one; `POST /detect` `{ q, api_key }` answers `[{ language,
 * confidence }]`; `GET /languages` answers `[{ code, name, targets }]`. Errors
 * are `{ error }` with 400 (bad language), 403 (bad or missing key, or banned)
 * and 429 (slow down).
 *
 * The address is one an administrator configured, so it is reached through the
 * host's configured-request fetch, private addresses included - a server on
 * the administrator's own network is the usual way to run one.
 *
 * Server-only.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";

const KEY = "translate.libretranslate";

/** Long enough for a large batch on a small server. */
const TIMEOUT_MS = 60_000;

/** The most of an answer read; a reply larger than this is not a translation. */
const ANSWER_MAX_BYTES = 4 * 1024 * 1024;

/** What is stored: the address and the sealed key, if any. */
const storedShape = z.object({
    url: z.string().url().nullable().catch(null),
    key: z.string().nullable().catch(null)
});

type Stored = z.infer<typeof storedShape>;

const NOTHING: Stored = { url: null, key: null };

export interface LibreTranslateConfig {
    readonly url: string | null;
    readonly hasKey: boolean;
}

/** An address as kept: trimmed, no trailing slash, http or https, no credentials. */
export function normalizeServerUrl(raw: string): string | null {
    const text = raw.trim().replace(/\/+$/, "");
    if (!text) return null;
    try {
        const url = new URL(text);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        if (url.username || url.password) return null;
        return url.toString().replace(/\/+$/, "");
    } catch {
        return null;
    }
}

export const libreTranslateInput = z
    .object({
        url: z
            .string()
            .max(2048)
            .transform((raw, ctx) => {
                if (!raw.trim()) return null;
                const url = normalizeServerUrl(raw);
                if (!url) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "url" });
                return url;
            }),
        /** Undefined keeps the stored key, null or empty removes it, a string replaces it. */
        key: z.string().trim().max(512).nullable().optional()
    })
    .strict();

export type LibreTranslateInput = z.infer<typeof libreTranslateInput>;

async function readStored(): Promise<Stored> {
    const raw = await host.settingStore.getSetting(KEY);
    try {
        const parsed = storedShape.safeParse(raw ? JSON.parse(raw) : {});
        return parsed.success ? parsed.data : NOTHING;
    } catch {
        return NOTHING;
    }
}

export async function loadLibreTranslate(): Promise<LibreTranslateConfig> {
    const stored = await readStored();
    return { url: stored.url, hasKey: stored.key !== null };
}

/** Whether LibreTranslate can answer: an address is set. Sends nothing. */
export async function libreTranslateReady(): Promise<boolean> {
    return (await readStored()).url !== null;
}

interface Target {
    readonly url: string;
    readonly key: string | null;
}

/** The address and the opened key, or null while it is off. */
async function connection(): Promise<Target | null> {
    const stored = await readStored();
    if (!stored.url) return null;
    const key = stored.key ? await host.translateEngines.openEngineKey(stored.key) : null;
    return { url: stored.url, key };
}

export type LibreFailure = "unavailable" | "paused" | "failed";

/**
 * Why the engine gave no answer. Named like the host's refusal, so the one
 * classification in `serve.ts` (`failureOf`) reads both.
 */
export class LibreTranslateRefusal extends Error {
    public readonly code: LibreFailure;

    public constructor(code: LibreFailure, detail?: string) {
        super(detail ? `translation engine ${code}: ${detail}` : `translation engine ${code}`);
        this.name = "EngineRefusal";
        this.code = code;
    }
}

export type ConfiguredRequest = (
    address: string,
    init: RequestInit & { timeoutMs?: number },
    options: { allowPrivate: boolean }
) => Promise<Response>;

const configured: ConfiguredRequest = (address, init, options) =>
    host.safeFetch.configuredRequest(address, init, options);

const errorShape = z.object({ error: z.string() }).partial();

async function call(
    path: string,
    body: Record<string, unknown> | null,
    request: ConfiguredRequest,
    given?: Target
): Promise<unknown> {
    const target = given ?? (await connection());
    if (!target) throw new LibreTranslateRefusal("unavailable");
    const sent = body && target.key ? { ...body, api_key: target.key } : body;
    let response: Response;
    try {
        response = await request(
            `${target.url}${path}`,
            sent
                ? {
                      method: "POST",
                      headers: { "content-type": "application/json", accept: "application/json" },
                      body: JSON.stringify(sent),
                      timeoutMs: TIMEOUT_MS
                  }
                : { method: "GET", headers: { accept: "application/json" }, timeoutMs: TIMEOUT_MS },
            { allowPrivate: true }
        );
    } catch (caught) {
        const detail = caught instanceof Error ? caught.message : undefined;
        throw new LibreTranslateRefusal("failed", detail);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > ANSWER_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new LibreTranslateRefusal("failed", "too large");
    }
    const text = await response.text().catch(() => "");
    let json: unknown = null;
    try {
        json = text.length <= ANSWER_MAX_BYTES ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    if (!response.ok) {
        const said = errorShape.safeParse(json);
        const reason = said.success && said.data.error ? ` ${said.data.error}` : "";
        // Asked to slow down: a pause, as a provider's rate limit is elsewhere.
        const code = response.status === 429 ? "paused" : "failed";
        throw new LibreTranslateRefusal(code, `status ${response.status}${reason}`);
    }
    return json;
}

const detectedShape = z.union([z.object({ language: z.string() }).passthrough(), z.string()]);

const translateAnswer = z.object({
    translatedText: z.union([z.string(), z.array(z.string())]),
    detectedLanguage: z.union([detectedShape, z.array(detectedShape)]).optional()
});

const detectAnswer = z.array(z.object({ language: z.string(), confidence: z.number() }));

export const languagesAnswer = z.array(
    z.object({ code: z.string(), name: z.string(), targets: z.array(z.string()).optional() })
);

function languageOf(detected: z.infer<typeof detectedShape> | undefined): string | null {
    if (detected === undefined) return null;
    return typeof detected === "string" ? detected : detected.language;
}

/** LibreTranslate's spelling of a language: `zh-Hant` is `zt`, any other region is dropped. */
export function libreCode(code: string): string {
    if (code === "zh-Hant") return "zt";
    return code.split("-")[0]!.toLowerCase();
}

export async function libreTranslate(
    texts: readonly string[],
    from: string | null,
    to: string,
    request: ConfiguredRequest = configured
): Promise<{ texts: string[]; detected: string | null }> {
    const raw = await call(
        "/translate",
        {
            q: [...texts],
            source: from ? libreCode(from) : "auto",
            target: libreCode(to),
            format: "text"
        },
        request
    );
    const parsed = translateAnswer.safeParse(raw);
    if (!parsed.success) throw new LibreTranslateRefusal("failed", "answer");
    const said = parsed.data.translatedText;
    const out = Array.isArray(said) ? said : [said];
    if (out.length !== texts.length) throw new LibreTranslateRefusal("failed", "answer count");
    const detected = parsed.data.detectedLanguage;
    return { texts: out, detected: languageOf(Array.isArray(detected) ? detected[0] : detected) };
}

export async function libreDetect(
    text: string,
    request: ConfiguredRequest = configured
): Promise<string | null> {
    const raw = await call("/detect", { q: text.slice(0, 1000) }, request);
    const parsed = detectAnswer.safeParse(raw);
    if (!parsed.success) throw new LibreTranslateRefusal("failed", "answer");
    const [top] = [...parsed.data].sort((a, b) => b.confidence - a.confidence);
    return top?.language ?? null;
}

/** The languages a server offers; also how a new address is checked before it is kept. */
export async function libreLanguages(
    target: Target,
    request: ConfiguredRequest = configured
): Promise<z.infer<typeof languagesAnswer>> {
    const parsed = languagesAnswer.safeParse(await call("/languages", null, request, target));
    if (!parsed.success) throw new LibreTranslateRefusal("failed", "answer");
    return parsed.data;
}

/**
 * Keeps a new address and key once the server answered `/languages` with
 * them. An empty address switches the engine off and forgets the key.
 */
export async function saveLibreTranslate(
    input: LibreTranslateInput,
    request: ConfiguredRequest = configured
): Promise<LibreTranslateConfig> {
    if (!input.url) {
        await host.settingStore.setSetting(KEY, JSON.stringify(NOTHING));
        return { url: null, hasKey: false };
    }
    const stored = await readStored();
    let key: string | null;
    if (input.key !== undefined) key = input.key || null;
    else key = stored.key ? await host.translateEngines.openEngineKey(stored.key) : null;
    await libreLanguages({ url: input.url, key }, request);
    const sealed = key ? await host.translateEngines.sealEngineKey(key) : null;
    await host.settingStore.setSetting(KEY, JSON.stringify({ url: input.url, key: sealed }));
    return { url: input.url, hasKey: sealed !== null };
}
