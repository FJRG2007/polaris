"use client";

/**
 * Service detail panel (Railway-style): opens on a service and exposes its
 * deployment history, environment variables, metrics, an interactive console, a
 * file browser, and settings (auto-deploy, keep-releases, domains) as tabs.
 * Reuses the existing terminal/files/logs building blocks.
 */

import Link from "next/link";
import { FilesPanel } from "./files-panel";
import * as deployActions from "./actions";
import { VolumesTab } from "./volumes-panel";
import { TerminalPanel } from "./terminal-panel";
import { LogViewer } from "@/components/log-viewer";
import type { HttpLogEntry } from "@polaris/deploy";
import { isLocalDomain, primaryDomain } from "./domain-rank";
import { stageServiceDeleteAction } from "./project-actions";
import { useDisplayFormat } from "@/components/display-format";
import { isTunnelHostname, type DisplayFormat } from "@polaris/core";
import { CloudflareMark, NgrokMark } from "@/components/brand-icons";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { ServiceIcon, StatusPill, dbTone, serviceKindOf, type ProjectApp } from "./deploy-view";
import { MetricsHistory, percent, ratioPercent, type MetricSpec } from "@/components/metrics-history";
import {
    cn,
    Input,
    Button,
    Dialog,
    Select,
    Switch,
    Checkbox,
    Textarea,
    DialogTitle,
    DropdownMenu,
    DialogContent,
    DropdownMenuItem,
    ConfirmDeleteDialog,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuSeparator
} from "@polaris/ui";
import {
    ArrowUpRight,
    ChartColumn,
    CheckCircle2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Download,
    ExternalLink,
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
    ScrollText,
    Search,
    ShieldCheck,
    Square,
    Trash2,
    X
} from "lucide-react";

/**
 * The panel's own tabs, and the two screens that are not tabs.
 *
 * Security and Analytics are whole apps with a scope selector, jails, bans, feeds
 * and history behind them. A copy of either squeezed into this panel is a second
 * implementation that drifts from the real one - which is exactly what happened to
 * Security, sitting here showing the rules while the firewall grew everything
 * around them. So they link out with this service already selected instead.
 */
const TABS = ["Deployments", "Variables", "Metrics", "Console", "Files", "Volumes", "Settings"] as const;
type Tab = (typeof TABS)[number];

const LINKED_TABS = [
    { label: "Security", icon: ShieldCheck, href: (id: string) => `/apps/firewall?scope=application&id=${id}` },
    { label: "Analytics", icon: ChartColumn, href: (id: string) => `/apps/analytics?scope=application&id=${id}` }
] as const;

