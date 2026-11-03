/**
 * One interface for every engine, and which one answers a request.
 *
 * The browser's own translator goes first when the owner allows it and the
 * reader's browser has it: it is free and the text never leaves the device.
 * Then the paid providers the owner added a key for, DeepL before Google, and
 * Polar's model last - it reads tone well but is the slowest and spends from
 * the same allowance as Polar's answers.
 */

import type { EngineId, ServerEngineId, TranslateSettings } from "./schemas";

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

/** Server engines in the order they are tried. */
export const SERVER_ORDER: readonly ServerEngineId[] = ["deepl", "google", "polar"];

export type ServerAvailability = Readonly<Record<ServerEngineId, boolean>>;

/** The server engines the owner allows and that can answer, in order. */
export function usableServerEngines(
    available: ServerAvailability,
    settings: TranslateSettings
): ServerEngineId[] {
    return SERVER_ORDER.filter((id) => available[id] && settings.engines[id]);
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

/** What the screen can choose from, the browser first when it is there. */
export function usableEngines(input: {
    browser: boolean;
    available: ServerAvailability;
    settings: TranslateSettings;
}): EngineId[] {
    const server = usableServerEngines(input.available, input.settings);
    return input.browser && input.settings.engines.browser ? ["browser", ...server] : server;
}

/**
 * The engine the screen asks: the reader's pick when it is still usable,
 * otherwise the first usable one, or null when nothing is.
 */
export function pickEngine(usable: readonly EngineId[], chosen: EngineId | null): EngineId | null {
    if (chosen && usable.includes(chosen)) return chosen;
    return usable[0] ?? null;
}
