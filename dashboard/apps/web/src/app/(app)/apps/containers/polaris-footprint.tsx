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

import { useCallback, useRef } from "react";
import { formatBytes } from "@polaris/core";
import { RefreshCw, Sparkles } from "lucide-react";
import { useLiveRead } from "@/components/use-live-resource";
import { Button, Card, CardBody, Skeleton } from "@polaris/ui";
import { footprintDiskBytes, type FootprintPart, type PolarisFootprint } from "./types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type Words = NamespaceTranslator<"components">;

/** The parts of the stack by the English name `lib/polaris-parts` gives them, so
 *  a reading already on its way keeps meaning the same row. A part this does not
 *  know keeps its own name. */
const PART_KEYS: Readonly<Record<string, string>> = {
    Dashboard: "web",
    Database: "postgres",
    Edge: "traefik",
    "Edge guard": "edgeGuard",
    "Host daemon": "hostd",
    "Call server": "livekit",
    "Local discovery": "mdns",
    "Minecraft router": "mcRouter",
    "Edge (legacy)": "caddy",
    "Public tunnel": "tunnel"
};

function partWords(t: Words, part: FootprintPart): { label: string; summary: string } {
    const key = PART_KEYS[part.label];
    if (!key) return { label: part.label, summary: part.summary };
    return {
        label: t(`footprint.parts.${key}.label` as NamespaceKey<"components">),
        summary: t(`footprint.parts.${key}.summary` as NamespaceKey<"components">)
    };
}

/** Slow to measure and slow to change: a stack that has just been asked how big it
 *  is will give the same answer for a good while. */
const REFRESH_MS = 5 * 60_000;

export function PolarisFootprintCard() {
    const t = useTranslations("components");
    // Set for the next read only, so the button gets a measurement taken now while
    // the poll behind it goes on sharing the one the server is holding - which is
    // what keeps a page open in two tabs from measuring the stack twice.
    const forced = useRef(false);

    const load = useCallback(async (signal: AbortSignal): Promise<PolarisFootprint> => {
        const fresh = forced.current;
        forced.current = false;
        const response = await fetch(`/api/polaris/footprint${fresh ? "?fresh=1" : ""}`, {
            cache: "no-store",
            signal
        });
        const body: unknown = await response.json();
        if (!response.ok) {
            throw new Error(
                typeof body === "object" && body !== null && "error" in body
                    ? String((body as { error: unknown }).error)
                    : t("footprint.noReason")
            );
        }
        return body as PolarisFootprint;
    }, [t]);

    const {
        data: footprint,
        loading,
        error,
        stale,
        refreshing,
        refresh
    } = useLiveRead<PolarisFootprint>({
        load,
        cacheKey: "polaris.footprint",
        intervalMs: REFRESH_MS
    });

    const measureAgain = (): void => {
        forced.current = true;
        refresh();
    };

    const problem = error ?? stale;

    return (
        <Card className="mb-4">
            <CardBody className="flex flex-col gap-3 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                        <Sparkles className="size-4 text-muted-foreground" />
                        {t("footprint.title")}
                    </div>
                    <Button size="sm" variant="ghost" onClick={measureAgain} disabled={refreshing}>
                        <RefreshCw className="size-4" />
                        {t("footprint.measure")}
                    </Button>
                </div>

                {problem && (
                    <p className="text-sm text-danger">
                        {t("footprint.failed", { reason: problem })}
                    </p>
                )}

                {footprint ? (
                    <Totals footprint={footprint} />
                ) : loading ? (
                    <Skeleton className="h-4 w-72" />
                ) : null}

                {(footprint || loading) && (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[38rem] text-sm">
                            <thead className="text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="py-1 pr-3 font-medium">{t("footprint.columns.part")}</th>
                                    <th className="py-1 pr-3 font-medium">{t("footprint.columns.cpu")}</th>
                                    <th className="py-1 pr-3 font-medium">{t("footprint.columns.memory")}</th>
                                    <th className="py-1 font-medium">{t("footprint.columns.disk")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {footprint
                                    ? footprint.parts.map((part) => (
                                          <PartRow key={part.id} part={part} />
                                      ))
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
                )}
            </CardBody>
        </Card>
    );
}

/** The three numbers the card exists to give, in one line. */
function Totals({ footprint }: { footprint: PolarisFootprint }) {
    const disk = footprintDiskBytes(footprint);
    // Optional against the type, on purpose. An update rolls over without going
    // down, so for a few seconds the container still serving this endpoint can be
    // the previous one - and this figure is newer than some of those. Reading it
    // as though it were always there turns a stale answer into a blank screen.
    const rest = footprint.rest as PolarisFootprint["rest"] | undefined;
    const t = useTranslations("components");
    const strong = (chunks: React.ReactNode) => (
        <span key="strong" className="font-medium text-foreground">
            {chunks}
        </span>
    );
    return (
        <p className="text-sm text-muted-foreground">
            {t.rich("footprint.totals", {
                memory: formatBytes(footprint.memUsedBytes),
                machine: footprint.memTotalBytes ? "yes" : "no",
                total: footprint.memTotalBytes ? formatBytes(footprint.memTotalBytes) : "",
                cpu: footprint.cpuPercent,
                complete: footprint.diskComplete ? "yes" : "no",
                disk: formatBytes(disk),
                images: formatBytes(footprint.imageBytes),
                data: formatBytes(footprint.volumeBytes),
                written: formatBytes(footprint.writableBytes),
                b: strong
            })}
            {rest && rest.containers > 0 ? (
                <>
                    {" "}
                    {t.rich("footprint.rest", {
                        count: rest.containers,
                        memory: formatBytes(rest.memUsedBytes),
                        cpu: rest.cpuPercent,
                        b: strong
                    })}
                </>
            ) : null}
        </p>
    );
}

function PartRow({ part }: { part: FootprintPart }) {
    const volumes = part.volumes.reduce((total, volume) => total + (volume.usedBytes ?? 0), 0);
    const disk = (part.imageBytes ?? 0) + (part.writableBytes ?? 0) + volumes;
    const running = part.state === "running";
    const t = useTranslations("components");
    const words = partWords(t, part);
    return (
        <tr className="border-t border-border align-top">
            <td className="py-2 pr-3">
                <div className="font-medium">{words.label}</div>
                {words.summary && (
                    <div className="text-xs text-muted-foreground">{words.summary}</div>
                )}
                <div className="truncate text-xs text-muted-foreground/80" title={part.image}>
                    {part.name}
                    {running ? "" : ` - ${part.state}`}
                </div>
            </td>
            <td className="py-2 pr-3 text-muted-foreground">
                {part.cpuPercent === null ? "-" : `${part.cpuPercent}%`}
            </td>
            <td className="py-2 pr-3 text-muted-foreground">
                {part.memUsedBytes === null ? "-" : formatBytes(part.memUsedBytes)}
            </td>
            <td
                className="py-2 text-muted-foreground"
                title={[
                    part.imageBytes === null ? null : t("footprint.image", { size: formatBytes(part.imageBytes) }),
                    part.writableBytes === null
                        ? null
                        : t("footprint.written", { size: formatBytes(part.writableBytes) }),
                    ...part.volumes.map(
                        (volume) =>
                            `${volume.name} ${volume.usedBytes === null ? t("footprint.notMeasured") : formatBytes(volume.usedBytes)}`
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
