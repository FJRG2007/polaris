"use client";

/**
 * The translation of selected text, in a panel at the point the menu was
 * opened: into the reader's language first, with a language switch, Copy and
 * the way into the Translate app with the same words.
 */

import Link from "next/link";
import { Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Popover, PopoverAnchor, PopoverContent, Skeleton, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { TranslationOutcome } from "@/lib/text-translation/queue";
import { LanguageSelect } from "./language-select";
import { useTextTranslator } from "./provider";

export interface SelectionToTranslate {
    readonly x: number;
    readonly y: number;
    readonly text: string;
}

export function SelectionTranslation({
    selection,
    onClose
}: {
    selection: SelectionToTranslate | null;
    onClose: () => void;
}) {
    const t = useTranslations("common");
    const toast = useToast();
    const translator = useTextTranslator();
    const [to, setTo] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<TranslationOutcome | null>(null);
    const target = to ?? translator?.target ?? "en";
    const text = selection?.text ?? "";

    useEffect(() => {
        if (!translator || !text) return;
        let current = true;
        setOutcome(null);
        void translator.translate(text, target).then((answer) => current && setOutcome(answer));
        return () => {
            current = false;
        };
    }, [translator, text, target]);

    if (!translator) return null;

    const shown = outcome?.kind === "translated" ? outcome.text : outcome?.kind === "same" ? text : "";

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(shown);
            toast.show({ title: t("selectionMenu.copied") });
        } catch {
            toast.show({ title: t("selectionMenu.copyFailed") });
        }
    };

    return (
        <Popover open={selection !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            <PopoverAnchor asChild>
                <span
                    aria-hidden
                    className="pointer-events-none fixed size-0"
                    style={{ left: selection?.x ?? 0, top: selection?.y ?? 0 }}
                />
            </PopoverAnchor>
            <PopoverContent align="start" data-selection-translation aria-live="polite">
                <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-muted-foreground">
                        {t("textTranslation.title")}
                    </span>
                    <LanguageSelect
                        value={target}
                        onChange={setTo}
                        label={t("textTranslation.language")}
                        className="h-7 w-40 min-w-0 text-xs"
                    />
                </div>
                <div className="mt-2 min-h-10 whitespace-pre-wrap break-words text-sm">
                    {outcome === null ? (
                        <div className="space-y-1.5" aria-label={t("textTranslation.working")}>
                            <Skeleton className="h-3.5 w-full" />
                            <Skeleton className="h-3.5 w-2/3" />
                        </div>
                    ) : outcome.kind === "failed" ? (
                        <p className="text-muted-foreground">
                            {outcome.message ?? t("textTranslation.failed")}
                        </p>
                    ) : (
                        <>
                            <p>{shown}</p>
                            {outcome.kind === "same" && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {t("textTranslation.alreadyIn")}
                                </p>
                            )}
                        </>
                    )}
                </div>
                <div className="mt-3 flex items-center justify-end gap-1">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!shown}
                        aria-label={t("textTranslation.copy")}
                        title={t("textTranslation.copy")}
                        onClick={() => void copy()}
                    >
                        <Copy className="size-3.5" />
                    </Button>
                    <Button variant="outline" size="sm" asChild>
                        <Link href={translator.openHref(text, target)} onClick={onClose}>
                            <ExternalLink className="size-3.5" />
                            {t("textTranslation.open")}
                        </Link>
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
