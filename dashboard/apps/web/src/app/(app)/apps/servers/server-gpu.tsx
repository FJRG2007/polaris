"use client";

/**
 * A server's NVIDIA cards: each card as it is now, the containers holding
 * memory on them, and the cards together over time.
 *
 * Read from what the metrics collector last took of the machine, never probed
 * from here, so a page open on a server that is off answers at once. A machine
 * without a card says so in one line and draws nothing else; it is most of them.
 */

import { Box } from "lucide-react";
import { Skeleton } from "@polaris/ui";
import { formatBytes } from "@polaris/core";
import type { GpuReading } from "@/lib/gpu/nvidia";
import type { MachineGpuView } from "@/lib/gpu/gpu-view";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { GPU_METRICS, MetricsHistory } from "@/components/metrics-history";

/** The collector's own cadence: polling faster only reads the same figures. */
const REFRESH_MS = 30_000;

export function ServerGpu({ metricsId }: { metricsId: string }) {
    const t = useTranslations("servers");
    const base = `/api/watch/hosts/${encodeURIComponent(metricsId)}`;
    const { data, error } = useLiveResource<MachineGpuView>({
        url: `${base}/gpu`,
        cacheKey: `servers.gpu.${metricsId}`,
        intervalMs: REFRESH_MS,
        select: (body) => body as MachineGpuView
    });

    return (
        <section className="flex flex-col gap-2" aria-label={t("gpu.heading")}>
            <h2 className="text-sm font-medium">{t("gpu.heading")}</h2>
            <GpuBody view={data} error={Boolean(error) && !data} t={t} />
            {data && data.gpus.length > 0 ? (
                <>
                    <h3 className="mt-2 text-xs font-medium text-muted-foreground">{t("gpu.history")}</h3>
                    <MetricsHistory
                        endpoint={`${base}/metrics/history`}
                        live={`${base}/metrics/stream`}
                        metrics={GPU_METRICS}
                    />
                    <p className="text-xs text-muted-foreground">{t("gpu.hint")}</p>
                </>
            ) : null}
        </section>
    );
}

/** The cards and their containers, without the history. Exported for tests. */
export function GpuBody({
    view,
    error,
    t
}: {
    view: MachineGpuView | null | undefined;
    error: boolean;
    t: NamespaceTranslator<"servers">;
}) {
    if (!view) {
        return error ? (
            <p className="text-xs text-muted-foreground">{t("gpu.unread")}</p>
        ) : (
            // One card's worth: the region waiting on the reading, nothing more.
            <Skeleton className="h-20 w-full" />
        );
    }
    if (view.gpus.length === 0) return <p className="text-xs text-muted-foreground">{t("gpu.none")}</p>;
    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {view.gpus.map((gpu) => (
                    <GpuCard key={gpu.uuid} gpu={gpu} t={t} />
                ))}
            </div>
            <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t("gpu.containers")}</span>
                {view.containers.length === 0 ? (
                    <span className="text-xs text-muted-foreground">{t("gpu.noContainers")}</span>
                ) : (
                    view.containers.map((row) => (
                        <div key={row.name} className="flex min-w-0 items-center gap-2 text-xs">
                            <Box className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate" title={row.name}>
                                {row.name}
                            </span>
                            <span className="shrink-0 text-muted-foreground">
                                {t("gpu.onCards", { list: row.gpuIndexes.join(", ") })}
                            </span>
                            <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                                {formatBytes(row.memoryUsedBytes)}
                            </span>
                        </div>
                    ))
                )}
                {view.moreContainers > 0 ? (
                    <span className="text-xs text-muted-foreground">
                        {t("gpu.more", { count: view.moreContainers })}
                    </span>
                ) : null}
            </div>
        </div>
    );
}

function GpuCard({ gpu, t }: { gpu: GpuReading; t: NamespaceTranslator<"servers"> }) {
    const missing = t("gpu.notMeasured");
    const memory =
        gpu.memoryUsedBytes !== null && gpu.memoryTotalBytes !== null
            ? t("gpu.of", { used: formatBytes(gpu.memoryUsedBytes), total: formatBytes(gpu.memoryTotalBytes) })
            : gpu.memoryUsedBytes !== null
              ? formatBytes(gpu.memoryUsedBytes)
              : missing;
    const memoryShare =
        gpu.memoryUsedBytes !== null && gpu.memoryTotalBytes
            ? gpu.memoryUsedBytes / gpu.memoryTotalBytes
            : null;
    return (
        <div className="flex min-w-0 flex-col gap-2 rounded-md bg-muted/40 px-3 py-2">
            <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-xs font-medium">{t("gpu.card", { index: gpu.index })}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground" title={gpu.name}>
                    {gpu.name}
                </span>
            </div>
            <Bar
                label={t("gpu.use")}
                share={gpu.utilizationPercent === null ? null : gpu.utilizationPercent / 100}
                caption={gpu.utilizationPercent === null ? missing : `${Math.round(gpu.utilizationPercent)}%`}
            />
            <Bar label={t("gpu.memory")} share={memoryShare} caption={memory} />
            <div className="grid grid-cols-2 gap-2 text-xs">
                <span className="flex min-w-0 flex-col">
                    <span className="text-muted-foreground">{t("gpu.temperature")}</span>
                    <span className="tabular-nums">
                        {gpu.temperatureC === null ? missing : t("gpu.celsius", { value: Math.round(gpu.temperatureC) })}
                    </span>
                </span>
                <span className="flex min-w-0 flex-col">
                    <span className="text-muted-foreground">{t("gpu.power")}</span>
                    <span className="tabular-nums">
                        {gpu.powerWatts === null ? missing : t("gpu.watts", { value: Math.round(gpu.powerWatts) })}
                    </span>
                </span>
            </div>
        </div>
    );
}

function Bar({ label, share, caption }: { label: string; share: number | null; caption: string }) {
    return (
        <div className="flex flex-col gap-1">
            <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
                <span className="text-muted-foreground">{label}</span>
                <span className="min-w-0 truncate tabular-nums" title={caption}>
                    {caption}
                </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-border">
                {share === null ? null : (
                    <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }}
                    />
                )}
            </div>
        </div>
    );
}
