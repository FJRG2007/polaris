"use client";

/**
 * Symbiote as a row of the server's mod list, installed in one click.
 *
 * It is not a Modrinth project, so it has no icon or author of its own there:
 * it shows Polaris's mark and is credited to Polaris. Players do not download it
 * from here - the jar is not public. They get it with the mod pack's line, which
 * carries it whenever the server does. Nothing restarts: the server downloads it
 * on its next start, and the row says so.
 */

import { useGameText } from "../game-text";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useState, useTransition } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Badge, Button, Skeleton } from "@polaris/ui";
import type { SymbioteState } from "../../lib/minecraft/symbiote-service";
import { setSymbioteAction, symbioteStateAction } from "./symbiote-actions";

const { useConfirm } = hostUi.confirmDialog;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;
const { mergeUnchanged } = hostUi.structuralMerge;

/** How old the kept state may be and still paint first on a revisit. */
const KEPT_STATE_MS = 24 * 3_600_000;

/** Polaris's mark, the icon a mod Polaris carries is shown with. */
function PolarisIcon() {
    return (
        <div className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface">
            <svg
                viewBox="0 0 24 24"
                className="size-5 text-primary"
                fill="currentColor"
                aria-hidden
            >
                <path d="M12 2l1.9 6.6L20 10l-6.1 1.4L12 18l-1.9-6.6L4 10l6.1-1.4L12 2z" />
            </svg>
        </div>
    );
}

export function SymbioteRow({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const t = useGameText("minecraft");
    const stateKey = `symbiote:${installedAppId}`;
    const [state, setState] = useState<SymbioteState | null>(null);
    useKeptSnapshot<SymbioteState>(stateKey, KEPT_STATE_MS, (kept) =>
        setState((current) => current ?? kept.value)
    );
    // The kept state only paints: the buttons wait on this visit's own read.
    const [heard, setHeard] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    useEffect(() => {
        if (heard && state) writeSnapshot(stateKey, state);
    }, [heard, stateKey, state]);

    useEffect(() => {
        void symbioteStateAction(installedAppId).then((answer) => {
            const found = answer.state;
            if (found) {
                setState((current) => mergeUnchanged(current, found));
                setHeard(true);
            } else {
                setError(answer.error ?? t("symbiote.readFailed"));
            }
        });
    }, [installedAppId]);

    async function change(on: boolean): Promise<void> {
        // Asked before the transition: a dialog opened inside one is never drawn.
        if (
            !on &&
            !(await confirm({
                title: t("symbiote.removeTitle"),
                description: t("symbiote.removeBody"),
                confirmLabel: t("symbiote.remove"),
                danger: true
            }))
        ) {
            return;
        }
        setError(null);
        setNote(null);
        const before = state;
        setState((current) => (current ? { ...current, installed: on } : current));
        startTransition(async () => {
            const result = await setSymbioteAction({ installedAppId, on });
            if (result.error) {
                setState(before);
                setError(result.error);
                return;
            }
            setNote(on ? t("symbiote.installedNote") : t("symbiote.removedNote"));
        });
    }

    const fits = state?.fit === "fits";
    const blocker = !state
        ? null
        : state.fit === "loader"
          ? t("symbiote.notLoader")
          : state.fit === "release"
            ? t("symbiote.notRelease")
            : !state.bundled
              ? t("symbiote.notBundled")
              : !state.reachable && !state.installed
                ? t("symbiote.needsAddress")
                : null;
    const canInstall = canManage && heard && !pending && fits && blocker === null;

    // On another loader it is nothing this list could ever carry.
    if (state?.fit === "loader") return null;

    return (
        <li className="flex flex-col gap-2 rounded-md border border-border p-2">
            <div className="flex items-start gap-3">
                <PolarisIcon />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium">{t("symbiote.title")}</p>
                        {state?.installed && (
                            <Badge variant="success">{t("symbiote.installed")}</Badge>
                        )}
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                        {t("symbiote.about")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {t("mods.byAuthor", { name: "Polaris" })}
                    </p>
                </div>
                {!heard && !state ? (
                    <Skeleton className="h-8 w-32" />
                ) : state?.installed ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canManage || !heard || pending}
                        onClick={() => void change(false)}
                    >
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Trash2 className="size-4" />
                        )}
                        {t("symbiote.remove")}
                    </Button>
                ) : (
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={!canInstall}
                        onClick={() => void change(true)}
                    >
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Plus className="size-4" />
                        )}
                        {t("symbiote.install")}
                    </Button>
                )}
            </div>
            {blocker ? (
                <p className="text-xs text-muted-foreground">{blocker}</p>
            ) : fits ? (
                <p className="text-xs text-muted-foreground">{t("symbiote.playersNeedIt")}</p>
            ) : null}
            {fits && !canManage && (
                <p className="text-xs text-muted-foreground">{t("symbiote.onlyManagers")}</p>
            )}
            {note && <p className="text-xs text-muted-foreground">{note}</p>}
            {error && (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            )}
            {confirmElement}
        </li>
    );
}
