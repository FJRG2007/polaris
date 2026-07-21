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
    Trash2
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
    Switch,
    cn
} from "@polaris/ui";
import { ServiceIcon, StatusPill, dbTone, serviceKindOf, type ProjectApp } from "./deploy-view";
import { TerminalPanel } from "./terminal-panel";
import { FilesPanel } from "./files-panel";
import {
    addDomainAction,
    deleteEnvVarAction,
    deployApplicationAction,
    importEnvVarsAction,
    listDeploymentsAction,
    listEnvVarsAction,
    removeApplicationDeploymentAction,
    restartApplicationAction,
    saveEnvVarAction,
    setApplicationRunningAction,
    setAutoDeployAction
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
                    full ? "w-full max-w-none" : "w-full max-w-none sm:w-[820px]"
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

                <div className="flex items-center gap-1 overflow-x-auto border-b border-border/60 px-5 text-sm">
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

/** A small circular author avatar - a source glyph until real author avatars exist. */
function DeployAvatar({ app }: { app: ProjectApp }) {
    return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <ServiceIcon kind={serviceKindOf(app.sourceType)} className="size-4" />
        </span>
    );
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
                onDone={reload}
            />
        );
    }

    const active = items?.find((item) => item.isCurrent) ?? null;
    const history = (items ?? []).filter((item) => !item.isCurrent);
    const region = app.domains[0] ? "Deployed" : app.sourceType === "image" ? "Registry" : "GitHub";

    return (
        <div className="flex flex-col gap-4 py-2">
            <div className="flex items-center gap-3">
                {app.domains[0] ? (
                    <a
                        href={`https://${app.domains[0].hostname}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
                    >
                        <Globe className="size-4 shrink-0 text-muted-foreground" /> {app.domains[0].hostname}
                    </a>
                ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Globe className="size-4 shrink-0" /> No domain yet
                    </span>
                )}
                <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
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
                                <DeployAvatar app={app} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-foreground">{depTitle(active)}</p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {relativeTime(active.createdAt)} via {sourceLabel(app)}
                                    </p>
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
                                                <DeployAvatar app={app} />
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate font-medium text-foreground">{depTitle(deployment)}</p>
                                                    <p className="truncate text-xs text-muted-foreground">
                                                        {relativeTime(deployment.createdAt)} via {sourceLabel(app)}
                                                    </p>
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

            <div className="flex items-center gap-3 overflow-x-auto border-b border-border/60 text-sm">
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
            ) : cat === "HTTP Logs" || cat === "Network Flow Logs" ? (
                <Empty text={`No ${cat.toLowerCase()} yet.`} />
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
    const [search, setSearch] = useState("");
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

    const lines = log ? log.split("\n") : [];
    const filtered = search.trim() ? lines.filter((line) => line.toLowerCase().includes(search.toLowerCase())) : lines;

    return (
        <div className="flex flex-col gap-2">
            <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Filter and search logs"
                    className="pl-8 font-mono text-xs"
                />
            </div>
            <div className="h-[26rem] overflow-auto rounded-md bg-[#0b0e14] py-2 font-mono text-xs leading-relaxed text-zinc-300">
                {filtered.length === 0 ? (
                    <p className="px-3 py-2 text-muted-foreground">{log ? "No matching lines." : "Waiting for output..."}</p>
                ) : (
                    filtered.map((line, index) => (
                        <div key={index} className="whitespace-pre-wrap px-3 hover:bg-white/5">
                            {line || " "}
                        </div>
                    ))
                )}
            </div>
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
    const [reveal, setReveal] = useState<Record<string, boolean>>({});
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [raw, setRaw] = useState("");
    const [rawOpen, setRawOpen] = useState(false);
    const [showAdd, setShowAdd] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    function reload() {
        setItems(null);
        void listEnvVarsAction(scope, scopeId).then(setItems);
    }
    useEffect(reload, [scope, scopeId]);

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
            <div className="flex items-center justify-between gap-2">
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
                    {items.map((item) => (
                        <li key={item.id} className="group flex items-center gap-3 border-b border-border/40 py-2.5 text-sm">
                            <span className="text-xs text-muted-foreground/50">{"{ }"}</span>
                            <span className="w-60 shrink-0 truncate font-mono text-xs font-medium">{item.key}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                                {item.isSecret ? "•••••••" : reveal[item.id] ? (item.value ?? "") : "•••••••"}
                            </span>
                            {!item.isSecret && (
                                <button
                                    type="button"
                                    onClick={() => setReveal((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                                    className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                                    aria-label="Toggle value"
                                >
                                    {reveal[item.id] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                </button>
                            )}
                            <button
                                type="button"
                                title="Remove"
                                onClick={() => startTransition(async () => { await deleteEnvVarAction(item.id); reload(); })}
                                className="text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                            >
                                <Trash2 className="size-4" />
                            </button>
                        </li>
                    ))}
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

    if (loading) return <Loading />;
    if (!data?.state) return <Empty text="No metrics yet - the service needs a running container." />;

    return (
        <div className="grid gap-3 py-2 sm:grid-cols-2">
            <Meter label="CPU" value={data.cpuPercent} unit="%" />
            <Meter label="Memory" value={data.memPercent} unit="%" />
            <div className="rounded-lg border border-border/60 p-4 text-sm sm:col-span-2">
                State: <span className="font-medium">{data.state}</span>
            </div>
        </div>
    );
}

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

function SettingsTab({ app, isGit, onChanged }: { app: ProjectApp; isGit: boolean; onChanged: () => void }) {
    const [autoDeploy, setAutoDeploy] = useState(app.autoDeploy);
    const [branch, setBranch] = useState(app.deployBranch ?? "");
    const [filter, setFilter] = useState(app.commitFilter ?? "");
    const [keepReleases, setKeepReleases] = useState(app.keepReleases);
    const [hostname, setHostname] = useState("");
    const [port, setPort] = useState("3000");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function saveSettings() {
        setError(null);
        startTransition(async () => {
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
        startTransition(async () => {
            const result = await addDomainAction({ applicationId: app.id, hostname: hostname.trim() || undefined, targetPort: Number(port) });
            if (result.error) setError(result.error);
            else {
                setHostname("");
                onChanged();
            }
        });
    }

    return (
        <div className="flex flex-col gap-5 py-2">
            <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Domains</h3>
                {app.domains.length > 0 ? (
                    <ul className="flex flex-col gap-1">
                        {app.domains.map((domain) => (
                            <li key={domain.id}>
                                <a
                                    href={`https://${domain.hostname}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                >
                                    <Globe className="size-3" /> {domain.hostname}
                                </a>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-xs text-muted-foreground">No domains yet.</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                    <Input value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder="custom domain (blank = free subdomain)" className="flex-1" />
                    <Input value={port} onChange={(event) => setPort(event.target.value)} placeholder="port" className="w-24" />
                    <Button variant="outline" onClick={addDomain} disabled={pending}>
                        Add domain
                    </Button>
                </div>
            </section>

            {isGit && (
                <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">Auto-deploy</h3>
                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>Deploy on push</span>
                        <Switch checked={autoDeploy} onChange={setAutoDeploy} aria-label="Deploy on push" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
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
