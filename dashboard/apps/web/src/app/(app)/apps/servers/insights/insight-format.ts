/**
 * How a server metric reads on screen. CPU, memory and disk are shares of the
 * machine; network is traffic per second in both directions together.
 */

import { formatBytes } from "@polaris/core";
import type { InsightMetric } from "@/lib/server-insights/insights";

export function formatMetric(metric: InsightMetric, value: number | null): string | null {
    if (value == null || !Number.isFinite(value)) return null;
    if (metric === "network") return `${formatBytes(Math.max(0, Math.round(value)))}/s`;
    return `${Math.round(value)}%`;
}
