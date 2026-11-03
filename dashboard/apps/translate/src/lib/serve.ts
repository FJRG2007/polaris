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
import { AUTO, normalizeDetected } from "../model/languages";
import { pickServerEngine, usableServerEngines } from "../model/engines";
import type {
    DetectInput,
    ServerEngineId,
    TranslateInput,
    TranslateSettings
} from "../model/schemas";

/** Why a request got no translation, as the route answers it. */
export type ServeFailure = "noEngine" | "unavailable" | "limit" | "paused" | "failed";

const STATUS: Readonly<Record<ServeFailure, number>> = {
    noEngine: 409,
    unavailable: 409,
    limit: 429,
    paused: 503,
    failed: 502
};

const MESSAGE: Readonly<Record<ServeFailure, TranslateKey>> = {
    noEngine: "errors.noEngine",
    unavailable: "errors.engineUnavailable",
    limit: "errors.limit",
    paused: "errors.paused",
    failed: "errors.failed"
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
export async function failureResponse(failure: ServeFailure, admin: boolean): Promise<Response> {
    const t = await translateT();
    const key = admin ? MESSAGE[failure] : (READER_MESSAGE[failure] ?? MESSAGE[failure]);
    return Response.json({ error: failure, message: t(key) }, { status: STATUS[failure] });
}

/** What an engine threw, as a failure code. Anything unexpected is logged. */
function failureOf(caught: unknown): ServeFailure {
    if (caught instanceof Error && caught.name === "EngineRefusal") {
        const code = (caught as Error & { code?: string }).code;
        if (code === "unavailable" || code === "limit" || code === "paused") return code;
        return "failed";
    }
    console.error("polaris: a translation failed:", caught);
    return "failed";
}

async function engineFor(userId: string, asked?: ServerEngineId): Promise<ServerEngineId | null> {
    const [settings, available] = await Promise.all([
        loadSettings(),
        host.translateEngines.serverEngineStatus(userId)
    ]);
    return pickServerEngine(available, settings, asked);
}

export type Served<T> =
    ({ ok: true; engine: ServerEngineId } & T) | { ok: false; failure: ServeFailure };

export async function translateOnServer(
    userId: string,
    input: TranslateInput
): Promise<Served<{ texts: string[]; detected: string | null }>> {
    const engine = await engineFor(userId, input.engine);
    if (!engine) return { ok: false, failure: input.engine ? "unavailable" : "noEngine" };
    try {
        const answer = await host.translateEngines.serverTranslate(
            engine,
            userId,
            input.texts,
            input.from === AUTO ? null : input.from,
            input.to
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
