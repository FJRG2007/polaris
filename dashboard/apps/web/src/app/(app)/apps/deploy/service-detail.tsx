"use client";

/**
 * Service detail panel (Railway-style): opens on a service and exposes its
 * deployment history, environment variables, metrics, an interactive console, a
 * file browser, and settings (auto-deploy, keep-releases, domains) as tabs.
 * Reuses the existing terminal/files/logs building blocks.
 */

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import {
    CheckCircle2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Copy,
    Download,
    Eye,
    EyeOff,
    Globe,
    Loader2,
    MapPin,
    Maximize2,
    Minimize2,
    MoreVertical,
    Play,
    Plus,
    RotateCw,
    Search,
    Square,
    Trash2,
    X
} from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    Select,
    Switch,
    cn
} from "@polaris/ui";
import { CloudflareMark } from "@/components/brand-icons";
import { ServiceIcon, StatusPill, dbTone, serviceKindOf, type ProjectApp } from "./deploy-view";
import { MetricsHistory, percent, ratioPercent, type MetricSpec } from "@/components/metrics-history";
import { LogViewer } from "@/components/log-viewer";
import type { HttpLogEntry } from "@polaris/deploy";
import { TerminalPanel } from "./terminal-panel";
import { FilesPanel } from "./files-panel";
import {
    addDomainAction,
    deleteEnvVarAction,
    deployApplicationAction,
    importEnvVarsAction,
    listDeployServersAction,
    listDeploymentsAction,
    listEnvVarsAction,
    setAppServerAction,
    removeApplicationDeploymentAction,
    removeDomainAction,
    restartApplicationAction,
    revealEnvVarAction,
    saveEnvVarAction,
    setAppPortAction,
    setApplicationRunningAction,
    setAutoDeployAction,
    setDomainEnabledAction,
    quickTunnelStatusAction,
    startQuickTunnelAction,
    stopQuickTunnelAction
} from "./actions";

