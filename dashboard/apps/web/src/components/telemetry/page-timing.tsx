"use client";

/**
 * Polaris' own page loads, reported to its own Telemetry project.
 *
 * The browser's Web Vitals for this document (Next's `useReportWebVitals`) are
 * gathered while the page is open and sent once, when it is hidden or left, as
 * one request. One load in ten is sent, and every load over a Web Vitals target,
 * so a slow screen always shows up and a fast one costs almost nothing.
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import { VITAL_TARGETS } from "@/lib/telemetry/performance";

type Vital = keyof typeof VITAL_TARGETS;

const SAMPLE = 0.1;
const VITALS: Readonly<Record<string, Vital>> = { LCP: "lcp", FCP: "fcp", TTFB: "ttfb", INP: "inp", CLS: "cls" };

/** What this document measured, and the address it was loaded at. */
const pending: { path: string | null; values: Partial<Record<Vital, number>>; sent: boolean } = {
    path: null,
    values: {},
    sent: false
};

/** Whether this load is sent: sampled, or slower than a target. */
export function worthSending(values: Readonly<Partial<Record<Vital, number>>>, roll: number): boolean {
    if (Object.keys(values).length === 0) return false;
    if (roll < SAMPLE) return true;
    return (Object.entries(values) as [Vital, number][]).some(([vital, value]) => value > VITAL_TARGETS[vital]);
}

function flush(): void {
    if (pending.sent || !pending.path || !worthSending(pending.values, Math.random())) return;
    pending.sent = true;
    void fetch("/api/telemetry/page-load", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: pending.path, values: pending.values }),
        keepalive: true
    }).catch(() => undefined);
}

export function PageTiming() {
    const pathname = usePathname();

    useReportWebVitals((metric) => {
        const vital = VITALS[metric.name];
        if (!vital || pending.sent) return;
        // The address the document was loaded at, not one navigated to later:
        // these numbers describe that first load.
        pending.path ??= pathname;
        // CLS is stored in thousandths, the way the ingest stores it.
        pending.values[vital] = vital === "cls" ? metric.value * 1000 : metric.value;
    });

    useEffect(() => {
        const onHide = () => {
            if (document.visibilityState === "hidden") flush();
        };
        document.addEventListener("visibilitychange", onHide);
        window.addEventListener("pagehide", flush);
        return () => {
            document.removeEventListener("visibilitychange", onHide);
            window.removeEventListener("pagehide", flush);
        };
    }, []);

    return null;
}
