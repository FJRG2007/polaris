/**
 * The server engines as the screen reaches them: `/api/translate`, naming the
 * engine so the answer comes from the one the reader sees chosen.
 */

import { AUTO } from "../model/languages";
import type { EngineId, ServerEngineId } from "../model/schemas";
import type { EngineResult, TranslateEngine } from "../model/engines";

export const TRANSLATE_API = "/api/translate";

export interface ServerStatusView {
    engines: ServerEngineId[];
    browser: boolean;
    defaultTarget: string;
    /** The administrator's order; missing from a status cached before it existed. */
    order?: EngineId[];
    /** The most characters one translation may have; null or missing is no limit. */
    charLimit?: number | null;
    /** Whether pictures and recordings can be read here; missing from an older cache. */
    reads?: { images: boolean; audio: boolean };
}

/** An answer the server refused, carrying the sentence it gave. */
export class ServerEngineError extends Error {
    public readonly code: string;

    public constructor(code: string, message: string) {
        super(message);
        this.name = "ServerEngineError";
        this.code = code;
    }
}

async function post<T>(
    path: string,
    body: unknown,
    fallback: string,
    signal?: AbortSignal
): Promise<T> {
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal
    });
    const answer = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
    } & T;
    if (!response.ok)
        throw new ServerEngineError(answer.error ?? "failed", answer.message ?? fallback);
    return answer;
}

export async function fetchServerStatus(signal?: AbortSignal): Promise<ServerStatusView> {
    const response = await fetch(TRANSLATE_API, { signal });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as ServerStatusView;
}

/** One server engine behind the shared interface. `fallback` is said when the server says nothing. */
export function createServerEngine(id: ServerEngineId, fallback: string): TranslateEngine {
    return {
        id,
        async translate(texts, from, to, signal): Promise<EngineResult> {
            const answer = await post<{ texts: string[]; detected: string | null }>(
                TRANSLATE_API,
                { texts, from: from ?? AUTO, to, engine: id },
                fallback,
                signal
            );
            return { texts: answer.texts, detected: answer.detected };
        },
        async detect(text, signal) {
            const answer = await post<{ language: string | null }>(
                `${TRANSLATE_API}/detect`,
                { text, engine: id },
                fallback,
                signal
            );
            return answer.language;
        }
    };
}

/** A file posted as it is to one of the reading routes; the answer, or the sentence refusing it. */
export async function postFile<T>(
    path: string,
    file: Blob,
    fallback: string,
    signal?: AbortSignal
): Promise<T> {
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
        signal
    });
    const answer = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
    } & T;
    if (!response.ok)
        throw new ServerEngineError(answer.error ?? "failed", answer.message ?? fallback);
    return answer;
}