const TABS = ["Deployments", "Variables", "Metrics", "Console", "Files", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function ServiceDetail({ app, onChanged, onClose }: { app: ProjectApp; onChanged: () => void; onClose: () => void }) {
    const [tab, setTab] = useState<Tab>("Deployments");
    const [full, setFull] = useState(false);
    const isGit = app.sourceType === "dockerfile" || app.sourceType === "nixpacks";

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                className={cn(
                    "right-0 left-auto top-0 flex h-full max-h-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none rounded-l-xl border-y-0 border-r-0 p-0 data-[state=open]:slide-in-from-right-4",
                    full ? "w-full max-w-none" : "w-full max-w-none sm:w-[820px] sm:max-w-[calc(100vw-2rem)]"
                )}
            >
                <div className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
                    <ServiceIcon kind={serviceKindOf(app.sourceType)} className="size-5 shrink-0 text-foreground" />
                    <DialogTitle className="truncate text-base font-semibold">{app.name}</DialogTitle>
                    {app.currentDeploymentId && (
                        <StatusPill tone={dbTone(app.deployStatus ?? "")} label={app.deployStatus ?? "deployed"} />
                    )}
                    <button
                        type="button"
                        onClick={() => setFull((value) => !value)}
                        title={full ? "Exit full screen" : "Full screen"}
                        className="ml-auto mr-8 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                    </button>
                </div>

                <div className="no-scrollbar flex items-center gap-1 overflow-x-auto border-b border-border/60 px-5 text-sm">
                    {TABS.map((name) => (
                        <button
                            key={name}
                            type="button"
                            onClick={() => setTab(name)}
                            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 transition-colors ${
                                tab === name
                                    ? "border-primary text-foreground"
                                    : "border-transparent text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {name}
                        </button>
                    ))}
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-3">
                    {tab === "Deployments" && <DeploymentsTab app={app} onChanged={onChanged} />}
                    {tab === "Variables" && <VariablesTab app={app} />}
                    {tab === "Metrics" && <MetricsTab applicationId={app.id} />}
                    {tab === "Console" && (
                        <TerminalPanel targetId={app.targetId} containerRef={app.containerRef} label={app.containerRef} />
                    )}
                    {tab === "Files" && <FilesPanel applicationId={app.id} />}
                    {tab === "Settings" && <SettingsTab app={app} isGit={isGit} onChanged={onChanged} />}
                </div>
            </DialogContent>
        </Dialog>
    );
}

type DepSummary = Awaited<ReturnType<typeof listDeploymentsAction>>[number];

function relativeTime(iso: string): string {
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
    if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`;
    return new Date(iso).toLocaleDateString();
}

function depBadge(deployment: DepSummary): { label: string; cls: string } {
    if (deployment.isCurrent) return { label: "ACTIVE", cls: "bg-success/15 text-success" };
    if (["failed", "cancelled", "rolled_back"].includes(deployment.status))
        return { label: "FAILED", cls: "bg-danger/15 text-danger" };
    if (["queued", "deploying"].includes(deployment.status))
        return { label: deployment.status.toUpperCase(), cls: "bg-warning/15 text-warning" };
    return { label: "REMOVED", cls: "bg-muted text-muted-foreground" };
}

function depTitle(deployment: DepSummary): string {
    if (deployment.commitMessage) return deployment.commitMessage;
    if (deployment.commitSha) return `Deploy ${deployment.commitSha.slice(0, 7)}`;
    return "Manual deploy";
}

/** Short source label for a deployment's subtitle ("via GitHub" / "via Registry"). */
function sourceLabel(app: ProjectApp): string {
    return app.sourceType === "image" ? "Registry" : "GitHub";
}

/** The commit author's avatar (GitHub), falling back to the source glyph. */
function DeployAvatar({ app, deployment }: { app: ProjectApp; deployment?: DepSummary | null }) {
    if (deployment?.authorAvatarUrl) {
        // eslint-disable-next-line @next/next/no-img-element -- external avatar, no loader needed
        return (
            <img
                src={deployment.authorAvatarUrl}
                alt={deployment.authorName ?? "author"}
                title={deployment.authorName ?? undefined}
                className="size-8 shrink-0 rounded-full border border-border object-cover"
            />
        );
    }
    return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <ServiceIcon kind={serviceKindOf(app.sourceType)} className="size-4" />
        </span>
    );
}

/** Deployment subtitle: relative time, optional author, and the source. */
function deploySubtitle(deployment: DepSummary, app: ProjectApp): string {
    const by = deployment.authorName ? ` by ${deployment.authorName}` : "";
    return `${relativeTime(deployment.createdAt)}${by} via ${sourceLabel(app)}`;
}

/** The per-deployment overflow menu: redeploy, restart, enable/disable, remove. */
function DeploymentMenu({
    app,
    deployment,
    onAct,
    onChanged
}: {
    app: ProjectApp;
    deployment: DepSummary;
    onAct: () => void;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const isActive = deployment.isCurrent;
    const stopped = deployment.status === "stopped";

    function run(action: () => Promise<{ error?: string }>) {
        startTransition(async () => {
            await action().catch(() => undefined);
            onAct();
            onChanged();
        });
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    onClick={(event) => event.stopPropagation()}
                    disabled={pending}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="Deployment actions"
                >
                    {pending ? <Loader2 className="size-4 animate-spin" /> : <MoreVertical className="size-4" />}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem onSelect={() => run(() => deployApplicationAction(app.id))}>
                    <RotateCw className="size-4" /> Redeploy
                </DropdownMenuItem>
                {isActive && (
                    <>
                        <DropdownMenuItem onSelect={() => run(() => restartApplicationAction(app.id))}>
                            <RotateCw className="size-4" /> Restart
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => run(() => setApplicationRunningAction(app.id, stopped))}>
                            {stopped ? <Play className="size-4" /> : <Square className="size-4" />}
                            {stopped ? "Enable" : "Disable"}
                        </DropdownMenuItem>
                    </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    className="text-danger focus:text-danger"
                    onSelect={() => run(() => removeApplicationDeploymentAction(app.id))}
                >
                    <Trash2 className="size-4" /> Remove
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function DeploymentsTab({ app, onChanged }: { app: ProjectApp; onChanged: () => void }) {
    const [items, setItems] = useState<DepSummary[] | null>(null);
    const [logsFor, setLogsFor] = useState<string | null>(null);
    const [historyOpen, setHistoryOpen] = useState(true);
    const [successOpen, setSuccessOpen] = useState(false);
    const [busy, startTransition] = useTransition();

    function reload() {
        void listDeploymentsAction(app.id).then(setItems);
    }
    useEffect(reload, [app.id]);

    function deploy() {
        startTransition(async () => {
            try {
                const result = await deployApplicationAction(app.id);
                if (result.deploymentId) setLogsFor(result.deploymentId);
                reload();
                onChanged();
            } catch {
                // A failure surfaces on the refreshed status; never crash the panel.
            }
        });
    }

    if (logsFor) {
        const deployment = items?.find((item) => item.id === logsFor) ?? null;
        return (
            <DeploymentLogsView
                app={app}
                deploymentId={logsFor}
                deployment={deployment}
                onBack={() => setLogsFor(null)}
                onDone={() => {
                    reload();
                    onChanged();
                }}
            />
        );
    }

    const active = items?.find((item) => item.isCurrent) ?? null;
    const history = (items ?? []).filter((item) => !item.isCurrent);
    // The live URL is the first enabled domain; a disabled one is kept but not served.
    const primaryDomain = app.domains.find((domain) => domain.enabled) ?? null;
    const region = primaryDomain ? "Deployed" : app.sourceType === "image" ? "Registry" : "GitHub";

    return (
        <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {primaryDomain ? (
                        <a
                            href={`https://${primaryDomain.hostname}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
                        >
                            <Globe className="size-4 shrink-0 text-muted-foreground" /> {primaryDomain.hostname}
                        </a>
                    ) : (
                        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Globe className="size-4 shrink-0" /> No domain yet
                        </span>
                    )}
                    {app.ipUrl && (
                        <a
                            href={app.ipUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-w-0 items-center gap-1.5 truncate pl-[1.375rem] text-xs text-muted-foreground hover:text-primary hover:underline"
                            title="Reachable on the local network (host IP)"
                        >
                            {app.ipUrl.replace(/^https?:\/\//, "")}
                        </a>
                    )}
                </div>
                <div className="ml-auto hidden items-center gap-4 text-xs text-muted-foreground sm:flex">
                    <span className="inline-flex items-center gap-1">
                        <MapPin className="size-3.5" /> {region}
                    </span>
                    <span>1 Replica</span>
                </div>
                <Button size="sm" disabled={busy} onClick={deploy}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : "Deploy"}
                </Button>
            </div>

            {items === null ? (
                <Loading />
            ) : items.length === 0 ? (
                <Empty text="No deployments yet. Click Deploy to ship the current source." />
            ) : (
                <>
                    {active && (
                        <div className="overflow-hidden rounded-xl border border-success/30 bg-success/[0.06]">
                            <div className="flex items-center gap-3 p-3">
                                <span className="shrink-0 rounded bg-success/15 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-success">
                                    ACTIVE
                                </span>
                                <DeployAvatar app={app} deployment={active} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-foreground">{depTitle(active)}</p>
                                    <p className="truncate text-xs text-muted-foreground">{deploySubtitle(active, app)}</p>
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="shrink-0 border-success/40 text-success hover:bg-success/10 hover:text-success"
                                    onClick={() => setLogsFor(active.id)}
                                >
                                    View logs
                                </Button>
                                <DeploymentMenu app={app} deployment={active} onAct={reload} onChanged={onChanged} />
                            </div>
                            <button
                                type="button"
                                onClick={() => setSuccessOpen((value) => !value)}
                                className="flex w-full items-center gap-1.5 border-t border-success/20 px-3 py-2 text-xs text-success"
                            >
                                <CheckCircle2 className="size-3.5" />
                                {active.status === "running"
                                    ? "Deployment successful"
                                    : active.status === "stopped"
                                      ? "Deployment disabled"
                                      : `Status: ${active.status}`}
                                <ChevronDown className={cn("ml-auto size-3.5 transition-transform", successOpen && "rotate-180")} />
                            </button>
                            {successOpen && (
                                <div className="border-t border-success/20 px-3 py-2 text-xs text-muted-foreground">
                                    {active.commitSha ? (
                                        <span className="font-mono">{active.commitSha.slice(0, 7)}</span>
                                    ) : (
                                        "Manual deploy"
                                    )}
                                    {" - "}
                                    {new Date(active.createdAt).toLocaleString()}
                                </div>
                            )}
                        </div>
                    )}

                    {history.length > 0 && (
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                                <button
                                    type="button"
                                    onClick={() => setHistoryOpen((value) => !value)}
                                    className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                                >
                                    <ChevronRight className={cn("size-3.5 transition-transform", historyOpen && "rotate-90")} />
                                    History
                                </button>
                            </div>
                            {historyOpen && (
                                <ul className="flex flex-col gap-2">
                                    {history.map((deployment) => {
                                        const badge = depBadge(deployment);
                                        const failed = ["failed", "cancelled", "rolled_back"].includes(deployment.status);
                                        return (
                                            <li
                                                key={deployment.id}
                                                onClick={() => setLogsFor(deployment.id)}
                                                className={cn(
                                                    "flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition-colors hover:border-muted-foreground/40",
                                                    failed ? "border-danger/30 bg-danger/5" : "border-border/60"
                                                )}
                                            >
                                                <span className={cn("shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide", badge.cls)}>
                                                    {badge.label}
                                                </span>
                                                <DeployAvatar app={app} deployment={deployment} />
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate font-medium text-foreground">{depTitle(deployment)}</p>
                                                    <p className="truncate text-xs text-muted-foreground">{deploySubtitle(deployment, app)}</p>
                                                </div>
                                                <DeploymentMenu app={app} deployment={deployment} onAct={reload} onChanged={onChanged} />
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function DeploymentLogsView({
    app,
    deploymentId,
    deployment,
    onBack,
    onDone
}: {
    app: ProjectApp;
    deploymentId: string;
    deployment: DepSummary | null;
    onBack: () => void;
    onDone: () => void;
}) {
    const CATS = ["Details", "Build Logs", "Deploy Logs", "HTTP Logs", "Network Flow Logs"] as const;
    const [cat, setCat] = useState<(typeof CATS)[number]>("Deploy Logs");
    const badge = deployment ? depBadge(deployment) : null;

    return (
        <div className="flex flex-col gap-2 py-2">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onBack}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="Back"
                >
                    <ChevronLeft className="size-4" />
                </button>
                <ServiceIcon kind={serviceKindOf(app.sourceType)} className="size-4 shrink-0 text-foreground" />
                <span className="truncate text-sm font-semibold">{app.name}</span>
                {deployment?.commitSha && (
                    <>
                        <span className="text-muted-foreground/40">/</span>
                        <span className="font-mono text-xs text-muted-foreground">{deployment.commitSha.slice(0, 7)}</span>
                    </>
                )}
                {badge && <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>}
                {deployment && (
                    <span className="ml-auto text-xs text-muted-foreground">{new Date(deployment.createdAt).toLocaleString()}</span>
                )}
            </div>

            <div className="no-scrollbar flex items-center gap-3 overflow-x-auto border-b border-border/60 text-sm">
                {CATS.map((name) => (
                    <button
                        key={name}
                        type="button"
                        onClick={() => setCat(name)}
                        className={`-mb-px whitespace-nowrap border-b-2 px-1 py-1.5 transition-colors ${
                            cat === name ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {name}
                    </button>
                ))}
            </div>

            {cat === "Details" ? (
                <DetailsPanel app={app} deployment={deployment} />
            ) : cat === "Build Logs" ? (
                <LogStream deploymentId={deploymentId} onDone={onDone} />
            ) : cat === "Deploy Logs" ? (
                <RuntimeLogView appId={app.id} />
            ) : cat === "HTTP Logs" ? (
                <HttpLogsView appId={app.id} deploymentStart={deployment?.createdAt ?? null} />
            ) : cat === "Network Flow Logs" ? (
                <Empty text="No network flow logs yet." />
            ) : (
                <LogStream deploymentId={deploymentId} onDone={onDone} />
            )}
        </div>
    );
}

function DetailsPanel({ app, deployment }: { app: ProjectApp; deployment: DepSummary | null }) {
    const rows: Array<[string, ReactNode]> = [
        ["Status", deployment?.status ?? "-"],
        ["Commit", deployment?.commitSha ? deployment.commitSha.slice(0, 12) : "-"],
        ["Message", deployment?.commitMessage ?? "-"],
        ["Started", deployment ? new Date(deployment.createdAt).toLocaleString() : "-"],
        ["Domain", app.domains[0]?.hostname ?? "-"]
    ];
    return (
        <div className="flex flex-col divide-y divide-border/40 text-sm">
            {rows.map(([label, value]) => (
                <div key={label} className="flex gap-4 py-2">
                    <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
                    <span className="min-w-0 flex-1 break-words">{value}</span>
                </div>
            ))}
            {deployment?.error && <p className="py-2 text-sm text-danger">{deployment.error}</p>}
        </div>
    );
}

function LogStream({ deploymentId, onDone }: { deploymentId: string; onDone: () => void }) {
    const [log, setLog] = useState("");
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    useEffect(() => {
        let active = true;
        let done = false;
        let timer: ReturnType<typeof setTimeout>;
        async function poll(): Promise<void> {
            const res = await fetch(`/api/deploy/deployments/${deploymentId}/log`, { cache: "no-store" });
            if (!active) return;
            if (res.ok) {
                const data = (await res.json()) as { status: string; log: string };
                setLog(data.log);
                if (["running", "failed", "cancelled", "rolled_back"].includes(data.status)) {
                    if (!done) {
                        done = true;
                        onDoneRef.current();
                    }
                    return;
                }
            }
            timer = setTimeout(poll, 1500);
        }
        void poll();
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [deploymentId]);

    return <LogViewer log={log} name={deploymentId} searchable className="h-[26rem]" />;
}

/** Live runtime stdout/stderr of the app's container - what the app prints while
 *  running, distinct from the build log. Polled while the tab is open. */
function RuntimeLogView({ appId }: { appId: string }) {
    const [log, setLog] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        async function poll(): Promise<void> {
            if (typeof document !== "undefined" && document.hidden) {
                timer = setTimeout(poll, 3000);
                return;
            }
            try {
                const res = await fetch(`/api/deploy/apps/${appId}/logs?tail=500`, { cache: "no-store" });
                if (!active) return;
                if (res.ok) {
                    const data = (await res.json()) as { log: string };
                    setLog(data.log ?? "");
                    setError(null);
                } else {
                    const data = (await res.json().catch(() => null)) as { error?: string } | null;
                    setError(data?.error ?? "Could not read runtime logs");
                }
            } catch {
                if (active) setError("Could not read runtime logs");
            }
            if (active) timer = setTimeout(poll, 2500);
        }
        void poll();
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [appId]);

    if (error) return <Empty text={error} />;
    if (log === null) return <Loading />;
    if (!log.trim()) {
        return <Empty text="No runtime logs yet. The container may have just started, or writes nothing to stdout." />;
    }
    return <LogViewer log={log} name={`${appId}-runtime`} searchable className="h-[26rem]" />;
}

/** Color an HTTP status by its class: 2xx ok, 3xx redirect, 4xx client, 5xx server. */
function statusTone(status: number): string {
    if (status >= 500) return "bg-red-500/10 text-red-600 dark:text-red-400";
    if (status >= 400) return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    if (status >= 300) return "bg-sky-500/10 text-sky-600 dark:text-sky-400";
    if (status >= 200) return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    return "bg-muted text-muted-foreground";
}

/** Quote a CSV cell when it contains a comma, quote, or newline. */
function csvCell(value: string | number): string {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const HTTP_METHODS = ["all", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const STATUS_CLASSES = [
    { value: "all", label: "Any status" },
    { value: "2", label: "2xx" },
    { value: "3", label: "3xx" },
    { value: "4", label: "4xx" },
    { value: "5", label: "5xx" }
];
const HTTP_PAGE = 100;

/**
 * HTTP access logs for an app, from the edge's per-request log so any app is
 * covered. Polled live. Scoped to the current deployment by default (clear to
 * search all history), with method / status-class / date-range filters and an
 * infinite-scroll window so a large log renders only what is on screen.
 */
function HttpLogsView({ appId, deploymentStart }: { appId: string; deploymentStart: string | null }) {
    const [entries, setEntries] = useState<HttpLogEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [ipFilter, setIpFilter] = useState<string | null>(null);
    const [method, setMethod] = useState("all");
    const [statusClass, setStatusClass] = useState("all");
    const [scopeDeploy, setScopeDeploy] = useState(true);
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [visible, setVisible] = useState(HTTP_PAGE);
    const sentinelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        async function poll(): Promise<void> {
            if (typeof document !== "undefined" && document.hidden) {
                timer = setTimeout(poll, 2500);
                return;
            }
            try {
                const res = await fetch(`/api/deploy/apps/${appId}/http-logs?tail=2000`, { cache: "no-store" });
                if (!active) return;
                if (res.ok) {
                    const data = (await res.json()) as { entries: HttpLogEntry[] };
                    setEntries(data.entries);
                    setError(null);
                } else {
                    const data = (await res.json().catch(() => null)) as { error?: string } | null;
                    setError(data?.error ?? "Could not read HTTP logs");
                }
            } catch {
                if (active) setError("Could not read HTTP logs");
            }
            if (active) timer = setTimeout(poll, 2500);
        }
        void poll();
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [appId]);

    // An explicit from/to wins; otherwise "this deployment" clamps to its start.
    const fromMs = from
        ? new Date(from).getTime()
        : scopeDeploy && deploymentStart
          ? new Date(deploymentStart).getTime()
          : null;
    const toMs = to ? new Date(to).getTime() : null;

    const all = entries ?? [];
    const query = search.trim().toLowerCase();
    const filtered = all.filter((entry) => {
        if (ipFilter && entry.ip !== ipFilter) return false;
        if (method !== "all" && entry.method !== method) return false;
        if (statusClass !== "all" && Math.floor(entry.status / 100) !== Number(statusClass)) return false;
        if (fromMs !== null || toMs !== null) {
            const t = entry.time ? Date.parse(entry.time) : NaN;
            if (!Number.isFinite(t)) {
                if (fromMs !== null) return false;
            } else {
                if (fromMs !== null && t < fromMs) return false;
                if (toMs !== null && t > toMs) return false;
            }
        }
        if (query) {
            return (
                entry.path.toLowerCase().includes(query) ||
                entry.ip.toLowerCase().includes(query) ||
                entry.method.toLowerCase().includes(query) ||
                String(entry.status).includes(query) ||
                (entry.userAgent?.toLowerCase().includes(query) ?? false)
            );
        }
        return true;
    });

    // Reset the window whenever the filter set changes.
    useEffect(() => {
        setVisible(HTTP_PAGE);
    }, [ipFilter, method, statusClass, from, to, scopeDeploy, query]);

    // Grow the window as the bottom sentinel scrolls into view (infinite scroll).
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) return;
        const observer = new IntersectionObserver((records) => {
            if (records[0]?.isIntersecting) setVisible((current) => current + HTTP_PAGE);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [filtered.length]);

    const shown = filtered.slice(0, visible);
    const scoped = scopeDeploy && deploymentStart && !from;

    function exportCsv(): void {
        const header = ["time", "ip", "method", "path", "status", "host", "bytes", "referer", "user_agent", "duration_ms"];
        const rows = filtered.map((entry) => [
            entry.time ?? "",
            entry.ip,
            entry.method,
            entry.path,
            entry.status,
            entry.host ?? "",
            entry.bytes ?? "",
            entry.referer ?? "",
            entry.userAgent ?? "",
            entry.durationMs ?? ""
        ]);
        const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = ipFilter ? `${appId}-http-logs-${ipFilter.replace(/[^\w.-]/g, "_")}.csv` : `${appId}-http-logs.csv`;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Filter by path, IP, status, or agent"
                        className="pl-8 text-xs"
                    />
                </div>
                <Button type="button" variant="outline" size="sm" onClick={exportCsv} disabled={!filtered.length} className="shrink-0">
                    <Download className="size-4" /> Export
                </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
                <button
                    type="button"
                    onClick={() => {
                        setScopeDeploy((value) => !value);
                        setFrom("");
                        setTo("");
                    }}
                    disabled={!deploymentStart}
                    className={`rounded-md border px-2 py-1 transition-colors disabled:opacity-40 ${
                        scoped ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                >
                    {scoped ? "This deployment" : "All history"}
                </button>
                <Select value={method} onValueChange={setMethod} options={HTTP_METHODS.map((m) => ({ value: m, label: m === "all" ? "Any method" : m }))} className="h-8 w-36 min-w-[9rem]" aria-label="Method" />
                <Select value={statusClass} onValueChange={setStatusClass} options={STATUS_CLASSES} className="h-8 w-36 min-w-[9rem]" aria-label="Status" />
                <Input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} className="h-8 w-auto text-xs" aria-label="From" />
                <span className="text-muted-foreground">to</span>
                <Input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} className="h-8 w-auto text-xs" aria-label="To" />
                {(from || to || method !== "all" || statusClass !== "all" || ipFilter) && (
                    <button
                        type="button"
                        onClick={() => {
                            setFrom("");
                            setTo("");
                            setMethod("all");
                            setStatusClass("all");
                            setIpFilter(null);
                        }}
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                        <X className="size-3" /> Clear
                    </button>
                )}
            </div>

            {entries !== null && !error && all.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                        <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> Live
                    </span>
                    <span>
                        {filtered.length} request{filtered.length === 1 ? "" : "s"}
                        {filtered.length !== all.length ? ` of ${all.length}` : ""}
                    </span>
                    {ipFilter && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-foreground">
                            <span className="text-muted-foreground">IP</span>
                            <span className="font-mono">{ipFilter}</span>
                            <button type="button" onClick={() => setIpFilter(null)} aria-label="Clear IP filter" className="ml-0.5 rounded-full p-0.5 hover:bg-card-hover">
                                <X className="size-3" />
                            </button>
                        </span>
                    )}
                </div>
            )}

            {entries === null && !error ? (
                <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 size-4 animate-spin" /> Reading logs...
                </div>
            ) : error ? (
                <Empty text={error} />
            ) : filtered.length === 0 ? (
                <Empty
                    text={
                        all.length > 0
                            ? "No requests match the filter."
                            : "No HTTP requests yet. They appear here as soon as traffic reaches the running service."
                    }
                />
            ) : (
                <div className="max-h-[26rem] overflow-auto rounded-md border border-border/60">
                    <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-card text-muted-foreground">
                            <tr className="border-b border-border/60 text-left">
                                <th className="whitespace-nowrap px-3 py-2 font-medium">Time</th>
                                <th className="px-3 py-2 font-medium">Method</th>
                                <th className="px-3 py-2 font-medium">Status</th>
                                <th className="px-3 py-2 font-medium">Path</th>
                                <th className="whitespace-nowrap px-3 py-2 font-medium">Client IP</th>
                                <th className="px-3 py-2 font-medium">User agent</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40">
                            {shown.map((entry, index) => (
                                <tr key={index} className="hover:bg-muted/40">
                                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground" title={entry.time ?? undefined}>
                                        {entry.time ? new Date(entry.time).toLocaleTimeString() : "-"}
                                    </td>
                                    <td className="px-3 py-1.5 font-mono">{entry.method}</td>
                                    <td className="px-3 py-1.5">
                                        <span className={`rounded px-1.5 py-0.5 font-mono ${statusTone(entry.status)}`}>{entry.status}</span>
                                    </td>
                                    <td className="max-w-[18rem] truncate px-3 py-1.5 font-mono" title={entry.path}>
                                        {entry.path}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-1.5">
                                        <button
                                            type="button"
                                            onClick={() => setIpFilter(ipFilter === entry.ip ? null : entry.ip)}
                                            title="Show only this IP's requests"
                                            className={`font-mono hover:underline ${
                                                ipFilter === entry.ip ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                                            }`}
                                        >
                                            {entry.ip}
                                        </button>
                                    </td>
                                    <td className="max-w-[16rem] truncate px-3 py-1.5 text-muted-foreground" title={entry.userAgent ?? undefined}>
                                        {entry.userAgent ?? "-"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {shown.length < filtered.length && <div ref={sentinelRef} className="h-8 w-full" />}
                </div>
            )}
        </div>
    );
}

function VariablesTab({ app }: { app: ProjectApp }) {
    const [scope, setScope] = useState<"application" | "environment">("application");
    const scopeId = scope === "application" ? app.id : app.environmentId;
    const [items, setItems] = useState<Awaited<ReturnType<typeof listEnvVarsAction>> | null>(null);
    const [key, setKey] = useState("");
    const [value, setValue] = useState("");
    const [isSecret, setIsSecret] = useState(true);
    // Revealed values, keyed by id: non-secrets use the listed value, secrets are
    // decrypted on demand so a secret only reaches the client when the eye is clicked.
    const [revealed, setRevealed] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [raw, setRaw] = useState("");
    const [rawOpen, setRawOpen] = useState(false);
    const [showAdd, setShowAdd] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    function reload() {
        setItems(null);
        setRevealed({});
        void listEnvVarsAction(scope, scopeId).then(setItems);
    }
    useEffect(reload, [scope, scopeId]);

    function toggleReveal(item: { id: string; isSecret: boolean; value: string | null }) {
        if (item.id in revealed) {
            setRevealed((prev) => {
                const next = { ...prev };
                delete next[item.id];
                return next;
            });
            return;
        }
        if (!item.isSecret) {
            setRevealed((prev) => ({ ...prev, [item.id]: item.value ?? "" }));
            return;
        }
        void revealEnvVarAction(item.id).then((result) => {
            if (typeof result.value === "string") setRevealed((prev) => ({ ...prev, [item.id]: result.value as string }));
        });
    }

    function importRaw() {
        setError(null);
        setNote(null);
        startTransition(async () => {
            const result = await importEnvVarsAction({ scope, scopeId, text: raw, isSecret: true });
            if (result.error) setError(result.error);
            else {
                setRaw("");
                setRawOpen(false);
                setNote(`Imported ${result.count} variable${result.count === 1 ? "" : "s"}.`);
                reload();
            }
        });
    }

    function add() {
        setError(null);
        startTransition(async () => {
            const result = await saveEnvVarAction({ scope, scopeId, key, value, isSecret });
            if (result.error) {
                setError(result.error);
                return;
            }
            setKey("");
            setValue("");
            reload();
        });
    }

    return (
        <div className="flex flex-col gap-4 py-2">
            <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-sm">
                {(
                    [
                        ["application", "This service"],
                        ["environment", "Environment (shared)"]
                    ] as const
                ).map(([value, label]) => (
                    <button
                        key={value}
                        type="button"
                        onClick={() => setScope(value)}
                        className={`rounded px-3 py-1.5 font-medium transition-colors ${
                            scope === value ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                    {items ? items.length : 0} {scope === "environment" ? "environment" : "service"} variable
                    {items && items.length === 1 ? "" : "s"}
                </span>
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setRawOpen((open) => !open)}>
                        {"{ } Raw Editor"}
                    </Button>
                    <Button size="sm" onClick={() => setShowAdd((open) => !open)}>
                        <Plus className="size-4" /> New Variable
                    </Button>
                </div>
            </div>
            {note && <p className="text-xs text-success">{note}</p>}
            {rawOpen && (
                <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
                    <span className="text-xs font-medium text-muted-foreground">
                        Paste a .env - KEY=value per line. Quotes, spaces, `export` and # comments are handled.
                    </span>
                    <textarea
                        value={raw}
                        onChange={(event) => setRaw(event.target.value)}
                        rows={6}
                        placeholder={'DATABASE_URL="postgres://user:pass@host:5432/db"\nAPI_KEY=abc123 # inline comment\nexport NODE_ENV=production'}
                        className="rounded-md border border-input bg-surface px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <div className="flex items-center justify-between gap-2">
                        <label className="cursor-pointer text-xs text-primary hover:underline">
                            Upload a .env file
                            <input
                                type="file"
                                accept=".env,text/plain"
                                className="hidden"
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    if (file) void file.text().then((text) => setRaw((prev) => (prev ? `${prev}\n${text}` : text)));
                                }}
                            />
                        </label>
                        <Button onClick={importRaw} disabled={pending || !raw.trim()}>
                            {pending && <Loader2 className="size-4 animate-spin" />} Import
                        </Button>
                    </div>
                </div>
            )}
            {showAdd && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2">
                    <Input value={key} onChange={(event) => setKey(event.target.value)} placeholder="KEY" className="w-44 font-mono" />
                    <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="value" className="min-w-0 flex-1" />
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch checked={isSecret} onChange={setIsSecret} aria-label="Secret" /> secret
                    </label>
                    <Button onClick={add} disabled={pending || !key.trim()}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : "Add"}
                    </Button>
                </div>
            )}
            {items === null ? (
                <Loading />
            ) : items.length === 0 ? (
                <Empty text="No variables yet. Add one or paste a .env." />
            ) : (
                <ul className="flex flex-col">
                    {items.map((item) => {
                        const shown = item.id in revealed;
                        return (
                            <li key={item.id} className="group flex items-center gap-3 border-b border-border/40 py-2.5 text-sm">
                                <span className="text-xs text-muted-foreground/50">{"{ }"}</span>
                                <span className="w-60 shrink-0 truncate font-mono text-xs font-medium">{item.key}</span>
                                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                                    {shown ? (
                                        revealed[item.id] || <span className="text-muted-foreground/50">(empty)</span>
                                    ) : (
                                        <SecretMask />
                                    )}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => toggleReveal(item)}
                                    className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                                    aria-label={shown ? "Hide value" : "Reveal value"}
                                >
                                    {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                </button>
                                <button
                                    type="button"
                                    title="Remove"
                                    onClick={() => startTransition(async () => { await deleteEnvVarAction(item.id); reload(); })}
                                    className="text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                                >
                                    <Trash2 className="size-4" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
        </div>
    );
}

function MetricsTab({ applicationId }: { applicationId: string }) {
    const [data, setData] = useState<{ state?: string; cpuPercent?: number | null; memPercent?: number | null } | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let active = true;
        void fetch(`/api/deploy/apps/${applicationId}/metrics`, { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => active && setData(body))
            .catch(() => undefined)
            .finally(() => active && setLoading(false));
        return () => {
            active = false;
        };
    }, [applicationId]);

    return (
        <div className="flex flex-col gap-4 py-1">
            {loading ? (
                <Loading />
            ) : data?.state ? (
                <div className="grid gap-3 sm:grid-cols-2">
                    <Meter label="CPU" value={data.cpuPercent} unit="%" />
                    <Meter label="Memory" value={data.memPercent} unit="%" />
                    <div className="rounded-lg border border-border/60 p-4 text-sm sm:col-span-2">
                        State: <span className="font-medium">{data.state}</span>
                    </div>
                </div>
            ) : (
                <Empty text="No live metrics - the service has no running container. History below, if any." />
            )}
            <div>
                <h3 className="mb-1 text-sm font-medium">History</h3>
                <MetricsHistory endpoint={`/api/deploy/apps/${applicationId}/metrics/history`} metrics={DEPLOY_METRICS} />
            </div>
            <div>
                <h3 className="mb-1 text-sm font-medium">HTTP</h3>
                <MetricsHistory<HttpPoint> endpoint={`/api/deploy/apps/${applicationId}/http-metrics`} metrics={HTTP_METRICS} />
            </div>
        </div>
    );
}

/** Charts drawn on the Deploy Metrics tab: CPU and memory as percentages. */
const DEPLOY_METRICS: MetricSpec[] = [
    { key: "cpu", label: "CPU", value: (point) => point.cpuPercent, format: percent, tone: "primary", max: 100 },
    {
        key: "mem",
        label: "Memory",
        value: (point) => ratioPercent(point.memUsedBytes, point.memTotalBytes),
        format: percent,
        tone: "success",
        max: 100
    }
];

/** A bucket of the app's HTTP traffic series (mirrors HttpMetricPoint from the API). */
interface HttpPoint {
    t: number;
    requests: number;
    errorRate: number | null;
    avgResponseMs: number | null;
    bytesPerSec: number;
}

/** Human-readable byte-rate for the traffic chart (B/s, KB/s, MB/s, GB/s). */
function formatRate(bytesPerSec: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytesPerSec;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}/s`;
}

/** Charts drawn on the Deploy Metrics tab HTTP section, derived from access logs. */
const HTTP_METRICS: MetricSpec<HttpPoint>[] = [
    { key: "req", label: "Requests", value: (point) => point.requests, format: (value) => String(Math.round(value)), tone: "primary" },
    { key: "err", label: "Request error rate", value: (point) => point.errorRate, format: percent, tone: "danger", max: 100 },
    { key: "rt", label: "Response time", value: (point) => point.avgResponseMs, format: (value) => `${Math.round(value)} ms`, tone: "warning" },
    { key: "net", label: "Public network traffic", value: (point) => point.bytesPerSec, format: formatRate, tone: "success" }
];

function Meter({ label, value, unit }: { label: string; value: number | null | undefined; unit: string }) {
    const pct = typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
    return (
        <div className="rounded-lg border border-border/60 p-4">
            <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground">{typeof value === "number" ? `${value.toFixed(0)}${unit}` : "-"}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

/** Per-app Cloudflare Quick Tunnel: a public URL with no account/DNS/port-forward.
 *  Loads the live state, then starts/refreshes/stops the cloudflared sidecar. */
function QuickTunnelPanel({ appId }: { appId: string }) {
    const [status, setStatus] = useState<{ running: boolean; url: string | null } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let active = true;
        quickTunnelStatusAction(appId)
            .then((next) => {
                if (active) setStatus(next);
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [appId]);

    function start(): void {
        setError(null);
        startTransition(async () => {
            const result = await startQuickTunnelAction(appId);
            if (result.error) setError(result.error);
            else setStatus({ running: true, url: result.url ?? null });
        });
    }

    function stop(): void {
        setError(null);
        startTransition(async () => {
            const result = await stopQuickTunnelAction(appId);
            if (result.error) setError(result.error);
            else setStatus({ running: false, url: null });
        });
    }

    async function copy(url: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard unavailable (insecure context); the link is still visible to copy manually.
        }
    }

    const running = status?.running ?? false;
    return (
        <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <CloudflareMark className="size-4" /> Public tunnel
            </h3>
            <p className="text-xs text-muted-foreground">
                Expose this app on a public Cloudflare URL - no account, no DNS, no port-forwarding. The link
                changes each time the tunnel starts; for a stable custom domain, configure a tunnel under
                Integrations.
            </p>
            {running && status?.url && (
                <div className="flex items-center gap-2">
                    <a
                        href={status.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-primary hover:underline"
                    >
                        <CloudflareMark className="size-3.5 shrink-0" /> {status.url.replace(/^https?:\/\//, "")}
                    </a>
                    <button
                        type="button"
                        title="Copy link"
                        onClick={() => copy(status.url as string)}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                        {copied ? <CheckCircle2 className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
                    </button>
                </div>
            )}
            {running && !status?.url && (
                <p className="text-xs text-muted-foreground">Tunnel running - waiting for its public URL...</p>
            )}
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
                {running ? (
                    <>
                        <Button variant="outline" onClick={start} disabled={pending}>
                            {pending && <Loader2 className="size-4 animate-spin" />} Refresh
                        </Button>
                        <Button variant="outline" onClick={stop} disabled={pending}>
                            Stop tunnel
                        </Button>
                    </>
                ) : (
                    <Button variant="outline" onClick={start} disabled={pending}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <CloudflareMark className="size-4" />} Expose with Cloudflare
                    </Button>
                )}
            </div>
        </section>
    );
}

function SettingsTab({ app, isGit, onChanged }: { app: ProjectApp; isGit: boolean; onChanged: () => void }) {
    const [autoDeploy, setAutoDeploy] = useState(app.autoDeploy);
    const [branch, setBranch] = useState(app.deployBranch ?? "");
    const [filter, setFilter] = useState(app.commitFilter ?? "");
    const [keepReleases, setKeepReleases] = useState(app.keepReleases);
    // Empty means "not pinned": the deploy detects the container port from the image
    // (see buildAppPlan). Only a value the user types here pins it.
    const [containerPort, setContainerPort] = useState(app.port != null ? String(app.port) : "");
    const [hostname, setHostname] = useState("");
    const [port, setPort] = useState(String(app.port ?? 3000));
    const [exposure, setExposure] = useState<"subdomain" | "le" | "tunnel">("subdomain");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function saveSettings() {
        setError(null);
        startTransition(async () => {
            const portValue = Number(containerPort.trim());
            if (Number.isInteger(portValue) && portValue > 0) {
                const portResult = await setAppPortAction(app.id, portValue);
                if (portResult.error) {
                    setError(portResult.error);
                    return;
                }
            }
            const result = await setAutoDeployAction({
                applicationId: app.id,
                autoDeploy,
                deployBranch: branch.trim() || undefined,
                commitFilter: filter.trim() || undefined,
                keepReleases
            });
            if (result.error) setError(result.error);
            else onChanged();
        });
    }

    function addDomain() {
        setError(null);
        const isCustom = exposure !== "subdomain";
        startTransition(async () => {
            const result = await addDomainAction({
                applicationId: app.id,
                hostname: isCustom ? hostname.trim() || undefined : undefined,
                targetPort: Number(port),
                cert: exposure === "le" ? "le" : exposure === "tunnel" ? "none" : undefined
            });
            if (result.error) setError(result.error);
            else {
                setHostname("");
                onChanged();
            }
        });
    }

    return (
        <div className="flex flex-col gap-5 py-2">
            <ServerSection app={app} onChanged={onChanged} />

            <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Networking</h3>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Container port
                    <Input
                        value={containerPort}
                        onChange={(event) => setContainerPort(event.target.value)}
                        placeholder="Auto (from image)"
                        inputMode="numeric"
                        className="w-40"
                    />
                    <span>
                        The port the app listens on inside its container. Leave empty to detect it from the image
                        automatically; set it (e.g. 5601 for OpenSearch Dashboards) only when the image exposes several
                        ports or none. The IP:port link and every domain route target it. Applies on the next deploy.
                    </span>
                </label>
                {app.ipUrl && (
                    <a
                        href={app.ipUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
                    >
                        <Globe className="size-3" /> {app.ipUrl.replace(/^https?:\/\//, "")}
                    </a>
                )}
            </section>

            <section className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">Public access</h3>
                    <p className="text-xs text-muted-foreground">
                        Reach this service from the internet - a custom domain you point here, or a Cloudflare tunnel
                        that needs no DNS or port-forwarding. Add a domain below, or expose it through the tunnel.
                    </p>
                </div>
                {app.domains.length > 0 ? (
                    <ul className="flex flex-col gap-1">
                        {app.domains.map((domain) => (
                            <li key={domain.id} className="group flex items-center gap-2">
                                {domain.enabled ? (
                                    <a
                                        href={`https://${domain.hostname}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-primary hover:underline"
                                    >
                                        <Globe className="size-3 shrink-0" /> {domain.hostname}
                                    </a>
                                ) : (
                                    <span
                                        title="Domain disabled - not serving"
                                        className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground line-through"
                                    >
                                        <Globe className="size-3 shrink-0" /> {domain.hostname}
                                    </span>
                                )}
                                <Switch
                                    checked={domain.enabled}
                                    onChange={(next) => startTransition(async () => { await setDomainEnabledAction(domain.id, next); onChanged(); })}
                                    aria-label={domain.enabled ? "Disable domain" : "Enable domain"}
                                />
                                <button
                                    type="button"
                                    title="Remove domain"
                                    onClick={() => startTransition(async () => { await removeDomainAction(domain.id); onChanged(); })}
                                    className="text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-xs text-muted-foreground">No domains yet.</p>
                )}
                <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Exposure
                            <Select
                                value={exposure}
                                onValueChange={(value) => setExposure(value as "subdomain" | "le" | "tunnel")}
                                options={[
                                    { value: "subdomain", label: "Free subdomain (auto)" },
                                    { value: "le", label: "Custom domain - Let's Encrypt" },
                                    { value: "tunnel", label: "Custom domain - behind a tunnel/proxy" }
                                ]}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Port
                            <Input value={port} onChange={(event) => setPort(event.target.value)} placeholder="port" />
                        </label>
                    </div>
                    {exposure !== "subdomain" && (
                        <Input
                            value={hostname}
                            onChange={(event) => setHostname(event.target.value)}
                            placeholder="app.example.com"
                        />
                    )}
                    <p className="text-xs text-muted-foreground">
                        {exposure === "subdomain"
                            ? "Follows your Network exposure mode (Admin - Domains): public with Let's Encrypt on a reachable box, or LAN-only on a home/NAT box. For public access from home, set a wildcard domain there or start a Public tunnel below."
                            : exposure === "le"
                              ? "Point the domain's DNS at this server's public IP (port-forward / DuckDNS). Traefik gets a Let's Encrypt certificate automatically."
                              : "For a domain fronted by a tunnel (Cloudflare / ngrok) or an external proxy that terminates TLS. Configure the tunnel under Integrations."}
                    </p>
                    <div className="flex justify-end">
                        <Button variant="outline" onClick={addDomain} disabled={pending}>
                            Add domain
                        </Button>
                    </div>
                </div>
                <div className="border-t border-border/50 pt-4">
                    <QuickTunnelPanel appId={app.id} />
                </div>
            </section>

            {isGit && (
                <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">Auto-deploy</h3>
                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>Deploy on push</span>
                        <Switch checked={autoDeploy} onChange={setAutoDeploy} aria-label="Deploy on push" />
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Branch
                            <Input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Commit filter
                            <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="build:" />
                        </label>
                    </div>
                </section>
            )}

            <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Releases</h3>
                <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-sm">
                    <span>
                        <span className="font-medium">Keep previous deployments</span>
                        <span className="block text-xs text-muted-foreground">
                            Keep old versions running instead of replacing them on each deploy. Off by default.
                        </span>
                    </span>
                    <Switch checked={keepReleases} onChange={setKeepReleases} aria-label="Keep previous deployments" />
                </div>
            </section>

            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button onClick={saveSettings} disabled={pending}>
                    {pending && <Loader2 className="size-4 animate-spin" />} Save settings
                </Button>
            </div>
        </div>
    );
}

/** Pick which connected server this service runs on. Changing it tears the
 *  current deployment down on the old server; the service redeploys on the new. */
function ServerSection({ app, onChanged }: { app: ProjectApp; onChanged: () => void }) {
    const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
    const [serverId, setServerId] = useState(app.serverId);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        void listDeployServersAction()
            .then((list) => setServers(list))
            .catch(() => undefined);
    }, []);

    const changed = serverId !== app.serverId;

    function move() {
        setError(null);
        startTransition(async () => {
            const result = await setAppServerAction(app.id, serverId);
            if (result.error) setError(result.error);
            else onChanged();
        });
    }

    const options = servers.length > 0 ? servers : [{ id: app.serverId, name: app.serverName }];

    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Server</h3>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Where this service runs
                <Select
                    value={serverId}
                    onValueChange={setServerId}
                    options={options.map((server) => ({ value: server.id, label: server.name }))}
                    aria-label="Server"
                />
                <span>
                    Move the service to another connected server. Connect more under Servers. Changing this stops the
                    current container on the old server; redeploy to bring it up on the new one.
                </span>
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            {changed && (
                <div className="flex justify-end">
                    <Button variant="outline" onClick={move} disabled={pending}>
                        {pending && <Loader2 className="size-4 animate-spin" />} Move to {options.find((server) => server.id === serverId)?.name ?? "server"}
                    </Button>
                </div>
            )}
        </section>
    );
}

function Loading() {
    return (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading...
        </div>
    );
}

function Empty({ text }: { text: string }) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{text}</p>;
}

/** A masked value placeholder: fixed-width dots, so secrets never render as text. */
function SecretMask() {
    return (
        <span className="inline-flex items-center gap-0.5 align-middle">
            {Array.from({ length: 8 }).map((_, index) => (
                <span key={index} className="size-1 rounded-full bg-muted-foreground/50" />
            ))}
        </span>
    );
}
