/**
 * Core Web Vitals as a visitor's browser measured them on a site Polaris counts.
 *
 * Field data, not a lab run: the tracker reads the browser's own performance
 * entries on the page it is loaded in (opt-in per site with `data-vitals`) and
 * sends them once, when the page is left. The ratings use Google's published
 * thresholds (https://web.dev/articles/vitals) and are judged on the 75th
 * percentile, which is how those thresholds are meant to be read.
 */

import { z } from "zod";

export const WEB_VITALS = ["lcp", "inp", "cls", "fcp", "ttfb"] as const;
export type WebVital = (typeof WEB_VITALS)[number];

/** [good, needs improvement] upper bounds; anything past the second is poor.
 *  Milliseconds for every metric but CLS, which is a unitless score. */
export const WEB_VITAL_THRESHOLDS: Readonly<Record<WebVital, readonly [number, number]>> = {
    lcp: [2500, 4000],
    inp: [200, 500],
    cls: [0.1, 0.25],
    fcp: [1800, 3000],
    ttfb: [800, 1800]
};

export type WebVitalBand = "good" | "improve" | "poor" | "unknown";

/** The rating of one value; a metric that was not measured is unknown, never good. */
export function webVitalBand(metric: WebVital, value: number | null | undefined): WebVitalBand {
    if (value === null || value === undefined || !Number.isFinite(value)) return "unknown";
    const [good, improve] = WEB_VITAL_THRESHOLDS[metric];
    if (value <= good) return "good";
    if (value <= improve) return "improve";
    return "poor";
}

/** A minute is far past any real timing; a value above it is a broken clock, not a slow page. */
const TIMING = z.number().finite().min(0).max(60_000);

/** What the tracker may send about one page. Every metric is optional - a
 *  browser that does not support one simply leaves it out - but at least one
 *  must be present for the beat to mean anything. */
export const webVitalsSchema = z
    .object({
        lcp: TIMING.optional(),
        inp: TIMING.optional(),
        cls: z.number().finite().min(0).max(100).optional(),
        fcp: TIMING.optional(),
        ttfb: TIMING.optional()
    })
    .strict()
    .refine((vitals) => WEB_VITALS.some((metric) => vitals[metric] !== undefined), {
        message: "No metric measured"
    });
export type WebVitalsInput = z.infer<typeof webVitalsSchema>;
