"use client";

/**
 * Storage locations: where service data lives, how full each place is, and the
 * moves between them. Every region loads on its own, so the page draws at once
 * and only the part still waiting shows a skeleton.
 */

import Link from "next/link";
import { formatBytes } from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { useLiveRead } from "@/components/use-live-resource";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowRight, HardDrive, Loader2, Network, PlugZap, Plus, Server } from "lucide-react";
import {
    locationError,
    locationInputSchema,
    normalizeLocationInput
} from "@/lib/storage-moves/location-input";
import type {
    LocationsView,
    MoveError,
    MoveView,
    SpaceResult,
    VolumeLocationView
} from "@/lib/storage-moves/service";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    SegmentedControl,
    Select,
    Skeleton,
    cn
} from "@polaris/ui";
import * as actions from "./actions";

type T = ReturnType<typeof useTranslations<"admin">>;

const WORKING = new Set([
    "queued",
    "stopping",
    "copying",
    "switching",
    "starting",
    "cleaning",
    "rolling-back"
]);

function Meter({
    used,
    total,
    tone
}: {
    used: number;
    total: number;
    tone?: "warning" | "danger";
}) {
    const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
    return (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
            <div
                className={cn(
                    "h-full rounded-full",
                    tone === "danger"
                        ? "bg-danger"
                        : tone === "warning"
                          ? "bg-warning"
                          : "bg-primary"
                )}
                style={{ width: `${percent}%` }}
            />
        </div>
    );
}

function protocolLabel(t: T, kind: string): string {
    if (kind === "smb") return t("storage.protocols.smb");
    if (kind === "nfs") return t("storage.protocols.nfs");
    return t("storage.protocols.unas");
}

function NasSpace({ id, t, version }: { id: string; t: T; version: number }) {
    const [result, setResult] = useState<SpaceResult | null>(null);
    const [busy, setBusy] = useState(false);
    const test = useCallback(async () => {
        setBusy(true);
        const answer = await runAction(
            () => actions.locationSpaceAction(id),
            () => undefined
        );
        setResult(answer ?? { ok: false, reason: "unreachable" });
        setBusy(false);
    }, [id]);
    useEffect(() => void test(), [test, version]);

    let text: string;
    let failed = false;
    if (!result) text = t("storage.locations.checking");
    else if (result.ok)
        text =
            result.free !== null && result.total !== null
                ? t("storage.locations.freeOf", {
                      free: formatBytes(result.free),
                      total: formatBytes(result.total)
                  })
                : t("storage.locations.connectedNoSize");
    else {
        failed = true;
        text =
            result.reason === "denied"
                ? t("storage.locations.denied")
                : result.reason === "notMounted"
                  ? t("storage.locations.notMounted")
                  : result.reason === "missing"
                    ? t("storage.locations.missing")
                    : t("storage.locations.unreachable");
    }
    return (
        <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
                {result?.ok && result.used !== null && result.total ? (
                    <Meter used={result.used} total={result.total} />
                ) : null}
                <p
                    className={cn(
                        "mt-1 truncate text-xs",
                        failed ? "text-danger-ink" : "text-muted-foreground"
                    )}
                    title={text}
                >
                    {text}
                </p>
            </div>
            <Button
                size="icon"
                variant="ghost"
                aria-label={t("storage.locations.test")}
                title={t("storage.locations.test")}
                disabled={busy}
                onClick={() => void test()}
            >
                {busy ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                    <PlugZap className="size-4" aria-hidden />
                )}
            </Button>
        </div>
    );
}

const EMPTY_FORM = {
    name: "",
    protocol: "smb" as "smb" | "nfs",
    host: "",
    path: "",
    username: "",
    password: "",
    domain: ""
};

type FieldErrors = Partial<
    Record<"name" | "host" | "path" | "username" | "password" | "domain", string>
>;

