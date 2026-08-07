"use client";

/**
 * A service's live state and consumption, as every screen that shows it reads it.
 *
 * One hook rather than a fetch per screen, and one cache key for all of them: the
 * badge on a service card and the Metrics tab behind it are the same reading, so
 * opening the service paints what the list already fetched, and going back paints
 * what the tab did. Neither has to start from a spinner.
 *
 * The cadence is the caller's, because the cost is not the same everywhere: this
 * endpoint inspects the container and takes a stats sample, and a list of services
 * asks it once per card.
 */

import { useLiveResource, type LiveResource } from "@/components/use-live-resource";

/** What /api/deploy/apps/[id]/metrics answers. Every field is absent for a service
 *  with no container, and null for one that is not running. */
export interface ServiceLiveMetrics {
    state?: string;
    health?: string | null;
    cpuPercent?: number | null;
    memPercent?: number | null;
    memUsedBytes?: number | null;
    memTotalBytes?: number | null;
}

/** A service's own page, where the figures are the point of the screen. */
export const SERVICE_METRICS_MS = 15_000;

/** The same reading on a card in a list, which asks for it once per service. */
export const SERVICE_LIST_METRICS_MS = 30_000;

export function useServiceMetrics(
    applicationId: string,
    intervalMs: number
): LiveResource<ServiceLiveMetrics> {
    return useLiveResource<ServiceLiveMetrics>({
        url: `/api/deploy/apps/${applicationId}/metrics`,
        cacheKey: `deploy.service-metrics.${applicationId}`,
        intervalMs,
        select: (body) => body as ServiceLiveMetrics
    });
}
