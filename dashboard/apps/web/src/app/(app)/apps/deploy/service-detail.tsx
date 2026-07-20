"use client";

/**
 * Service detail panel (Railway-style): opens on a service and exposes its
 * deployment history, environment variables, metrics, an interactive console, a
 * file browser, and settings (auto-deploy, keep-releases, domains) as tabs.
 * Reuses the existing terminal/files/logs building blocks.
 */

import { useEffect, useState, useTransition } from "react";
import { Eye, EyeOff, Globe, Loader2, Maximize2, Minimize2, Plus, Trash2 } from "lucide-react";
import { Badge, Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Switch, cn } from "@polaris/ui";
import { ServiceIcon, StatusPill, DeploymentLogs, dbTone, serviceKindOf, type ProjectApp } from "./deploy-view";
import { TerminalPanel } from "./terminal-panel";
import { FilesPanel } from "./files-panel";
import {
    addDomainAction,
    deleteEnvVarAction,
    deployApplicationAction,
    importEnvVarsAction,
    listDeploymentsAction,
    listEnvVarsAction,
    saveEnvVarAction,
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
                    "left-0 top-0 flex h-full max-h-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none rounded-r-xl border-y-0 border-l-0 p-0 data-[state=open]:slide-in-from-left-4",
                    full ? "w-full max-w-none" : "w-full max-w-none sm:w-[760px]"
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

function DeploymentsTab({ app, onChanged }: { app: ProjectApp; onChanged: () => void }) {
    const [items, setItems] = useState<Awaited<ReturnType<typeof listDeploymentsAction>> | null>(null);
    const [logsFor, setLogsFor] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    function reload() {
        void listDeploymentsAction(app.id).then(setItems);
    }
    useEffect(reload, [app.id]);

    return (
        <div className="flex flex-col gap-3 py-2">
            <div className="flex items-center gap-2">
                {app.domains[0] ? (
                    <a
                        href={`https://${app.domains[0].hostname}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 items-center gap-1 truncate text-sm text-primary hover:underline"
                    >
                        <Globe className="size-3.5 shrink-0" /> {app.domains[0].hostname}
                    </a>
                ) : (
                    <span className="text-sm text-muted-foreground">No domain yet</span>
                )}
                <Button
                    size="sm"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() =>
                        startTransition(async () => {
                            const result = await deployApplicationAction(app.id);
                            if (result.deploymentId) setLogsFor(result.deploymentId);
                            reload();
                            onChanged();
                        })
                    }
                >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : "Deploy"}
                </Button>
            </div>
            {items === null ? (
                <Loading />
            ) : items.length === 0 ? (
                <Empty text="No deployments yet." />
            ) : (
                <ul className="flex flex-col gap-1">
                    {items.map((deployment) => (
                        <li
                            key={deployment.id}
                            className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
                        >
                            <StatusPill tone={dbTone(deployment.status)} label={deployment.status} />
                            {deployment.isCurrent && <Badge variant="success">current</Badge>}
                            <span className="text-xs text-muted-foreground">
                                {new Date(deployment.createdAt).toLocaleString()}
                            </span>
                            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setLogsFor(deployment.id)}>
                                Logs
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            <Dialog open={logsFor !== null} onOpenChange={(open) => !open && setLogsFor(null)}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>Deployment logs</DialogTitle>
                    </DialogHeader>
                    {logsFor && <DeploymentLogs deploymentId={logsFor} onDone={reload} />}
                </DialogContent>
            </Dialog>
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
                <p className="text-xs text-muted-foreground">
                    {scope === "environment"
                        ? "Shared by every service in this environment."
                        : "Injected into this service on the next deploy."}
                </p>
                <Button variant="outline" size="sm" onClick={() => setRawOpen((open) => !open)}>
                    {rawOpen ? "Close" : "Paste .env"}
                </Button>
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
            {items === null ? (
                <Loading />
            ) : items.length === 0 ? (
                <Empty text="No variables yet." />
            ) : (
                <ul className="flex flex-col gap-1">
                    {items.map((item) => (
                        <li key={item.id} className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                            <span className="font-mono text-xs font-medium">{item.key}</span>
                            <span className="ml-2 truncate font-mono text-xs text-muted-foreground">
                                {item.isSecret ? (reveal[item.id] ? "••••••" : "••••••") : item.value}
                            </span>
                            {!item.isSecret && (
                                <button
                                    type="button"
                                    onClick={() => setReveal((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                                    className="text-muted-foreground hover:text-foreground"
                                    aria-label="Toggle"
                                >
                                    {reveal[item.id] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                </button>
                            )}
                            {item.isSecret && <Badge variant="neutral">secret</Badge>}
                            <Button
                                variant="ghost"
                                size="icon"
                                className="ml-auto"
                                title="Remove"
                                onClick={() =>
                                    startTransition(async () => {
                                        await deleteEnvVarAction(item.id);
                                        reload();
                                    })
                                }
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
                <span className="text-xs font-medium text-muted-foreground">New variable</span>
                <div className="flex flex-wrap items-center gap-2">
                    <Input value={key} onChange={(event) => setKey(event.target.value)} placeholder="KEY" className="w-40 font-mono" />
                    <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="value" className="flex-1" />
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch checked={isSecret} onChange={setIsSecret} aria-label="Secret" /> secret
                    </label>
                    <Button onClick={add} disabled={pending || !key.trim()}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add
                    </Button>
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
            </div>
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
