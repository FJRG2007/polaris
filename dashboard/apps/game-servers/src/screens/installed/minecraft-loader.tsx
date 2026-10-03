"use client";

/**
 * Which version of the mod loader this server runs, and the one way to change it.
 *
 * A loader left on "latest" asks its repository which version that is on every
 * start, so a repository that is down or changes its format stops every such
 * server from starting at all. Polaris holds the installed version instead (see
 * `lib/minecraft/loader-pin.ts`), and this card says so. Updating is a decision
 * made here, with what it risks said before it is made.
 */

import { useGameText, type GameText } from "../game-text";
import { hostUi } from "@polaris/app-host/client";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge, Button, Card, CardBody, Skeleton } from "@polaris/ui";
import type { LoaderPinView } from "../../lib/minecraft/loader-pin-service";
import { readLoaderPinAction, updateLoaderAction } from "./minecraft-actions";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

const { useConfirm } = hostUi.confirmDialog;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;

/** How old the kept reading may be and still paint first on a revisit. */
const KEPT_MS = 24 * 3_600_000;

export function MinecraftLoader({
    installedAppId,
    playersOnline,
    running,
    refresh = 0
}: {
    installedAppId: string;
    playersOnline: number;
    /** Whether the server is up, which decides whether updating restarts it. */
    running: boolean;
    /** Changes whenever something else on the page saved. */
    refresh?: number;
}) {
    const t = useGameText("minecraft");
    const [view, setView] = useState<LoaderPinView | null>(null);
    const key = `loader-pin:${installedAppId}`;
    useKeptSnapshot<LoaderPinView>(key, KEPT_MS, (kept) =>
        setView((current) => current ?? kept.value)
    );
    const heard = useRef(false);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    const read = useCallback(async () => {
        const answer = await readLoaderPinAction(installedAppId).catch(() => ({
            view: undefined,
            error: t("errors.couldNotReadTheLoader")
        }));
        if (answer.view) {
            heard.current = true;
            setView(answer.view);
            writeSnapshot(key, answer.view);
            return;
        }
        if (!heard.current) setView(null);
        setNote(answer.error ?? t("errors.couldNotReadTheLoader"));
    }, [installedAppId, key]);

    useEffect(() => {
        void read();
    }, [read, refresh]);

    // Nothing to say about a server with no mod loader, and nothing drawn for one.
    if (view?.pin.state === "none") return null;
    if (!view) {
        return note ? (
            <Card>
                <CardBody className="py-6 text-center text-sm text-muted-foreground">
                    {note}
                </CardBody>
            </Card>
        ) : (
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-64 max-w-full" />
                </CardBody>
            </Card>
        );
    }

    const pin = view.pin;

    async function update(): Promise<void> {
        if (pin.state !== "held") return;
        const body = t("loader.confirmBody", { loader: pin.loader, version: pin.version });
        const restartWords =
            playersOnline > 0
                ? t("joinPassword.playersWillDrop", { count: playersOnline })
                : t("loader.confirmRestartEmpty");
        const ok = await confirm({
            title: t("loader.confirmTitle", { loader: pin.loader }),
            description: running ? `${body} ${restartWords}` : body,
            confirmLabel: running ? t("loader.updateAndRestart") : t("loader.updateOnly")
        });
        if (!ok) return;
        setNote(null);
        startTransition(async () => {
            const answer = await updateLoaderAction(installedAppId).catch(() => ({
                restarted: undefined,
                error: t("errors.couldNotUpdateTheLoader")
            }));
            if (answer.error) {
                setNote(answer.error);
                return;
            }
            setNote(
                answer.restarted
                    ? t("loader.updateStarted", { loader: pin.loader })
                    : t("loader.updateQueued", { loader: pin.loader })
            );
            await read();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("loader.title")}</p>
                        <p className="truncate text-sm" title={labelOf(pin, t)}>
                            {labelOf(pin, t)}
                        </p>
                    </div>
                    {pin.state === "held" && !view.updating && <Badge>{t("loader.pinned")}</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                    {view.updating
                        ? t("loader.updating", { loader: pin.loader })
                        : pin.state === "held"
                          ? t("loader.heldHint", { loader: pin.loader })
                          : pin.state === "following"
                            ? t("loader.followingHint", { loader: pin.loader })
                            : pin.state === "release"
                              ? t("loader.releaseHint", { loader: pin.loader })
                              : t("loader.customHint")}
                </p>
                {pin.state === "held" && !view.updating && (
                    <div>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void update()}
                            disabled={pending}
                        >
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <RefreshCw className="size-4" />
                            )}
                            {t("loader.update")}
                        </Button>
                    </div>
                )}
                {note && <p className="text-xs text-muted-foreground">{note}</p>}
            </CardBody>
            {confirmElement}
        </Card>
    );
}

function labelOf(
    pin: Exclude<LoaderPinView["pin"], { state: "none" }>,
    t: GameText<"minecraft">
): string {
    switch (pin.state) {
        case "held":
            return t("loader.held", { loader: pin.loader, version: pin.version });
        case "custom":
            return t("loader.custom", { loader: pin.loader });
        default:
            return t("loader.following", { loader: pin.loader });
    }
}
