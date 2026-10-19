"use client";

/**
 * The owner's tunnels. The live state of every running card is read in one
 * request - from the servers, so it is slow and can fail - and until the first
 * handshake a card carries the firewall rule the operator has to add at their
 * provider, with the values to type. That rule is the one step Polaris cannot
 * take, and the handshake is how this screen knows it was taken.
 */

import { formatBytes } from "@polaris/core";
import { useRouter } from "next/navigation";
import { TunnelDialog } from "./tunnel-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Network, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { removeTunnelAction, setTunnelPausedAction } from "./actions";
import * as polls from "./tunnels-polls";
import { useUnmountSignal } from "@/lib/poll-fetch";
import type {
    TunnelOptions,
    TunnelStatus,
    TunnelView
} from "@/lib/deploy/wireguard/tunnel-service";
import {
    Badge,
    Button,
    Card,
    ConfirmDeleteDialog,
    CopyButton,
    EmptyState,
    Skeleton,
    useToast
} from "@polaris/ui";

/** How often the running cards re-read their state while the page is open. */
const POLL_MS = 15_000;

/** Called with a card's state, or null when it could not be read. */
type StatusListener = (status: TunnelStatus | null) => void;
type WatchStatus = (id: string, listener: StatusListener) => () => void;

/**
 * One read for every card that is watching: each server is reached once per
 * round however many tunnels it carries. Cards that start watching together
 * share the first read; one read at a time, so a slow server never piles them up.
 */
function useTunnelStatuses(): { watch: WatchStatus; refresh: () => void } {
    const listeners = useRef(new Map<string, StatusListener>());
    const reading = useRef(false);
    const again = useRef(false);
    const queued = useRef<ReturnType<typeof setTimeout> | null>(null);

    const signal = useUnmountSignal();
    const read = useCallback(async (): Promise<void> => {
        if (reading.current) {
            again.current = true;
            return;
        }
        const ids = [...listeners.current.keys()];
        if (ids.length === 0) return;
        reading.current = true;
        try {
            const reply = await polls.tunnelStatuses(ids, signal()).catch(() => ({
                statuses: undefined
            }));
            for (const id of ids) listeners.current.get(id)?.(reply.statuses?.[id] ?? null);
        } finally {
            reading.current = false;
        }
        if (again.current) {
            again.current = false;
            void read();
        }
    }, []);

    const refresh = useCallback(() => {
        if (queued.current) return;
        queued.current = setTimeout(() => {
            queued.current = null;
            void read();
        }, 0);
    }, [read]);

    useEffect(() => {
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void read();
        }, POLL_MS);
        return () => {
            clearInterval(timer);
            if (queued.current) clearTimeout(queued.current);
        };
    }, [read]);

    const watch = useCallback<WatchStatus>(
        (id, listener) => {
            listeners.current.set(id, listener);
            refresh();
            return () => {
                if (listeners.current.get(id) === listener) listeners.current.delete(id);
            };
        },
        [refresh]
    );

    return { watch, refresh };
}

export function TunnelsView({
    tunnels,
    options
}: {
    tunnels: TunnelView[];
    options: TunnelOptions;
}) {
    const t = useTranslations("tunnels");
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const shown = tunnels.filter((tunnel) => !hidden.has(tunnel.id));
    const statuses = useTunnelStatuses();

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex justify-end">
                <TunnelDialog options={options} />
            </div>
            {shown.length === 0 ? (
                <EmptyState
                    icon={<Network className="size-5 shrink-0" />}
                    title={t("empty.title")}
                    description={t("empty.description")}
                />
            ) : (
                shown.map((tunnel) => (
                    <TunnelCard
                        key={tunnel.id}
                        tunnel={tunnel}
                        watch={statuses.watch}
                        refresh={statuses.refresh}
                        onHide={(gone) =>
                            setHidden((current) => {
                                const next = new Set(current);
                                if (gone) next.add(tunnel.id);
                                else next.delete(tunnel.id);
                                return next;
                            })
                        }
                    />
                ))
            )}
        </div>
    );
}

const HEALTH_VARIANT = {
    up: "success",
    waiting: "warning",
    down: "danger",
    paused: "neutral",
    unknown: "neutral"
} as const;

