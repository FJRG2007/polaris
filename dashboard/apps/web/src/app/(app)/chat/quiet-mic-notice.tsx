"use client";

/**
 * The line that tells somebody the room can barely hear them.
 *
 * The person this happens to is the one person in the call who cannot notice
 * it: they hear everybody else at a normal level and themselves not at all. So
 * it is measured - their outgoing voice against everybody else's as it arrives
 * here, while each is talking - and said only when they sit well below the rest
 * for long enough to be a level rather than a moment. See `call-loudness`.
 *
 * It offers the one fix Polaris owns, turning the microphone volume up, and
 * names the two it does not: the noise setting, and the level the machine
 * itself gives the microphone.
 */

import { Volume1, X } from "lucide-react";
import { useEffect, useState } from "react";
import { GAIN_MAX, useMicGain } from "./mic-gain";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { gapFor, quietVerdict, SELF, useLoudness } from "./call-loudness";

/** How far one press turns the volume up: a step somebody will hear, small
 *  enough that two presses are not a shout. */
const STEP = 0.25;

/** Whether the room can barely hear this browser, by how much, and the two
 *  things that can be done about it here. */
export interface QuietMic {
    /** Said: the microphone is on, the gap has held, and nobody closed it. */
    readonly quiet: boolean;
    /** How far below everybody else, in decibels, rounded. */
    readonly db: number;
    readonly atMax: boolean;
    readonly turnUp: () => void;
    readonly dismiss: () => void;
}

/**
 * The measurement behind the line, without the line.
 *
 * A hook of its own so the call screen can weigh it against everything else the
 * call has to say - see `call-notices`.
 */
export function useQuietMic(micOn: boolean): QuietMic {
    const levels = useLoudness();
    const [gain, setGain] = useMicGain();
    const [quiet, setQuiet] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const gap = gapFor(levels, SELF);

    useEffect(() => {
        setQuiet((was) => quietVerdict(gap, was));
    }, [gap]);

    const atMax = gain >= GAIN_MAX;
    return {
        quiet: micOn && quiet && !dismissed && gap !== null,
        db: Math.round(gap ?? 0),
        atMax,
        turnUp: () => setGain(Math.min(GAIN_MAX, gain + STEP)),
        dismiss: () => setDismissed(true)
    };
}

export function QuietMicNotice({ micOn }: { micOn: boolean }) {
    const t = useTranslations("chat");
    const { quiet, db, atMax, turnUp, dismiss } = useQuietMic(micOn);
    if (!quiet) return null;
    return (
        <p
            role="status"
            className="flex shrink-0 items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-ink"
        >
            <Volume1 className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
                {atMax ? t("quietMic.atMax", { db }) : t("quietMic.quiet", { db })}
            </span>
            {!atMax && (
                <button
                    type="button"
                    onClick={turnUp}
                    className="shrink-0 rounded px-1.5 py-0.5 font-medium underline decoration-dotted underline-offset-2 hover:no-underline"
                >
                    {t("quietMic.turnUp")}
                </button>
            )}
            <button
                type="button"
                onClick={dismiss}
                aria-label={t("noAudio.dismiss")}
                title={t("noAudio.dismiss")}
                className="-m-1 shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100"
            >
                <X className="size-3.5" />
            </button>
        </p>
    );
}
