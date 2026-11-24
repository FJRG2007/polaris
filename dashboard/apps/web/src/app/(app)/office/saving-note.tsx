"use client";

/**
 * The line under an editor that says whether the work is safe: saving, kept on
 * this device while Polaris is out of reach, or not saved with a way to try
 * again. Every editor on `use-office-document` shows it.
 */

import { Button, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { OfficeSaving } from "@/app/(app)/office/use-office-document";

/** What the corner says about whether the work is safe. Quiet when it is: a
 *  permanent "saved" is a label nobody reads, and the one that matters is the
 *  one that says it did not. */
export function SavingNote({ state, onRetry }: { state: OfficeSaving; onRetry: () => void }) {
    const t = useTranslations("office");
    if (state === "settled") return null;
    return (
        <div
            role="status"
            className={cn(
                "flex shrink-0 items-center gap-3 border-t border-border px-4 py-1.5 text-[12px]",
                state === "failed" ? "text-danger" : "text-muted-foreground"
            )}
        >
            <p className="min-w-0 flex-1">
                {state === "saving"
                    ? t("docEditor.saving")
                    : state === "offline"
                      ? t("docEditor.offline")
                      : t("docEditor.thatDidNotSaveYour")}
            </p>
            {state === "failed" ? (
                <Button size="sm" variant="ghost" onClick={onRetry}>
                    {t("docEditor.retry")}
                </Button>
            ) : null}
        </div>
    );
}
