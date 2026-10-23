"use client";

/**
 * Backup access: how the domain stays reachable from outside when the home line
 * stops taking visitors. The operator picks the path and the mode; the card shows
 * which path serves the domain now, the last flip, and how long each path takes
 * to answer, refreshed in the background.
 */

import Link from "next/link";
import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { Button, Skeleton } from "@polaris/ui";
import { saveBackupAccessAction } from "./actions";
import { PageSection } from "@/components/page-section";
import { RelativeTime } from "@/components/relative-time";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { BackupConfig, BackupView } from "@/lib/backup-access/service";

const STATUS_URL = "/api/admin/domains/backup-access";
const MODES = ["automatic", "always", "manual"] as const;

export function BackupAccessCard() {
    const t = useTranslations("admin");
    const live = useLiveResource<BackupView>({
        url: STATUS_URL,
        cacheKey: "admin.backupAccess",
        intervalMs: 30_000,
        select: (body) => body as BackupView
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const view = live.data;

    async function save(change: Partial<BackupConfig>) {
        if (!view) return;
        const next = { ...view.config, ...change };
        if (JSON.stringify(next) === JSON.stringify(view.config)) return;
        const before = view;
        live.replace({ ...view, config: next });
        setBusy(true);
        setError("");
        const result = await runAction(() => saveBackupAccessAction(next), setError);
        setBusy(false);
        live.replace(result ?? before);
    }

    if (view && !view.configured) return null;

    return (
        <PageSection
            id="backup-access"
            title={t("domains.backup.title")}
            description={t("domains.backup.description")}
        >
            {!view ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-56" />
                    <Skeleton className="h-4 w-72" />
                    <Skeleton className="h-4 w-48" />
                </div>
            ) : (
                <div className="flex flex-col gap-4 text-sm">
                    <StateLine view={view} />

                    <Choice label={t("domains.backup.path")}>
                        <Pick
                            on={view.config.path === null}
                            disabled={busy}
                            onClick={() => void save({ path: null })}
                        >
                            {t("domains.backup.paths.off")}
                        </Pick>
                        <Pick
                            on={view.config.path === "tunnel"}
                            disabled={busy || !view.cloudflare}
                            title={view.cloudflare ? undefined : t("domains.backup.needsToken")}
                            onClick={() => void save({ path: "tunnel" })}
                        >
                            {t("domains.backup.paths.tunnel")}
                        </Pick>
                        <Pick
                            on={view.config.path === "relay"}
                            disabled={busy || view.servers.length === 0}
                            title={
                                view.servers.length === 0
                                    ? t("domains.backup.needsServer")
                                    : undefined
                            }
                            onClick={() =>
                                void save({
                                    path: "relay",
                                    relayTargetId:
                                        view.config.relayTargetId ?? view.servers[0]?.id ?? null
                                })
                            }
                        >
                            {t("domains.backup.paths.relay")}
                        </Pick>
                    </Choice>

                    {!view.cloudflare ? (
                        <p className="text-xs text-muted-foreground">
                            {t.rich("domains.backup.connectCloudflare", {
                                link: (chunks: React.ReactNode) => (
                                    <Link
                                        key="link"
                                        href="/admin/integrations"
                                        className="text-primary hover:underline"
                                    >
                                        {chunks}
                                    </Link>
                                )
                            })}
                        </p>
                    ) : null}

                    {view.config.path === "relay" && view.servers.length > 0 ? (
                        <Choice label={t("domains.backup.server")}>
                            {view.servers.map((server) => (
                                <Pick
                                    key={server.id}
                                    on={view.config.relayTargetId === server.id}
                                    disabled={busy}
                                    title={server.name}
                                    onClick={() => void save({ relayTargetId: server.id })}
                                >
                                    <span className="max-w-48 truncate">{server.name}</span>
                                </Pick>
                            ))}
                        </Choice>
                    ) : null}

                    {view.config.path ? (
                        <>
                            <Choice label={t("domains.backup.mode")}>
                                {MODES.map((mode) => (
                                    <Pick
                                        key={mode}
                                        on={view.config.mode === mode}
                                        disabled={busy}
                                        onClick={() => void save({ mode })}
                                    >
                                        {t(`domains.backup.modes.${mode}`)}
                                    </Pick>
                                ))}
                            </Choice>
                            {view.config.mode === "manual" ? (
                                <div>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        disabled={busy}
                                        onClick={() =>
                                            void save({ manualOn: !view.config.manualOn })
                                        }
                                    >
                                        {view.config.manualOn
                                            ? t("domains.backup.useDirect")
                                            : t("domains.backup.useBackup")}
                                    </Button>
                                </div>
                            ) : null}
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    checked={view.config.dataSaver}
                                    disabled={busy}
                                    onChange={(event) =>
                                        void save({ dataSaver: event.target.checked })
                                    }
                                />
                                <span className="min-w-0">
                                    {t("domains.backup.dataSaver")}
                                    <span className="block text-xs text-muted-foreground">
                                        {t("domains.backup.dataSaverHint")}
                                    </span>
                                </span>
                            </label>
                        </>
                    ) : null}

                    <Latency view={view} />
                    <Problem view={view} />

                    {view.relay && view.relay.tcp.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("domains.backup.tcpCarried", { ports: view.relay.tcp.join(", ") })}
                        </p>
                    ) : null}
                    {view.relay && view.relay.skippedUdp.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("domains.backup.udpSkipped", {
                                ports: view.relay.skippedUdp.join(", ")
                            })}
                        </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">{t("domains.backup.physics")}</p>
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
            )}
        </PageSection>
    );
}

