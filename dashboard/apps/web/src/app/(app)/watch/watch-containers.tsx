"use client";

/**
 * The container cards, fetched after the screen has painted.
 *
 * Unlike a server or a service, a container has no stored history to read from -
 * its figures only exist by asking every reachable daemon for a listing and then a
 * stats sample per container, which takes seconds, not milliseconds. Rendering
 * that on the server meant the whole of Watch waited on Docker, including the two
 * screens that never show a container. Here the section is on screen immediately
 * and the cards drop in, a revisit paints the previous answer from the session
 * cache while the fresh one is on its way, and the list keeps itself current.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { RefreshCw } from "lucide-react";
import type { WatchCard } from "@/lib/watch-overview-service";
import { sortByConsumption } from "@/lib/watch/card-order";
import { useLiveResource } from "@/components/use-live-resource";
import { WatchCardGrid, WatchCardGridSkeleton, WatchCardList } from "./watch-cards";

/** How often the list re-reads. Slower than the collector's own cadence would
 *  suggest, because every pass costs a stats read per container on every machine
 *  and a container list barely changes between them. */
const POLL_MS = 60_000;

const EMPTY = "No containers on any reachable server.";

function useContainers() {
    return useLiveResource<WatchCard[]>({
        url: "/api/watch/containers",
        cacheKey: "watch.containers",
        intervalMs: POLL_MS,
        select: (body) => {
            const containers = (body as { containers?: unknown }).containers;
            return Array.isArray(containers) ? (containers as WatchCard[]) : [];
        }
    });
}

/** The Containers screen: every container, with a control to ask again now. */
export function WatchContainersView() {
    const { data, loading, error, stale, refreshing, refresh } = useContainers();

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                    {stale ?? (data ? `${data.length} container${data.length === 1 ? "" : "s"}` : "")}
                </p>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={refresh}
                    disabled={refreshing}
                    aria-label="Refresh"
                    title="Refresh"
                >
                    <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
                </Button>
            </div>
            {loading ? (
                <WatchCardGridSkeleton count={6} />
            ) : (
                <WatchCardList cards={data ?? []} label="containers" empty={error ?? EMPTY} />
            )}
        </div>
    );
}

/** The overview's Containers group: the first few, and the count in its heading. */
export function WatchContainersSection({ limit }: { limit: number }) {
    const { data, loading, error } = useContainers();
    const count = data?.length ?? 0;

    return (
        <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">
                    Containers {data ? <span className="text-muted-foreground">({count})</span> : null}
                </h2>
                <Link href="/watch/containers" className="text-xs text-primary hover:underline">
                    {count > limit ? `View all ${count}` : "View all"}
                </Link>
            </div>
            {loading ? (
                <WatchCardGridSkeleton count={3} />
            ) : (
                <WatchCardGrid cards={sortByConsumption(data ?? [], "cpu").slice(0, limit)} empty={error ?? EMPTY} />
            )}
        </section>
    );
}
