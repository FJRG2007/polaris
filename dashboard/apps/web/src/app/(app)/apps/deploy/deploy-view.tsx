"use client";

/**
 * Deploy app view. Lists projects and their applications, and drives create and
 * deploy actions. Projects group environments; each environment holds
 * applications and managed databases. All confirmations are in-app (no native
 * dialogs). Full build/deploy on the local host needs the full edition; the view
 * says so plainly when it is unavailable rather than failing silently.
 */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Boxes, Database, FolderOpen, Globe, Plus, Rocket, TerminalSquare, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import { TerminalPanel } from "./terminal-panel";
import { FilesPanel } from "./files-panel";
import {
    addDomainAction,
    createApplicationAction,
    createDatabaseAction,
    createProjectAction,
    deleteProjectAction,
    deployApplicationAction,
    deployDatabaseAction
} from "./actions";

const DB_ENGINES = ["postgres", "mysql", "mariadb", "mongo", "redis"] as const;

export interface ProjectSummary {
    id: string;
    name: string;
    environments: {
        id: string;
        name: string;
        applications: {
            id: string;
            name: string;
            sourceType: string;
            currentDeploymentId: string | null;
            targetId: string;
            containerRef: string;
            domains: { id: string; hostname: string; kind: string }[];
        }[];
        databases: { id: string; name: string; engine: string; status: string }[];
    }[];
}

