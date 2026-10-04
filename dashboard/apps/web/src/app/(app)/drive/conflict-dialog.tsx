"use client";

/**
 * "This name is already taken here - what should happen?" Asked before an
 * upload, a paste or a move writes anything, one clash at a time, with an
 * "Apply to all" for a batch so a folder of forty clashes is one answer rather
 * than forty. What each choice does to the file already there is said under the
 * buttons, because "Replace" means something different on a source with a bin
 * than on one without.
 */

import { useState } from "react";
import { File, Folder } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { choicesFor, decide, startQueue, type ConflictQueue } from "./conflict-queue";
import type { ClashView, ConflictChoice, ReplaceBlocked } from "@/lib/drive/conflict-types";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

/** What the dialog is asked: the clashes, whether others arrive with them, and whether
 *  the clash turned up while writing (somebody else took the name meanwhile). */
export interface ConflictRequest {
    readonly clashes: readonly ClashView[];
    readonly batch: boolean;
    readonly late?: boolean;
}

const BLOCKED_KEYS = {
    permission: "conflicts.blocked.permission",
    locked: "conflicts.blocked.locked",
    kind: "conflicts.blocked.kind",
    merge: "conflicts.blocked.merge"
} as const satisfies Record<ReplaceBlocked, string>;

const CHOICE_KEYS = {
    replace: "conflicts.replace",
    merge: "conflicts.merge",
    keepBoth: "conflicts.keepBoth",
    skip: "conflicts.skip"
} as const satisfies Record<ConflictChoice, string>;

export function ConflictDialog({
    request,
    onDone
}: {
    request: ConflictRequest | null;
    /** The decision for every clash by its path, or null when the person cancelled. */
    onDone: (decisions: Map<string, ConflictChoice> | null) => void;
}) {
    return (
        <Dialog open={request !== null} onOpenChange={(open) => !open && onDone(null)}>
            {request ? (
                // Keyed on the request, so a new question starts from its first clash.
                <ConflictBody
                    key={request.clashes.map((c) => c.path).join("\n")}
                    request={request}
                    onDone={onDone}
                />
            ) : null}
        </Dialog>
    );
}

function ConflictBody({
    request,
    onDone
}: {
    request: ConflictRequest;
    onDone: (decisions: Map<string, ConflictChoice> | null) => void;
}) {
    const t = useTranslations("drive");
    const tc = useTranslations("common");
    const [queue, setQueue] = useState<ConflictQueue>(() => startQueue(request.clashes));
    const [toAll, setToAll] = useState(false);
    const total = request.clashes.length;
    const current = queue.pending[0];
    if (!current) return null;
    const position = total - queue.pending.length + 1;
    const others = queue.pending.slice(1);
    const choices = choicesFor(current, request.batch);
    const isDir = current.existingKind === "dir";
    const Icon = isDir ? Folder : File;

    function choose(choice: ConflictChoice) {
        const next = decide(queue, choice, toAll, request.batch);
        if (next.pending.length === 0) {
            onDone(new Map(next.decided));
            return;
        }
        setQueue(next);
        setToAll(false);
    }

    return (
        <DialogContent className="max-w-lg">
            <DialogHeader>
                <DialogTitle>
                    {total > 1 ? t("conflicts.title", { count: total }) : t("conflicts.titleOne")}
                </DialogTitle>
                <DialogDescription>
                    {request.late
                        ? t("conflicts.late", { name: current.existingName })
                        : isDir
                          ? t("conflicts.existsFolder", { name: current.existingName })
                          : t("conflicts.existsFile", { name: current.existingName })}
                </DialogDescription>
            </DialogHeader>

            <div className="flex min-w-0 items-center gap-3 rounded-md bg-muted/50 px-3 py-2">
                <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={current.path}>
                        {current.path}
                    </p>
                    {total > 1 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("conflicts.position", { current: position, total })}
                        </p>
                    ) : null}
                </div>
            </div>

            <ul className="space-y-1 text-sm text-muted-foreground">
                {choices.includes("replace") ? (
                    <li>
                        {current.recoverable
                            ? t("conflicts.replaceToBin")
                            : t("conflicts.replaceForGood")}
                    </li>
                ) : null}
                {choices.includes("merge") ? <li>{t("conflicts.mergeHint")}</li> : null}
                <li>{t("conflicts.keepBothHint")}</li>
                {current.replaceBlocked ? (
                    <li>
                        {t(BLOCKED_KEYS[current.replaceBlocked], {
                            kind: current.existingKind
                        })}
                    </li>
                ) : null}
            </ul>

            {others.length > 0 ? (
                <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                        {t("conflicts.alsoTaken", { count: others.length })}
                    </p>
                    <ul className="max-h-28 space-y-0.5 overflow-y-auto text-sm">
                        {others.map((clash) => (
                            <li key={clash.path} className="truncate" title={clash.path}>
                                {clash.path}
                            </li>
                        ))}
                    </ul>
                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                            checked={toAll}
                            onChange={(event) => setToAll(event.target.checked)}
                        />
                        {t("conflicts.applyToAll", { count: queue.pending.length })}
                    </label>
                </div>
            ) : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                <Button type="button" variant="ghost" onClick={() => onDone(null)}>
                    {tc("actions.cancel")}
                </Button>
                {choices
                    .slice()
                    .reverse()
                    .map((choice) => (
                        <Button
                            key={choice}
                            type="button"
                            variant={choice === choices[0] ? "primary" : "secondary"}
                            onClick={() => choose(choice)}
                        >
                            {t(CHOICE_KEYS[choice])}
                        </Button>
                    ))}
            </div>
        </DialogContent>
    );
}
