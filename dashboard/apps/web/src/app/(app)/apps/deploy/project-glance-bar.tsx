"use client";

/**
 * The line under a project's switchers that answers the first three questions
 * about the environment on screen: where does it answer, how did the last deploy
 * go, and is anything wrong.
 *
 * Seeded by the layout and then kept current here - a layout is not re-rendered
 * by the page's refresh, so a summary that relied on it would still say
 * "deploying" long after the deploy had finished.
 */

import Link from "next/link";
import { rankedDomains } from "./domain-rank";
import { useEffect, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { projectGlanceAction } from "./glance-actions";
import { isInFlightStatus } from "@/lib/deploy/status";
import { RelativeTime } from "@/components/relative-time";
import { FAILED_DEPLOY_STATUSES } from "@/lib/deploy/attention";
import { ArrowUpRight, ChevronDown, CircleAlert, Globe } from "lucide-react";
import type { EnvironmentGlance, GlanceAddress } from "@/lib/deploy/project-glance";
import {
    Badge,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
    statusChipClass
} from "@polaris/ui";

const IDLE_MS = 15_000;
const MOVING_MS = 4_000;

/** Keep the layout's glance current while the project is open. */
export function useProjectGlance(
    projectId: string,
    initial: Record<string, EnvironmentGlance>
): Record<string, EnvironmentGlance> {
    const [glance, setGlance] = useState(initial);
    useEffect(() => setGlance(initial), [initial]);

    const moving = Object.values(glance).some((entry) =>
        isInFlightStatus(entry.lastDeploy?.status)
    );
    useEffect(() => {
        let active = true;
        function refresh(): void {
            if (document.hidden) return;
            void projectGlanceAction(projectId)
                .catch(() => null)
                .then((next) => {
                    if (active && next) setGlance(next);
                });
        }
        const timer = setInterval(refresh, moving ? MOVING_MS : IDLE_MS);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            active = false;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [projectId, moving]);
    return glance;
}

/** The chip a deployment's state wears. */
function deployVariant(status: string): "success" | "warning" | "danger" | "neutral" {
    if (FAILED_DEPLOY_STATUSES.includes(status)) return "danger";
    if (isInFlightStatus(status)) return "warning";
    if (status === "running" || status === "success") return "success";
    return "neutral";
}

const HEALTH_DOT: Record<string, string> = {
    up: "bg-success-solid",
    down: "bg-danger-solid"
};

function HealthDot({ address }: { address: GlanceAddress }) {
    const status = address.healthStatus ?? "unknown";
    return (
        <span
            role="img"
            aria-label={
                status === "up"
                    ? "Answering"
                    : status === "down"
                      ? "Not answering"
                      : "Not checked yet"
            }
            className={cn(
                "size-1.5 shrink-0 rounded-full",
                HEALTH_DOT[status] ?? "bg-foreground-subtle"
            )}
        />
    );
}

function storedHostname(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function storeHostname(key: string, hostname: string): void {
    try {
        window.localStorage.setItem(key, hostname);
    } catch {
        // Private windows and blocked storage: the choice just does not survive a reload.
    }
}

export function ProjectGlanceBar({
    environmentId,
    glance,
    serviceHref
}: {
    environmentId: string;
    glance: EnvironmentGlance | undefined;
    /** Where opening one of its services goes. */
    serviceHref: (applicationId: string) => string;
}) {
    const addresses = useMemo(() => rankedDomains(glance?.addresses ?? []), [glance]);
    const storageKey = `polaris.deploy.glance.${environmentId}`;
    const [picked, setPicked] = useState<string | null>(null);
    useEffect(() => setPicked(storedHostname(storageKey)), [storageKey]);

    if (!glance) return null;
    const shown = addresses.find((address) => address.hostname === picked) ?? addresses[0] ?? null;
    const last = glance.lastDeploy;
    const attention = glance.attention;
    const firstAttention = attention[0];

    function pick(hostname: string): void {
        setPicked(hostname);
        storeHostname(storageKey, hostname);
    }

    return (
        <section
            aria-label="Environment summary"
            className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-card px-4 py-2.5"
        >
            <div className="flex min-w-0 max-w-full flex-1 basis-64 items-center gap-2">
                {shown ? (
                    <>
                        <HealthDot address={shown} />
                        <a
                            href={`https://${shown.hostname}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-w-0 items-center gap-1 truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
                        >
                            <span className="truncate" title={shown.hostname}>
                                {shown.hostname}
                            </span>
                            <ArrowUpRight className="size-3.5 text-muted-foreground" />
                        </a>
                        <CopyButton value={`https://${shown.hostname}`} label="the address" />
                        {addresses.length > 1 && (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                        aria-label="Switch address"
                                    >
                                        {shown.service}
                                        <span className="tabular-nums text-foreground-subtle">
                                            +{addresses.length - 1}
                                        </span>
                                        <ChevronDown className="size-3.5" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="start"
                                    className="max-h-72 max-w-[min(24rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain"
                                >
                                    <DropdownMenuLabel>
                                        Addresses in this environment
                                    </DropdownMenuLabel>
                                    {addresses.map((address) => (
                                        <DropdownMenuItem
                                            key={address.id}
                                            onSelect={() => pick(address.hostname)}
                                        >
                                            <HealthDot address={address} />
                                            <span
                                                className="min-w-0 flex-1 truncate"
                                                title={address.hostname}
                                            >
                                                {address.hostname}
                                            </span>
                                            <span className="shrink-0 text-xs text-muted-foreground">
                                                {address.service}
                                            </span>
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                        {addresses.length === 1 && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {shown.service}
                            </span>
                        )}
                    </>
                ) : (
                    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                        <Globe className="size-4" /> No address yet
                    </span>
                )}
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                {last ? (
                    <Link
                        href={serviceHref(last.applicationId)}
                        className="inline-flex min-w-0 items-center gap-2 rounded-md text-xs text-muted-foreground hover:text-foreground"
                        title={`Open ${last.service}`}
                    >
                        <span className="shrink-0">Last deploy</span>
                        <Badge variant={deployVariant(last.status)} className="shrink-0 capitalize">
                            {last.status.replace(/_/g, " ")}
                        </Badge>
                        <RelativeTime
                            iso={last.createdAt}
                            formatStyle="narrow"
                            className="shrink-0 tabular-nums"
                        />
                        <span className="truncate" title={last.service}>
                            {last.service}
                        </span>
                    </Link>
                ) : (
                    <span className="text-xs text-muted-foreground">Not deployed yet</span>
                )}
                {firstAttention && (
                    <Link
                        href={serviceHref(firstAttention.applicationId)}
                        title={attention
                            .map((entry) => `${entry.service}: ${entry.reasons.join(", ")}`)
                            .join("\n")}
                        className={cn(statusChipClass("danger"), "hover:bg-danger-soft")}
                    >
                        <CircleAlert className="size-3" />
                        {attention.length === 1
                            ? `${firstAttention.service} needs a look`
                            : `${attention.length} services need a look`}
                    </Link>
                )}
            </div>
        </section>
    );
}
