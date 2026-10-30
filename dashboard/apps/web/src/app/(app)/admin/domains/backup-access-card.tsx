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
import { Button, Skeleton, Checkbox } from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { holdersCanBeFreed, UNKNOWN_HOLDER } from "@/lib/backup-access/port-holders";
import { freeRelayPortsAction, saveBackupAccessAction, updateRelayEdgeAction } from "./actions";
import { RelayFirewallGuide } from "./relay-firewall-guide";
import { TAILSCALE_CONNECT_ID } from "./tailscale-card";
import { PageSection } from "@/components/page-section";
import { RelativeTime } from "@/components/relative-time";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { BackupConfig, BackupView } from "@/lib/backup-access/service";
import { INBOUND_FEATURES, carries, type InboundPath } from "@/lib/backup-access/inbound";

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
    const [confirm, confirmDialog] = useConfirm();
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

    async function freePorts() {
        const yes = await confirm({
            title: t("domains.backup.freePortsTitle"),
            description: t("domains.backup.freePortsBody", { holders: view?.probe?.detail ?? "" }),
            confirmLabel: t("domains.backup.freePorts"),
            danger: true
        });
        if (yes) await repair(freeRelayPortsAction);
    }

    async function updateEdge() {
        const yes = await confirm({
            title: t("domains.backup.updateEdgeTitle"),
            description: t("domains.backup.updateEdgeBody"),
            confirmLabel: t("domains.backup.updateEdge"),
            danger: true
        });
        if (yes) await repair(updateRelayEdgeAction);
    }

    async function repair(action: typeof freeRelayPortsAction) {
        setBusy(true);
        setError("");
        const result = await runAction(action, setError);
        setBusy(false);
        if (!result) return;
        live.replace(result.view);
        if (result.failure) setError(t(`domains.backup.repairFailed.${result.failure}`));
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
                    <LineReach view={view} />
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

                    <PathsCompared view={view} />

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
                                <Checkbox
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
                    <Problem
                        view={view}
                        busy={busy}
                        onFree={() => void freePorts()}
                        onUpdateEdge={() => void updateEdge()}
                    />

                    {view.config.path === "relay" ? <RelayFirewallGuide view={view} /> : null}
                    {view.config.path !== "relay" && view.relay && view.relay.tcp.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("domains.backup.tcpCarried", { ports: view.relay.tcp.join(", ") })}
                        </p>
                    ) : null}
                    {view.config.path !== "relay" && view.relay && view.relay.udp.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("domains.backup.udpCarried", { ports: view.relay.udp.join(", ") })}
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
            {confirmDialog}
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

function Problem({
    view,
    busy,
    onFree,
    onUpdateEdge
}: {
    view: BackupView;
    busy: boolean;
    onFree: () => void;
    onUpdateEdge: () => void;
}) {
    const t = useTranslations("admin");
    const probe = view.probe;
    if (!probe?.problem && !probe?.conflicts.length) return null;
    const holders = (probe.detail ?? "").split(", ");
    const held = probe.problem === "ports-held";
    const freeable = held && holdersCanBeFreed(holders);
    const named = holders.filter((name) => name && name !== UNKNOWN_HOLDER);
    const portsHeld = named.length
        ? t("domains.backup.portsHeldStuck", { detail: named.join(", ") })
        : t("domains.backup.portsHeldUnnamed");
    return (
        <div className="flex flex-col items-start gap-2">
            <p className="break-words rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                {held && !freeable
                    ? portsHeld
                    : probe.problem
                      ? t(`domains.backup.problems.${probe.problem}`, {
                            detail: probe.detail ?? "-"
                        })
                      : t("domains.backup.conflicts", { names: probe.conflicts.join(", ") })}
            </p>
            {freeable ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={onFree}>
                    {t("domains.backup.freePorts")}
                </Button>
            ) : null}
            {probe.problem === "edge-outdated" ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={onUpdateEdge}>
                    {t("domains.backup.updateEdge")}
                </Button>
            ) : null}
        </div>
    );
}

/** The path visitors use right now, or null when none reaches the house. */
function activePath(view: BackupView): InboundPath | null {
    if (view.state.serving === "backup") return view.config.path;
    return view.reach?.cgnat ? null : "direct";
}

/**
 * Whether the line itself takes visitors, and what works on the path in use. A
 * carrier NAT is said in words with the reason it was recognised, and the way
 * out is the path picker right below.
 */
