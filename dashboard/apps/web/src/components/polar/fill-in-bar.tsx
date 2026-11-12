"use client";

/**
 * The fields a rewrite left for the writer (`{{Recipient's name}}`), listed
 * under the field so none is sent by mistake. Each one, pressed, selects that
 * field in the text so typing replaces it (`RichTextEditor`'s `reveal`).
 */

import { useMemo } from "react";
import { TextCursorInput } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { fillInFields } from "@/lib/polar/improve-draft";

export function FillInBar({
    text,
    onReveal
}: {
    text: string;
    onReveal: (label: string) => void;
}) {
    const t = useTranslations("components");
    const fields = useMemo(() => fillInFields(text), [text]);
    if (fields.length === 0) return null;
    return (
        <div
            role="status"
            className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-warning-edge bg-warning-soft px-2 py-1.5 text-xs text-warning-ink"
        >
            <TextCursorInput className="size-3.5 shrink-0" aria-hidden />
            <span className="shrink-0">{t("improve.fillIn", { count: fields.length })}</span>
            {fields.map((label) => (
                <button
                    key={label}
                    type="button"
                    title={t("improve.fillInField", { field: label })}
                    className="min-w-0 max-w-full truncate rounded-sm border border-dashed border-warning-edge bg-background/60 px-1.5 py-0.5 text-warning-ink hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onReveal(label)}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}
