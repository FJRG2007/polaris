"use client";

/**
 * Deploy app view. A Railway-style canvas: projects hold environments, each
 * environment holds a grid of service cards (applications and managed databases).
 * Creation flows live in focused dialogs instead of cramped inline forms, all
 * confirmations are in-app (no native dialogs), and the local build/deploy path
 * says plainly when it needs the full edition rather than failing silently.
 */

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import {
    ArrowLeft,
    Check,
    ChevronRight,
    Database,
    FolderOpen,
    GitBranch,
    Globe,
    Loader2,
    Lock,
    Plus,
    RefreshCw,
    Rocket,
    Search,
    TerminalSquare
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
    Switch,
    type SelectOption
} from "@polaris/ui";
import { DockerMark, GitHubMark } from "@/components/brand-icons";
import { TerminalPanel } from "./terminal-panel";
import { FilesPanel } from "./files-panel";
import {
    addDomainAction,
    createApplicationAction,
    createDatabaseAction,
    deployApplicationAction,
    deployDatabaseAction,
    githubReposAction,
    inspectRepoAction,
    listDeployServersAction,
    setAutoDeployAction
} from "./actions";

const DB_ENGINES = ["postgres", "mysql", "mariadb", "mongo", "redis"] as const;

const ENGINE_OPTIONS: SelectOption[] = DB_ENGINES.map((engine) => ({
    value: engine,
    label: engine,
    icon: <Database className="size-4 text-muted-foreground" />
}));

export type ProjectApp = ProjectSummary["environments"][number]["applications"][number];
type ProjectDatabase = ProjectSummary["environments"][number]["databases"][number];

export interface ProjectSummary {
    id: string;
    name: string;
    environments: {
        id: string;
        name: string;
        isDefault: boolean;
        layout: string;
        applications: {
            id: string;
            name: string;
            environmentId: string;
            sourceType: string;
            currentDeploymentId: string | null;
            deployStatus: string | null;
            targetId: string;
            containerRef: string;
            autoDeploy: boolean;
            deployBranch: string | null;
            commitFilter: string | null;
            keepReleases: boolean;
            /** The container port the app listens on (for the IP:port link and routes). */
            port: number | null;
            /** Direct LAN/intranet URL (host IP + published port), when a public IP is known. */
            ipUrl: string | null;
            domains: { id: string; hostname: string; kind: string }[];
        }[];
        databases: { id: string; name: string; engine: string; status: string }[];
    }[];
}

export type ServiceKind = "github" | "image" | "database";

/** The service kind an application's source maps to (for icons). */
export function serviceKindOf(sourceType: string): ServiceKind {
    return sourceType === "image" ? "image" : "github";
}

/** Brand-accurate icon for a service kind (GitHub / Docker / database). */
export function ServiceIcon({ kind, className = "size-4" }: { kind: ServiceKind; className?: string }) {
    if (kind === "github") return <GitHubMark className={className} />;
    if (kind === "image") return <DockerMark className={className} />;
    return <Database className={className} />;
}

/** One environment's services as a Railway-style card grid plus the new-service action. */
export function EnvironmentServices({
    environment,
    canManage,
    onChanged,
    onOpenService
}: {
    environment: ProjectSummary["environments"][number];
    canManage: boolean;
    onChanged: () => void;
    onOpenService?: (app: ProjectApp) => void;
}) {
    const isEmpty = environment.applications.length === 0 && environment.databases.length === 0;

    return (
        <div className="flex flex-col gap-3">
            {isEmpty ? (
                <div className="rounded-lg border border-dashed border-border/60 px-4 py-16 text-center">
                    <p className="text-sm text-muted-foreground">No services in this environment yet.</p>
                    {canManage && (
                        <p className="mt-1 text-xs text-muted-foreground/70">
                            Add a GitHub repository, a Docker image, or a database.
                        </p>
                    )}
                </div>
            ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {environment.applications.map((app) => (
                        <AppCard
                            key={app.id}
                            app={app}
                            canManage={canManage}
                            onChanged={onChanged}
                            onOpen={onOpenService ? () => onOpenService(app) : undefined}
                        />
                    ))}
                    {environment.databases.map((database) => (
                        <DatabaseCard key={database.id} database={database} canManage={canManage} onChanged={onChanged} />
                    ))}
                </div>
            )}
        </div>
    );
}

