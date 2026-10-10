"use client";

/**
 * Symbiote on the Mods tab: installed on the server in one click, and the same
 * jar handed to players for their own game.
 *
 * It runs on both sides, so a server with it and a player without it cannot
 * meet - which is why the download sits beside the install rather than in
 * another tab. Nothing restarts: the server downloads it on its next start, and
 * the card says so.
 */

import { useGameText } from "../game-text";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useState, useTransition } from "react";
import { MOD_PATH } from "../../lib/minecraft/polaris-login";
import { SYMBIOTE_FILE } from "../../lib/minecraft/symbiote";
import { Download, Loader2, Plus, Trash2 } from "lucide-react";
import type { SymbioteState } from "../../lib/minecraft/symbiote-service";
import { setSymbioteAction, symbioteStateAction } from "./symbiote-actions";
import { Badge, Button, Card, CardBody, CopyButton, Skeleton } from "@polaris/ui";

const { useConfirm } = hostUi.confirmDialog;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;
const { mergeUnchanged } = hostUi.structuralMerge;

/** How old the kept state may be and still paint first on a revisit. */
const KEPT_STATE_MS = 24 * 3_600_000;

/** Where the jar is served, on this dashboard's own address. */
const DOWNLOAD_PATH = `${MOD_PATH}/${SYMBIOTE_FILE}`;

export function SymbioteCard({
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
    const [link, setLink] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    useEffect(() => setLink(`${window.location.origin}${DOWNLOAD_PATH}`), []);

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

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">{t("symbiote.title")}</p>
                            {state?.installed && (
                                <Badge variant="success">{t("symbiote.installed")}</Badge>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">{t("symbiote.about")}</p>
                    </div>
                    {!heard && !state ? (
                        <Skeleton className="h-8 w-40" />
                    ) : (
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                            {state?.installed ? (
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
                            {fits && state?.bundled && (
                                <>
                                    <Button size="sm" variant="secondary" asChild>
                                        <a href={DOWNLOAD_PATH} download={SYMBIOTE_FILE}>
                                            <Download className="size-4" />
                                            {t("symbiote.download")}
                                        </a>
                                    </Button>
                                    {link && (
                                        <CopyButton value={link} label={t("symbiote.copyLink")} />
                                    )}
                                </>
                            )}
                        </div>
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
            </CardBody>
            {confirmElement}
        </Card>
    );
}
