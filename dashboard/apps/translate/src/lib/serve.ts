/**
 * Translation on the server, for `/api/translate`: the owner's settings, the
 * engines that can answer this person, and one request to the one picked.
 *
 * The engines themselves are the host's (`translateEngines`): the paid ones go
 * through the paid-request gate there, and their keys never reach the app.
 *
 * Server-only.
 */

import { translateT } from "./i18n";
import { host } from "@polaris/app-host";
import { loadSettings } from "./settings";
import type { TranslateKey } from "../../messages";
import { ENGINE_LIMITS, translateInChunks } from "../model/chunk";
import { AUTO, normalizeDetected } from "../model/languages";
import { pickServerEngine, usableServerEngines } from "../model/engines";
import type {
    DetectInput,
    ServerEngineId,
    TranslateInput,
    TranslateSettings
} from "../model/schemas";

/** Why a request got no translation, as the route answers it. */
export type ServeFailure = "noEngine" | "unavailable" | "limit" | "paused" | "failed" | "overLimit";

const STATUS: Readonly<Record<ServeFailure, number>> = {
    noEngine: 409,
    unavailable: 409,
    limit: 429,
    paused: 503,
    failed: 502,
    overLimit: 413
};

const MESSAGE: Readonly<Record<ServeFailure, TranslateKey>> = {
    noEngine: "errors.noEngine",
    unavailable: "errors.engineUnavailable",
    limit: "errors.limit",
    paused: "errors.paused",
    failed: "errors.failed",
    overLimit: "errors.overLimit"
};

/** What a reader who is not an administrator is told instead: nothing to set up. */
const READER_MESSAGE: Readonly<Partial<Record<ServeFailure, TranslateKey>>> = {
    noEngine: "errors.noEngineReader",
    paused: "errors.pausedReader"
};

export interface ServerStatus {
    settings: TranslateSettings;
    /** The server engines the owner allows that can answer, in the order tried. */
    engines: ServerEngineId[];
}

export async function serverStatus(userId: string): Promise<ServerStatus> {
    const [settings, available] = await Promise.all([
        loadSettings(),
        host.translateEngines.serverEngineStatus(userId)
    ]);
    return { settings, engines: usableServerEngines(available, settings) };
}

/**
 * A failure as the route's JSON answer, in the reader's words. Only an
 * administrator is told what to set up; anybody else, that the administrators
 * look after it.
 */
export async function failureResponse(
    failure: ServeFailure,
    admin: boolean,
    values?: Record<string, string | number>
): Promise<Response> {
    const t = await translateT();
    const key = admin ? MESSAGE[failure] : (READER_MESSAGE[failure] ?? MESSAGE[failure]);
    return Response.json({ error: failure, message: t(key, values) }, { status: STATUS[failure] });
}

/** What an engine threw, as a failure code. Anything unexpected is logged. */
export function failureOf(caught: unknown): ServeFailure {
    if (caught instanceof Error && caught.name === "EngineRefusal") {
        const code = (caught as Error & { code?: string }).code;
        if (code === "unavailable" || code === "limit" || code === "paused") return code;
        return "failed";
    }
    console.error("polaris: a translation failed:", caught);
    return "failed";
}

export type Served<T> =
    | ({ ok: true; engine: ServerEngineId } & T)
    | { ok: false; failure: ServeFailure; limit?: number };

export async function translateOnServer(
    userId: string,
    input: TranslateInput
): Promise<Served<{ texts: string[]; detected: string | null }>> {
    const [settings, available] = await Promise.all([
        loadSettings(),
        host.translateEngines.serverEngineStatus(userId)
    ]);
    const total = input.texts.reduce((sum, text) => sum + text.length, 0);
    if (settings.charLimit !== null && total > settings.charLimit) {
        return { ok: false, failure: "overLimit", limit: settings.charLimit };
    }
    const engine = pickServerEngine(available, settings, input.engine);
    if (!engine) return { ok: false, failure: input.engine ? "unavailable" : "noEngine" };
    try {
        // Cut to what this engine takes at once; the reader sees one answer.
        const answer = await translateInChunks(input.texts, ENGINE_LIMITS[engine], (batch) =>
            host.translateEngines.serverTranslate(
                engine,
                userId,
                batch,
                input.from === AUTO ? null : input.from,
                input.to
            )
        );
        return {
            ok: true,
            engine,
            texts: answer.texts,
            detected: input.from === AUTO ? normalizeDetected(answer.detected) : null
        };
    } catch (caught) {
        return { ok: false, failure: failureOf(caught) };
    }
}

export async function detectOnServer(
    userId: string,
    input: DetectInput
): Promise<Served<{ language: string | null }>> {
    const { engines } = await serverStatus(userId);
    // Google has a detection call of its own; it goes first when it can answer.
    const engine = input.engine
        ? engines.includes(input.engine)
            ? input.engine
            : null
        : engines.includes("google")
          ? "google"
          : (engines[0] ?? null);
    if (!engine) return { ok: false, failure: input.engine ? "unavailable" : "noEngine" };
    try {
        const raw = await host.translateEngines.serverDetect(engine, userId, input.text);
        return { ok: true, engine, language: normalizeDetected(raw) };
    } catch (caught) {
        return { ok: false, failure: failureOf(caught) };
    }
}