function LineReach({ view }: { view: BackupView }) {
    const t = useTranslations("admin");
    const reach = view.reach;
    const active = activePath(view);
    return (
        <div className="flex flex-col gap-2">
            {reach?.cgnat ? (
                <p
                    role="status"
                    className="break-words rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground"
                >
                    {t(
                        reach.certain
                            ? "domains.backup.cgnat.title"
                            : "domains.backup.cgnat.titleSuspected",
                        {
                            ip: reach.publicIp ?? "-"
                        }
                    )}{" "}
                    {reach.reason ? t(`domains.backup.cgnat.reasons.${reach.reason}`) : null}{" "}
                    {view.config.path
                        ? t("domains.backup.cgnat.covered")
                        : t(`domains.backup.cgnat.pick.${view.recommended}`)}
                </p>
            ) : null}
            <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                    {active
                        ? t("domains.backup.works.on", {
                              path: t(`domains.backup.paths.${active}`)
                          })
                        : t("domains.backup.works.none")}
                </span>
                <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
                    {INBOUND_FEATURES.filter((feature) => feature !== "everyone").map((feature) => {
                        const on = active !== null && carries(active, feature);
                        return (
                            <li key={feature} className="flex min-w-0 gap-2">
                                <span className={on ? "text-success" : "text-danger"}>
                                    {on
                                        ? t("domains.backup.works.yes")
                                        : t("domains.backup.works.no")}
                                </span>
                                <span className="min-w-0 truncate">
                                    {t(`domains.backup.features.${feature}`)}
                                </span>
                            </li>
                        );
                    })}
                </ul>
                {view.calls === "local-only" ? (
                    <p className="text-xs text-muted-foreground">
                        {t("domains.backup.works.callsLocal")}
                    </p>
                ) : null}
                <Ipv6Line view={view} />
            </div>
        </div>
    );
}

/** What IPv6 visitors get: published, refused by the router, or not writable here. */
function Ipv6Line({ view }: { view: BackupView }) {
    const t = useTranslations("admin");
    const { address, inbound, published, problem } = view.ipv6;
    if (!address) return null;
    const key = published
        ? "published"
        : problem === "no-cloudflare"
          ? "noCloudflare"
          : problem === "failed"
            ? "failed"
            : inbound === false
              ? "blocked"
              : "checking";
    return (
        <p className="break-words text-xs text-muted-foreground">
            {t(`domains.backup.ipv6.${key}`, { address: published ?? address })}
        </p>
    );
}

const COMPARED: readonly InboundPath[] = ["relay", "tunnel", "tailscale"];

/**
 * Bring the Tailscale section into view and put the focus on its connect button.
 * A bare `#tailscale` did nothing anyone could see: the section sits right under
 * this card, so following the anchor barely moved the page.
 */
function goToTailscale(event: React.MouseEvent<HTMLAnchorElement>) {
    const section = document.getElementById("tailscale");
    if (!section) return;
    event.preventDefault();
    section.scrollIntoView({ block: "start", behavior: "smooth" });
    document.getElementById(TAILSCALE_CONNECT_ID)?.focus({ preventScroll: true });
    window.history.replaceState(null, "", "#tailscale");
}

/** The ways in side by side, the recommended one marked, each with its catch. */
function PathsCompared({ view }: { view: BackupView }) {
    const t = useTranslations("admin");
    if (!view.reach?.cgnat && view.config.path) return null;
    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
                {t("domains.backup.compare.title")}
            </span>
            <ul className="flex flex-col gap-1.5 text-xs">
                {COMPARED.map((path) => (
                    <li key={path} className="min-w-0 break-words">
                        <span className="font-medium">{t(`domains.backup.paths.${path}`)}</span>
                        {view.recommended === path ? (
                            <span className="ml-2 text-success">
                                {t("domains.backup.compare.recommended")}
                            </span>
                        ) : null}
                        <span className="block text-muted-foreground">
                            {t(`domains.backup.compare.${path}`)}
                        </span>
                        {path === "tailscale" ? (
                            <a
                                href="#tailscale"
                                onClick={goToTailscale}
                                className="text-primary hover:underline"
                            >
                                {view.tailscale
                                    ? t("domains.backup.compare.tailscaleOpen")
                                    : t("domains.backup.compare.tailscaleSetUp")}
                            </a>
                        ) : null}
                    </li>
                ))}
            </ul>
        </div>
    );
}
