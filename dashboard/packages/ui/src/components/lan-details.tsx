"use client";

/**
 * Where a thing is on the local network: its address and hardware address, each
 * one press from the clipboard, for typing into a router's reservation page.
 *
 * Either line is left out when it is not known, so a table the host cannot read
 * shows the address alone. `LanDetailsRegion` reads them after the page has
 * painted, because the hardware address comes from the host and takes a moment.
 */

import { cn } from "../lib/cn";
import { Skeleton } from "./skeleton";
import { CopyButton } from "./copy-button";
import { useEffect, useState } from "react";

export interface LanDetailsValue {
    readonly address: string | null;
    readonly mac: string | null;
}

export interface LanDetailsLabels {
    readonly address: string;
    readonly mac: string;
}

function Line({ label, value, compact }: { label: string; value: string; compact: boolean }) {
    return (
        <div className="flex min-w-0 items-center gap-2">
            <dt className={compact ? "sr-only" : "shrink-0 text-xs text-muted-foreground"}>
                {label}
            </dt>
            <dd
                className={cn("min-w-0 truncate font-mono", compact ? "text-xs" : "text-sm")}
                title={value}
            >
                {value}
            </dd>
            <CopyButton value={value} label={label} className="shrink-0" />
        </div>
    );
}

export function LanDetails({
    details,
    labels,
    compact = false,
    className
}: {
    details: LanDetailsValue;
    labels: LanDetailsLabels;
    /** The labels for screen readers only, for a table cell. */
    compact?: boolean;
    className?: string;
}) {
    if (!details.address && !details.mac) return null;
    return (
        <dl className={cn("flex min-w-0 flex-col gap-1", className)}>
            {details.address ? (
                <Line label={labels.address} value={details.address} compact={compact} />
            ) : null}
            {details.mac ? <Line label={labels.mac} value={details.mac} compact={compact} /> : null}
        </dl>
    );
}

export function LanDetailsRegion({
    load,
    labels,
    className
}: {
    load: () => Promise<LanDetailsValue | null>;
    labels: LanDetailsLabels;
    className?: string;
}) {
    const [details, setDetails] = useState<LanDetailsValue | null | undefined>(undefined);

    useEffect(() => {
        let current = true;
        load().then(
            (value) => {
                if (current) setDetails(value);
            },
            () => {
                if (current) setDetails(null);
            }
        );
        return () => {
            current = false;
        };
        // Read once per mount: `load` is a new closure on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (details === undefined) return <Skeleton className={cn("h-11 w-56", className)} />;
    if (details === null) return null;
    return <LanDetails details={details} labels={labels} className={className} />;
}
