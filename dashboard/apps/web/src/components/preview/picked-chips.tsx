"use client";

/** The elements picked in a preview, waiting for the next message: the Code
 *  preview's and a chat's HTML preview's alike. */

import { Crosshair, X } from "lucide-react";
import type { PickedElement } from "@/lib/agents/preview-picker";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** The elements picked in the preview, waiting for the next message: each
 *  named by its tag and selector, the full selector on hover. */
export function PickedChips({
    picks,
    onRemove
}: {
    picks: readonly PickedElement[];
    onRemove: (index: number) => void;
}) {
    const t = useTranslations("polar");
    if (picks.length === 0) return null;
    return (
        <ul aria-label={t("code.pick.list")} className="flex min-w-0 flex-wrap gap-1.5">
            {picks.map((pick, index) => {
                const where = pick.source
                    ? `${pick.source.file}${pick.source.line ? `:${pick.source.line}` : ""}`
                    : pick.selector;
                return (
                    <li
                        key={`${index}:${pick.selector}`}
                        className="flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted py-0.5 ps-2 pe-0.5 text-xs"
                    >
                        <Crosshair className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate font-mono" title={`${pick.selector}\n${where}`}>
                            {`<${pick.tag}> ${where}`}
                        </span>
                        <button
                            type="button"
                            onClick={() => onRemove(index)}
                            aria-label={t("code.pick.remove", { tag: `<${pick.tag}>` })}
                            title={t("code.pick.remove", { tag: `<${pick.tag}>` })}
                            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:size-9"
                        >
                            <X className="size-3.5" />
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
