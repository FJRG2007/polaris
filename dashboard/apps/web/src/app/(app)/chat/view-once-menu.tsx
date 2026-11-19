"use client";

/**
 * Send it to be seen once, on a phone, for this long.
 *
 * A menu rather than a toggle because the timer is the decision: a photo opens
 * for ten seconds unless the sender says otherwise, a video until it is closed.
 * The trigger is the caller's, so a staged file's small mark and a recorded
 * clip's button choose the same way.
 */

import { Timer, X } from "lucide-react";
import type { ReactElement } from "react";
import { VIEW_SECONDS } from "@/lib/chat/view-once-choice";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@polaris/ui";

/** The timer as a sender reads it: "10 s", or "Until closed". */
export function useViewOnceTimerLabel(): (seconds: number | null) => string {
    const t = useTranslations("chat");
    return (seconds) => (seconds === null ? t("viewOnce.untilClosed") : t("viewOnce.seconds", { seconds }));
}

export function ViewOnceMenu({
    seconds,
    audio = false,
    onChange,
    children
}: {
    /** The timer chosen; undefined is "sent normally". */
    seconds: number | null | undefined;
    /** A recording plays to its end: there is no timer to choose. */
    audio?: boolean;
    onChange: (seconds: number | null | undefined) => void;
    /** The button that opens it. */
    children: ReactElement;
}) {
    const t = useTranslations("chat");
    const label = useViewOnceTimerLabel();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-48">
                {(audio ? [null] : [...VIEW_SECONDS, null]).map((choice) => (
                    <DropdownMenuItem
                        key={String(choice)}
                        onSelect={() => onChange(choice)}
                        className={seconds === choice ? "text-primary" : undefined}
                    >
                        <Timer />
                        {label(choice)}
                    </DropdownMenuItem>
                ))}
                {seconds !== undefined && (
                    <DropdownMenuItem onSelect={() => onChange(undefined)}>
                        <X />
                        {t("viewOnce.off")}
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