function AppCard({
    app,
    canManage,
    onChanged,
    onOpen
}: {
    app: ProjectApp;
    canManage: boolean;
    onChanged: () => void;
    onOpen?: () => void;
}) {
    const [busy, startTransition] = useTransition();
    const [showTerminal, setShowTerminal] = useState(false);
    const [showFiles, setShowFiles] = useState(false);
    const [showDomain, setShowDomain] = useState(false);
    const [showAutoDeploy, setShowAutoDeploy] = useState(false);
    const [logsFor, setLogsFor] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const isGit = app.sourceType === "dockerfile" || app.sourceType === "nixpacks";

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
                <button
                    type="button"
                    onClick={onOpen}
                    disabled={!onOpen}
                    className="flex min-w-0 items-center gap-2 text-left enabled:hover:text-primary"
                >
                    <ServiceIcon kind={serviceKindOf(app.sourceType)} className="size-4 shrink-0 text-foreground" />
                    <span className="truncate text-sm font-medium">{app.name}</span>
                </button>
                <StatusPill
                    tone={app.currentDeploymentId ? dbTone(app.deployStatus ?? "") : "idle"}
                    label={app.currentDeploymentId ? (app.deployStatus ?? "deployed") : "Not deployed"}
                />
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Badge>{app.sourceType === "dockerfile" ? "git" : app.sourceType}</Badge>
                {app.autoDeploy && <Badge>auto-deploy</Badge>}
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
                    {isGit && (
                        <Button variant="ghost" size="icon" onClick={() => setShowAutoDeploy(true)} title="Auto-deploy">
                            <GitBranch className="size-4" />
                        </Button>
                    )}
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

            {isGit && (
                <AutoDeployDialog app={app} open={showAutoDeploy} onOpenChange={setShowAutoDeploy} onChanged={onChanged} />
            )}

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

export function NewServiceButton({ environmentId, onChanged }: { environmentId: string; onChanged: () => void }) {
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
                    ) : view === "github" ? (
                        <NewGithubForm environmentId={environmentId} onDone={done} />
                    ) : (
                        <NewImageForm environmentId={environmentId} onDone={done} />
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

interface ServerOption {
    id: string;
    name: string;
}

/**
 * The servers a new service can deploy to (local host + connected SSH hosts),
 * with the first one selected by default - so a single-server setup needs no
 * choice and multi-server setups get an explicit picker.
 */
function useDeployServers(): { servers: ServerOption[]; serverId: string; setServerId: (id: string) => void } {
    const [servers, setServers] = useState<ServerOption[]>([]);
    const [serverId, setServerId] = useState("local");
    useEffect(() => {
        void listDeployServersAction()
            .then((list) => {
                setServers(list);
                if (list[0]) setServerId(list[0].id);
            })
            .catch(() => undefined);
    }, []);
    return { servers, serverId, setServerId };
}

function ServerField({ servers, value, onChange }: { servers: ServerOption[]; value: string; onChange: (id: string) => void }) {
    if (servers.length === 0) return null;
    return (
        <Field label="Server" hint="Where this service runs. Connect more under Servers.">
            <Select
                value={value}
                onValueChange={onChange}
                options={servers.map((server) => ({ value: server.id, label: server.name }))}
                aria-label="Server"
            />
        </Field>
    );
}

function NewImageForm({ environmentId, onDone }: { environmentId: string; onDone: () => void }) {
    const [name, setName] = useState("");
    const [image, setImage] = useState("");
    const [port, setPort] = useState("");
    const { servers, serverId, setServerId } = useDeployServers();
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        setError(null);
        const parsedPort = Number(port.trim());
        startTransition(async () => {
            const result = await createApplicationAction({
                environmentId,
                name,
                sourceType: "image",
                imageRef: image,
                serverId,
                port: port.trim() && Number.isInteger(parsedPort) ? parsedPort : undefined
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
            <Field
                label="Image"
                hint="Docker Hub, GHCR, Quay, GitLab or MCR. Private images: add a login under Registries."
            >
                <Input
                    value={image}
                    onChange={(event) => setImage(event.target.value)}
                    placeholder="ghcr.io/user/repo:latest"
                />
            </Field>
            <Field
                label="Port"
                hint="The port the container listens on (e.g. 5601 for OpenSearch Dashboards, 8080). Defaults to 80."
            >
                <Input value={port} onChange={(event) => setPort(event.target.value)} placeholder="80" inputMode="numeric" />
            </Field>
            <ServerField servers={servers} value={serverId} onChange={setServerId} />
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button onClick={submit} disabled={pending || !name.trim() || !image.trim()}>
                    {pending && <Loader2 className="size-4 animate-spin" />} Deploy image
                </Button>
            </div>
        </div>
    );
}

interface RepoOption {
    fullName: string;
    defaultBranch: string;
    private: boolean;
}

// Session cache of the connected account's repos so reopening the dialog is
// instant; the Refresh button re-fetches from GitHub.
let repoCache: RepoOption[] | null = null;
let repoCacheConnected = false;

type Builder = "dockerfile" | "nixpacks";

const BUILDER_OPTIONS: SelectOption[] = [
    { value: "dockerfile", label: "Dockerfile" },
    { value: "nixpacks", label: "Auto-detect (Nixpacks)" }
];

function NewGithubForm({ environmentId, onDone }: { environmentId: string; onDone: () => void }) {
    const [loading, setLoading] = useState(repoCache === null);
    const [connected, setConnected] = useState(repoCacheConnected);
    const [repos, setRepos] = useState<RepoOption[]>(repoCache ?? []);
    const [search, setSearch] = useState("");
    const [repoFullName, setRepoFullName] = useState("");
    const [manualUrl, setManualUrl] = useState("");
    const [name, setName] = useState("");
    const [branch, setBranch] = useState("");
    const [builder, setBuilder] = useState<Builder>("dockerfile");
    const [dockerfilePath, setDockerfilePath] = useState("Dockerfile");
    const [framework, setFramework] = useState<string | null>(null);
    const [inspecting, setInspecting] = useState(false);
    const { servers, serverId, setServerId } = useDeployServers();
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback((force: boolean) => {
        if (!force && repoCache !== null) {
            setRepos(repoCache);
            setConnected(repoCacheConnected);
            setLoading(false);
            return;
        }
        setLoading(true);
        void githubReposAction()
            .then((result) => {
                repoCache = result.repos;
                repoCacheConnected = result.connected;
                setRepos(result.repos);
                setConnected(result.connected);
            })
            .catch(() => undefined)
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        load(false);
    }, [load]);

    const usePicker = connected && repos.length > 0;
    const filtered = search.trim()
        ? repos.filter((repo) => repo.fullName.toLowerCase().includes(search.trim().toLowerCase()))
        : repos;
    const selected = Boolean(usePicker ? repoFullName : manualUrl.trim());
    const canSubmit = Boolean(name.trim()) && selected;

    function onPickRepo(repo: RepoOption) {
        setRepoFullName(repo.fullName);
        setName(repo.fullName.split("/")[1] ?? "");
        setBranch(repo.defaultBranch);
        setFramework(null);
        setInspecting(true);
        const [owner, repoName] = repo.fullName.split("/");
        void inspectRepoAction({ owner: owner ?? "", repo: repoName ?? "", branch: repo.defaultBranch })
            .then((inspection) => {
                setBuilder(inspection.builder);
                setDockerfilePath(inspection.dockerfile ?? "Dockerfile");
                setFramework(inspection.framework);
            })
            .catch(() => undefined)
            .finally(() => setInspecting(false));
    }

    function submit() {
        setError(null);
        const repoUrl = usePicker ? `https://github.com/${repoFullName}` : manualUrl.trim();
        startTransition(async () => {
            const result = await createApplicationAction({
                environmentId,
                name,
                sourceType: builder,
                repoUrl,
                branch: branch.trim() || undefined,
                dockerfilePath: builder === "dockerfile" ? dockerfilePath.trim() || undefined : undefined,
                provider: connected ? "github" : undefined,
                serverId
            });
            if (result.error) setError(result.error);
            else onDone();
        });
    }

    return (
        <div className="flex flex-col gap-3">
            {!connected && !loading && (
                <p className="rounded-md border border-border/60 bg-surface/40 px-3 py-2 text-xs text-muted-foreground">
                    Deploying a public repository.{" "}
                    <a href="/integrations" className="text-primary hover:underline">
                        Connect GitHub
                    </a>{" "}
                    for private repositories and a searchable picker.
                </p>
            )}

            {connected ? (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search repositories"
                                className="pl-8"
                            />
                        </div>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            title="Refresh repositories"
                            disabled={loading}
                            onClick={() => load(true)}
                        >
                            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
                        </Button>
                    </div>
                    <div className="max-h-56 overflow-auto rounded-md border border-border/60">
                        {loading ? (
                            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                                <Loader2 className="size-4 animate-spin" /> Loading repositories...
                            </div>
                        ) : filtered.length === 0 ? (
                            <p className="py-8 text-center text-sm text-muted-foreground">No repositories match.</p>
                        ) : (
                            filtered.map((repo) => (
                                <button
                                    key={repo.fullName}
                                    type="button"
                                    onClick={() => onPickRepo(repo)}
                                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
                                        repoFullName === repo.fullName ? "bg-muted" : ""
                                    }`}
                                >
                                    <GitHubMark className="size-4 shrink-0 text-muted-foreground" />
                                    <span className="truncate">{repo.fullName}</span>
                                    {repoFullName === repo.fullName && <Check className="size-4 shrink-0 text-primary" />}
                                    <span className="ml-auto flex items-center gap-2 pl-2 text-xs text-muted-foreground">
                                        {repo.private && <Lock className="size-3.5" />}
                                        {repo.defaultBranch}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            ) : (
                !loading && (
                    <Field label="Repository URL" hint="Public http(s) repository.">
                        <Input
                            value={manualUrl}
                            onChange={(event) => setManualUrl(event.target.value)}
                            placeholder="https://github.com/user/repo"
                        />
                    </Field>
                )
            )}

            {selected && (
                <>
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Name">
                            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-app" />
                        </Field>
                        <Field label="Branch">
                            <Input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" />
                        </Field>
                    </div>
                    <Field
                        label="Builder"
                        hint={
                            inspecting
                                ? "Detecting the stack..."
                                : framework
                                  ? `Detected ${framework}.`
                                  : "No Dockerfile found - Nixpacks auto-builds from the source."
                        }
                    >
                        <Select
                            value={builder}
                            onValueChange={(value) => setBuilder(value as Builder)}
                            options={BUILDER_OPTIONS}
                        />
                    </Field>
                    {builder === "dockerfile" && (
                        <Field label="Dockerfile path">
                            <Input
                                value={dockerfilePath}
                                onChange={(event) => setDockerfilePath(event.target.value)}
                                placeholder="Dockerfile"
                            />
                        </Field>
                    )}
                    <ServerField servers={servers} value={serverId} onChange={setServerId} />
                </>
            )}

            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button onClick={submit} disabled={pending || !canSubmit}>
                    {pending && <Loader2 className="size-4 animate-spin" />} Deploy repository
                </Button>
            </div>
        </div>
    );
}

function NewDatabaseForm({ environmentId, onDone }: { environmentId: string; onDone: () => void }) {
    const [name, setName] = useState("");
    const [engine, setEngine] = useState<(typeof DB_ENGINES)[number]>("postgres");
    const { servers, serverId, setServerId } = useDeployServers();
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await createDatabaseAction({ environmentId, engine, name, serverId });
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
            <ServerField servers={servers} value={serverId} onChange={setServerId} />
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button onClick={submit} disabled={pending || !name.trim()}>
                    {pending && <Loader2 className="size-4 animate-spin" />} Add database
                </Button>
            </div>
        </div>
    );
}

function AutoDeployDialog({
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
    const [enabled, setEnabled] = useState(app.autoDeploy);
    const [branch, setBranch] = useState(app.deployBranch ?? "");
    const [filter, setFilter] = useState(app.commitFilter ?? "");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await setAutoDeployAction({
                applicationId: app.id,
                autoDeploy: enabled,
                deployBranch: branch.trim() || undefined,
                commitFilter: filter.trim() || undefined
            });
            if (result.error) setError(result.error);
            else {
                onOpenChange(false);
                onChanged();
            }
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Auto-deploy - {app.name}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>
                            <span className="font-medium">Deploy on push</span>
                            <span className="block text-xs text-muted-foreground">
                                Rebuild and deploy automatically when a matching commit is pushed. Needs GitHub App
                                webhooks reaching this instance (public domain).
                            </span>
                        </span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label="Deploy on push" />
                    </div>
                    <Field label="Branch" hint="Only this branch triggers a deploy. Blank uses the app's branch.">
                        <Input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" />
                    </Field>
                    <Field
                        label="Commit filter"
                        hint='Deploy only when the commit message contains this (e.g. "build:"), or "regex:<pattern>". Blank = any commit.'
                    >
                        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="build:" />
                    </Field>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending}>
                            {pending && <Loader2 className="size-4 animate-spin" />} Save
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
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

export function StatusPill({ tone, label }: { tone: "success" | "warning" | "danger" | "idle"; label: string }) {
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

export function dbTone(status: string): "success" | "warning" | "danger" | "idle" {
    const value = status.toLowerCase();
    if (["running", "active", "healthy", "ready"].includes(value)) return "success";
    if (["failed", "error", "stopped"].includes(value)) return "danger";
    if (["queued", "provisioning", "deploying", "pending", "building"].includes(value)) return "warning";
    return "idle";
}

export function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
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

export function DeploymentLogs({ deploymentId, onDone }: { deploymentId: string; onDone: () => void }) {
    const [log, setLog] = useState("");
    const [status, setStatus] = useState("queued");
    const preRef = useRef<HTMLPreElement>(null);
    // Keep onDone out of the effect deps: it is recreated every render, and calling
    // it (a state update) here would otherwise re-run the effect and loop.
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
                setStatus(data.status);
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
