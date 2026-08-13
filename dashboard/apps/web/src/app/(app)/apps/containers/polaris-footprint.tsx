"use client";

/**
 * What Polaris itself is using, on the machine it runs on.
 *
 * The Containers table lists the control plane's own containers alongside
 * everything deployed, which answers "is it running" and not "what does it cost".
 * That question was only answerable by reading the table and adding it up by eye -
 * and by knowing which of those containers are Polaris in the first place, which
 * their names do not reliably say.
 *
 * Only on the local host, because that is the machine Polaris is installed on. It
 * arrives after the table rather than with it: measuring means inspecting every
 * part and asking each one how big its volumes are, and the page must not wait on
 * that.
 */

import { formatBytes } from "@polaris/core";
import { RefreshCw, Sparkles } from "lucide-react";
import { Button, Card, CardBody, Skeleton } from "@polaris/ui";
import { useLiveResource } from "@/components/use-live-resource";
import { footprintDiskBytes, type FootprintPart, type PolarisFootprint } from "./types";

/** Slow to measure and slow to change: a stack that has just been asked how big it
 *  is will give the same answer for a good while. */
const REFRESH_MS = 5 * 60_000;

export function PolarisFootprintCard() {
    const {
        data: footprint,
        loading,
        error,
        refreshing,
        refresh
    } = useLiveResource<PolarisFootprint>({
        url: "/api/polaris/footprint",
        cacheKey: "polaris.footprint",
        intervalMs: REFRESH_MS,
        select: (body) => body as PolarisFootprint
    });

    if (error && !footprint) return null;

    return (
        <Card className="mb-4">
            <CardBody className="flex flex-col gap-3 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                        <Sparkles className="size-4 text-muted-foreground" />
                        Polaris itself
                    </div>
                    <Button size="sm" variant="ghost" onClick={refresh} disabled={refreshing || loading}>
                        <RefreshCw className="size-4" />
                        Measure again
                    </Button>
                </div>

                {footprint ? <Totals footprint={footprint} /> : <Skeleton className="h-4 w-72" />}

                <div className="overflow-x-auto">
                    <table className="w-full min-w-[38rem] text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="py-1 pr-3 font-medium">Part</th>
                                <th className="py-1 pr-3 font-medium">CPU</th>
                                <th className="py-1 pr-3 font-medium">Memory</th>
                                <th className="py-1 font-medium">Disk</th>
                            </tr>
                        </thead>
                        <tbody>
                            {footprint
                                ? footprint.parts.map((part) => <PartRow key={part.id} part={part} />)
                                : [0, 1, 2, 3].map((row) => (
                                      <tr key={row} className="border-t border-border">
                                          <td className="py-2 pr-3" colSpan={4}>
                                              <Skeleton className="h-4 w-full" />
                                          </td>
                                      </tr>
                                  ))}
                        </tbody>
                    </table>
                </div>
            </CardBody>
        </Card>
    );
}

/** The three numbers the card exists to give, in one line. */
function Totals({ footprint }: { footprint: PolarisFootprint }) {
    const disk = footprintDiskBytes(footprint);
    return (
        <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{formatBytes(footprint.memUsedBytes)}</span> of memory
            {footprint.memTotalBytes ? ` of the machine's ${formatBytes(footprint.memTotalBytes)}` : ""},{" "}
            <span className="font-medium text-foreground">{footprint.cpuPercent}%</span> CPU, and{" "}
            <span className="font-medium text-foreground">{footprint.diskComplete ? "" : "at least "}
                {formatBytes(disk)}
            </span>{" "}
            on disk - {formatBytes(footprint.imageBytes)} of images, {formatBytes(footprint.volumeBytes)} of data,{" "}
            {formatBytes(footprint.writableBytes)} written by the containers themselves.
        </p>
    );
}

function PartRow({ part }: { part: FootprintPart }) {
    const volumes = part.volumes.reduce((total, volume) => total + (volume.usedBytes ?? 0), 0);
    const disk = (part.imageBytes ?? 0) + (part.writableBytes ?? 0) + volumes;
    const running = part.state === "running";
    return (
        <tr className="border-t border-border align-top">
            <td className="py-2 pr-3">
                <div className="font-medium">{part.label}</div>
                {part.summary && <div className="text-xs text-muted-foreground">{part.summary}</div>}
                <div className="truncate text-xs text-muted-foreground/80" title={part.image}>
                    {part.name}
                    {running ? "" : ` - ${part.state}`}
                </div>
            </td>
            <td className="py-2 pr-3 text-muted-foreground">{part.cpuPercent === null ? "-" : `${part.cpuPercent}%`}</td>
            <td className="py-2 pr-3 text-muted-foreground">
                {part.memUsedBytes === null ? "-" : formatBytes(part.memUsedBytes)}
            </td>
            <td
                className="py-2 text-muted-foreground"
                title={[
                    part.imageBytes === null ? null : `image ${formatBytes(part.imageBytes)}`,
                    part.writableBytes === null ? null : `written ${formatBytes(part.writableBytes)}`,
                    ...part.volumes.map(
                        (volume) =>
                            `${volume.name} ${volume.usedBytes === null ? "not measured" : formatBytes(volume.usedBytes)}`
                    )
                ]
                    .filter(Boolean)
                    .join("\n")}
            >
                {disk === 0 ? "-" : formatBytes(disk)}
            </td>
        </tr>
    );
}
