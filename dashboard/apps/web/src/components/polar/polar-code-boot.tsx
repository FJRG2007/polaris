"use client";

/**
 * What a starting session is doing, in place of a word that never changes.
 *
 * Read off the session's own terminal (`bootProgress`), the only thing that
 * exists before the agent does: a forty-second Enigma install after a version
 * bump reads as "Installing Enigma 1.73.0" rather than as a hang. Asked on a
 * timer only while it is shown and the tab is visible; anything it cannot read
 * leaves the fallback on screen.
 */

import { agentText } from "@/lib/agents/words";
import { useUnmountSignal } from "@/lib/poll-fetch";
import { bootProgress } from "@/lib/agents/boot-progress";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { sessionScreen } from "@/components/agents/sessions/sessions-polls";

/** As often as the thread itself is read while a session is live. */
export const BOOT_READ_MS = 3000;

/** The step under way, as the boot labels it, or null when there is none. */
export function bootStepLabel(screen: string): string | null {
    return bootProgress(screen)?.find((step) => step.state === "doing")?.label ?? null;
}

export function CodeBootLine({ sessionId, fallback }: { sessionId: string; fallback: ReactNode }) {
    const t = useTranslations("agents");
    const signal = useUnmountSignal();
    const [label, setLabel] = useState<string | null>(null);

    useEffect(() => {
        let stopped = false;
        const read = () => {
            if (document.visibilityState !== "visible") return;
            sessionScreen(sessionId, signal())
                .then((answer) => {
                    if (stopped || !answer || answer.error) return;
                    setLabel(bootStepLabel(answer.screen ?? ""));
                })
                .catch(() => undefined);
        };
        read();
        const timer = setInterval(read, BOOT_READ_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [sessionId, signal]);

    return <>{label ? agentText(t, label) : fallback}</>;
}
