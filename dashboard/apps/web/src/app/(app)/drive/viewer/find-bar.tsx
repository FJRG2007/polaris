"use client";

/**
 * Find a run of text in the file on screen.
 *
 * A config file is the case this exists for: somebody opens a mod's settings
 * from a server's own files, and the setting they came for is one line in three
 * hundred. Scrolling for it is the difference between a file browser and a text
 * editor.
 *
 * It follows what every editor does, because that is what hands are already
 * trained on: it opens on Ctrl+F, steps on Enter, goes back on Shift+Enter, and
 * closes on Escape. The count is beside the box rather than after it, so
 * "nothing here" is read before the third attempt at spelling it.
 */

import { useEffect, useRef } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Input } from "@polaris/ui";
import { MOST_MATCHES } from "./find-in-file";
import { ChevronDown, ChevronUp, X } from "lucide-react";

export function FindBar({
    query,
    onQuery,
    total,
    current,
    onStep,
    onClose,
    label
}: {
    query: string;
    onQuery: (value: string) => void;
    total: number;
    /** Zero-based, and only meaningful when there is anything to be on. */
    current: number;
    onStep: (by: 1 | -1) => void;
    onClose: () => void;
    /** What the box says it searches, when it is not a file. */
    label?: string;
}) {
    const t = useTranslations("driveViewer");
    const box = useRef<HTMLInputElement>(null);
    // Opened with the caret in it: a find bar somebody has to click into is one
    // press longer than the editor they are used to.
    useEffect(() => box.current?.focus(), []);

    const nothing = query !== "" && total === 0;

    return (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Input
                ref={box}
                value={query}
                onChange={(event) => onQuery(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        onStep(event.shiftKey ? -1 : 1);
                    } else if (event.key === "Escape") {
                        event.preventDefault();
                        onClose();
                    }
                }}
                placeholder={label ?? t("find.findInThisFile")}
                aria-label={label ?? t("find.findInThisFile")}
                className="h-8 max-w-64"
            />
            <span
                className={`text-xs tabular-nums ${nothing ? "text-danger" : "text-muted-foreground"}`}
                aria-live="polite"
            >
                {query === ""
                    ? ""
                    : total === 0
                      ? t("find.noMatches")
                      : t("find.matchOf", { current: current + 1, total: `${total}${total === MOST_MATCHES ? "+" : ""}` })}
            </span>
            <div className="ml-auto flex items-center gap-1">
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={total === 0}
                    onClick={() => onStep(-1)}
                    aria-label={t("find.previousMatch")}
                    title={t("find.previousMatchShiftEnter")}
                >
                    <ChevronUp className="size-4" />
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={total === 0}
                    onClick={() => onStep(1)}
                    aria-label={t("find.nextMatch")}
                    title={t("find.nextMatchEnter")}
                >
                    <ChevronDown className="size-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={onClose} aria-label={t("find.closeFind")} title={t("find.closeEsc")}>
                    <X className="size-4" />
                </Button>
            </div>
        </div>
    );
}
