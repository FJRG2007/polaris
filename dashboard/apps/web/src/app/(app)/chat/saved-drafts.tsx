"use client";

/**
 * The drafts somebody put aside in this conversation, and getting one back.
 *
 * Nothing about a draft is in the room - it is not a message - so without a line
 * over the box the only record of one is the memory of whoever wrote it, which is
 * the same failure the scheduled line exists to prevent. Drawn the same way for
 * the same reason: a line when there is anything, the count, and a list behind
 * it. Nothing at all when there is nothing, which is nearly always.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { FilePen, RotateCcw, Trash2 } from "lucide-react";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { useDisplayFormat } from "@/components/display-format";
import { removeSavedDraft, saveDraft, savedDrafts, type SavedDraft } from "./drafts";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

/**
 * The drafts set aside under one box, kept in step with storage.
 *
 * Read in the browser and never while rendering: they live in this browser's
 * storage, and the server drawing the page has none. Another tab putting one
 * aside in the same conversation shows up here too, through the storage event,
 * rather than the two tabs disagreeing about what is waiting.
 */
export function useSavedDrafts(boxKey: string | null): {
    drafts: readonly SavedDraft[];
    save: (body: string) => boolean;
    remove: (key: string) => void;
} {
    const [drafts, setDrafts] = useState<readonly SavedDraft[]>([]);

    const reread = useCallback(() => setDrafts(boxKey ? savedDrafts(boxKey) : []), [boxKey]);

    useEffect(() => {
        reread();
        if (!boxKey) return;
        window.addEventListener("storage", reread);
        return () => window.removeEventListener("storage", reread);
    }, [boxKey, reread]);

    const save = useCallback(
        (body: string) => {
            if (!boxKey) return false;
            const saved = saveDraft(boxKey, body) !== null;
            reread();
            return saved;
        },
        [boxKey, reread]
    );

    const remove = useCallback(
        (key: string) => {
            removeSavedDraft(key);
            reread();
        },
        [reread]
    );

    return { drafts, save, remove };
}

export function SavedDraftsBar({
    drafts,
    onRestore,
    onDelete
}: {
    drafts: readonly SavedDraft[];
    /** Put it back in the box. The box decides what happens to anything already
     *  in it - see the composer. */
    onRestore: (draft: SavedDraft) => void;
    onDelete: (key: string) => void;
}) {
    const t = useTranslations("chat");
    const format = useDisplayFormat();
    const [open, setOpen] = useState(false);

    // Closed along with the last one, rather than left open over an empty list.
    useEffect(() => {
        if (drafts.length === 0) setOpen(false);
    }, [drafts.length]);

    if (drafts.length === 0) return null;

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="mb-2 flex w-full items-center gap-2 rounded-md bg-muted/30 px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
                <FilePen className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">
                    {drafts.length === 1
                        ? t("savedDrafts.one", { excerpt: plainExcerpt(drafts[0]!.body, 80) })
                        : t("savedDrafts.many", { count: drafts.length })}
                </span>
                <span className="ml-auto shrink-0 underline-offset-2 hover:underline">
                    {t("savedDrafts.see", { count: drafts.length })}
                </span>
            </button>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{t("savedDrafts.savedDrafts")}</DialogTitle>
                        <DialogDescription>
                            {t("savedDrafts.onlyYouCanSeeThese")}
                        </DialogDescription>
                    </DialogHeader>
                    <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto overscroll-contain">
                        {drafts.map((draft) => (
                            <li
                                key={draft.key}
                                className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3"
                            >
                                <p className="whitespace-pre-wrap break-words text-sm">
                                    {plainExcerpt(draft.body, 400)}
                                </p>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs text-muted-foreground">
                                        {t("savedDrafts.savedAt", { date: format.dateTime(new Date(draft.at).toISOString()) })}
                                    </span>
                                    <span className="ml-auto flex items-center gap-1">
                                        <Button
                                            size="xs"
                                            variant="ghost"
                                            onClick={() => {
                                                setOpen(false);
                                                onRestore(draft);
                                            }}
                                        >
                                            <RotateCcw className="size-3.5" />
                                            {t("savedDrafts.restore")}
                                        </Button>
                                        <Button
                                            size="xs"
                                            variant="ghost"
                                            onClick={() => onDelete(draft.key)}
                                        >
                                            <Trash2 className="size-3.5" />
                                            {t("savedDrafts.delete")}
                                        </Button>
                                    </span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </DialogContent>
            </Dialog>
        </>
    );
}
