/**
 * What a new camera starts out believing about movement.
 *
 * Sensitivity is not a number anybody guesses right the first time, and it is
 * not the same number for a hallway and a garden facing a hedge. So it is set
 * once for the instance - by whoever has already tuned one camera and knows what
 * works here - and every camera added afterwards starts there. Each camera can
 * still disagree; this is only where it begins.
 *
 * Stored as one JSON setting rather than three, because they are read together
 * and are meaningless apart: sensitivity without the settle window is exactly
 * the setup that fills a log with moths.
 *
 * Server-only.
 */

import { getSetting, setSetting } from "@/lib/setting-store";
import { DEFAULT_DETECTION, type DetectionSettings } from "@/lib/home/detection";

export const DETECTION_DEFAULTS_KEY = "home.detection.defaults";

/** The three knobs a new camera inherits. The rest of a detection setting is
 *  about one camera - which classes, which hours - and has no useful instance
 *  answer. */
export interface DetectionDefaults {
    readonly sensitivity: number;
    readonly settleSeconds: number;
    readonly minGapSeconds: number;
}

export const FACTORY_DEFAULTS: DetectionDefaults = {
    sensitivity: DEFAULT_DETECTION.sensitivity,
    settleSeconds: DEFAULT_DETECTION.settleSeconds,
    minGapSeconds: DEFAULT_DETECTION.minGapSeconds
};

/** A number somebody typed, clamped rather than refused: a sensitivity of 400 is
 *  a slip, and the useful response is 100. */
function clamp(value: unknown, low: number, high: number, fallback: number): number {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(high, Math.max(low, parsed));
}

export async function detectionDefaults(): Promise<DetectionDefaults> {
    const raw = await getSetting(DETECTION_DEFAULTS_KEY);
    if (!raw) return FACTORY_DEFAULTS;
    try {
        const stored = JSON.parse(raw) as Partial<DetectionDefaults>;
        return {
            sensitivity: clamp(stored.sensitivity, 1, 100, FACTORY_DEFAULTS.sensitivity),
            settleSeconds: clamp(stored.settleSeconds, 0, 60, FACTORY_DEFAULTS.settleSeconds),
            minGapSeconds: clamp(stored.minGapSeconds, 1, 3600, FACTORY_DEFAULTS.minGapSeconds)
        };
    } catch {
        return FACTORY_DEFAULTS;
    }
}

export async function setDetectionDefaults(input: DetectionDefaults): Promise<void> {
    await setSetting(
        DETECTION_DEFAULTS_KEY,
        JSON.stringify({
            sensitivity: clamp(input.sensitivity, 1, 100, FACTORY_DEFAULTS.sensitivity),
            settleSeconds: clamp(input.settleSeconds, 0, 60, FACTORY_DEFAULTS.settleSeconds),
            minGapSeconds: clamp(input.minGapSeconds, 1, 3600, FACTORY_DEFAULTS.minGapSeconds)
        })
    );
}

/** The detection settings a brand-new camera is created with. */
export async function startingDetection(): Promise<DetectionSettings> {
    return { ...DEFAULT_DETECTION, ...(await detectionDefaults()) };
}