function TunnelCard({
    tunnel,
    watch,
    refresh,
    onHide
}: {
    tunnel: TunnelView;
    watch: WatchStatus;
    refresh: () => void;
    onHide: (gone: boolean) => void;
}) {
    const t = useTranslations("tunnels");
    const toast = useToast();
    const router = useRouter();
    const [paused, setPaused] = useState(tunnel.paused);
    const [status, setStatus] = useState<TunnelStatus | null>(null);
    const [statusError, setStatusError] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirming, setConfirming] = useState(false);

    useEffect(() => setPaused(tunnel.paused), [tunnel.paused]);

    useEffect(() => {
        if (paused) return;
        return watch(tunnel.id, (next) => {
            if (next) {
                setStatus(next);
                setStatusError(false);
            } else setStatusError(true);
        });
    }, [paused, tunnel.id, watch]);

    async function togglePause(): Promise<void> {
        const next = !paused;
        setPaused(next);
        setBusy(true);
        const reply = await setTunnelPausedAction({ id: tunnel.id, paused: next });
        setBusy(false);
        if (reply.error) {
            setPaused(!next);
            toast.show({ title: reply.error });
            // A pause that stopped one end and not the other is still recorded.
            router.refresh();
            return;
        }
        setStatus(null);
        router.refresh();
    }

    async function remove(): Promise<void> {
        setConfirming(false);
        onHide(true);
        const reply = await removeTunnelAction({ id: tunnel.id });
        if (reply.error) {
            onHide(false);
            toast.show({ title: reply.error });
            // A removal that could not reach a server leaves the tunnel, paused.
            router.refresh();
            return;
        }
        router.refresh();
    }

    const health = paused ? "paused" : (status?.health ?? null);
    const waiting = !paused && status?.health === "waiting";
    const down = !paused && status?.health === "down";

    return (
        <Card className="flex min-w-0 flex-col gap-3 p-4">
            <div className="flex min-w-0 flex-wrap items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <a
                        href={`https://${tunnel.hostname}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="truncate font-medium hover:underline"
                        title={t("actions.open", { hostname: tunnel.hostname })}
                    >
                        {tunnel.hostname}
                    </a>
                    <span className="truncate text-xs text-muted-foreground">
                        {t("list.via", {
                            server: tunnel.publicServer.name,
                            port: tunnel.listenPort
                        })}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                        {t("list.service", {
                            service: tunnel.service.name,
                            project: tunnel.service.project,
                            server: tunnel.service.server
                        })}
                    </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {health ? (
                        <Badge variant={HEALTH_VARIANT[health]}>{t(`health.${health}`)}</Badge>
                    ) : (
                        <Skeleton className="h-5 w-16" />
                    )}
                    {paused ? null : (
                        <IconButton label={t("actions.refresh")} onClick={refresh}>
                            <RefreshCw />
                        </IconButton>
                    )}
                    <IconButton
                        label={paused ? t("actions.resume") : t("actions.pause")}
                        disabled={busy}
                        onClick={() => void togglePause()}
                    >
                        {paused ? <Play /> : <Pause />}
                    </IconButton>
                    <IconButton
                        label={t("actions.remove")}
                        disabled={busy}
                        onClick={() => setConfirming(true)}
                    >
                        <Trash2 />
                    </IconButton>
                </div>
            </div>

            {paused ? null : status ? (
                <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                    <Reading label={t("list.handshake")}>
                        {status.lastHandshake > 0 ? (
                            <RelativeTime
                                iso={new Date(status.lastHandshake * 1000).toISOString()}
                            />
                        ) : (
                            t("list.never")
                        )}
                    </Reading>
                    <Reading label={t("list.received")}>{formatBytes(status.rxBytes)}</Reading>
                    <Reading label={t("list.sent")}>{formatBytes(status.txBytes)}</Reading>
                </dl>
            ) : statusError ? (
                <p className="text-sm text-muted-foreground">{t("list.statusFailed")}</p>
            ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-hidden>
                    <Skeleton className="h-9" />
                    <Skeleton className="h-9" />
                    <Skeleton className="h-9" />
                </div>
            )}

            {waiting ? <FirewallStep tunnel={tunnel} /> : null}
            {down ? (
                <p className="rounded-md bg-danger-soft p-3 text-sm text-danger-ink">
                    {t("setup.down", {
                        port: tunnel.listenPort,
                        server: tunnel.publicServer.name,
                        service: tunnel.service.name
                    })}
                </p>
            ) : null}

            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                name={tunnel.hostname}
                requireTyping={false}
                kind={t("remove.kind")}
                title={t("remove.title")}
                question={t("remove.question", { hostname: tunnel.hostname })}
                confirmLabel={t("remove.confirm")}
                onConfirm={() => void remove()}
            />
        </Card>
    );
}

/** The rule to add at the public server's provider, with every value to type. */
export function FirewallStep({ tunnel }: { tunnel: TunnelView }) {
    const t = useTranslations("tunnels");
    const address = tunnel.endpointHost;
    return (
        <div className="flex min-w-0 flex-col gap-2 rounded-md bg-warning-soft p-3 text-sm text-warning-ink">
            <p className="font-medium">
                {t("setup.title", { port: tunnel.listenPort, server: tunnel.publicServer.name })}
            </p>
            <p>{t("setup.body")}</p>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {/* i18n-ignore: a protocol name, typed as is */}
                <Reading label={t("setup.protocol")}>UDP</Reading>
                <Reading label={t("setup.port")}>
                    <span className="flex items-center gap-1">
                        <code className="font-mono">{tunnel.listenPort}</code>
                        <CopyButton value={String(tunnel.listenPort)} label={t("setup.port")} />
                    </span>
                </Reading>
                <Reading label={t("setup.source")}>
                    <code className="font-mono">0.0.0.0/0</code>
                </Reading>
                <Reading label={t("setup.address")}>
                    {address ? (
                        <span className="flex min-w-0 items-center gap-1">
                            <code className="truncate font-mono" title={address}>
                                {address}
                            </code>
                            <CopyButton value={address} label={t("setup.address")} />
                        </span>
                    ) : (
                        t("setup.addressUnknown")
                    )}
                </Reading>
            </dl>
            {address ? (
                <p>
                    {t("setup.dns", {
                        hostname: tunnel.hostname,
                        address,
                        record: address.includes(":") ? "AAAA" : "A"
                    })}
                </p>
            ) : null}
        </div>
    );
}

function Reading({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs opacity-70">{label}</dt>
            <dd className="min-w-0 truncate">{children}</dd>
        </div>
    );
}

function IconButton({
    label,
    disabled,
    onClick,
    children
}: {
    label: string;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
        >
            {children}
        </Button>
    );
}
