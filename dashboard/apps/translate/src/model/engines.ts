/**
 * One interface for every engine, and which one answers a request.
 *
 * Engines are tried in the order the administrator set (`settings.order`,
 * by default the browser's translator, the local one, DeepL, Google, then
 * Polar's model), skipping any that is switched off, has no key, or - for the
 * two that run on the device - that the reader's browser cannot run.
 */

import {
    SERVER_ENGINE_IDS,
    type EngineId,
    type ServerEngineId,
    type TranslateSettings
} from "./schemas";

export interface EngineResult {
    texts: string[];
    /** The source language the engine read, when it was asked to detect it. */
    detected: string | null;
}

/** What every engine does, wherever it runs. `from` null means "detect it". */
export interface TranslateEngine {
    readonly id: EngineId;
    translate(
        texts: readonly string[],
        from: string | null,
        to: string,
        signal?: AbortSignal
    ): Promise<EngineResult>;
    detect(text: string, signal?: AbortSignal): Promise<string | null>;
}

function isServerEngine(id: EngineId): id is ServerEngineId {
    return (SERVER_ENGINE_IDS as readonly string[]).includes(id);
}

export type ServerAvailability = Readonly<Record<ServerEngineId, boolean>>;

/** The server engines the owner allows and that can answer, in order. */
export function usableServerEngines(
    available: ServerAvailability,
    settings: TranslateSettings
): ServerEngineId[] {
    return settings.order
        .filter(isServerEngine)
        .filter((id) => available[id] && settings.engines[id]);
}

/**
 * The server engine for a request: the one asked for when it is usable, or
 * null when it is not (a request that names an engine never gets another),
 * else the first usable one in order.
 */
export function pickServerEngine(
    available: ServerAvailability,
    settings: TranslateSettings,
    asked?: ServerEngineId
): ServerEngineId | null {
    const usable = usableServerEngines(available, settings);
    if (asked) return usable.includes(asked) ? asked : null;
    return usable[0] ?? null;
}

/** What the screen can choose from, in the administrator's order. */
export function usableEngines(input: {
    browser: boolean;
    /** Whether this browser can run the local engine (WebAssembly in a worker). */
    local: boolean;
    available: ServerAvailability;
    settings: TranslateSettings;
}): EngineId[] {
    const server = usableServerEngines(input.available, input.settings);
    const device: Partial<Record<EngineId, boolean>> = {
        browser: input.browser && input.settings.engines.browser,
        local: input.local && input.settings.engines.local
    };
    return input.settings.order.filter((id) => device[id] ?? server.includes(id as ServerEngineId));
}

/**
 * The engine the screen asks: the reader's pick when it is still usable,
 * otherwise the first usable one, or null when nothing is.
 */
export function pickEngine(usable: readonly EngineId[], chosen: EngineId | null): EngineId | null {
    if (chosen && usable.includes(chosen)) return chosen;
    return usable[0] ?? null;
}