function Choice({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div role="group" aria-label={label} className="flex flex-wrap gap-2">
                {children}
            </div>
        </div>
    );
}

function Pick(props: {
    on: boolean;
    disabled?: boolean;
    title?: string;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <Button
            size="sm"
            variant={props.on ? "primary" : "secondary"}
            aria-pressed={props.on}
            disabled={props.disabled}
            title={props.title}
            onClick={props.onClick}
        >
            {props.children}
        </Button>
    );
}

function StateLine({ view }: { view: BackupView }) {
    const t = useTranslations("admin");
    const { state, probe } = view;
    let line: React.ReactNode;
    if (probe?.verdict === "no-uplink" || !state.uplink)
        line = <span className="text-danger">{t("domains.backup.state.noUplink")}</span>;
    else if (state.serving === "backup")
        line = (
            <span className="text-warning">
                {t("domains.backup.state.backup")}{" "}
                {state.since ? <RelativeTime iso={state.since} /> : null}
            </span>
        );
    else line = <span className="text-success">{t("domains.backup.state.direct")}</span>;
    return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("domains.backup.now")}</dt>
            <dd className="min-w-0 truncate">{line}</dd>
            <dt className="text-muted-foreground">{t("domains.backup.lastFlip")}</dt>
            <dd className="min-w-0 truncate">
                {state.lastFlip ? (
                    <>
                        <RelativeTime iso={state.lastFlip.at} />
                        {" - "}
                        {t(`domains.backup.reasons.${state.lastFlip.reason}`)}
                    </>
                ) : (
                    t("domains.backup.never")
                )}
            </dd>
            {probe ? (
                <>
                    <dt className="text-muted-foreground">{t("domains.backup.checked")}</dt>
                    <dd className="min-w-0 truncate">
                        <RelativeTime iso={probe.checkedAt} />
                        {" - "}
                        {probe.from
                            ? t("domains.backup.fromOutside", { server: probe.from })
                            : t("domains.backup.fromInside")}
                    </dd>
                </>
            ) : null}
        </dl>
    );
}

function Latency({ view }: { view: BackupView }) {
    const t = useTranslations("admin");
    const latency = view.probe?.latency;
    const rows = [
        ["direct", latency?.direct ?? null, true],
        ["tunnel", latency?.tunnel ?? null, view.tunnelReady],
        ["relay", latency?.relay ?? null, view.relay !== null]
    ] as const;
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t("domains.backup.latency")}</span>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                {rows.map(([key, ms, set]) => (
                    <div key={key} className="contents">
                        <dt className="text-muted-foreground">
                            {t(`domains.backup.paths.${key}`)}
                        </dt>
                        <dd className="min-w-0 truncate font-mono">
                            {!set
                                ? t("domains.backup.notSet")
                                : ms === null
                                  ? t("domains.backup.noAnswer")
                                  : t("domains.backup.ms", { ms })}
                        </dd>
                    </div>
                ))}
            </dl>
            {view.probe && !view.probe.from && !view.probe.calibrated ? (
                <p className="text-xs text-muted-foreground">{t("domains.backup.insideOnly")}</p>
            ) : null}
        </div>
    );
}

function Problem({ view }: { view: BackupView }) {
    const t = useTranslations("admin");
    const probe = view.probe;
    if (!probe?.problem && !probe?.conflicts.length) return null;
    return (
        <p className="break-words rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
            {probe.problem
                ? t(`domains.backup.problems.${probe.problem}`, { detail: probe.detail ?? "-" })
                : t("domains.backup.conflicts", { names: probe.conflicts.join(", ") })}
        </p>
    );
}
