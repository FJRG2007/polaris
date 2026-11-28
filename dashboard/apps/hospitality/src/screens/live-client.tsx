"use client";

/**
 * The browser side of Hospitality's live channel, and the screen density flag.
 *
 * One EventSource per screen on the venue's own server: when anything of the
 * venue changes, `reload` runs (after a short settle), so a table opened on a
 * handheld appears on the bar's tablet within a second, with no internet. A
 * hidden tab keeps the signal and spends it when it is shown again.
 */

import { useEffect, useRef, useState } from "react";

export function useHospitalityLive(venueId: string | null, reload: () => void): void {
    const latest = useRef(reload);
    latest.current = reload;
    useEffect(() => {
        if (typeof EventSource === "undefined") return;
        let banked = false;
        const source = new EventSource(`/api/hospitality/stream${venueId ? `?venue=${encodeURIComponent(venueId)}` : ""}`);
        source.onmessage = () => {
            if (document.visibilityState === "hidden") banked = true;
            else latest.current();
        };
        const onVisible = () => {
            if (document.visibilityState === "visible" && banked) {
                banked = false;
                latest.current();
            }
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            source.close();
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [venueId]);
}

export type HospitalityMode = "standard" | "basic";

const MODE_KEY = "hospitality:mode";

/**
 * Standard (the Polaris look) or basic (big targets, few words) - remembered on
 * this device, so a tablet at the bar stays basic for whoever picks it up.
 */
export function useHospitalityMode(): [HospitalityMode, (mode: HospitalityMode) => void] {
    const [mode, setMode] = useState<HospitalityMode>("standard");
    useEffect(() => {
        try {
            if (localStorage.getItem(MODE_KEY) === "basic") setMode("basic");
        } catch {
            // Storage blocked: the standard view.
        }
    }, []);
    return [
        mode,
        (next) => {
            setMode(next);
            try {
                localStorage.setItem(MODE_KEY, next);
            } catch {
                // Storage blocked: the choice lasts this visit.
            }
        }
    ];
}
