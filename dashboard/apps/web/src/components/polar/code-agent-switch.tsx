"use client";

/**
 * Hand a running Code session to another agent or model, beside the composer.
 * The picker offers the person's own sources that can sign in, the ones a start
 * offers; the server resolves the pick again and refuses one that is not
 * theirs. The switch shows at once and goes back if the server refuses it; on
 * success the new session, carrying the conversation, opens here.
 */

import { useCallback, useState } from "react";
import { ArrowLeftRight, LoaderCircle } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";
import { fromWire } from "@/lib/app-bundles/wire";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CodeModelPicker } from "@/components/polar/code-model-picker";
import type { CodePick, CodeSource } from "@/lib/polar/agents/code-sources";

/** Sources the switch may offer: any that can sign in. */
export function switchableSources(sources: readonly CodeSource[]): CodeSource[] {
    return sources.filter((source) => source.readiness !== "missing");
}

async function readChoices(): Promise<readonly CodeSource[]> {
    const response = await fetch("/api/polar/code/choices", { cache: "no-store" });
    if (!response.ok) throw new Error(`choices answered ${response.status}`);
    const answer = fromWire(((await response.json()) as { value?: unknown }).value) as {
        code?: { sources?: readonly CodeSource[] };
    } | null;
    return answer?.code?.sources ?? [];
}

export function CodeAgentSwitch({
    sessionId,
    disabled = false,
    onSwitched,
    onError
}: {
    sessionId: string;
    disabled?: boolean;
    /** Opens the session that carries on. */
    onSwitched: (id: string) => void;
    onError: (message: string | null) => void;
}) {
    const t = useTranslations("agents");
    const [open, setOpen] = useState(false);
    const [sources, setSources] = useState<readonly CodeSource[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [pick, setPick] = useState<CodePick | null>(null);
    const [switching, setSwitching] = useState(false);

    const load = useCallback(() => {
        setFailed(false);
        void readChoices()
            .then((loaded) => setSources(switchableSources(loaded)))
            .catch(() => setFailed(true));
    }, []);

    const confirm = () => {
        if (!pick || switching) return;
        // Shown at once: the dialog closes and the button says it is switching.
        setOpen(false);
        setSwitching(true);
        onError(null);
        void fetch("/api/polar/code/switch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, pick })
        })
            .then(async (response) => {
                if (!response.ok) throw new Error("");
                const answer = fromWire(((await response.json()) as { value?: unknown }).value) as {
                    id?: string;
                    error?: string;
                } | null;
                if (!answer?.id) throw new Error(answer?.error ?? "");
                onSwitched(answer.id);
            })
            .catch((error: unknown) => {
                // Put back: the dialog reopens on the same pick.
                setOpen(true);
                onError(error instanceof Error && error.message ? error.message : t("session.switch.errors.failed"));
            })
            .finally(() => setSwitching(false));
    };

    return (
        <>
            <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 min-w-0 max-w-48 gap-1.5 px-2 text-xs"
                disabled={disabled || switching}
                aria-label={t("session.switch.title")}
                title={t("session.switch.title")}
                onClick={() => {
                    setOpen(true);
                    load();
                }}
            >
                {switching ? (
                    <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
                ) : (
                    <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 truncate">
                    {switching ? t("session.switch.switching") : t("session.switch.button")}
                </span>
            </Button>
            <Dialog open={open} onOpenChange={(next) => (switching ? undefined : setOpen(next))}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("session.switch.title")}</DialogTitle>
                        <DialogDescription>{t("session.switch.intro")}</DialogDescription>
                    </DialogHeader>
                    <div className="flex min-w-0 flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">{t("session.switch.pick")}</span>
                        {sources !== null && sources.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("session.switch.none")}</p>
                        ) : (
                            <CodeModelPicker
                                sources={sources}
                                value={pick}
                                onChange={setPick}
                                automatic={false}
                                disabled={switching}
                            />
                        )}
                        {failed ? <p className="text-xs text-destructive">{t("session.switch.loadFailed")}</p> : null}
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={switching} onClick={() => setOpen(false)}>
                            {t("session.switch.cancel")}
                        </Button>
                        <Button type="button" disabled={!pick || switching} onClick={confirm}>
                            {t("session.switch.confirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
