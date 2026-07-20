"use client";

/**
 * Deploy app view. A Railway-style canvas: projects hold environments, each
 * environment holds a grid of service cards (applications and managed databases).
 * Creation flows live in focused dialogs instead of cramped inline forms, all
 * confirmations are in-app (no native dialogs), and the local build/deploy path
 * says plainly when it needs the full edition rather than failing silently.
 */

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
    ArrowLeft,
    Boxes,
    ChevronRight,
    Database,
    FolderOpen,
    Globe,
    Loader2,
    Plus,
    Rocket,
    TerminalSquare,
    Trash2
} from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    type SelectOption
} from "@polaris/ui";
import { DockerMark, GitHubMark } from "@/components/brand-icons";
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

const ENGINE_OPTIONS: SelectOption[] = DB_ENGINES.map((engine) => ({
    value: engine,
    label: engine,
    icon: <Database className="size-4 text-muted-foreground" />
}));

type ProjectApp = ProjectSummary["environments"][number]["applications"][number];
type ProjectDatabase = ProjectSummary["environments"][number]["databases"][number];

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
    const refresh = () => router.refresh();

    return (
        <div className="flex flex-col gap-6">
            {!localReady && canManage && (
                <Card className="border-warning/30 bg-warning/5">
                    <CardBody className="text-sm text-muted-foreground">
                        The local host is not ready to build and deploy. This needs the full edition with a running{" "}
                        <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">polaris-hostd</code>.
                        Remote servers added in the Servers view work regardless.
                    </CardBody>
                </Card>
            )}

            {canManage && (
                <div className="flex items-center justify-between gap-4">
                    <p className="text-sm text-muted-foreground">
                        {projects.length === 0
                            ? "No projects yet."
                            : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
                    </p>
                    <CreateProjectButton onChanged={refresh} />
                </div>
            )}

            {projects.length === 0 ? (
                <EmptyState
                    icon={<Boxes className="size-6 text-muted-foreground" />}
                    title="Deploy your first app"
                    description="Create a project to group environments, applications, and databases."
                />
            ) : (
                projects.map((project) => (
                    <ProjectCard key={project.id} project={project} canManage={canManage} onChanged={refresh} />
                ))
            )}
        </div>
    );
}

