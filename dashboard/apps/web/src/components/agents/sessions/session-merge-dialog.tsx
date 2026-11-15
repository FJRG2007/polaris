"use client";

/**
 * The merge confirmation, shared by the checks bar and the pull request tab.
 * The merge itself is GitHub's: branch protection, required checks and the
 * person's own permission are enforced there, and its refusal is what shows
 * here. Given the head commit that was read, GitHub refuses the merge if the
 * branch moved since.
 */

import { Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select
} from "@polaris/ui";
import { mergeSessionPullAction } from "./actions";

type MergeMethod = "squash" | "merge" | "rebase";

export function SessionMergeDialog({
    sessionId,
    number,
    sha,
    description,
    onClose,
    onMerged
}: {
    sessionId: string;
    number: number;
    /** The head commit the person is looking at, when known. */
    sha?: string;
    description: string;
    onClose: () => void;
    onMerged: () => void;
}) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const [method, setMethod] = useState<MergeMethod>("squash");
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    const merge = () =>
        startTransition(async () => {
            setError(null);
            const result = await runAction(
                () => mergeSessionPullAction({ sessionId, method, ...(sha ? { sha } : {}) }),
                setError
            );
            if (!result) return;
            if (result.error) {
                setError(result.error);
                return;
            }
            onMerged();
        });

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("session.merge.title", { number })}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="space-y-1">
                        <label className="text-sm font-medium">{t("session.merge.method")}</label>
                        <Select
                            value={method}
                            onValueChange={(next) => setMethod(next as MergeMethod)}
                            options={(["squash", "merge", "rebase"] as const).map((value) => ({
                                value,
                                label: t(`session.merge.methods.${value}`)
                            }))}
                        />
                    </div>
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                        {tcommon("actions.cancel")}
                    </Button>
                    <Button onClick={merge} disabled={busy}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {busy ? t("session.merge.merging") : t("session.merge.submit")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
