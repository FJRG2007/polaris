"use client";

/**
 * Where the server keeps its world, and moving it.
 *
 * Three places, in the words of what they cost: this server (fastest, uses its
 * disk), a NAS while it is stopped (runs from this server's disk, and gives the
 * disk back while nobody plays), or a NAS all the time (slower). The copy behind
 * every change is checked before the server uses it, and what is left behind is
 * removed only after that.
 */

import { formatBytes } from "@polaris/core";
import { HardDrive, Loader2 } from "lucide-react";
import type { AppHostTypes } from "@polaris/app-host";
import { useGameText, type GameText } from "../game-text";
import { useCallback, useEffect, useState, useTransition } from "react";
import { chooseGameStorageAction, readGameStorageAction } from "./storage-actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    Skeleton
} from "@polaris/ui";

type AppStorageView = AppHostTypes["AppStorageView"];
type Mode = "server" | "park" | "nas";
type MoveState = NonNullable<AppStorageView["move"]>["state"];

const WORKING: ReadonlySet<MoveState> = new Set([
    "queued",
    "stopping",
    "copying",
    "switching",
    "starting",
    "cleaning",
    "rolling-back"
]);

/** How long a finished or failed move stays on the card. */
const RECENT_MS = 24 * 60 * 60_000;

function place(t: GameText<"games">, label: string | null): string {
    return label || t("storage.here");
}

/** The mode the controls start from: the saved one, or for a server nobody chose
 *  for yet, the one that describes where its world already is. */
function startingChoice(view: AppStorageView): { mode: Mode; connectionId: string } {
    if (view.choice)
        return { mode: view.choice.mode, connectionId: view.choice.connectionId ?? "" };
    const onNas = view.places.some((label) => label !== null);
    return {
        mode: onNas ? "nas" : "server",
        connectionId: onNas ? (view.connections[0]?.id ?? "") : ""
    };
}

function moveLine(t: GameText<"games">, move: NonNullable<AppStorageView["move"]>): string {
    const target = place(t, move.targetLabel);
    if (move.state === "copying" && move.totalBytes !== null && move.copiedBytes !== null)
        return t("storage.copying", {
            target,
            copied: formatBytes(Math.min(move.copiedBytes, move.totalBytes)),
            total: formatBytes(move.totalBytes)
        });
    return t(`storage.states.${move.state}`, { target, origin: place(t, move.originLabel) });
}