function CreateProjectButton({ onChanged }: { onChanged: () => void }) {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        if (!name.trim()) return;
        setError(null);
        startTransition(async () => {
            const result = await createProjectAction({ name });
            if (result.error) {
                setError(result.error);
                return;
            }
            setName("");
            setOpen(false);
            onChanged();
        });
    }

    return (
        <>
            <Button onClick={() => setOpen(true)}>
                <Plus className="size-4" /> New project
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>New project</DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                        <Field label="Project name">
                            <Input
                                autoFocus
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="my-project"
                                onKeyDown={(event) => event.key === "Enter" && submit()}
                            />
                        </Field>
                        {error && <p className="text-sm text-danger">{error}</p>}
                        <div className="flex justify-end gap-2">
                            <Button variant="ghost" onClick={() => setOpen(false)}>
                                Cancel
                            </Button>
                            <Button onClick={submit} disabled={pending || !name.trim()}>
                                {pending && <Loader2 className="size-4 animate-spin" />} Create
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

function ProjectCard({
    project,
    canManage,
    onChanged
}: {
    project: ProjectSummary;
    canManage: boolean;
    onChanged: () => void;
}) {
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [pending, startTransition] = useTransition();

    return (
        <Card>
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-5 py-4">
                <div className="flex items-center gap-2">
                    <Boxes className="size-4 text-muted-foreground" />
                    <h2 className="text-base font-medium">{project.name}</h2>
                </div>
                {canManage &&
                    (confirmDelete ? (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">Delete project and everything in it?</span>
                            <Button
                                variant="danger"
                                size="sm"
                                disabled={pending}
                                onClick={() =>
                                    startTransition(async () => {
                                        await deleteProjectAction(project.id);
                                        setConfirmDelete(false);
                                        onChanged();
                                    })
                                }
                            >
                                {pending && <Loader2 className="size-4 animate-spin" />} Confirm
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                                Cancel
                            </Button>
                        </div>
                    ) : (
                        <Button variant="ghost" size="icon" onClick={() => setConfirmDelete(true)} title="Delete project">
                            <Trash2 className="size-4" />
                        </Button>
                    ))}
            </div>
            <CardBody className="flex flex-col gap-6">
                {project.environments.map((environment) => (
                    <EnvironmentSection
                        key={environment.id}
                        environment={environment}
                        canManage={canManage}
                        onChanged={onChanged}
                    />
                ))}
            </CardBody>
        </Card>
    );
}

function EnvironmentSection({
    environment,
    canManage,
    onChanged
}: {
    environment: ProjectSummary["environments"][number];
    canManage: boolean;
    onChanged: () => void;
}) {
    const isEmpty = environment.applications.length === 0 && environment.databases.length === 0;

    return (
        <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {environment.name}
                </span>
                {canManage && <NewServiceButton environmentId={environment.id} onChanged={onChanged} />}
            </div>

            {isEmpty ? (
                <p className="rounded-md border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
                    No services yet.
                </p>
            ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {environment.applications.map((app) => (
                        <AppCard key={app.id} app={app} canManage={canManage} onChanged={onChanged} />
                    ))}
                    {environment.databases.map((database) => (
                        <DatabaseCard key={database.id} database={database} canManage={canManage} onChanged={onChanged} />
                    ))}
                </div>
            )}
        </section>
    );
}

function AppCard({ app, canManage, onChanged }: { app: ProjectApp; canManage: boolean; onChanged: () => void }) {
    const [busy, startTransition] = useTransition();
    const [showTerminal, setShowTerminal] = useState(false);
    const [showFiles, setShowFiles] = useState(false);
    const [showDomain, setShowDomain] = useState(false);
    const [logsFor, setLogsFor] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    function onDeploy() {
        setError(null);
        startTransition(async () => {
            const result = await deployApplicationAction(app.id);
            if (result.error) setError(result.error);
            else if (result.deploymentId) setLogsFor(result.deploymentId);
            onChanged();
        });
    }

    return (
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-surface/60 p-4 transition-colors hover:border-border">
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Rocket className="size-4 shrink-0 text-primary" />
                    <span className="truncate text-sm font-medium">{app.name}</span>
                </div>
                <StatusPill
                    tone={app.currentDeploymentId ? "success" : "idle"}
                    label={app.currentDeploymentId ? "Deployed" : "Not deployed"}
                />
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Badge>{app.sourceType === "dockerfile" ? "git" : app.sourceType}</Badge>
                <MetricsBadge applicationId={app.id} />
            </div>

            {app.domains.length > 0 && (
                <div className="flex flex-col gap-1">
                    {app.domains.map((domain) => (
                        <a
                            key={domain.id}
                            href={`https://${domain.hostname}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 truncate text-xs text-primary hover:underline"
                        >
                            <Globe className="size-3 shrink-0" /> {domain.hostname}
                        </a>
                    ))}
                </div>
            )}

            {error && <p className="text-xs text-danger">{error}</p>}

            {canManage && (
                <div className="mt-auto flex items-center gap-1 border-t border-border/60 pt-3">
                    <Button size="sm" variant="secondary" onClick={onDeploy} disabled={busy} className="mr-auto">
                        {busy ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />} Deploy
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setShowFiles(true)} title="Files">
                        <FolderOpen className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setShowTerminal(true)} title="Terminal">
                        <TerminalSquare className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setShowDomain(true)} title="Domains">
                        <Globe className="size-4" />
                    </Button>
                </div>
            )}

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

            <DomainDialog app={app} open={showDomain} onOpenChange={setShowDomain} onChanged={onChanged} />

            <Dialog open={logsFor !== null} onOpenChange={(open) => !open && setLogsFor(null)}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>Deployment - {app.name}</DialogTitle>
                    </DialogHeader>
                    {logsFor && <DeploymentLogs deploymentId={logsFor} onDone={onChanged} />}
                </DialogContent>
            </Dialog>
        </div>
    );
}

function DatabaseCard({
    database,
    canManage,
    onChanged
}: {
    database: ProjectDatabase;
    canManage: boolean;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();

    return (
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-surface/60 p-4 transition-colors hover:border-border">
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Database className="size-4 shrink-0 text-accent" />
                    <span className="truncate text-sm font-medium">{database.name}</span>
                </div>
                <StatusPill tone={dbTone(database.status)} label={database.status} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Badge>{database.engine}</Badge>
            </div>

            {canManage && (
                <div className="mt-auto flex border-t border-border/60 pt-3">
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={pending}
                        onClick={() =>
                            startTransition(async () => {
                                await deployDatabaseAction(database.id);
                                onChanged();
                            })
                        }
                    >
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />} Provision
                    </Button>
                </div>
            )}
        </div>
    );
}

const SERVICE_TYPES = [
    { id: "github", label: "GitHub Repository", icon: <GitHubMark className="size-5" /> },
    { id: "docker", label: "Docker Image", icon: <DockerMark className="size-5" /> },
    { id: "database", label: "Database", icon: <Database className="size-5" /> }
] as const;

type ServiceView = "list" | "github" | "docker" | "database";

const SERVICE_TITLES: Record<Exclude<ServiceView, "list">, string> = {
    github: "GitHub Repository",
    docker: "Docker Image",
    database: "Database"
};

function NewServiceButton({ environmentId, onChanged }: { environmentId: string; onChanged: () => void }) {
    const [open, setOpen] = useState(false);
    const [view, setView] = useState<ServiceView>("list");

    function done() {
        setOpen(false);
        onChanged();
    }

    return (
        <>
            <Button
                variant="outline"
                size="sm"
                onClick={() => {
                    setView("list");
                    setOpen(true);
                }}
            >
                <Plus className="size-4" /> New service
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            {view !== "list" && (
                                <button
                                    type="button"
                                    onClick={() => setView("list")}
                                    className="-ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    aria-label="Back"
                                >
                                    <ArrowLeft className="size-4" />
                                </button>
                            )}
                            {view === "list" ? "New service" : SERVICE_TITLES[view]}
                        </DialogTitle>
                    </DialogHeader>
                    {view === "list" ? (
                        <ServiceTypeList onPick={setView} />
                    ) : view === "database" ? (
                        <NewDatabaseForm environmentId={environmentId} onDone={done} />
                    ) : (
                        <NewAppForm environmentId={environmentId} mode={view} onDone={done} />
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}

function ServiceTypeList({ onPick }: { onPick: (view: Exclude<ServiceView, "list">) => void }) {
    return (
        <div className="flex flex-col gap-1">
            {SERVICE_TYPES.map((type) => (
                <button
                    key={type.id}
                    type="button"
                    onClick={() => onPick(type.id)}
                    className="group flex items-center gap-4 rounded-lg px-3 py-3 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <span className="flex size-5 shrink-0 items-center justify-center">{type.icon}</span>
                    <span className="flex-1 text-sm font-medium">{type.label}</span>
                    <ChevronRight className="size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
            ))}
        </div>
    );
}

function NewAppForm({
    environmentId,
    mode,
    onDone
}: {
    environmentId: string;
    mode: "github" | "docker";
    onDone: () => void;
}) {
    const isGit = mode === "github";
    const [name, setName] = useState("");
    const [image, setImage] = useState("");
    const [repoUrl, setRepoUrl] = useState("");
    const [branch, setBranch] = useState("");
    const [dockerfilePath, setDockerfilePath] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const canSubmit = name.trim() && (isGit ? repoUrl.trim() : image.trim());

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await createApplicationAction({
                environmentId,
                name,
                sourceType: isGit ? "dockerfile" : "image",
                imageRef: image,
                repoUrl,
                branch: branch.trim() || undefined,
                dockerfilePath: dockerfilePath.trim() || undefined
            });
            if (result.error) setError(result.error);
            else onDone();
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <Field label="Name">
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-app" autoFocus />
            </Field>
            {isGit ? (
                <>
                    <Field label="Repository URL" hint="Public http(s) repository.">
                        <Input
                            value={repoUrl}
                            onChange={(event) => setRepoUrl(event.target.value)}
                            placeholder="https://github.com/user/repo"
                        />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Branch">
                            <Input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" />
                        </Field>
                        <Field label="Dockerfile">
                            <Input
                                value={dockerfilePath}
                                onChange={(event) => setDockerfilePath(event.target.value)}
                                placeholder="Dockerfile"
                            />
                        </Field>
                    </div>
                </>
            ) : (
                <Field label="Image" hint="Docker Hub, GHCR, Quay, GitLab or MCR. e.g. ghcr.io/user/repo:latest">
                    <Input
                        value={image}
                        onChange={(event) => setImage(event.target.value)}
                        placeholder="ghcr.io/user/repo:latest"
                    />
                </Field>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button onClick={submit} disabled={pending || !canSubmit}>
                    {pending && <Loader2 className="size-4 animate-spin" />} {isGit ? "Deploy repository" : "Deploy image"}
                </Button>
            </div>
        </div>
    );
}

function NewDatabaseForm({ environmentId, onDone }: { environmentId: string; onDone: () => void }) {
    const [name, setName] = useState("");
    const [engine, setEngine] = useState<(typeof DB_ENGINES)[number]>("postgres");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await createDatabaseAction({ environmentId, engine, name });
            if (result.error) setError(result.error);
            else onDone();
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <Field label="Name">
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-db" autoFocus />
            </Field>
            <Field label="Engine">
                <Select
                    value={engine}
                    onValueChange={(value) => setEngine(value as (typeof DB_ENGINES)[number])}
                    options={ENGINE_OPTIONS}
                />
            </Field>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button onClick={submit} disabled={pending || !name.trim()}>
                    {pending && <Loader2 className="size-4 animate-spin" />} Add database
                </Button>
            </div>
        </div>
    );
}

function DomainDialog({
    app,
    open,
    onOpenChange,
    onChanged
}: {
    app: ProjectApp;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChanged: () => void;
}) {
    const [hostname, setHostname] = useState("");
    const [port, setPort] = useState("80");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
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
                onOpenChange(false);
                onChanged();
            }
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Domains - {app.name}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    {app.domains.length > 0 && (
                        <div className="flex flex-col gap-1">
                            {app.domains.map((domain) => (
                                <a
                                    key={domain.id}
                                    href={`https://${domain.hostname}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                >
                                    <Globe className="size-3" /> {domain.hostname}
                                </a>
                            ))}
                        </div>
                    )}
                    <Field label="Custom domain" hint="Leave blank for a free subdomain.">
                        <Input
                            value={hostname}
                            onChange={(event) => setHostname(event.target.value)}
                            placeholder="app.example.com"
                        />
                    </Field>
                    <Field label="Target port">
                        <Input value={port} onChange={(event) => setPort(event.target.value)} placeholder="80" className="w-28" />
                    </Field>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end">
                        <Button onClick={submit} disabled={pending}>
                            {pending && <Loader2 className="size-4 animate-spin" />} Add domain
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            {children}
            {hint && <span className="text-xs text-muted-foreground/70">{hint}</span>}
        </label>
    );
}

function StatusPill({ tone, label }: { tone: "success" | "warning" | "danger" | "idle"; label: string }) {
    const dot = {
        success: "bg-success",
        warning: "bg-warning",
        danger: "bg-danger",
        idle: "bg-muted-foreground"
    }[tone];
    return (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-surface px-2 py-0.5 text-xs text-muted-foreground">
            <span className={`size-1.5 rounded-full ${dot}`} />
            {label}
        </span>
    );
}

function dbTone(status: string): "success" | "warning" | "danger" | "idle" {
    const value = status.toLowerCase();
    if (["running", "active", "healthy", "ready"].includes(value)) return "success";
    if (["failed", "error", "stopped"].includes(value)) return "danger";
    if (["queued", "provisioning", "deploying", "pending", "building"].includes(value)) return "warning";
    return "idle";
}

function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
    return (
        <Card>
            <CardBody className="flex flex-col items-center gap-2 py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-muted">{icon}</div>
                <h3 className="text-sm font-medium">{title}</h3>
                <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
            </CardBody>
        </Card>
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
            <StatusPill tone={dbTone(status)} label={`Status: ${status}`} />
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
