"use client";

/**
 * Service detail panel (Railway-style): opens on a service and exposes its
 * deployment history, environment variables, metrics, an interactive console, a
 * file browser, and settings (auto-deploy, keep-releases, domains) as tabs.
 * Reuses the existing terminal/files/logs building blocks.
 */

import { useEffect, useState, useTransition } from "react";
import { Eye, EyeOff, Globe, Loader2, Plus, Trash2 } from "lucide-react";
import { Badge, Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Switch } from "@polaris/ui";
import { ServiceIcon, StatusPill, DeploymentLogs, dbTone, serviceKindOf, type ProjectApp } from "./deploy-view";
import { TerminalPanel } from "./terminal-panel";
import { FilesPanel } from "./files-panel";
import {
    addDomainAction,
    deleteEnvVarAction,
    deployApplicationAction,
    listDeploymentsAction,
    listEnvVarsAction,
    saveEnvVarAction,
    setAutoDeployAction
} from "./actions";

const TABS = ["Deployments", "Variables", "Metrics", "Console", "Files", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function ServiceDetail({ app, onChanged, onClose }: { app: ProjectApp; onChanged: () => void; onClose: () => void }) {
    const [tab, setTab] = useState<Tab>("Deployments");
    const isGit = app.sourceType === "dockerfile" || app.sourceType === "nixpacks";

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-4xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <ServiceIcon kind={serviceKindOf(app.sourceType)} className="size-5 text-foreground" />
                        {app.name}
                        {app.currentDeploymentId && (
                            <StatusPill tone={dbTone(app.deployStatus ?? "")} label={app.deployStatus ?? "deployed"} />
                        )}
                    </DialogTitle>
                </DialogHeader>

                <div className="flex items-center gap-1 border-b border-border/60 text-sm">
                    {TABS.map((name) => (
                        <button
                            key={name}
                            type="button"
                            onClick={() => setTab(name)}
                            className={`-mb-px border-b-2 px-3 py-2 transition-colors ${
                                tab === name
                                    ? "border-primary text-foreground"
                                    : "border-transparent text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {name}
                        </button>
                    ))}
                </div>

                <div className="min-h-[22rem]">
                    {tab === "Deployments" && <DeploymentsTab app={app} onChanged={onChanged} />}
                    {tab === "Variables" && <VariablesTab applicationId={app.id} />}
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
            <div className="flex justify-end">
                <Button
                    size="sm"
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

function VariablesTab({ applicationId }: { applicationId: string }) {
    const [items, setItems] = useState<Awaited<ReturnType<typeof listEnvVarsAction>> | null>(null);
    const [key, setKey] = useState("");
    const [value, setValue] = useState("");
    const [isSecret, setIsSecret] = useState(true);
    const [reveal, setReveal] = useState<Record<string, boolean>>({});
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function reload() {
        void listEnvVarsAction(applicationId).then(setItems);
    }
    useEffect(reload, [applicationId]);

    function add() {
        setError(null);
        startTransition(async () => {
            const result = await saveEnvVarAction({ applicationId, key, value, isSecret });
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
            <p className="text-xs text-muted-foreground">Variables are injected into the container on the next deploy.</p>
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