function AddLocationDialog({
    open,
    onOpenChange,
    onAdded,
    t
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdded: () => void;
    t: T;
}) {
    const [form, setForm] = useState(EMPTY_FORM);
    const [touched, setTouched] = useState<Record<string, boolean>>({});
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!open) {
            setForm(EMPTY_FORM);
            setTouched({});
            setError(null);
        }
    }, [open]);

    const parsed = useMemo(
        () => locationInputSchema.safeParse(normalizeLocationInput(form)),
        [form]
    );
    const errors: FieldErrors = {};
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            const field = issue.path[0] as keyof FieldErrors;
            // An empty field is unfinished, not wrong: the asterisk says so.
            if (!errors[field] && form[field]?.trim()) errors[field] = issue.message;
        }
    }
    const message = (code: string | undefined) =>
        code ? t(`storage.form.errors.${locationError(code)}`) : undefined;
    const set = (key: keyof typeof EMPTY_FORM, value: string) => {
        setForm((previous) => ({ ...previous, [key]: value }));
        setTouched((previous) => ({ ...previous, [key]: true }));
    };

    const submit = async () => {
        if (!parsed.success) return;
        setPending(true);
        setError(null);
        const result = await runAction(() => actions.addLocationAction(form), setError);
        setPending(false);
        if (!result) return;
        if (result.error) return setError(result.error);
        onAdded();
        onOpenChange(false);
    };

    const field = (
        key: "name" | "host" | "path" | "username" | "password" | "domain",
        label: string,
        options: {
            required?: boolean;
            type?: string;
            placeholder?: string;
            autoComplete?: string;
        } = {}
    ) => {
        const shown = touched[key] ? message(errors[key]) : undefined;
        return (
            <label className="flex min-w-0 flex-col gap-1 text-sm">
                <span className="font-medium">
                    {label}
                    {options.required ? <span aria-hidden> *</span> : null}
                </span>
                <Input
                    value={form[key]}
                    type={options.type ?? "text"}
                    placeholder={options.placeholder}
                    autoComplete={options.autoComplete ?? "off"}
                    aria-invalid={shown ? true : undefined}
                    onChange={(event) => set(key, event.target.value)}
                />
                {shown ? <span className="text-xs text-danger-ink">{shown}</span> : null}
            </label>
        );
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("storage.form.title")}</DialogTitle>
                    <DialogDescription>{t("storage.form.description")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <SegmentedControl
                        aria-label={t("storage.form.protocol")}
                        value={form.protocol}
                        onValueChange={(value) =>
                            setForm((previous) => ({ ...previous, protocol: value }))
                        }
                        options={[
                            { value: "smb", label: t("storage.protocols.smb") },
                            { value: "nfs", label: t("storage.protocols.nfs") }
                        ]}
                    />
                    {field("name", t("storage.form.name"), {
                        required: true,
                        placeholder: t("storage.form.namePlaceholder")
                    })}
                    {field("host", t("storage.form.host"), {
                        required: true,
                        placeholder: "nas.local"
                    })}
                    {form.protocol === "smb"
                        ? field("path", t("storage.form.share"), {
                              required: true,
                              placeholder: "data"
                          })
                        : field("path", t("storage.form.export"), {
                              required: true,
                              placeholder: "/volume1/data"
                          })}
                    {form.protocol === "smb" ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                            {field("username", t("storage.form.username"), {
                                autoComplete: "username"
                            })}
                            {field("password", t("storage.form.password"), {
                                type: "password",
                                autoComplete: "new-password"
                            })}
                        </div>
                    ) : (
                        <p className="text-xs text-muted-foreground">{t("storage.form.nfsHint")}</p>
                    )}
                    {form.protocol === "smb" ? field("domain", t("storage.form.domain")) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-danger-ink">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("storage.form.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={pending}
                            aria-disabled={!parsed.success || pending}
                        >
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" aria-hidden />
                            ) : null}
                            {t("storage.form.submit")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function MoveDialog({
    volume,
    onOpenChange,
    onStarted,
    serverName,
    t
}: {
    volume: VolumeLocationView | null;
    onOpenChange: (open: boolean) => void;
    onStarted: () => void;
    serverName: (label: string | null) => string;
    t: T;
}) {
    const [destination, setDestination] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        setDestination(volume?.destinations[0]?.value ?? "");
        setError(null);
    }, [volume]);
    if (!volume) return null;

    const start = async () => {
        setPending(true);
        setError(null);
        const result = await runAction(
            () => actions.startMoveAction({ volumeId: volume.id, destination }),
            setError
        );
        setPending(false);
        if (!result) return;
        if (result.error) return setError(result.error);
        onStarted();
        onOpenChange(false);
    };

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {t("storage.move.title", { volume: volume.name, app: volume.appName })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("storage.move.description", { app: volume.appName })}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 text-sm">
                    <p className="text-muted-foreground">
                        {t("storage.move.from", { location: serverName(volume.locationLabel) })}
                    </p>
                    <label className="flex flex-col gap-1">
                        <span className="font-medium">{t("storage.move.to")}</span>
                        <Select
                            value={destination}
                            onValueChange={setDestination}
                            aria-label={t("storage.move.to")}
                            options={volume.destinations.map((option) => ({
                                value: option.value,
                                label: serverName(option.label)
                            }))}
                        />
                    </label>
                    {error ? (
                        <p role="alert" className="text-danger-ink">
                            {error}
                        </p>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {t("storage.form.cancel")}
                    </Button>
                    <Button disabled={pending || !destination} onClick={() => void start()}>
                        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                        {t("storage.move.start")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function errorText(t: T, error: MoveError): string {
    const base = (() => {
        switch (error.code) {
            case "noSpace":
                return error.freeBytes !== undefined && error.neededBytes !== undefined
                    ? t("storage.errors.noSpaceSized", {
                          free: formatBytes(error.freeBytes),
                          needed: formatBytes(error.neededBytes)
                      })
                    : t("storage.errors.noSpace");
            case "mismatch":
                return t("storage.errors.mismatch");
            case "unreadable":
                return t("storage.errors.unreadable");
            case "unwritable":
                return t("storage.errors.unwritable");
            case "mount":
                return t("storage.errors.mount");
            case "stillRunning":
                return t("storage.errors.stillRunning");
            case "startFailed":
                return t("storage.errors.startFailed");
            case "gone":
                return t("storage.errors.gone");
            case "cleanFailed":
                return t("storage.errors.cleanFailed");
            case "originShared":
                return t("storage.errors.originShared");
            case "copy":
                return t("storage.errors.copy");
            default:
                return t("storage.errors.unexpected");
        }
    })();
    if (error.notRestored) return `${base} ${t("storage.errors.notRestored")}`;
    return error.notRestarted ? `${base} ${t("storage.errors.notRestarted")}` : base;
}

function stateLabel(t: T, state: MoveView["state"]): string {
    const labels: Record<MoveView["state"], string> = {
        queued: t("storage.states.queued"),
        stopping: t("storage.states.stopping"),
        copying: t("storage.states.copying"),
        switching: t("storage.states.switching"),
        starting: t("storage.states.starting"),
        moved: t("storage.states.moved"),
        cleaning: t("storage.states.cleaning"),
        finished: t("storage.states.finished"),
        "rolling-back": t("storage.states.rollingBack"),
        failed: t("storage.states.failed")
    };
    return labels[state];
}

function MoveRow({
    move,
    t,
    serverName,
    onChanged
}: {
    move: MoveView;
    t: T;
    serverName: (label: string | null) => string;
    onChanged: () => void;
}) {
    const [confirming, setConfirming] = useState(false);
    const [pending, setPending] = useState<"remove" | "keep" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const answer = async (choice: "remove" | "keep") => {
        setPending(choice);
        setError(null);
        const result = await runAction(
            () => actions.answerMoveAction({ id: move.id, answer: choice }),
            setError
        );
        setPending(null);
        if (result?.error) return setError(result.error);
        if (result) {
            setConfirming(false);
            onChanged();
        }
    };
    const working = WORKING.has(move.state);
    const tone =
        move.state === "failed"
            ? "danger"
            : move.state === "moved"
              ? "warning"
              : move.state === "finished"
                ? "success"
                : "neutral";
    return (
        <li className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span
                    className="min-w-0 truncate font-medium"
                    title={`${move.volumeName} - ${move.appName}`}
                >
                    {t("storage.moves.what", {
                        volume: move.volumeName || t("storage.moves.removedVolume"),
                        app: move.appName || t("storage.moves.removedApp")
                    })}
                </span>
                <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                    <span className="truncate">{serverName(move.originLabel)}</span>
                    <ArrowRight className="size-3.5 shrink-0" aria-label={t("storage.moves.to")} />
                    <span className="truncate">{serverName(move.targetLabel)}</span>
                </span>
                <Badge variant={tone} className="ml-auto">
                    {working ? <Loader2 className="mr-1 size-3 animate-spin" aria-hidden /> : null}
                    {stateLabel(t, move.state)}
                </Badge>
            </div>
            {move.state === "copying" ? (
                <div className="flex flex-col gap-1">
                    <Meter used={move.percent ?? 0} total={100} />
                    <p className="text-xs text-muted-foreground">
                        {move.totalBytes !== null && move.copiedBytes !== null
                            ? t("storage.moves.progress", {
                                  copied: formatBytes(Math.min(move.copiedBytes, move.totalBytes)),
                                  total: formatBytes(move.totalBytes)
                              })
                            : t("storage.moves.measuring")}
                    </p>
                </div>
            ) : null}
            {move.error && !(move.originShared && move.error.code === "originShared") ? (
                <div className="text-xs text-danger-ink">
                    <p>{errorText(t, move.error)}</p>
                    {move.error.detail ? (
                        <p className="mt-0.5 break-words font-mono opacity-80">
                            {move.error.detail}
                        </p>
                    ) : null}
                </div>
            ) : null}
            {move.state === "moved" ? (
                <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                        {move.originShared
                            ? t("storage.moves.sharedHint", {
                                  origin: serverName(move.originLabel)
                              })
                            : t("storage.moves.keptHint", { origin: serverName(move.originLabel) })}
                    </p>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending !== null}
                        onClick={() => void answer("keep")}
                    >
                        {pending === "keep" ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : null}
                        {t("storage.moves.keep")}
                    </Button>
                    {move.originShared ? null : (
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={pending !== null}
                            onClick={() => setConfirming(true)}
                        >
                            {t("storage.moves.remove")}
                        </Button>
                    )}
                </div>
            ) : null}
            {move.state === "finished" ? (
                <p className="text-xs text-muted-foreground">
                    {move.originRemoved
                        ? t("storage.moves.removedHint")
                        : t("storage.moves.keptDone", { origin: serverName(move.originLabel) })}
                </p>
            ) : null}
            {error && !confirming ? <p className="text-xs text-danger-ink">{error}</p> : null}
            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                requireTyping={false}
                name={move.volumeName}
                kind={t("storage.moves.removeKind")}
                title={t("storage.moves.removeTitle")}
                question={t("storage.moves.removeQuestion", {
                    volume: move.volumeName,
                    origin: serverName(move.originLabel)
                })}
                description={t("storage.moves.removeDescription", {
                    target: serverName(move.targetLabel)
                })}
                confirmLabel={t("storage.moves.remove")}
                pending={pending === "remove"}
                error={confirming ? error : null}
                onConfirm={() => void answer("remove")}
            />
        </li>
    );
}

export function StorageView() {
    const t = useTranslations("admin");
    const serverName = useCallback((label: string | null) => label ?? t("storage.thisServer"), [t]);
    const [adding, setAdding] = useState(false);
    const [moving, setMoving] = useState<VolumeLocationView | null>(null);
    const [version, setVersion] = useState(0);

    const locations = useLiveRead<LocationsView>({
        load: useCallback(() => actions.locationsAction(), []),
        cacheKey: "admin-storage-locations",
        intervalMs: 60_000
    });
    const volumes = useLiveRead<VolumeLocationView[]>({
        load: useCallback(() => actions.volumeLocationsAction(), []),
        cacheKey: "admin-storage-volumes",
        intervalMs: 30_000
    });
    const active = (moves: MoveView[] | null) =>
        (moves ?? []).some((move) => WORKING.has(move.state));
    const [fast, setFast] = useState(false);
    const moves = useLiveRead<MoveView[]>({
        load: useCallback(() => actions.movesAction(), []),
        cacheKey: "admin-storage-moves",
        intervalMs: fast ? 3_000 : 30_000
    });
    useEffect(() => setFast(active(moves.data)), [moves.data]);

    const refreshAll = () => {
        locations.refresh();
        volumes.refresh();
        moves.refresh();
    };

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                    <CardTitle>{t("storage.locations.title")}</CardTitle>
                    <Button size="sm" onClick={() => setAdding(true)}>
                        <Plus className="size-4" aria-hidden />
                        {t("storage.locations.add")}
                    </Button>
                </CardHeader>
                <CardBody className="flex flex-col divide-y divide-border">
                    {locations.loading ? (
                        <div className="flex flex-col gap-3 py-2">
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </div>
                    ) : locations.error ? (
                        <p className="py-2 text-sm text-danger-ink">{t("storage.loadFailed")}</p>
                    ) : (
                        <>
                            {(locations.data?.servers ?? []).map((server) => (
                                <div key={server.machine} className="flex items-center gap-3 py-3">
                                    <Server
                                        className="size-4 shrink-0 text-muted-foreground"
                                        aria-hidden
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">
                                            {serverName(server.name)}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {t("storage.locations.serverKind")}
                                        </p>
                                    </div>
                                    <div className="w-40 shrink-0 sm:w-56">
                                        <Meter
                                            used={server.total - server.free}
                                            total={server.total}
                                            tone={
                                                server.level === "critical"
                                                    ? "danger"
                                                    : server.level === "low"
                                                      ? "warning"
                                                      : undefined
                                            }
                                        />
                                        <p className="mt-1 truncate text-xs text-muted-foreground">
                                            {t("storage.locations.freeOf", {
                                                free: formatBytes(server.free),
                                                total: formatBytes(server.total)
                                            })}
                                        </p>
                                    </div>
                                </div>
                            ))}
                            {(locations.data?.nas ?? []).map((nas) => (
                                <div key={nas.id} className="flex items-center gap-3 py-3">
                                    <Network
                                        className="size-4 shrink-0 text-muted-foreground"
                                        aria-hidden
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                            <span className="truncate" title={nas.name}>
                                                {nas.name}
                                            </span>
                                            <Badge>{protocolLabel(t, nas.kind)}</Badge>
                                        </p>
                                        <p
                                            className="truncate text-xs text-muted-foreground"
                                            title={nas.address}
                                        >
                                            {nas.address}
                                            {" - "}
                                            {t("storage.locations.volumes", { count: nas.volumes })}
                                            {nas.ownerName
                                                ? ` - ${t("storage.locations.owner", { name: nas.ownerName })}`
                                                : ""}
                                        </p>
                                    </div>
                                    <div className="w-40 shrink-0 sm:w-56">
                                        <NasSpace id={nas.id} t={t} version={version} />
                                    </div>
                                </div>
                            ))}
                            {(locations.data?.nas ?? []).length === 0 ? (
                                <p className="py-3 text-sm text-muted-foreground">
                                    {t("storage.locations.noNas")}
                                </p>
                            ) : (
                                <p className="pt-3 text-xs text-muted-foreground">
                                    {t("storage.locations.manageHint")}{" "}
                                    <Link href="/drive" className="underline">
                                        {t("storage.locations.manageLink")}
                                    </Link>
                                </p>
                            )}
                        </>
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("storage.moves.title")}</CardTitle>
                </CardHeader>
                <CardBody>
                    {moves.loading ? (
                        <Skeleton className="h-12 w-full" />
                    ) : moves.error ? (
                        <p className="text-sm text-danger-ink">{t("storage.loadFailed")}</p>
                    ) : (moves.data ?? []).length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("storage.moves.empty")}</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {(moves.data ?? []).map((move) => (
                                <MoveRow
                                    key={move.id}
                                    move={move}
                                    t={t}
                                    serverName={serverName}
                                    onChanged={refreshAll}
                                />
                            ))}
                        </ul>
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("storage.volumes.title")}</CardTitle>
                    <p className="text-sm text-muted-foreground">
                        {t("storage.volumes.description")}
                    </p>
                </CardHeader>
                <CardBody>
                    {volumes.loading ? (
                        <div className="flex flex-col gap-3">
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </div>
                    ) : volumes.error ? (
                        <p className="text-sm text-danger-ink">{t("storage.loadFailed")}</p>
                    ) : (volumes.data ?? []).length === 0 ? (
                        <EmptyState
                            icon={<HardDrive className="size-5" aria-hidden />}
                            title={t("storage.volumes.empty")}
                        />
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {(volumes.data ?? []).map((volume) => {
                                const blocked = volume.busy
                                    ? t("storage.volumes.busy")
                                    : !volume.deployed
                                      ? t("storage.volumes.notDeployed")
                                      : volume.swarm
                                        ? t("storage.volumes.swarm")
                                        : volume.destinations.length === 0
                                          ? t("storage.volumes.nowhere")
                                          : null;
                                return (
                                    <li
                                        key={volume.id}
                                        className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                                <Link
                                                    href={`/apps/deploy/${volume.projectId}?service=${encodeURIComponent(volume.applicationId)}`}
                                                    className="truncate hover:underline"
                                                    title={`${volume.appName} (${volume.projectName})`}
                                                >
                                                    {volume.appName}
                                                </Link>
                                                {volume.game ? (
                                                    <Badge variant="primary">
                                                        {t("storage.volumes.game")}
                                                    </Badge>
                                                ) : null}
                                            </p>
                                            <p
                                                className="truncate text-xs text-muted-foreground"
                                                title={`${volume.name} - ${volume.mountPath}`}
                                            >
                                                {volume.name} - {volume.mountPath}
                                            </p>
                                        </div>
                                        <span
                                            className="min-w-0 max-w-full truncate text-sm text-muted-foreground sm:max-w-[14rem]"
                                            title={serverName(volume.locationLabel)}
                                        >
                                            {serverName(volume.locationLabel)}
                                        </span>
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            disabled={blocked !== null}
                                            title={blocked ?? undefined}
                                            onClick={() => setMoving(volume)}
                                        >
                                            {t("storage.volumes.move")}
                                        </Button>
                                        {blocked ? (
                                            <p className="w-full text-xs text-muted-foreground">
                                                {blocked}
                                            </p>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </CardBody>
            </Card>

            <AddLocationDialog
                open={adding}
                onOpenChange={setAdding}
                onAdded={() => {
                    setVersion((value) => value + 1);
                    refreshAll();
                }}
                t={t}
            />
            <MoveDialog
                volume={moving}
                onOpenChange={(open) => (open ? undefined : setMoving(null))}
                onStarted={refreshAll}
                serverName={serverName}
                t={t}
            />
        </div>
    );
}
