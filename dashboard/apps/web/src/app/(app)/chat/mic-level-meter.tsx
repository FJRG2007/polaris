"use client";

/**
 * How loud the microphone is, right now, as a row of bars.
 *
 * The answer to "is it picking me up" without asking anybody: bars that light
 * green while somebody talks, yellow when they are loud and red when they are
 * too close - see `level-bars`. The same meter in the call's microphone menu and
 * on the devices screen, so the two never disagree about the same microphone.
 *
 * It measures what it is given before it opens anything:
 *
 * - **A track** - the call's own microphone, or the one a test on the devices
 *   screen already opened. Measured through a clone, so the meter still reads
 *   while the call is muted (a muted track carries silence, which is the answer
 *   to a different question) and so stopping the meter never stops the call's
 *   microphone. A clone is not a second device request: a second request for
 *   the same microphone is what breaks a call on a phone.
 * - **Nothing, with `listen`** - it opens the chosen microphone itself, and lets
 *   go of it when it goes away. Only ever where the browser has already been
 *   allowed the microphone, so drawing a meter never raises a permission prompt
 *   nobody asked for.
 */

import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { measureVoice } from "./voice-level";
import { micConstraints } from "./mic-cleanup";
import { METER_BARS, barTone, litBars, type BarTone } from "./level-bars";

/** How often the level is read. Fast enough to follow a syllable. */
const READ_EVERY_MS = 60;

const TONE_CLASS: Record<BarTone, string> = {
    low: "bg-success",
    mid: "bg-warning",
    high: "bg-danger"
};

/** Whether this browser has already been allowed the microphone. Asked rather
 *  than tried, because trying is the prompt. A browser that cannot say is
 *  treated as not allowed. */
async function micAllowed(): Promise<boolean> {
    try {
        const status = await navigator.permissions.query({
            name: "microphone" as PermissionName
        });
        return status.state === "granted";
    } catch {
        return false;
    }
}

export function MicLevelMeter({
    track = null,
    listen = false,
    deviceId = null,
    threshold,
    className
}: {
    /** A microphone already open - measured, never stopped. */
    track?: MediaStreamTrack | null;
    /** With no track, open the microphone to measure it. */
    listen?: boolean;
    /** Which microphone to open when it has to open one. */
    deviceId?: string | null;
    /** Where a voice-activity microphone opens, drawn as a mark on the row. */
    threshold?: number;
    className?: string;
}) {
    const [level, setLevel] = useState(0);

    useEffect(() => {
        let stopped = false;
        let copy: MediaStreamTrack | null = null;
        let opened: MediaStream | null = null;
        let meter: ReturnType<typeof measureVoice> = null;
        let timer: ReturnType<typeof setInterval> | null = null;

        const measure = (source: MediaStreamTrack) => {
            meter = measureVoice(source);
            if (!meter) return;
            const reading = meter;
            timer = setInterval(() => setLevel(reading.read()), READ_EVERY_MS);
        };

        if (track && track.readyState === "live") {
            copy = track.clone();
            copy.enabled = true;
            measure(copy);
        } else if (listen && typeof navigator !== "undefined" && navigator.mediaDevices) {
            void (async () => {
                if (!(await micAllowed()) || stopped) return;
                const stream = await navigator.mediaDevices
                    .getUserMedia({ audio: micConstraints(deviceId ?? undefined) })
                    .catch(() => null);
                // Let go of it straight away if the meter went away while the
                // browser was answering.
                if (stopped) {
                    for (const each of stream?.getTracks() ?? []) each.stop();
                    return;
                }
                opened = stream;
                const own = stream?.getAudioTracks()[0];
                if (own) measure(own);
            })();
        }

        return () => {
            stopped = true;
            if (timer) clearInterval(timer);
            meter?.stop();
            copy?.stop();
            for (const each of opened?.getTracks() ?? []) each.stop();
            setLevel(0);
        };
    }, [track, listen, deviceId]);

    const lit = litBars(level);

    return (
        <div
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={level}
            className={cn("relative flex h-3 w-full items-stretch gap-0.5", className)}
        >
            {Array.from({ length: METER_BARS }, (_, index) => (
                <span
                    key={index}
                    data-lit={index < lit ? "" : undefined}
                    className={cn(
                        "flex-1 rounded-sm transition-colors duration-75",
                        index < lit ? TONE_CLASS[barTone(index)] : "bg-muted"
                    )}
                />
            ))}
            {threshold !== undefined && (
                <span
                    aria-hidden
                    title="Anything past this counts as you speaking"
                    className="absolute -inset-y-0.5 w-0.5 rounded-full bg-foreground/70"
                    style={{ left: `${threshold}%` }}
                />
            )}
        </div>
    );
}