export function DeployView({
    projects,
    canManage,
    localReady
}: {
    projects: ProjectSummary[];
    canManage: boolean;
    localReady: boolean;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [newProject, setNewProject] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    function onCreateProject() {
        if (!newProject.trim()) return;
        setError(null);
        startTransition(async () => {
            const result = await createProjectAction({ name: newProject });
            if (result.error) setError(result.error);
            else setNewProject("");
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-6">
            {!localReady && canManage && (
                <Card>
                    <CardBody className="text-sm text-muted-foreground">
                        The local host is not ready to build and deploy. This needs the full edition with a
                        running <code>polaris-hostd</code>. Remote servers added in the Servers view work regardless.
                    </CardBody>
                </Card>
            )}

            {canManage && (
                <div className="flex items-end gap-2">
                    <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">New project</label>
                        <Input
                            value={newProject}
                            onChange={(event) => setNewProject(event.target.value)}
                            placeholder="my-project"
                            onKeyDown={(event) => event.key === "Enter" && onCreateProject()}
                        />
                    </div>
                    <Button onClick={onCreateProject} disabled={pending || !newProject.trim()}>
                        <Plus className="size-4" /> Create
                    </Button>
                </div>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}

            {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">No projects yet. Create one to deploy your first app.</p>
            ) : (
                projects.map((project) => (
                    <Card key={project.id}>
                        <CardHeader className="flex items-center justify-between">
                            <CardTitle className="flex items-center gap-2">
                                <Boxes className="size-4" /> {project.name}
                            </CardTitle>
                            {canManage &&
                                (confirmDelete === project.id ? (
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-muted-foreground">Delete project?</span>
                                        <Button
                                            variant="danger"
                                            onClick={() =>
                                                startTransition(async () => {
                                                    await deleteProjectAction(project.id);
                                                    setConfirmDelete(null);
                                                    router.refresh();
                                                })
                                            }
                                        >
                                            Confirm
                                        </Button>
                                        <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                                            Cancel
                                        </Button>
                                    </div>
                                ) : (
                                    <Button variant="ghost" onClick={() => setConfirmDelete(project.id)}>
                                        <Trash2 className="size-4" />
                                    </Button>
                                ))}
                        </CardHeader>
                        <CardBody className="flex flex-col gap-4">
                            {project.environments.map((environment) => (
                                <EnvironmentBlock
                                    key={environment.id}
                                    environment={environment}
                                    canManage={canManage}
                                    onChanged={() => router.refresh()}
                                />
                            ))}
                        </CardBody>
                    </Card>
                ))
            )}
        </div>
    );
}

function ApplicationRow({
    app,
    canManage,
    onChanged
}: {
    app: ProjectSummary["environments"][number]["applications"][number];
    canManage: boolean;
    onChanged: () => void;
}) {
    const [busy, startTransition] = useTransition();
    const [showDomain, setShowDomain] = useState(false);
    const [showTerminal, setShowTerminal] = useState(false);
    const [showFiles, setShowFiles] = useState(false);
    const [logsFor, setLogsFor] = useState<string | null>(null);
    const [hostname, setHostname] = useState("");
    const [port, setPort] = useState("80");
    const [error, setError] = useState<string | null>(null);

    function onDeploy() {
        startTransition(async () => {
            const result = await deployApplicationAction(app.id);
            if (result.error) setError(result.error);
            else if (result.deploymentId) setLogsFor(result.deploymentId);
            onChanged();
        });
    }

    function onAddDomain() {
        setError(null);
        startTransition(async () => {
            const result = await addDomainAction({
                applicationId: app.id,
                hostname: hostname.trim() || undefined,
                targetPort: Number(port)
            });
            if (result.error) setError(result.error);
            else {
                setHostname("");
                setShowDomain(false);
            }
            onChanged();
        });
    }

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <Rocket className="size-4 text-muted-foreground" />
                    <span className="text-sm">{app.name}</span>
                    <Badge>{app.sourceType}</Badge>
                    <MetricsBadge applicationId={app.id} />
                    {app.domains.map((domain) => (
                        <a
                            key={domain.id}
                            href={`https://${domain.hostname}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline"
                        >
                            <Globe className="size-3" /> {domain.hostname}
                        </a>
                    ))}
                </div>
                {canManage && (
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" onClick={() => setShowFiles(true)} title="Files">
                            <FolderOpen className="size-4" />
                        </Button>
                        <Button variant="ghost" onClick={() => setShowTerminal(true)} title="Terminal">
                            <TerminalSquare className="size-4" />
                        </Button>
                        <Button variant="ghost" onClick={() => setShowDomain((value) => !value)} title="Domains">
                            <Globe className="size-4" />
                        </Button>
                        <Button variant="secondary" onClick={onDeploy} disabled={busy}>
                            Deploy
                        </Button>
                    </div>
                )}
            </div>

            <Dialog open={showTerminal} onOpenChange={setShowTerminal}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>Terminal - {app.name}</DialogTitle>
                    </DialogHeader>
                    {showTerminal && (
                        <TerminalPanel targetId={app.targetId} containerRef={app.containerRef} label={app.containerRef} />
                    )}
                </DialogContent>
            </Dialog>

            <Dialog open={showFiles} onOpenChange={setShowFiles}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Files - {app.name}</DialogTitle>
                    </DialogHeader>
                    {showFiles && <FilesPanel applicationId={app.id} />}
                </DialogContent>
            </Dialog>

            <Dialog open={logsFor !== null} onOpenChange={(open) => !open && setLogsFor(null)}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>Deployment - {app.name}</DialogTitle>
                    </DialogHeader>
                    {logsFor && <DeploymentLogs deploymentId={logsFor} onDone={onChanged} />}
                </DialogContent>
            </Dialog>
            {showDomain && canManage && (
                <div className="flex flex-wrap items-end gap-2 pl-6">
                    <Input
                        value={hostname}
                        onChange={(event) => setHostname(event.target.value)}
                        placeholder="custom domain (blank = free subdomain)"
                        className="w-64"
                    />
                    <Input
                        value={port}
                        onChange={(event) => setPort(event.target.value)}
                        placeholder="port"
                        className="w-20"
                    />
                    <Button variant="outline" onClick={onAddDomain} disabled={busy}>
                        Add domain
                    </Button>
                    {error && <span className="text-xs text-red-400">{error}</span>}
                </div>
            )}
        </div>
    );
}

function EnvironmentBlock({
    environment,
    canManage,
    onChanged
}: {
    environment: ProjectSummary["environments"][number];
    canManage: boolean;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState("");
    const [image, setImage] = useState("");
    const [dbName, setDbName] = useState("");
    const [dbEngine, setDbEngine] = useState<(typeof DB_ENGINES)[number]>("postgres");
    const [error, setError] = useState<string | null>(null);

    function onCreateApp() {
        setError(null);
        startTransition(async () => {
            const result = await createApplicationAction({ environmentId: environment.id, name, imageRef: image });
            if (result.error) setError(result.error);
            else {
                setName("");
                setImage("");
            }
            onChanged();
        });
    }

    function onCreateDatabase() {
        setError(null);
        startTransition(async () => {
            const result = await createDatabaseAction({ environmentId: environment.id, engine: dbEngine, name: dbName });
            if (result.error) setError(result.error);
            else setDbName("");
            onChanged();
        });
    }

    function onDeployDatabase(databaseId: string) {
        startTransition(async () => {
            await deployDatabaseAction(databaseId);
            onChanged();
        });
    }

    return (
        <div className="rounded-md border border-border/60 p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{environment.name}</div>

            <div className="flex flex-col gap-2">
                {environment.applications.length === 0 && environment.databases.length === 0 && (
                    <p className="text-sm text-muted-foreground">No applications yet.</p>
                )}
                {environment.applications.map((app) => (
                    <ApplicationRow key={app.id} app={app} canManage={canManage} onChanged={onChanged} />
                ))}
                {environment.databases.map((database) => (
                    <div key={database.id} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                            <Database className="size-4 text-muted-foreground" />
                            <span className="text-sm">{database.name}</span>
                            <Badge>{database.engine}</Badge>
                            <Badge>{database.status}</Badge>
                        </div>
                        {canManage && (
                            <Button variant="secondary" onClick={() => onDeployDatabase(database.id)} disabled={pending}>
                                Provision
                            </Button>
                        )}
                    </div>
                ))}
            </div>

            {canManage && (
                <div className="mt-3 flex flex-wrap items-end gap-2">
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="app name"
                        className="w-40"
                    />
                    <Input
                        value={image}
                        onChange={(event) => setImage(event.target.value)}
                        placeholder="image e.g. nginx:latest"
                        className="w-56"
                    />
                    <Button onClick={onCreateApp} disabled={pending || !name.trim() || !image.trim()}>
                        <Plus className="size-4" /> Add app
                    </Button>
                </div>
            )}
            {canManage && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Input
                        value={dbName}
                        onChange={(event) => setDbName(event.target.value)}
                        placeholder="database name"
                        className="w-40"
                    />
                    <select
                        value={dbEngine}
                        onChange={(event) => setDbEngine(event.target.value as (typeof DB_ENGINES)[number])}
                        className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                    >
                        {DB_ENGINES.map((engine) => (
                            <option key={engine} value={engine}>
                                {engine}
                            </option>
                        ))}
                    </select>
                    <Button variant="outline" onClick={onCreateDatabase} disabled={pending || !dbName.trim()}>
                        <Database className="size-4" /> Add database
                    </Button>
                </div>
            )}
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        </div>
    );
}

function DeploymentLogs({ deploymentId, onDone }: { deploymentId: string; onDone: () => void }) {
    const [log, setLog] = useState("");
    const [status, setStatus] = useState("queued");
    const preRef = useRef<HTMLPreElement>(null);

    useEffect(() => {
        let active = true;
        let timer: ReturnType<typeof setTimeout>;

        async function poll(): Promise<void> {
            const res = await fetch(`/api/deploy/deployments/${deploymentId}/log`, { cache: "no-store" });
            if (!active) return;
            if (res.ok) {
                const data = (await res.json()) as { status: string; log: string };
                setLog(data.log);
                setStatus(data.status);
                if (["running", "failed", "cancelled", "rolled_back"].includes(data.status)) {
                    onDone();
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
    }, [deploymentId, onDone]);

    useEffect(() => {
        if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
    }, [log]);

    return (
        <div className="flex flex-col gap-2">
            <div className="text-xs text-muted-foreground">Status: {status}</div>
            <pre
                ref={preRef}
                className="h-80 overflow-auto rounded-md bg-[#0b0e14] p-3 text-xs leading-relaxed text-zinc-300"
            >
                {log || "Waiting for output..."}
            </pre>
        </div>
    );
}

function MetricsBadge({ applicationId }: { applicationId: string }) {
    const [text, setText] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        void fetch(`/api/deploy/apps/${applicationId}/metrics`, { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : null))
            .then((data: { state?: string; cpuPercent?: number | null; memPercent?: number | null } | null) => {
                if (!active || !data?.state) return;
                const parts = [data.state];
                if (typeof data.cpuPercent === "number") parts.push(`${data.cpuPercent.toFixed(0)}% cpu`);
                if (typeof data.memPercent === "number") parts.push(`${data.memPercent.toFixed(0)}% mem`);
                setText(parts.join(" · "));
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [applicationId]);

    if (!text) return null;
    return <Badge>{text}</Badge>;
}