export function ServiceDetail({
    app,
    staged,
    onChanged,
    onClose
}: {
    app: ProjectApp;
    /** Queued for removal in the changeset. The panel keeps working - the service
     *  is still up - but says so, and stops offering a second delete. */
    staged?: boolean;
    onChanged: () => void;
    onClose: () => void;
}) {
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
                    {staged && (
                        <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            Removal pending
                        </span>
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
                    <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
                    {LINKED_TABS.map((entry) => {
                        const Icon = entry.icon;
                        return (
                            <Link
                                key={entry.label}
                                href={entry.href(app.id)}
                                // The arrow is the whole point: these leave the panel,
                                // and a tab that closes what you were looking at without
                                // saying so first is the worst kind of surprise.
                                title={`Open ${entry.label.toLowerCase()} for ${app.name}`}
                                className="-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <Icon className="size-3.5" />
                                {entry.label}
                                <ArrowUpRight className="size-3 opacity-60" />
                            </Link>
                        );
                    })}
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-3">
                    {tab === "Deployments" && <DeploymentsTab app={app} onChanged={onChanged} />}
                    {tab === "Variables" && <VariablesTab app={app} />}
                    {tab === "Metrics" && <MetricsTab applicationId={app.id} />}
                    {tab === "Console" && (
                        <TerminalPanel
                            target={{ kind: "container", targetId: app.targetId, containerRef: app.containerRef }}
                            label={app.containerRef}
                        />
                    )}
                    {tab === "Files" && <FilesPanel applicationId={app.id} />}
                    {tab === "Volumes" && <VolumesTab app={app} />}
                    {tab === "Settings" && (
                        <SettingsTab app={app} isGit={isGit} staged={staged ?? false} onChanged={onChanged} />
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

type DepSummary = Awaited<ReturnType<typeof deployActions.listDeploymentsAction>>[number];

function relativeTime(iso: string, format: DisplayFormat): string {
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
    if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`;
    return format.date(iso);
}

function depBadge(deployment: DepSummary): { label: string; cls: string } {
    if (deployment.isCurrent) return { label: "ACTIVE", cls: "bg-success/15 text-success" };
    if (["failed", "cancelled", "rolled_back"].includes(deployment.status))
        return { label: "FAILED", cls: "bg-danger/15 text-danger" };
    if (["queued", "deploying"].includes(deployment.status))
        return { label: deployment.status.toUpperCase(), cls: "bg-warning/15 text-warning" };
    return { label: "REMOVED", cls: "bg-muted text-muted-foreground" };
}

/** Whether a deployment has stopped moving. Everything else is still queued or
 *  building, and has no container behind it yet. */
function isSettled(deployment: DepSummary): boolean {
    return !["queued", "deploying"].includes(deployment.status);
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
function deploySubtitle(deployment: DepSummary, app: ProjectApp, format: DisplayFormat): string {
    const by = deployment.authorName ? ` by ${deployment.authorName}` : "";
    return `${relativeTime(deployment.createdAt, format)}${by} via ${sourceLabel(app)}`;
}

/** The address one kept version answers on, beside the service's own. Only a
 *  version that is still up has one, so there is never a link to nothing. */
function ReleaseLink({ deployment }: { deployment: DepSummary }) {
    if (!deployment.hostname) return null;
    return (
        <a
            href={`https://${deployment.hostname}`}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            aria-label={`Open this version at ${deployment.hostname}`}
            title={deployment.hostname}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
            <ExternalLink className="size-4" />
        </a>
    );
}

/**
 * The commit a deployment was built from, linking to it on the forge when the
 * repository is one whose URL shape we know. Without a link it is still shown -
 * the short SHA is what identifies the build in the logs either way.
 */
function CommitRef({ deployment, chars = 7 }: { deployment: DepSummary | null; chars?: number }) {
    if (!deployment?.commitSha) return null;
    const short = deployment.commitSha.slice(0, chars);
    if (!deployment.commitUrl) return <span className="font-mono">{short}</span>;
    return (
        <a
            href={deployment.commitUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            title={`View ${short} on the repository`}
            className="inline-flex items-center gap-1 font-mono underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
            {short}
            <ExternalLink className="size-3" />
        </a>
    );
}

/** The per-deployment overflow menu: redeploy, restart, enable/disable, remove. */
function DeploymentMenu({
    app,
    deployment,
    onAct,
    onChanged,
    onDeployStarted
}: {
    app: ProjectApp;
    deployment: DepSummary;
    onAct: () => void;
    onChanged: () => void;
    /** A redeploy from here starts a NEW deployment; the caller follows it. */
    onDeployStarted: (deploymentId: string) => void;
}) {
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const isActive = deployment.isCurrent;
    const stopped = deployment.status === "stopped";

    function run(action: () => Promise<{ error?: string }>) {
        startTransition(async () => {
            const result = await action().catch(() => ({ error: "That did not go through." }));
            setError(result?.error ?? null);
            onAct();
            onChanged();
        });
    }

    /**
     * Redeploy starts a new build; the row it was clicked from describes an old
     * one. Following the new deployment is the point - without it the row sits
     * there looking untouched while a build runs, and clicking it again opens the
     * log of the deployment that was replaced, which reads as the UI being stuck.
     */
    function redeploy() {
        startTransition(async () => {
            const result = await deployActions.deployApplicationAction(app.id).catch(() => ({
                error: "Could not start the deployment",
                deploymentId: undefined
            }));
            setError(result.error ?? null);
            onAct();
            onChanged();
            if (result.deploymentId) onDeployStarted(result.deploymentId);
        });
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    onClick={(event) => event.stopPropagation()}
                    disabled={pending}
                    title={error ?? undefined}
                    className={cn(
                        "shrink-0 rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
                        error ? "text-danger" : "text-muted-foreground"
                    )}
                    aria-label={error ? `Deployment actions - ${error}` : "Deployment actions"}
                >
                    {pending ? <Loader2 className="size-4 animate-spin" /> : <MoreVertical className="size-4" />}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem onSelect={redeploy}>
                    <RotateCw className="size-4" /> Redeploy
                </DropdownMenuItem>
                {isActive && (
                    <>
                        <DropdownMenuItem onSelect={() => run(() => deployActions.restartApplicationAction(app.id))}>
                            <RotateCw className="size-4" /> Restart
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => run(() => deployActions.setApplicationRunningAction(app.id, stopped))}>
                            {stopped ? <Play className="size-4" /> : <Square className="size-4" />}
                            {stopped ? "Enable" : "Disable"}
                        </DropdownMenuItem>
                    </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    className="text-danger focus:text-danger"
                    onSelect={() => run(() => deployActions.removeApplicationDeploymentAction(app.id))}
                >
                    <Trash2 className="size-4" /> Remove
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function DeploymentsTab({ app, onChanged }: { app: ProjectApp; onChanged: () => void }) {
    const format = useDisplayFormat();
    const [items, setItems] = useState<DepSummary[] | null>(null);
    const [logsFor, setLogsFor] = useState<string | null>(null);
    const [historyOpen, setHistoryOpen] = useState(true);
    const [successOpen, setSuccessOpen] = useState(false);
    const [busy, startTransition] = useTransition();

    function reload() {
        void deployActions.listDeploymentsAction(app.id).then(setItems);
    }
    useEffect(reload, [app.id]);

    // Poll while a deployment is still in flight so the card reflects the real state
    // without a manual page reload; stop once everything has reached a terminal state.
    useEffect(() => {
        const TERMINAL = new Set(["success", "failed", "cancelled", "rolled_back", "stopped"]);
        if (!items?.some((item) => !TERMINAL.has(item.status))) return;
        const timer = setInterval(reload, 3000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items]);

    function deploy() {
        startTransition(async () => {
            try {
                const result = await deployActions.deployApplicationAction(app.id);
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
    // The most stable/reachable domain (custom domain > free public subdomain > LAN);
    // a disabled one is never chosen.
    const primary = primaryDomain(app.domains);
    const region = primary ? "Deployed" : app.sourceType === "image" ? "Registry" : "GitHub";

    return (
        <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {primary ? (
                        <a
                            href={`https://${primary.hostname}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
                        >
                            <Globe className="size-4 shrink-0 text-muted-foreground" /> {primary.hostname}
                            {isLocalDomain(primary) && (
                                <span className="shrink-0 rounded bg-warning/10 px-1 text-[10px] font-medium text-warning">LAN</span>
                            )}
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
                                    <p className="truncate text-xs text-muted-foreground">{deploySubtitle(active, app, format)}</p>
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="shrink-0 border-success/40 text-success hover:bg-success/10 hover:text-success"
                                    onClick={() => setLogsFor(active.id)}
                                >
                                    View logs
                                </Button>
                                <ReleaseLink deployment={active} />
                                <DeploymentMenu
                                    app={app}
                                    deployment={active}
                                    onAct={reload}
                                    onChanged={onChanged}
                                    onDeployStarted={setLogsFor}
                                />
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
                                    {active.commitSha ? <CommitRef deployment={active} /> : "Manual deploy"}
                                    {" - "}
                                    {format.dateTime(active.createdAt)}
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
                                                    <p className="truncate text-xs text-muted-foreground">{deploySubtitle(deployment, app, format)}</p>
                                                </div>
                                                <ReleaseLink deployment={deployment} />
                                                <DeploymentMenu
                                                    app={app}
                                                    deployment={deployment}
                                                    onAct={reload}
                                                    onChanged={onChanged}
                                                    onDeployStarted={setLogsFor}
                                                />
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
    const format = useDisplayFormat();
    // While it is still going there is only one log worth opening: the build's.
    // The runtime log belongs to a container that does not exist yet, and landing
    // on it means being shown an error about the absence rather than the progress
    // you came to watch.
    const [cat, setCat] = useState<(typeof CATS)[number]>(
        deployment && !isSettled(deployment) ? "Build Logs" : "Deploy Logs"
    );
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
                        <span className="text-xs text-muted-foreground">
                            <CommitRef deployment={deployment} />
                        </span>
                    </>
                )}
                {badge && <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>}
                {deployment && (
                    <span className="ml-auto text-xs text-muted-foreground">{format.dateTime(deployment.createdAt)}</span>
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
                <RuntimeLogView appId={app.id} deployment={deployment} onSeeBuild={() => setCat("Build Logs")} />
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
    const format = useDisplayFormat();
    const rows: Array<[string, ReactNode]> = [
        ["Status", deployment?.status ?? "-"],
        ["Commit", deployment?.commitSha ? <CommitRef deployment={deployment} chars={12} /> : "-"],
        ["Message", deployment?.commitMessage ?? "-"],
        ["Started", deployment ? format.dateTime(deployment.createdAt) : "-"],
        ["Domain", (primaryDomain(app.domains) ?? app.domains[0])?.hostname ?? "-"]
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

/** Small pulsing "Live" badge shown above a log stream that is actively polling. */
function LivePill() {
    return (
        <span className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> Live
        </span>
    );
}

function LogStream({ deploymentId, onDone }: { deploymentId: string; onDone: () => void }) {
    const [log, setLog] = useState("");
    const [live, setLive] = useState(true);
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    useEffect(() => {
        let active = true;
        let done = false;
        let timer: ReturnType<typeof setTimeout>;
        setLive(true);
        async function poll(): Promise<void> {
            const res = await fetch(`/api/deploy/deployments/${deploymentId}/log`, { cache: "no-store" });
            if (!active) return;
            if (res.ok) {
                const data = (await res.json()) as { status: string; log: string };
                setLog(data.log);
                // The build stream is terminal once the deployment leaves the build phase
                // (running) or ends in failure; stop polling and drop the live indicator.
                if (["running", "failed", "cancelled", "rolled_back"].includes(data.status)) {
                    if (!done) {
                        done = true;
                        onDoneRef.current();
                    }
                    if (active) setLive(false);
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

    return (
        <div className="flex flex-col gap-2">
            {live && <LivePill />}
            <LogViewer log={log} name={deploymentId} searchable className="h-[26rem]" />
        </div>
    );
}

/**
 * Live runtime stdout/stderr of the app's container - what the app prints while
 * running, distinct from the build log. Polled while the tab is open.
 *
 * A deployment that has not finished has no container to read, and one that
 * failed never got one. Both used to surface whatever the engine said about the
 * absence - "the command failed (exit 1)" over a deploy that was building
 * perfectly well - which describes the query rather than the deployment. Those
 * two states are answered here instead, and point at the log that does exist.
 */
function RuntimeLogView({
    appId,
    deployment,
    onSeeBuild
}: {
    appId: string;
    deployment: DepSummary | null;
    onSeeBuild: () => void;
}) {
    const [log, setLog] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const pending = deployment !== null && !isSettled(deployment);
    const failed = deployment !== null && ["failed", "cancelled", "rolled_back"].includes(deployment.status);

    useEffect(() => {
        // Nothing to poll for: there is no container behind either state.
        if (pending || failed) return;
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
    }, [appId, pending, failed]);

    if (pending || failed) {
        return (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                    {pending
                        ? "Nothing is running yet - this deployment is still being built."
                        : "This deployment never started. It failed while it was being built."}
                </p>
                <Button size="sm" variant="outline" onClick={onSeeBuild}>
                    <ScrollText className="size-4" />
                    {pending ? "Watch the build" : "See what went wrong"}
                </Button>
            </div>
        );
    }
    if (error) return <Empty text={error} />;
    if (log === null) return <Loading />;
    if (!log.trim()) {
        return <Empty text="No runtime logs yet. The container may have just started, or writes nothing to stdout." />;
    }
    return (
        <div className="flex flex-col gap-2">
            <LivePill />
            <LogViewer log={log} name={`${appId}-runtime`} searchable className="h-[26rem]" />
        </div>
    );
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
    const format = useDisplayFormat();
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
    // True only when the user narrowed the set themselves. Distinguishes a genuine
    // "no match" from the deployment-scope clamp silently hiding all history.
    const hasUserFilter = method !== "all" || statusClass !== "all" || query !== "" || ipFilter !== null || Boolean(from) || Boolean(to);

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
                    <LivePill />
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
                all.length > 0 && scoped && !hasUserFilter ? (
                    // Every request in the log predates this deployment: the scope clamp,
                    // not a user filter, is hiding them. Say so and offer the full history.
                    <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                        <p>
                            No requests since this deployment started
                            {deploymentStart ? ` (${format.dateTime(deploymentStart)})` : ""}.
                        </p>
                        <p className="text-xs">
                            {all.length} earlier request{all.length === 1 ? "" : "s"} in the log.
                        </p>
                        <Button type="button" variant="outline" size="sm" onClick={() => setScopeDeploy(false)}>
                            Show all history
                        </Button>
                    </div>
                ) : (
                    <Empty
                        text={
                            all.length > 0
                                ? "No requests match the filter."
                                : "No HTTP requests yet. They appear here as soon as traffic reaches the running service."
                        }
                    />
                )
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
                                        {entry.time ? format.time(entry.time, { seconds: true }) : "-"}
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
    const [items, setItems] = useState<Awaited<ReturnType<typeof deployActions.listEnvVarsAction>> | null>(null);
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
        void deployActions.listEnvVarsAction(scope, scopeId).then(setItems);
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
        void deployActions.revealEnvVarAction(item.id).then((result) => {
            if (typeof result.value === "string") setRevealed((prev) => ({ ...prev, [item.id]: result.value as string }));
        });
    }

    function importRaw() {
        setError(null);
        setNote(null);
        startTransition(async () => {
            const result = await deployActions.importEnvVarsAction({ scope, scopeId, text: raw, isSecret: true });
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
            const result = await deployActions.saveEnvVarAction({ scope, scopeId, key, value, isSecret });
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
                    <Textarea
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
                                    className="text-muted-foreground transition-opacity hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                                    aria-label={shown ? "Hide value" : "Reveal value"}
                                >
                                    {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                </button>
                                <button
                                    type="button"
                                    title="Remove"
                                    onClick={() => startTransition(async () => { await deployActions.deleteEnvVarAction(item.id); reload(); })}
                                    className="text-muted-foreground transition-opacity hover:text-danger md:opacity-0 md:group-hover:opacity-100"
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

/** Human-readable byte count (B, KB, MB, GB, TB). */
function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function MetricsTab({ applicationId }: { applicationId: string }) {
    const [data, setData] = useState<{
        state?: string;
        cpuPercent?: number | null;
        memPercent?: number | null;
        memUsedBytes?: number | null;
        memTotalBytes?: number | null;
    } | null>(null);
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
                    <Meter label="CPU" value={data.cpuPercent} />
                    <Meter
                        label="Memory"
                        value={data.memPercent}
                        text={
                            typeof data.memUsedBytes === "number"
                                ? `${formatBytes(data.memUsedBytes)}${typeof data.memTotalBytes === "number" ? ` / ${formatBytes(data.memTotalBytes)}` : ""}`
                                : undefined
                        }
                    />
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

/** Charts drawn on the Deploy Metrics tab: CPU as a percentage, memory as absolute
 *  usage (a container's memory is a tiny fraction of host RAM, so a percent reads as
 *  0 - show the real MB/GB and let the chart auto-scale, like the Containers app). */
const DEPLOY_METRICS: MetricSpec[] = [
    { key: "cpu", label: "CPU", value: (point) => point.cpuPercent, format: percent, tone: "primary", max: 100 },
    {
        key: "mem",
        label: "Memory",
        value: (point) => point.memUsedBytes,
        // The absolute figure is the honest one here, but "of 16 GB" is what makes
        // it mean anything.
        describe: (point) => {
            const share = ratioPercent(point.memUsedBytes, point.memTotalBytes);
            return share === null || point.memTotalBytes === null
                ? null
                : `${percent(share)} of ${formatBytes(point.memTotalBytes)}`;
        },
        format: formatBytes,
        tone: "success"
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
    { key: "req", label: "Requests", value: (point) => point.requests, format: (value) => String(Math.round(value)), tone: "primary", summary: "sum" },
    { key: "err", label: "Request error rate", value: (point) => point.errorRate, format: percent, tone: "danger", max: 100, summary: "avg" },
    { key: "rt", label: "Response time", value: (point) => point.avgResponseMs, format: (value) => `${Math.round(value)} ms`, tone: "warning", summary: "avg" },
    { key: "net", label: "Public network traffic", value: (point) => point.bytesPerSec, format: formatRate, tone: "success", summary: "avg" }
];

/**
 * A percentage with the reading behind it. A container's memory is a sliver of
 * host RAM, so rounding the percentage to a whole number printed "0%" for a
 * service that was very much running - the percentage keeps its digits, and the
 * absolute figure sits beside it.
 */
function Meter({
    label,
    value,
    text
}: {
    label: string;
    value: number | null | undefined;
    /** The same reading in its own units (e.g. absolute memory), shown beside the
     *  percentage. The bar always uses value. */
    text?: string;
}) {
    const pct = typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
    const display = typeof value === "number" ? percent(value) : "-";
    return (
        <div className="rounded-lg border border-border/60 p-4">
            <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground">
                    {display}
                    {text ? <span className="ml-2 text-xs">{text}</span> : null}
                </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

/** Per-app Cloudflare Quick Tunnel: a public URL with no account/DNS/port-forward.
 *  Loads the live state, then starts/refreshes/stops the cloudflared sidecar. */
/** One exposure method inside Public access. A shared shell so the domain form and
 *  the two tunnels read as parallel options of one section, not competing panels. */
function MethodBlock({
    icon,
    title,
    description,
    children
}: {
    icon: ReactNode;
    title: string;
    description: string;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-surface/30 p-3">
            <div className="flex flex-col gap-0.5">
                <h4 className="flex items-center gap-1.5 text-sm font-medium">
                    {icon}
                    {title}
                </h4>
                <p className="text-xs text-muted-foreground">{description}</p>
            </div>
            {children}
        </div>
    );
}

/** One active exposure in the Public access list: a link + optional badge, an
 *  enable/disable switch, and an optional remove control, so tunnels read and behave
 *  like the domain rows above them. */
function ExposureRow({
    icon,
    label,
    href,
    badge,
    enabled,
    pending,
    onToggle,
    onRemove,
    removeLabel
}: {
    icon: ReactNode;
    label: string;
    href: string | null;
    badge?: string;
    enabled: boolean;
    pending: boolean;
    onToggle: (next: boolean) => void;
    onRemove?: () => void;
    removeLabel?: string;
}) {
    const linkClass = enabled
        ? "inline-flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-primary hover:underline"
        : "inline-flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground line-through";
    return (
        <li className="group flex items-center gap-2">
            {href && enabled ? (
                <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
                    <span className="shrink-0">{icon}</span> {label}
                </a>
            ) : (
                <span className={linkClass}>
                    <span className="shrink-0">{icon}</span> {label}
                </span>
            )}
            {badge && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{badge}</span>
            )}
            <Switch checked={enabled} onChange={onToggle} disabled={pending} aria-label={enabled ? "Disable" : "Enable"} />
            {/* Remove sits to the right of the switch, in a fixed-width slot so the
                switches still line up across every row whether or not a row has one. */}
            <span className="flex w-5 shrink-0 items-center justify-center">
                {onRemove && (
                    <button
                        type="button"
                        title={removeLabel ?? "Remove"}
                        onClick={onRemove}
                        disabled={pending}
                        className="text-muted-foreground transition-opacity hover:text-danger disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100"
                    >
                        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                    </button>
                )}
            </span>
        </li>
    );
}

/** The app's Cloudflare quick tunnel, shown when running. Refetches on `nonce` change. */
function QuickTunnelRow({ appId, nonce, onChanged }: { appId: string; nonce: number; onChanged: () => void }) {
    const [status, setStatus] = useState<Awaited<ReturnType<typeof deployActions.quickTunnelStatusAction>> | null>(null);
    const [pending, startTransition] = useTransition();
    useEffect(() => {
        void deployActions.quickTunnelStatusAction(appId).then(setStatus).catch(() => undefined);
    }, [appId, nonce]);
    if (!status?.running) return null;
    return (
        <ExposureRow
            icon={<CloudflareMark className="size-3.5" />}
            label={status.url ? status.url.replace(/^https?:\/\//, "") : "starting..."}
            href={status.url}
            // The sidecar can be up with a hostname that no longer answers, so say
            // which it is instead of presenting every running tunnel as a live link.
            badge={!status.url ? "starting..." : status.reachable ? "quick link" : "not answering"}
            enabled
            pending={pending}
            onToggle={() =>
                startTransition(async () => {
                    await deployActions.stopQuickTunnelAction(appId).catch(() => undefined);
                    onChanged();
                })
            }
        />
    );
}

/** The app's ngrok tunnel, shown when running. */
function NgrokTunnelRow({ appId, nonce, onChanged }: { appId: string; nonce: number; onChanged: () => void }) {
    const [status, setStatus] = useState<Awaited<ReturnType<typeof deployActions.ngrokTunnelStatusAction>> | null>(null);
    const [pending, startTransition] = useTransition();
    useEffect(() => {
        void deployActions.ngrokTunnelStatusAction(appId).then(setStatus).catch(() => undefined);
    }, [appId, nonce]);
    if (!status?.running) return null;
    return (
        <ExposureRow
            icon={<NgrokMark className="size-3.5" />}
            label={status.url ? status.url.replace(/^https?:\/\//, "") : "starting..."}
            href={status.url}
            badge="ngrok"
            enabled
            pending={pending}
            onToggle={() =>
                startTransition(async () => {
                    await deployActions.stopNgrokTunnelAction(appId).catch(() => undefined);
                    onChanged();
                })
            }
        />
    );
}

/** The app's Cloudflare named tunnel (stable hostname), shown when configured. */
function NamedTunnelRow({ appId, nonce, onChanged }: { appId: string; nonce: number; onChanged: () => void }) {
    const [status, setStatus] = useState<Awaited<ReturnType<typeof deployActions.namedTunnelStatusAction>> | null>(null);
    const [pending, startTransition] = useTransition();
    useEffect(() => {
        void deployActions.namedTunnelStatusAction(appId).then(setStatus).catch(() => undefined);
    }, [appId, nonce]);
    if (!status?.configured || !status.hostname) return null;
    const enabled = status.enabled;
    return (
        <ExposureRow
            icon={<CloudflareMark className="size-3.5" />}
            label={status.hostname}
            href={`https://${status.hostname}`}
            badge={!enabled ? "disabled" : status.managed ? "auto" : status.running ? "tunnel" : "not running"}
            enabled={enabled}
            pending={pending}
            onToggle={(next) =>
                startTransition(async () => {
                    await deployActions.setNamedTunnelEnabledAction({ applicationId: appId, enabled: next }).catch(() => undefined);
                    onChanged();
                })
            }
            onRemove={() =>
                startTransition(async () => {
                    await deployActions.stopNamedTunnelAction(appId).catch(() => undefined);
                    onChanged();
                })
            }
            removeLabel="Remove tunnel"
        />
    );
}

/** Every way to expose a service, unified into the one Public access selector. */
type ExposureKind =
    | "zone"
    | "subdomain"
    | "local"
    | "le"
    | "duckdns"
    | "proxy"
    | "cf-named"
    | "cf-quick"
    | "ngrok";

const EXPOSURE_OPTIONS: { value: ExposureKind; label: string; icon: ReactNode }[] = [
    { value: "zone", label: "Your domain (zone subdomain)", icon: <Globe className="size-4 text-primary" /> },
    { value: "subdomain", label: "Free subdomain (auto)", icon: <Globe className="size-4 text-muted-foreground" /> },
    { value: "local", label: "Local subdomain (LAN)", icon: <MapPin className="size-4 text-muted-foreground" /> },
    { value: "le", label: "Custom domain (any hostname)", icon: <Globe className="size-4 text-muted-foreground" /> },
    { value: "cf-named", label: "Cloudflare tunnel - custom domain", icon: <CloudflareMark className="size-4" /> },
    { value: "cf-quick", label: "Cloudflare quick link (free)", icon: <CloudflareMark className="size-4" /> },
    { value: "ngrok", label: "ngrok tunnel", icon: <NgrokMark className="size-4" /> },
    { value: "duckdns", label: "DuckDNS subdomain", icon: <img src="/logos/duckdns.webp" alt="" className="size-4 shrink-0" /> },
    { value: "proxy", label: "Behind a tunnel/proxy", icon: <Globe className="size-4 text-muted-foreground" /> }
];

/** Stands in for the base-domain zone, whose label is empty - Radix rejects an
 *  empty select value, and "@" is how a DNS zone's own record is written anyway. */
const ZONE_ROOT = "@";

/** What the server says about the subdomain in the field: the name, the hostname it
 *  makes, and whether anything already answers on it. */
type ZoneSubdomainCheck = Awaited<ReturnType<typeof deployActions.zoneSubdomainAction>>;

/** A URL-safe label from the app name, the default for a local/DuckDNS subdomain. */
function defaultLabel(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

/** What the server did about a custom hostname's DNS, when it did anything. */
type AddDomainDns = Awaited<ReturnType<typeof deployActions.addDomainAction>>["dns"];

/** What is left to do about a custom hostname's DNS, in one line. Null when the name
 *  already answers here, which is the case that needs saying nothing. */
function dnsAdvice(dns: AddDomainDns, hostname: string): string | null {
    if (!dns || dns.status === "unchanged") return null;
    if (dns.status === "created") return `${hostname} now points at ${dns.ip}. It may take a few minutes to spread.`;
    if (dns.status === "conflict") {
        return `${hostname} already points at ${dns.content}, so Polaris left it alone. Repoint it at ${dns.ip} to serve this app here.`;
    }
    const target = dns.ip ? ` at ${dns.ip}` : "";
    return `Point ${hostname}${target} in your DNS provider${dns.detail ? ` - ${dns.detail}` : "."}`;
}

function SettingsTab({
    app,
    isGit,
    staged,
    onChanged
}: {
    app: ProjectApp;
    isGit: boolean;
    staged: boolean;
    onChanged: () => void;
}) {
    const [autoDeploy, setAutoDeploy] = useState(app.autoDeploy);
    const [branch, setBranch] = useState(app.deployBranch ?? "");
    const [filter, setFilter] = useState(app.commitFilter ?? "");
    const [watchPaths, setWatchPaths] = useState(app.watchPaths ?? "");
    const [rootDirectory, setRootDirectory] = useState(app.rootDirectory ?? "");
    const [dockerfilePath, setDockerfilePath] = useState(app.dockerfilePath ?? "");
    const [installCommand, setInstallCommand] = useState(app.installCommand ?? "");
    const [buildCommand, setBuildCommand] = useState(app.buildCommand ?? "");
    const [startCommand, setStartCommand] = useState(app.startCommand ?? "");
    const [keepReleases, setKeepReleases] = useState(app.keepReleases);
    // Empty means "not pinned": the deploy detects the container port from the image
    // (see buildAppPlan). Only a value the user types here pins it.
    const [containerPort, setContainerPort] = useState(app.port != null ? String(app.port) : "");
    const [hostname, setHostname] = useState("");
    const [label, setLabel] = useState("");
    const [connectorToken, setConnectorToken] = useState("");
    const [port, setPort] = useState(app.port != null ? String(app.port) : "");
    const [advanced, setAdvanced] = useState(false);
    const [exposure, setExposure] = useState<ExposureKind>("subdomain");
    // Set as soon as the operator picks a method, so the async zone default below
    // never overrides a deliberate choice.
    const exposureTouched = useRef(false);
    const [cfConnected, setCfConnected] = useState(false);
    const [duckSub, setDuckSub] = useState<string | null>(null);
    const [zones, setZones] = useState<Array<{ label: string; host: string; primary: boolean }>>([]);
    // The operator's own domain, offered as the suggested custom hostname so a name
    // straight on it (app.example.com) is as obvious a choice as one in a zone.
    const [baseDomain, setBaseDomain] = useState("");
    const [zoneLabel, setZoneLabel] = useState<string | null>(null);
    const [randomName, setRandomName] = useState(false);
    // The subdomain the zone hostname takes. Empty means "not chosen yet": the server
    // then proposes the service's own name, or a free variant of it, and the field
    // adopts what it answers so what is shown is what will be created.
    const [subdomain, setSubdomain] = useState("");
    const [subdomainCheck, setSubdomainCheck] = useState<ZoneSubdomainCheck | null>(null);
    const [checkingSubdomain, setCheckingSubdomain] = useState(false);
    /** Zone + name the check already answered for, so adopting its answer or
     *  re-rendering does not ask again for a name nothing changed about. */
    const checkedSubdomain = useRef<string | null>(null);
    const [tunnelNonce, setTunnelNonce] = useState(0);
    const [error, setError] = useState<string | null>(null);
    // Kept after a successful add: a custom domain works only once its DNS points here,
    // and whether Polaris managed that itself is the one thing the operator has to know.
    const [dnsNote, setDnsNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        void deployActions.cloudflareAccountStatusAction().then((status) => setCfConnected(status.connected)).catch(() => undefined);
        void deployActions.duckdnsSubdomainAction().then((result) => setDuckSub(result.subdomain)).catch(() => undefined);
        // The zones belong to the Polaris host: their wildcard points here, so an app
        // on a remote server would be offered a hostname that resolves to the wrong
        // machine (and the server would ignore it anyway). Those keep their own
        // server's domain instead.
        if (app.serverId !== "local") return;
        void deployActions.deployZonesAction()
            .then(({ baseDomain: base, zones: result }) => {
                setZones(result);
                setBaseDomain(base);
                // A configured domain is the best default: it is the only option that
                // yields a stable, public hostname without a third party in the path.
                // The layout's own default zone wins, not merely the first stored one.
                // Only while the operator has not chosen yet, though - this resolves
                // after a round trip, and replacing a choice made in the meantime would
                // add a different kind of domain than the one they pressed for.
                if (result.length > 0 && !exposureTouched.current) {
                    setExposure("zone");
                    setZoneLabel((result.find((zone) => zone.primary) ?? result[0])?.label ?? "");
                }
            })
            .catch(() => undefined);
    }, [app.serverId]);

    // Resolve the subdomain field: with nothing typed the server proposes a free name,
    // and with something typed it says whether that one is still free. Debounced only
    // once there is something typed - the first proposal should not make the field
    // sit empty for half a second.
    const zoneKey = zoneLabel ?? zones[0]?.label ?? "";
    useEffect(() => {
        if (exposure !== "zone" || randomName || zones.length === 0) return;
        const typed = subdomain.trim();
        const key = `${zoneKey}|${typed}`;
        if (checkedSubdomain.current === key) return;
        let active = true;
        setCheckingSubdomain(true);
        const timer = setTimeout(() => {
            void deployActions.zoneSubdomainAction({ applicationId: app.id, zoneLabel: zoneKey, subdomain: typed || undefined })
                .then((result) => {
                    if (!active) return;
                    checkedSubdomain.current = `${zoneKey}|${result.subdomain}`;
                    setCheckingSubdomain(false);
                    setSubdomainCheck(result);
                    if (!typed && result.subdomain) setSubdomain(result.subdomain);
                })
                .catch(() => {
                    if (active) setCheckingSubdomain(false);
                });
        }, typed ? 400 : 0);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [app.id, exposure, randomName, subdomain, zoneKey, zones.length]);

    function saveSettings() {
        setError(null);
        startTransition(async () => {
            const portValue = Number(containerPort.trim());
            if (Number.isInteger(portValue) && portValue > 0) {
                const portResult = await deployActions.setAppPortAction(app.id, portValue);
                if (portResult.error) {
                    setError(portResult.error);
                    return;
                }
            }
            if (isGit) {
                const paths = await deployActions.setAppSourcePathsAction({
                    applicationId: app.id,
                    rootDirectory: rootDirectory.trim(),
                    dockerfilePath: dockerfilePath.trim(),
                    installCommand: installCommand.trim(),
                    buildCommand: buildCommand.trim(),
                    startCommand: startCommand.trim()
                });
                if (paths.error) {
                    setError(paths.error);
                    return;
                }
            }
            const result = await deployActions.setAutoDeployAction({
                applicationId: app.id,
                autoDeploy,
                deployBranch: branch.trim() || undefined,
                commitFilter: filter.trim() || undefined,
                watchPaths: watchPaths.trim() || undefined,
                keepReleases
            });
            if (result.error) setError(result.error);
            else onChanged();
        });
    }

    // Domain kinds serve on standard 80/443 (the port is a target detail, hidden under
    // Advanced). "local"/"duckdns" ask for just a label; "le"/"proxy"/"cf-named" a full
    // hostname; "subdomain"/tunnels need nothing.
    const isDomainExposure =
        exposure === "zone" ||
        exposure === "subdomain" ||
        exposure === "local" ||
        exposure === "le" ||
        exposure === "duckdns" ||
        exposure === "proxy";
    const usesLabel = exposure === "local" || exposure === "duckdns";
    const needsHostname = exposure === "le" || exposure === "proxy" || exposure === "cf-named";
    const labelSuffix = exposure === "local" ? ".plr.local" : exposure === "duckdns" && duckSub ? `.${duckSub}.duckdns.org` : "";
    // Suggest a name straight on the operator's own domain, since that is the one
    // people reach for first and the zone picker cannot offer it. Any other domain is
    // just as valid - the field takes whatever is typed.
    const hostnameHint = baseDomain ? `${defaultLabel(app.name)}.${baseDomain}` : "app.example.com";
    const duckMissing = exposure === "duckdns" && !duckSub;
    // A tunnel URL is already exposed by its tunnel; adding it as a domain only makes a
    // duplicate, dead route. Flag it as the user types (the server rejects it too).
    const hostnameIsTunnel = (exposure === "le" || exposure === "proxy") && isTunnelHostname(hostname.trim());

    // The target port the route stores: the Advanced override, else the app's known
    // port, else a sensible default. Routing serves on 80/443 regardless.
    function targetPort(): number {
        const override = Number(port.trim());
        if (advanced && Number.isInteger(override) && override > 0) return override;
        return app.port ?? (app.sourceType === "image" ? 80 : 3000);
    }

    // One action for every exposure: domains go through deployActions.addDomainAction, the three
    // tunnel kinds through their own start/provision actions. Tunnel results show up
    // in the list above via the row components once the nonce bumps.
    function submitExposure() {
        setError(null);
        setDnsNote(null);
        const labelValue = label.trim() || defaultLabel(app.name);
        startTransition(async () => {
            let result: { error?: string; hostname?: string | null; dns?: AddDomainDns } = {};
            if (exposure === "zone") {
                result = await deployActions.addDomainAction({
                    applicationId: app.id,
                    targetPort: targetPort(),
                    zoneLabel: zoneKey,
                    random: randomName,
                    subdomain: randomName ? undefined : subdomain.trim() || undefined
                });
            } else if (exposure === "subdomain") {
                // Auto = always reachable: a universally-resolvable sslip.io LAN name,
                // plus a free Cloudflare quick tunnel for public access when behind NAT.
                result = await deployActions.autoExposeAction({ applicationId: app.id, targetPort: targetPort() });
            } else if (exposure === "local") {
                result = await deployActions.addDomainAction({ applicationId: app.id, hostname: `${labelValue}.plr.local`, targetPort: targetPort(), cert: "internal" });
            } else if (exposure === "duckdns") {
                if (!duckSub) {
                    setError("Configure DuckDNS under Integrations first");
                    return;
                }
                result = await deployActions.addDomainAction({ applicationId: app.id, hostname: `${labelValue}.${duckSub}.duckdns.org`, targetPort: targetPort(), cert: "le" });
            } else if (exposure === "le") {
                result = await deployActions.addDomainAction({ applicationId: app.id, hostname: hostname.trim() || undefined, targetPort: targetPort(), cert: "le" });
            } else if (exposure === "proxy") {
                result = await deployActions.addDomainAction({ applicationId: app.id, hostname: hostname.trim() || undefined, targetPort: targetPort(), cert: "none" });
            } else if (exposure === "cf-named") {
                result = cfConnected
                    ? await deployActions.provisionNamedTunnelAction({ applicationId: app.id, hostname })
                    : await deployActions.startNamedTunnelAction({ applicationId: app.id, token: connectorToken, hostname });
            } else if (exposure === "cf-quick") {
                result = await deployActions.startQuickTunnelAction(app.id);
            } else if (exposure === "ngrok") {
                result = await deployActions.startNgrokTunnelAction(app.id);
            }
            if (result.error) setError(result.error);
            else {
                setDnsNote(dnsAdvice(result.dns, result.hostname ?? hostname.trim()));
                // Reset the add-a-domain form to a clean state after a successful add.
                setHostname("");
                setLabel("");
                // The name just created is taken now, so the next proposal has to be
                // asked for again rather than kept from before.
                setSubdomain("");
                setSubdomainCheck(null);
                checkedSubdomain.current = null;
                setConnectorToken("");
                setAdvanced(false);
                setPort(app.port != null ? String(app.port) : "");
                setTunnelNonce((nonce) => nonce + 1);
                onChanged();
            }
        });
    }

    const submitLabel =
        exposure === "cf-quick" || exposure === "ngrok"
            ? "Expose"
            : exposure === "cf-named"
              ? cfConnected
                  ? "Set up"
                  : "Connect"
              : "Add domain";
    // The zone the name goes in, for the suffix beside the field.
    const zoneHost = zones.find((zone) => zone.label === zoneKey)?.host ?? zones[0]?.host ?? "";
    // Only a checked answer about the name itself blocks the add: while a check is in
    // flight the operator is still typing, and a zone that cannot mint at all is the
    // add's error to report, not something to blame the typed name for.
    const subdomainTaken =
        exposure === "zone" &&
        !randomName &&
        !checkingSubdomain &&
        !subdomainCheck?.error &&
        subdomainCheck?.available === false;
    const submitDisabled =
        pending ||
        duckMissing ||
        hostnameIsTunnel ||
        subdomainTaken ||
        (needsHostname && !hostname.trim()) ||
        (exposure === "cf-named" && !cfConnected && !connectorToken.trim());

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
                        Reach this service from the internet. Point a domain here, or expose it through a Cloudflare
                        tunnel that needs no DNS or port-forwarding - pick whichever method fits your setup.
                    </p>
                </div>
                <ul className="flex flex-col gap-1">
                    {app.domains.map((domain) => (
                        <li key={domain.id} className="group flex items-center gap-2">
                            {domain.enabled && (
                                <span
                                    title={
                                        domain.healthStatus === "down"
                                            ? `Not reachable${domain.healthDetail ? ` - ${domain.healthDetail}` : ""}`
                                            : domain.healthStatus === "up"
                                              ? `Reachable${domain.healthCode ? ` (HTTP ${domain.healthCode})` : ""}`
                                              : "Not checked yet"
                                    }
                                    className={cn(
                                        "size-2 shrink-0 rounded-full",
                                        domain.healthStatus === "up" && "bg-success",
                                        domain.healthStatus === "down" && "bg-danger",
                                        domain.healthStatus !== "up" &&
                                            domain.healthStatus !== "down" &&
                                            "bg-muted-foreground/40"
                                    )}
                                />
                            )}
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
                            {(domain.kind === "lan" || domain.hostname.endsWith(".plr.local")) && (
                                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">local</span>
                            )}
                            <Switch
                                checked={domain.enabled}
                                onChange={(next) => startTransition(async () => { await deployActions.setDomainEnabledAction(domain.id, next); onChanged(); })}
                                aria-label={domain.enabled ? "Disable domain" : "Enable domain"}
                            />
                            <span className="flex w-5 shrink-0 items-center justify-center">
                                <button
                                    type="button"
                                    title="Remove domain"
                                    onClick={() => startTransition(async () => { await deployActions.removeDomainAction(domain.id); onChanged(); })}
                                    className="text-muted-foreground transition-opacity hover:text-danger md:opacity-0 md:group-hover:opacity-100"
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            </span>
                        </li>
                    ))}
                    <NamedTunnelRow appId={app.id} nonce={tunnelNonce} onChanged={() => setTunnelNonce((nonce) => nonce + 1)} />
                    <QuickTunnelRow appId={app.id} nonce={tunnelNonce} onChanged={() => setTunnelNonce((nonce) => nonce + 1)} />
                    <NgrokTunnelRow appId={app.id} nonce={tunnelNonce} onChanged={() => setTunnelNonce((nonce) => nonce + 1)} />
                </ul>
                <MethodBlock
                    icon={<Globe className="size-4" />}
                    title="Add a domain"
                    description="Pick how to expose this service - a free subdomain, your own domain with Let's Encrypt, or a Cloudflare/ngrok tunnel that needs no DNS or port-forwarding."
                >
                    <div className="flex flex-col gap-2">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Exposure
                            <Select
                                value={exposure}
                                onValueChange={(value) => {
                                    exposureTouched.current = true;
                                    setExposure(value as ExposureKind);
                                    setDnsNote(null);
                                }}
                                options={EXPOSURE_OPTIONS.filter((option) => option.value !== "zone" || zones.length > 0)}
                                aria-label="Exposure method"
                            />
                        </label>
                        {exposure === "zone" && zones.length > 0 && (
                            <div className="flex flex-col gap-2">
                                <Select
                                    value={(zoneLabel ?? zones[0]?.label) || ZONE_ROOT}
                                    onValueChange={(value) => {
                                        setZoneLabel(value === ZONE_ROOT ? "" : value);
                                        setSubdomainCheck(null);
                                    }}
                                    options={zones.map((zone) => ({ value: zone.label || ZONE_ROOT, label: `*.${zone.host}` }))}
                                    aria-label="Zone"
                                />
                                {!randomName && (
                                    <div className="flex flex-col gap-1">
                                        <div className="flex items-center gap-2">
                                            <Input
                                                value={subdomain}
                                                onChange={(event) => setSubdomain(event.target.value)}
                                                placeholder={defaultLabel(app.name)}
                                                autoComplete="off"
                                                aria-invalid={subdomainTaken}
                                                aria-label="Subdomain"
                                            />
                                            <span className="shrink-0 text-xs text-muted-foreground">.{zoneHost}</span>
                                        </div>
                                        {subdomainTaken && (
                                            <p className="text-xs text-danger">
                                                {subdomainCheck?.invalid
                                                    ? "Use letters, digits and dashes."
                                                    : "That subdomain is already in use."}
                                            </p>
                                        )}
                                    </div>
                                )}
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Checkbox
                                        checked={randomName}
                                        onChange={(event) => setRandomName(event.target.checked)}
                                    />
                                    Use a random name instead
                                </label>
                            </div>
                        )}
                        {usesLabel && !duckMissing && (
                            <div className="flex items-center gap-2">
                                <Input
                                    value={label}
                                    onChange={(event) => setLabel(event.target.value)}
                                    placeholder={defaultLabel(app.name)}
                                    autoComplete="off"
                                />
                                <span className="shrink-0 text-xs text-muted-foreground">{labelSuffix}</span>
                            </div>
                        )}
                        {needsHostname && (
                            <Input
                                value={hostname}
                                onChange={(event) => setHostname(event.target.value)}
                                placeholder={hostnameHint}
                                aria-invalid={hostnameIsTunnel}
                            />
                        )}
                        {hostnameIsTunnel && (
                            <p className="text-xs text-danger">
                                That is a tunnel URL - it is already exposed by its tunnel, so it can&apos;t be added as
                                a domain.
                            </p>
                        )}
                        {exposure === "cf-named" && !cfConnected && (
                            <Input
                                value={connectorToken}
                                onChange={(event) => setConnectorToken(event.target.value)}
                                placeholder="Cloudflare connector token (eyJhIjoi...)"
                                className="font-mono"
                            />
                        )}
                        <p className="text-xs text-muted-foreground">
                            {exposure === "zone"
                                ? `A hostname on your own domain, covered by the zone's wildcard record - no DNS to add, with a Let's Encrypt certificate. Choose the subdomain, or take a random one for an unguessable URL. Each build also gets this name with its commit added. For a name outside these zones${baseDomain ? `, like ${hostnameHint}` : ""}, or one on another domain, pick Custom domain.`
                                : exposure === "subdomain"
                                ? "Always reachable: a free sslip.io subdomain that resolves on any device (a public Let's Encrypt name on a reachable box). Behind NAT, Polaris also starts a free Cloudflare quick link so it works from outside. Connect a Cloudflare account or a custom domain for a stable public URL."
                                : exposure === "local"
                                  ? "A friendly <name>.plr.local address, LOCAL only - it resolves on your LAN via mDNS (works on macOS/iOS and most modern devices; Windows may not resolve it, use the free subdomain there). Trusted HTTPS once you install the CA root (Admin - Domains)."
                                  : exposure === "le"
                                    ? `Any hostname on any domain - ${hostnameHint} on your own, or a different domain entirely. Polaris writes the DNS record itself when the domain sits in your connected Cloudflare account; otherwise point it at this server. The certificate is issued automatically either way.`
                                    : exposure === "duckdns"
                                      ? duckMissing
                                          ? "Configure DuckDNS under Integrations first, then pick a subdomain here."
                                          : "Just the subdomain - the base is your DuckDNS domain. It resolves via DuckDNS with a Let's Encrypt certificate automatically."
                                      : exposure === "proxy"
                                        ? "For a domain fronted by an external proxy that terminates TLS."
                                        : exposure === "cf-named"
                                          ? cfConnected
                                              ? "Polaris creates the tunnel and the DNS record for you - just enter a hostname on a domain in your Cloudflare account."
                                              : "Create the tunnel in Cloudflare and paste its connector token. Tip: connect a Cloudflare API token under Integrations to skip this - then you only pick a hostname."
                                          : exposure === "cf-quick"
                                            ? "A throwaway *.trycloudflare.com URL - no account, no DNS, no port-forwarding. The link changes each time it starts."
                                              : "A public ngrok URL forwarded to this app. Add your ngrok authtoken under Integrations first; ngrok's free plan allows one tunnel at a time."}
                        </p>
                        {duckMissing && (
                            <a href="/integrations" className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline">
                                Set up DuckDNS <ExternalLink className="size-3" />
                            </a>
                        )}
                        {isDomainExposure && (
                            <div className="flex flex-col gap-2">
                                <button
                                    type="button"
                                    onClick={() => setAdvanced((value) => !value)}
                                    className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                >
                                    {advanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} Advanced
                                </button>
                                {advanced && (
                                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                        Target port
                                        <Input
                                            value={port}
                                            onChange={(event) => setPort(event.target.value)}
                                            placeholder={String(app.port ?? "auto")}
                                            inputMode="numeric"
                                            className="w-40"
                                        />
                                        <span>
                                            The container port this route targets. The service is served on the standard
                                            80/443 - you never put a port in the URL. Defaults to the app's port.
                                        </span>
                                    </label>
                                )}
                            </div>
                        )}
                        {dnsNote && <p className="text-xs text-muted-foreground">{dnsNote}</p>}
                        <div className="flex justify-end">
                            <Button variant="outline" onClick={submitExposure} disabled={submitDisabled}>
                                {pending && <Loader2 className="size-4 animate-spin" />} {submitLabel}
                            </Button>
                        </div>
                    </div>
                </MethodBlock>
            </section>

            {isGit && (
                <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">Source</h3>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Root directory
                            <Input
                                value={rootDirectory}
                                onChange={(event) => setRootDirectory(event.target.value)}
                                placeholder="apps/web"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                            />
                            <span>
                                Where this service lives in the repository. The build still gets the whole repository, so
                                shared packages and the lockfile above it are available. Blank = the repository root.
                            </span>
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Dockerfile path
                            <Input
                                value={dockerfilePath}
                                onChange={(event) => setDockerfilePath(event.target.value)}
                                placeholder="Dockerfile"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                            />
                            <span>
                                {rootDirectory.trim()
                                    ? `Relative to ${rootDirectory.trim()}.`
                                    : "Relative to the repository root."}
                            </span>
                        </label>
                    </div>
                </section>
            )}

            {app.sourceType === "nixpacks" && (
                <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">Build</h3>
                    <p className="text-xs text-muted-foreground">
                        Polaris reads the repository and works these out - the framework, the package manager, and the
                        workspace when there is one. Fill one in only to override what it found; the deployment log says
                        what it detected.
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Install command
                            <Input
                                value={installCommand}
                                onChange={(event) => setInstallCommand(event.target.value)}
                                placeholder="pnpm install --frozen-lockfile"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Build command
                            <Input
                                value={buildCommand}
                                onChange={(event) => setBuildCommand(event.target.value)}
                                placeholder="pnpm run build"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Start command
                            <Input
                                value={startCommand}
                                onChange={(event) => setStartCommand(event.target.value)}
                                placeholder="next start"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                            />
                        </label>
                    </div>
                </section>
            )}

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
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Watch paths
                        <Textarea
                            value={watchPaths}
                            onChange={(event) => setWatchPaths(event.target.value)}
                            placeholder={"apps/web/**\npackages/ui/**\n!**/*.md"}
                            rows={3}
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                        />
                        <span>
                            One glob per line. Deploy only when the push touched one of them, so a repository holding
                            several services rebuilds just the ones that changed. Prefix with ! to exclude. Blank = any
                            change.
                        </span>
                    </label>
                </section>
            )}

            <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Releases</h3>
                <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-sm">
                    <span>
                        <span className="font-medium">Keep previous deployments</span>
                        <span className="block text-xs text-muted-foreground">
                            Keep the last few versions running, each on its own address, while this
                            service&apos;s own address stays on the newest. A service with a volume or on
                            another server keeps the history but not the containers.
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

            <DangerSection app={app} staged={staged} onChanged={onChanged} />
        </div>
    );
}

/**
 * Removing the service. It is queued rather than done: the changeset banner at
 * the top of the project is what actually carries it out, so there is a step
 * between the click and the container being gone.
 */
function DangerSection({ app, staged, onChanged }: { app: ProjectApp; staged: boolean; onChanged: () => void }) {
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function remove() {
        setError(null);
        startTransition(async () => {
            const result = await stageServiceDeleteAction({ applicationId: app.id });
            if (result.error) {
                setError(result.error);
                return;
            }
            setConfirming(false);
            onChanged();
        });
    }

    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-danger">Danger</h3>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 p-3">
                <span className="min-w-0">
                    <span className="text-sm font-medium">Delete service</span>
                    <span className="block text-xs text-muted-foreground">
                        {staged
                            ? "Already queued. Deploy the pending changes to carry it out, or discard it from the banner."
                            : "Removes the container, its domains, variables and deploy history."}
                    </span>
                </span>
                <Button variant="danger" size="sm" disabled={staged} onClick={() => setConfirming(true)}>
                    <Trash2 className="size-4" /> {staged ? "Removal pending" : "Delete"}
                </Button>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}

            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                name={app.name}
                kind="service"
                confirmLabel="Stage removal"
                description="The container, its domains, variables and deploy history go. Nothing happens until you deploy the pending changes."
                error={error}
                pending={pending}
                onConfirm={remove}
            />
        </section>
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
        void deployActions.listDeployServersAction()
            .then((list) => setServers(list))
            .catch(() => undefined);
    }, []);

    const changed = serverId !== app.serverId;

    function move() {
        setError(null);
        startTransition(async () => {
            const result = await deployActions.setAppServerAction(app.id, serverId);
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
