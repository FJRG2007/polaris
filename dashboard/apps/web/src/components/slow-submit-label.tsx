"use client";

import { ShieldCheck } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

/**
 * A submit button's label while it is busy. For the first 300 ms it is the
 * button's own busy label; a submit still going after that swaps it, in place,
 * for a line with an animated shield. Both layers share one grid cell and the
 * swap is a CSS animation delay, so there is no timer and nothing moves: the
 * button keeps its size and the form below it never shifts. Motion is dropped
 * for `prefers-reduced-motion` (globals.css, `.slow-submit-*`).
 *
 * `protecting` picks the line: true only when the submit really runs the
 * password key stretching (OPAQUE's Argon2id), so the encryption line is never
 * shown for a wait that has nothing to do with it.
 */
export function SlowSubmitLabel({ busyLabel, protecting }: { busyLabel: string; protecting: boolean }) {
    const t = useTranslations("common");
    const line = protecting ? t("slowSubmit.protecting") : t("slowSubmit.working");
    return (
        <span className="grid min-w-0 max-w-full [grid-template-areas:'stack']">
            <span className="slow-submit-first min-w-0 truncate [grid-area:stack]" title={busyLabel}>{busyLabel}</span>
            <span
                className="slow-submit-later flex min-w-0 items-center justify-center gap-1.5 [grid-area:stack]"
                aria-live="polite"
                title={line}
            >
                <ShieldCheck aria-hidden className="slow-submit-shield" />
                <span className="min-w-0 truncate">{line}</span>
            </span>
        </span>
    );
}