export function ServerStorage({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const t = useGameText("games");
    const [view, setView] = useState<AppStorageView | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [mode, setMode] = useState<Mode>("server");
    const [connectionId, setConnectionId] = useState<string>("");
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback(async () => {
        const next = await readGameStorageAction(installedAppId).catch(() => null);
        setView(next);
        setLoaded(true);
        return next;
    }, [installedAppId]);

    // The saved choice is what the controls start from, and again after each save.
    const adopt = useCallback((next: AppStorageView | null) => {
        if (!next) return;
        const start = startingChoice(next);
        setMode(start.mode);
        setConnectionId(start.connectionId || next.connections[0]?.id || "");
    }, []);

    useEffect(() => {
        void load().then(adopt);
    }, [load, adopt]);

    const working = view?.move ? WORKING.has(view.move.state) : false;
    useEffect(() => {
        const timer = setInterval(() => void load(), working ? 3_000 : 30_000);
        return () => clearInterval(timer);
    }, [load, working]);

    if (!loaded) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>{t("storage.title")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-2">
                    <Skeleton className="h-5 w-48" />
                    <Skeleton className="h-16 w-full" />
                </CardBody>
            </Card>
        );
    }
    if (!view) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>{t("storage.title")}</CardTitle>
                </CardHeader>
                <CardBody>
                    <p className="text-sm text-danger-ink">{t("storage.loadFailed")}</p>
                </CardBody>
            </Card>
        );
    }

    const saved = startingChoice(view);
    const wanted = mode === "server" ? null : connectionId || null;
    const unchanged = saved.mode === mode && (mode === "server" || saved.connectionId === wanted);
    const needsNas = mode !== "server" && !wanted;
    const disabledReason = !canManage
        ? t("storage.noPermission")
        : view.locked
          ? t("storage.locked")
          : view.blocked
            ? t(`storage.blocked.${view.blocked}`)
            : working
              ? t("storage.busy")
              : null;
    // A running server is stopped while its world is copied, for anything but
    // `park`, which waits until it is stopped anyway.
    // A failed move is tried again with the same choice, which Apply cannot offer.
    const retrying = unchanged && view.move?.state === "failed";
    const stopsIt = view.running && mode !== "park" && (!unchanged || retrying);

    function apply(): void {
        setConfirming(false);
        setError(null);
        startTransition(async () => {
            const result = await chooseGameStorageAction({
                installedAppId,
                mode,
                connectionId: wanted
            }).catch(() => ({ error: t("storage.refused.unexpected") }));
            if (result.error) setError(result.error);
            adopt(await load());
        });
    }

    const options: { value: Mode; title: string; hint: string; off: string | null }[] = [
        {
            value: "server",
            title: t("storage.modes.server.title"),
            hint: t("storage.modes.server.hint"),
            off: null
        },
        {
            value: "park",
            title: t("storage.modes.park.title"),
            hint: t("storage.modes.park.hint"),
            off:
                canManage && view.connections.length === 0
                    ? t("storage.noNas")
                    : !view.parkable
                      ? t("storage.notParkable")
                      : null
        },
        {
            value: "nas",
            title: t("storage.modes.nas.title"),
            hint: t("storage.modes.nas.hint"),
            off: canManage && view.connections.length === 0 ? t("storage.noNas") : null
        }
    ];
    const recent =
        view.move &&
        (WORKING.has(view.move.state) ||
            (view.move.finishedAt !== null &&
                Date.now() - Date.parse(view.move.finishedAt) < RECENT_MS));

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle>{t("storage.title")}</CardTitle>
                <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                    <HardDrive className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">
                        {t("storage.now", {
                            place: [...new Set(view.places.map((label) => place(t, label)))].join(
                                ", "
                            )
                        })}
                        {view.sizeBytes !== null ? ` - ${formatBytes(view.sizeBytes)}` : ""}
                    </span>
                </span>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <div
                    role="radiogroup"
                    aria-label={t("storage.title")}
                    className="flex flex-col gap-2"
                >
                    {options.map((option) => {
                        const selected = mode === option.value;
                        const off = disabledReason !== null || option.off !== null;
                        return (
                            <button
                                key={option.value}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                disabled={off}
                                title={option.off ?? disabledReason ?? undefined}
                                onClick={() => setMode(option.value)}
                                className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                                    selected
                                        ? "border-primary bg-primary/5"
                                        : "border-border hover:bg-muted/50"
                                }`}
                            >
                                <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
                                    {option.title}
                                    {option.value === "park" ? (
                                        <Badge variant="primary">
                                            {t("storage.modes.park.recommended")}
                                        </Badge>
                                    ) : null}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {option.off ?? option.hint}
                                </span>
                            </button>
                        );
                    })}
                </div>
                {mode !== "server" && view.connections.length > 1 ? (
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("storage.nas")}</span>
                        <Select
                            value={connectionId}
                            onValueChange={setConnectionId}
                            aria-label={t("storage.nas")}
                            disabled={disabledReason !== null}
                            options={view.connections.map((connection) => ({
                                value: connection.id,
                                label: connection.name
                            }))}
                        />
                    </label>
                ) : null}
                {disabledReason ? (
                    <p className="text-xs text-muted-foreground">{disabledReason}</p>
                ) : null}
                {view.outOfReach ? (
                    <p className="text-xs text-warning-ink">{t("storage.outOfReach")}</p>
                ) : null}
                {recent && view.move ? (
                    <div className="flex flex-col gap-1 text-xs">
                        <p className="flex items-center gap-1.5 text-muted-foreground">
                            {working ? (
                                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                            ) : null}
                            {moveLine(t, view.move)}
                        </p>
                        {view.move.state === "copying" && view.move.percent !== null ? (
                            <div
                                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                                role="progressbar"
                                aria-valuenow={view.move.percent}
                                aria-valuemin={0}
                                aria-valuemax={100}
                            >
                                <div
                                    className="h-full bg-primary"
                                    style={{ width: `${view.move.percent}%` }}
                                />
                            </div>
                        ) : null}
                        {view.move.error ? (
                            <p className="text-danger-ink">
                                {view.move.error.code === "mismatch" && view.move.error.file
                                    ? t("storage.errors.mismatchFile", { file: view.move.error.file })
                                    : t(`storage.errors.${view.move.error.code}`, {
                                          file: view.move.error.file ?? ""
                                      })}
                            </p>
                        ) : null}
                    </div>
                ) : null}
                {error ? (
                    <p role="alert" className="text-sm text-danger-ink">
                        {error}
                    </p>
                ) : null}
                <div className="flex justify-end">
                    <Button
                        size="sm"
                        disabled={
                            disabledReason !== null || (unchanged && !retrying) || needsNas || pending
                        }
                        onClick={() => (stopsIt ? setConfirming(true) : apply())}
                    >
                        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                        {retrying ? t("storage.retry") : t("storage.apply")}
                    </Button>
                </div>
            </CardBody>
            <Dialog open={confirming} onOpenChange={setConfirming}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("storage.confirmTitle")}</DialogTitle>
                        <DialogDescription>{t("storage.confirmBody")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirming(false)}>
                            {t("storage.cancel")}
                        </Button>
                        <Button onClick={apply}>{t("storage.confirm")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
