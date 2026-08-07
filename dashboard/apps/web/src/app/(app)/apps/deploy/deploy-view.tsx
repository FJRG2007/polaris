"use client";

/**
 * Deploy app view. A Railway-style canvas: projects hold environments, each
 * environment holds a grid of service cards (applications and managed databases).
 * Creation flows live in focused dialogs instead of cramped inline forms, all
 * confirmations are in-app (no native dialogs), and the local build/deploy path
 * says plainly when it needs the full edition rather than failing silently.
 */

import { FilesPanel } from "./files-panel";
import * as deployActions from "./actions";
import { TerminalPanel } from "./terminal-panel";
import { LogViewer } from "@/components/log-viewer";
import { DbEngineIcon } from "@/components/db-engine-icon";
import { isLocalDomain, primaryDomain } from "./domain-rank";
import { stageDatabaseDeleteAction } from "./project-actions";
import { DockerMark, GitHubMark } from "@/components/brand-icons";
import { RepoPicker, type PickerRepo } from "@/components/repo-picker";
import { SERVICE_LIST_METRICS_MS, useServiceMetrics } from "./service-metrics";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useTransition,
    type ReactNode
} from "react";
import {
    databaseCreateSchema,
    dbEngineLabel,
    DB_ENGINES,
    DB_ENGINE_INFO,
    type DatabaseCreateInput,
    type DbEngine
} from "@polaris/core";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch,
    Textarea,
    type SelectOption
} from "@polaris/ui";
import {
    ArrowLeft,
    CheckCircle2,
    ChevronRight,
    Copy,
    Database,
    Eye,
    EyeOff,
    FolderOpen,
    GitBranch,
    Globe,
    Loader2,
    Lock,
    Plug,
    Plus,
    Rocket,
    TerminalSquare,
    Trash2
} from "lucide-react";

const ENGINE_OPTIONS: SelectOption[] = DB_ENGINES.map((engine) => ({
    value: engine,
    label: DB_ENGINE_INFO[engine].label,
    icon: <DbEngineIcon engine={engine} className="size-5" />
}));

type DbInstance = Awaited<ReturnType<typeof deployActions.listDatabaseInstancesAction>>[number];
type DbConnection = NonNullable<Awaited<ReturnType<typeof deployActions.databaseConnectionAction>>["connection"]>;

/** The dotted board texture shared with the canvas, for empty states. */
const DOT_BG: React.CSSProperties = {
    backgroundImage: "radial-gradient(circle, hsl(var(--muted-foreground) / 0.15) 1px, transparent 1px)",
    backgroundSize: "16px 16px"
};

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
            /** Server the app runs on: "local" or a Host id (for the Settings picker). */
            serverId: string;
            /** Display name of that server (e.g. "Local", or a host's name). */
            serverName: string;
            containerRef: string;
            autoDeploy: boolean;
            deployBranch: string | null;
            commitFilter: string | null;
            /** Globs a push must touch to redeploy this one, for a shared repository. */
            watchPaths: string | null;
            keepReleases: boolean;
            /** Where in the repository this service lives, for one holding several. */
            rootDirectory: string | null;
            /** Dockerfile it builds, as stored (relative to the root directory). */
            dockerfilePath: string | null;
            /** Set on this service to override what the build detected. Null leaves
             *  the phase to detection, which is what almost every service wants. */
            installCommand: string | null;
            buildCommand: string | null;
            startCommand: string | null;
            /** The container port the app listens on (for the IP:port link and routes). */
            port: number | null;
            /** Direct LAN/intranet URL (host IP + published port), when a public IP is known. */
            ipUrl: string | null;
            domains: {
                id: string;
                hostname: string;
                kind: string;
                enabled: boolean;
                healthStatus?: string;
                healthCode?: number | null;
                healthDetail?: string | null;
                /** Whether the operator supplied a certificate for this name. Never the
                 *  certificate itself - the panel only says which one is in use. */
                hasCertificate?: boolean;
            }[];
            volumes: {
                id: string;
                name: string;
                kind: string;
                source: string;
                mountPath: string;
                connectionId: string | null;
                connectionName: string | null;
                sizeLimit: string | null;
            }[];
        }[];
        databases: {
            id: string;
            name: string;
            engine: string;
            status: string;
            /** True when this is a database living inside another instance rather
             *  than a container of its own. */
            hostedOnInstance?: boolean;
            /** How many databases are hosted inside this one, which is what makes
             *  removing it destroy more than itself. */
            hostedCount?: number;
        }[];
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
    stagedIds,
    onChanged,
    onOpenService
}: {
    environment: ProjectSummary["environments"][number];
    canManage: boolean;
    /** Services queued for removal in the changeset, marked rather than hidden -
     *  they are still running until the changeset is deployed. */
    stagedIds?: ReadonlySet<string>;
    onChanged: () => void;
    onOpenService?: (app: ProjectApp) => void;
}) {
    const isEmpty = environment.applications.length === 0 && environment.databases.length === 0;

    return (
        <div className="flex flex-col gap-3">
            {isEmpty ? (
                <div
                    className="relative flex flex-col items-center gap-3 overflow-hidden rounded-xl border border-border/60 px-4 py-20 text-center"
                    style={DOT_BG}
                >
                    <div
                        className="pointer-events-none absolute inset-0"
                        style={{ background: "radial-gradient(120% 90% at 50% 40%, transparent 45%, hsl(var(--background)) 100%)" }}
                    />
                    <span className="relative grid size-11 place-items-center rounded-xl border border-border bg-card text-primary">
                        <Rocket className="size-5" />
                    </span>
                    <div className="relative">
                        <p className="text-sm font-medium">No services in this environment yet</p>
                        {canManage && (
                            <p className="mt-1 text-xs text-muted-foreground">
                                Add a GitHub repository, a Docker image, or a database.
                            </p>
                        )}
                    </div>
                </div>
            ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {environment.applications.map((app) => (
                        <AppCard
                            key={app.id}
                            app={app}
                            canManage={canManage}
                            staged={stagedIds?.has(app.id) ?? false}
                            onChanged={onChanged}
                            onOpen={onOpenService ? () => onOpenService(app) : undefined}
                        />
                    ))}
                    {environment.databases.map((database) => (
                        <DatabaseCard
                            key={database.id}
                            database={database}
                            canManage={canManage}
                            staged={stagedIds?.has(database.id) ?? false}
                            onChanged={onChanged}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function AppCard({
    app,
    canManage,
    staged,
    onChanged,
    onOpen
}: {
    app: ProjectApp;
    canManage: boolean;
    staged: boolean;
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
    const primary = primaryDomain(app.domains);

    function onDeploy() {
        setError(null);
        startTransition(async () => {
            const result = await deployActions.deployApplicationAction(app.id);
            if (result.error) setError(result.error);
            else if (result.deploymentId) setLogsFor(result.deploymentId);
            onChanged();
        });
    }

    return (
        <div
            className={`flex flex-col gap-3 rounded-xl border bg-surface/60 p-4 transition-[border-color,box-shadow] hover:shadow-md hover:shadow-black/15 ${
                staged ? "border-primary/50 ring-1 ring-primary/20" : "border-border/60 hover:border-border"
            }`}
        >
            <div className="flex items-start justify-between gap-2">
                <button
                    type="button"
                    onClick={onOpen}
                    disabled={!onOpen}
                    className="group flex min-w-0 items-center gap-2.5 text-left"
                >
                    <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface text-foreground transition-colors group-enabled:group-hover:border-primary/40">
                        <ServiceIcon kind={serviceKindOf(app.sourceType)} className="size-3.5" />
                    </span>
                    <span className="truncate text-sm font-medium group-enabled:group-hover:text-primary">{app.name}</span>
                </button>
                <StatusPill
                    tone={app.currentDeploymentId ? dbTone(app.deployStatus ?? "") : "idle"}
                    label={app.currentDeploymentId ? (app.deployStatus ?? "deployed") : "Not deployed"}
                />
            </div>

            <div className="flex flex-wrap items-center gap-2">
                {staged && (
                    <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                        Removal pending
                    </span>
                )}
                <Badge>{app.sourceType === "dockerfile" ? "git" : app.sourceType}</Badge>
                {app.autoDeploy && <Badge>auto-deploy</Badge>}
                <MetricsBadge applicationId={app.id} />
            </div>

            {primary && (
                // The single most stable/reachable domain (custom domain > free public
                // subdomain > LAN name), so the card surfaces where the service actually lives.
                <div className="flex min-w-0 items-center gap-1.5">
                    <a
                        href={`https://${primary.hostname}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-primary hover:underline"
                    >
                        <Globe className="size-3 shrink-0" /> {primary.hostname}
                    </a>
                    {isLocalDomain(primary) && (
                        <span
                            title="Resolves only on your local network"
                            className="shrink-0 rounded bg-warning/10 px-1 text-[10px] font-medium text-warning"
                        >
                            LAN
                        </span>
                    )}
                    {app.domains.length > 1 && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">+{app.domains.length - 1}</span>
                    )}
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
                        <TerminalPanel
                            target={{ kind: "container", targetId: app.targetId, containerRef: app.containerRef }}
                            label={app.containerRef}
                        />
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
    staged,
    onChanged
}: {
    database: ProjectDatabase;
    canManage: boolean;
    staged: boolean;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [confirming, setConfirming] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function remove() {
        setError(null);
        startTransition(async () => {
            const result = await stageDatabaseDeleteAction({ databaseId: database.id });
            if (result.error) {
                setError(result.error);
                return;
            }
            setConfirming(false);
            onChanged();
        });
    }

    return (
        <div
            className={`flex flex-col gap-3 rounded-xl border bg-surface/60 p-4 transition-[border-color,box-shadow] hover:shadow-md hover:shadow-black/15 ${
                staged ? "border-primary/50 ring-1 ring-primary/20" : "border-border/60 hover:border-border"
            }`}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                    <DbEngineIcon engine={database.engine} />
                    <span className="truncate text-sm font-medium">{database.name}</span>
                </div>
                <StatusPill tone={dbTone(database.status)} label={database.status} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
                {staged && (
                    <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                        Removal pending
                    </span>
                )}
                <Badge>{dbEngineLabel(database.engine)}</Badge>
                {database.hostedOnInstance && <Badge>On a shared instance</Badge>}
                {database.hostedCount ? (
                    <Badge>
                        Hosts {database.hostedCount} {database.hostedCount === 1 ? "database" : "databases"}
                    </Badge>
                ) : null}
            </div>

            {error && <p className="text-xs text-danger">{error}</p>}

            {canManage && (
                <div className="mt-auto flex items-center gap-1 border-t border-border/60 pt-3">
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={pending}
                        className="mr-auto"
                        onClick={() =>
                            startTransition(async () => {
                                await deployActions.deployDatabaseAction(database.id);
                                onChanged();
                            })
                        }
                    >
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />} Provision
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        title="Connection details"
                        aria-label="Connection details"
                        onClick={() => setConnecting(true)}
                    >
                        <Plug className="size-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        title={staged ? "Removal pending" : "Delete database"}
                        aria-label="Delete database"
                        disabled={staged}
                        onClick={() => setConfirming(true)}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                </div>
            )}

            <DatabaseConnectionDialog database={database} open={connecting} onOpenChange={setConnecting} />

            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                name={database.name}
                kind="database"
                confirmLabel="Stage removal"
                description={
                    database.hostedOnInstance
                        ? "The database and its user are dropped from the instance hosting them. The instance itself is untouched."
                        : database.hostedCount
                          ? `The container goes, and with it the ${database.hostedCount} ${database.hostedCount === 1 ? "database" : "databases"} hosted inside it. The named volume holding the data is left on the server so it can still be recovered by hand.`
                          : "The container goes; the named volume holding its data is left on the server so it can still be recovered by hand."
                }
                error={error}
                pending={pending}
                onConfirm={remove}
            />
        </div>
    );
}

/**
 * How to reach a database, once it exists.
 *
 * Creating one and then having to work out its address, its user and its
 * password from three other screens is the gap this closes: the URI is here,
 * ready to paste into a service's variables, and the password stays hidden until
 * it is asked for so the panel can be opened in front of somebody.
 */
function DatabaseConnectionDialog({
    database,
    open,
    onOpenChange
}: {
    database: ProjectDatabase;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [connection, setConnection] = useState<DbConnection | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [revealed, setRevealed] = useState(false);

    useEffect(() => {
        if (!open) return;
        setConnection(null);
        setError(null);
        setRevealed(false);
        let active = true;
        void deployActions.databaseConnectionAction(database.id).then((result) => {
            if (!active) return;
            if (result.connection) setConnection(result.connection);
            else setError(result.error ?? "Could not read the connection details");
        });
        return () => {
            active = false;
        };
    }, [open, database.id]);

    const hidden = "•".repeat(16);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <DbEngineIcon engine={database.engine} className="size-6" />
                        {database.name}
                    </DialogTitle>
                </DialogHeader>
                {error && <p className="text-sm text-danger">{error}</p>}
                {!connection && !error && (
                    <div className="flex justify-center py-8 text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                    </div>
                )}
                {connection && (
                    <div className="flex flex-col gap-3">
                        <Field
                            label="Connection URI"
                            hint="Reachable by name from any service in this environment."
                        >
                            <CopyRow value={connection.uri} secret={!revealed} />
                        </Field>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="Host">
                                <CopyRow value={connection.host} />
                            </Field>
                            <Field label="Port">
                                <CopyRow value={String(connection.port)} />
                            </Field>
                            <Field label="Database">
                                <CopyRow value={connection.database} />
                            </Field>
                            <Field label="User">
                                <CopyRow value={connection.username} />
                            </Field>
                        </div>
                        <Field label="Password">
                            <CopyRow value={revealed ? connection.password : hidden} copyValue={connection.password} />
                        </Field>
                        <div className="flex items-center justify-between gap-2">
                            <Button variant="ghost" size="sm" onClick={() => setRevealed((value) => !value)}>
                                {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                                {revealed ? "Hide password" : "Show password"}
                            </Button>
                            {connection.exposedPort && (
                                <span className="text-xs text-muted-foreground">
                                    Also published on the server at port {connection.exposedPort}
                                </span>
                            )}
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** A read-only value with a copy button, for anything meant to be pasted. */
function CopyRow({ value, secret, copyValue }: { value: string; secret?: boolean; copyValue?: string }) {
    const [copied, setCopied] = useState(false);
    const shown = secret ? value.replace(/:\/\/([^:]*):[^@]*@/, "://$1:********@") : value;

    function copy() {
        void navigator.clipboard.writeText(copyValue ?? value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    }

    return (
        <span className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-xs" title={shown}>
                {shown}
            </code>
            <button
                type="button"
                onClick={copy}
                title="Copy"
                aria-label="Copy"
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                {copied ? <CheckCircle2 className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </button>
        </span>
    );
}

export const SERVICE_TYPES = [
    { id: "github", label: "GitHub Repository", icon: <GitHubMark className="size-5" /> },
    { id: "docker", label: "Docker Image", icon: <DockerMark className="size-5" /> },
    { id: "database", label: "Database", icon: <Database className="size-5" /> }
] as const;

export type ServiceView = "list" | "github" | "docker" | "database";

const SERVICE_TITLES: Record<Exclude<ServiceView, "list">, string> = {
    github: "GitHub Repository",
    docker: "Docker Image",
    database: "Database"
};

/** The service-creation dialog as a controlled component, so any trigger (the header
 *  button or the canvas context menu) can open it at a chosen step. */
export function NewServiceDialog({
    environmentId,
    open,
    view,
    onOpenChange,
    onViewChange,
    onChanged
}: {
    environmentId: string;
    open: boolean;
    view: ServiceView;
    onOpenChange: (open: boolean) => void;
    onViewChange: (view: ServiceView) => void;
    onChanged: () => void;
}) {
    function done() {
        onOpenChange(false);
        onChanged();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {view !== "list" && (
                            <button
                                type="button"
                                onClick={() => onViewChange("list")}
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
                    <ServiceTypeList onPick={onViewChange} />
                ) : view === "database" ? (
                    <NewDatabaseForm environmentId={environmentId} onDone={done} />
                ) : view === "github" ? (
                    <NewGithubForm environmentId={environmentId} onDone={done} />
                ) : (
                    <NewImageForm environmentId={environmentId} onDone={done} />
                )}
            </DialogContent>
        </Dialog>
    );
}

export function NewServiceButton({ environmentId, onChanged }: { environmentId: string; onChanged: () => void }) {
    const [open, setOpen] = useState(false);
    const [view, setView] = useState<ServiceView>("list");

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
            <NewServiceDialog
                environmentId={environmentId}
                open={open}
                view={view}
                onOpenChange={setOpen}
                onViewChange={setView}
                onChanged={onChanged}
            />
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
        void deployActions.listDeployServersAction()
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
            const result = await deployActions.createApplicationAction({
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
                hint="The port the container listens on. Leave empty to detect it from the image; set it (e.g. 5601 for OpenSearch Dashboards) only if the image exposes several ports or none."
            >
                <Input value={port} onChange={(event) => setPort(event.target.value)} placeholder="Auto (from image)" inputMode="numeric" />
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

/** What the picker settled on. `fullName` is null for a git URL somewhere other
 *  than GitHub, which is what decides whether the clone is authenticated. */
interface RepoChoice {
    url: string;
    fullName: string | null;
    defaultBranch: string;
    private: boolean;
}

type Builder = "dockerfile" | "nixpacks";

const BUILDER_OPTIONS: SelectOption[] = [
    { value: "dockerfile", label: "Dockerfile" },
    { value: "nixpacks", label: "Auto-detect (Nixpacks)" }
];

/** The service name a plain git URL suggests: its last path segment. */
function nameFromUrl(url: string): string {
    const last = url.split("?")[0]?.split("#")[0]?.replace(/\/+$/, "").split("/").pop() ?? "";
    return last.replace(/\.git$/i, "");
}

/**
 * Choosing what to deploy.
 *
 * The repository field is the shared picker; everything below it is what only a
 * deploy asks for - the name, the branch, the builder and where it runs.
 */
function NewGithubForm({ environmentId, onDone }: { environmentId: string; onDone: () => void; }) {
    // Null until the picker's first read answers, so the "not connected" notice
    // does not flash before anybody has been asked.
    const [connected, setConnected] = useState<boolean | null>(null);
    const [choice, setChoice] = useState<RepoChoice | null>(null);
    const [name, setName] = useState("");
    const [branch, setBranch] = useState("");
    const [builder, setBuilder] = useState<Builder>("dockerfile");
    const [dockerfilePath, setDockerfilePath] = useState("Dockerfile");
    const [rootDirectory, setRootDirectory] = useState("");
    const [framework, setFramework] = useState<string | null>(null);
    const [inspecting, setInspecting] = useState(false);
    const { servers, serverId, setServerId } = useDeployServers();
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // Whether the account is connected decides one line of copy here and whether
    // the clone is authenticated, so it is read alongside the picker's own load.
    const listRepos = useCallback(async () => {
        const result = await deployActions.githubReposAction();
        setConnected(result.connected);
        return result;
    }, []);

    function pickRepo(repo: PickerRepo) {
        setChoice({
            url: `https://github.com/${repo.fullName}`,
            fullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
            private: repo.private
        });
        setName(repo.fullName.split("/")[1] ?? "");
        setBranch(repo.defaultBranch);
        setFramework(null);
        setInspecting(true);
        const [owner, repoName] = repo.fullName.split("/");
        void deployActions
            .inspectRepoAction({ owner: owner ?? "", repo: repoName ?? "", branch: repo.defaultBranch })
            .then((inspection) => {
                setBuilder(inspection.builder);
                setDockerfilePath(inspection.dockerfile ?? "Dockerfile");
                setFramework(inspection.framework);
            })
            .catch(() => undefined)
            .finally(() => setInspecting(false));
    }

    /** A git URL outside GitHub: nothing can be read from it up front, so the
     *  branch and the builder are left for the operator to state. */
    function pickUrl(url: string) {
        setChoice({ url, fullName: null, defaultBranch: "", private: false });
        setName(nameFromUrl(url));
        setBranch("");
        setBuilder("nixpacks");
        setFramework(null);
    }

    function clearChoice() {
        setChoice(null);
        setName("");
        setBranch("");
    }

    const canSubmit = Boolean(name.trim()) && choice !== null;

    function submit() {
        if (!choice) return;
        setError(null);
        startTransition(async () => {
            const result = await deployActions.createApplicationAction({
                environmentId,
                name,
                sourceType: builder,
                repoUrl: choice.url,
                branch: branch.trim() || undefined,
                dockerfilePath: builder === "dockerfile" ? dockerfilePath.trim() || undefined : undefined,
                rootDirectory: rootDirectory.trim() || undefined,
                // Only a GitHub repository can be cloned with the stored credentials.
                provider: connected && choice.fullName ? "github" : undefined,
                serverId
            });
            if (result.error) setError(result.error);
            else onDone();
        });
    }

    return (
        <div className="flex flex-col gap-3">
            {connected === false && (
                <p className="rounded-md border border-border/60 bg-surface/40 px-3 py-2 text-xs text-muted-foreground">
                    Searching public repositories.{" "}
                    <a href="/account/connections" className="text-primary hover:underline">
                        Connect your GitHub account
                    </a>{" "}
                    to reach private ones and your own list.
                </p>
            )}

            {choice ? (
                <div className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2">
                    {choice.fullName ? (
                        <GitHubMark className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                        <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">{choice.fullName ?? choice.url}</span>
                    {choice.private && <Lock className="size-3.5 shrink-0 text-muted-foreground" />}
                    <Button type="button" variant="ghost" size="sm" onClick={clearChoice}>
                        Change
                    </Button>
                </div>
            ) : (
                <RepoPicker
                    cacheKey="deploy"
                    autoFocus
                    list={listRepos}
                    search={deployActions.searchGithubReposAction}
                    onPick={pickRepo}
                    onPickUrl={pickUrl}
                />
            )}

            {choice && (
                <>
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Name">
                            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-app" />
                        </Field>
                        <Field label="Branch">
                            <Input
                                value={branch}
                                onChange={(event) => setBranch(event.target.value)}
                                placeholder="main"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                            />
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
                    <Field
                        label="Root directory"
                        hint="For a repository holding several apps. The build still gets the whole repository, so shared packages and the lockfile above it are available."
                    >
                        <Input
                            value={rootDirectory}
                            onChange={(event) => setRootDirectory(event.target.value)}
                            placeholder="apps/web"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                        />
                    </Field>
                    {builder === "dockerfile" && (
                        <Field
                            label="Dockerfile path"
                            hint={rootDirectory.trim() ? `Relative to ${rootDirectory.trim()}.` : undefined}
                        >
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

/** One labelled block of repository rows. Both sources render the same row, so a
 *  repository looks the same whether it came from the account or from a search. */
/** Picking this means "start an instance of its own", the default. */
const DEDICATED = "__dedicated__";

const PRIVILEGE_OPTIONS: SelectOption[] = [
    { value: "owner", label: "Owner - full control of this database" },
    { value: "readwrite", label: "Read and write - no schema changes" },
    { value: "readonly", label: "Read only" }
];

function NewDatabaseForm({ environmentId, onDone }: { environmentId: string; onDone: () => void }) {
    const [name, setName] = useState("");
    const [engine, setEngine] = useState<DbEngine>("postgres");
    const { servers, serverId, setServerId } = useDeployServers();
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // Advanced settings. Each empty value means "whatever the engine or Polaris
    // would pick", so the plain path stays two fields long.
    const [advanced, setAdvanced] = useState(false);
    const [instanceId, setInstanceId] = useState(DEDICATED);
    const [instances, setInstances] = useState<DbInstance[]>([]);
    const [version, setVersion] = useState("");
    const [exposePort, setExposePort] = useState("");
    const [databaseName, setDatabaseName] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [privileges, setPrivileges] = useState("owner");

    const info = DB_ENGINE_INFO[engine];
    const hosted = instanceId !== DEDICATED;

    // Which instances this engine could be placed on. Reloaded when the engine
    // changes, because an instance only hosts databases of its own engine.
    useEffect(() => {
        setInstanceId(DEDICATED);
        if (!info.namedDatabases) {
            setInstances([]);
            return;
        }
        let active = true;
        void deployActions.listDatabaseInstancesAction(environmentId, engine).then((rows) => {
            if (active) setInstances(rows);
        });
        return () => {
            active = false;
        };
    }, [environmentId, engine, info.namedDatabases]);

    /** The request as the schema sees it, so the form and the server agree on
     *  what is valid instead of each having an opinion. */
    function draft(): DatabaseCreateInput {
        return {
            environmentId,
            name: name.trim(),
            engine,
            serverId: hosted ? undefined : serverId,
            instanceId: hosted ? instanceId : undefined,
            version: !hosted && version ? version : undefined,
            exposePort: !hosted && exposePort.trim() ? Number(exposePort) : undefined,
            databaseName: databaseName.trim() || undefined,
            username: username.trim() || undefined,
            password: password || undefined,
            privileges: privileges as "owner" | "readwrite" | "readonly"
        };
    }

    // Validated as it is typed, against the schema the action runs, so a value
    // the server would refuse is refused here first.
    const parsed = databaseCreateSchema.safeParse(draft());
    const issue = name.trim() && !parsed.success ? parsed.error.issues[0] : null;

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await deployActions.createDatabaseAction(draft());
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
                <Select value={engine} onValueChange={(value) => setEngine(value as DbEngine)} options={ENGINE_OPTIONS} />
            </Field>
            {!hosted && <ServerField servers={servers} value={serverId} onChange={setServerId} />}

            <button
                type="button"
                onClick={() => setAdvanced((open) => !open)}
                className="flex items-center gap-1 self-start text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
                <ChevronRight className={`size-3.5 transition-transform ${advanced ? "rotate-90" : ""}`} />
                Advanced
            </button>

            {advanced && (
                <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
                    {info.namedDatabases && (
                        <Field
                            label="Runs on"
                            hint={
                                hosted
                                    ? "Created inside an instance that is already running, sharing its memory and its server."
                                    : "Starts a container of its own, with its own data volume."
                            }
                        >
                            <Select
                                value={instanceId}
                                onValueChange={setInstanceId}
                                options={[
                                    { value: DEDICATED, label: `A new ${info.label} instance` },
                                    ...instances.map((instance) => ({
                                        value: instance.id,
                                        label: `${instance.name} (${info.label} ${instance.version}, ${instance.databases} ${instance.databases === 1 ? "database" : "databases"})`
                                    }))
                                ]}
                            />
                        </Field>
                    )}

                    {!hosted && (
                        <>
                            <Field label="Version">
                                <Select
                                    value={version}
                                    onValueChange={setVersion}
                                    placeholder="Latest tested"
                                    options={info.versions.map((entry) => ({
                                        value: entry,
                                        label: `${info.label} ${entry}`
                                    }))}
                                />
                            </Field>
                            <Field
                                label="Published port"
                                hint="Blank keeps it reachable only by the services in this environment, which is what most databases want."
                            >
                                <Input
                                    value={exposePort}
                                    onChange={(event) => setExposePort(event.target.value)}
                                    placeholder={String(info.port)}
                                    inputMode="numeric"
                                    className="w-32"
                                />
                            </Field>
                        </>
                    )}

                    {info.namedUsers && (
                        <>
                            <Field label="Database name" hint="Defaults to the name above.">
                                <Input
                                    value={databaseName}
                                    onChange={(event) => setDatabaseName(event.target.value)}
                                    placeholder="my_db"
                                />
                            </Field>
                            <Field label="User">
                                <Input
                                    value={username}
                                    onChange={(event) => setUsername(event.target.value)}
                                    placeholder={hosted ? "my_db" : "polaris"}
                                />
                            </Field>
                            {/* An instance of its own hands its user the engine's
                                administrative account, so there is nothing to scope
                                down; the choice only exists on a shared instance. */}
                            {hosted && (
                                <Field label="Privileges" hint="What this user may do inside its own database.">
                                    <Select
                                        value={privileges}
                                        onValueChange={setPrivileges}
                                        options={PRIVILEGE_OPTIONS}
                                    />
                                </Field>
                            )}
                        </>
                    )}

                    <Field label="Password" hint="Blank generates a strong one and stores it encrypted.">
                        <Input
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder="Generated"
                        />
                    </Field>
                </div>
            )}

            {issue && <p className="text-sm text-warning">{issue.message}</p>}
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button onClick={submit} disabled={pending || !name.trim() || !parsed.success}>
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
    const [watchPaths, setWatchPaths] = useState(app.watchPaths ?? "");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await deployActions.setAutoDeployAction({
                applicationId: app.id,
                autoDeploy: enabled,
                deployBranch: branch.trim() || undefined,
                commitFilter: filter.trim() || undefined,
                watchPaths: watchPaths.trim() || undefined
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
                    <Field
                        label="Watch paths"
                        hint="One glob per line. Deploy only when the push touched one of them, so a repository holding several services rebuilds just the ones that changed. Prefix with ! to exclude. Blank = any change."
                    >
                        <Textarea
                            value={watchPaths}
                            onChange={(event) => setWatchPaths(event.target.value)}
                            placeholder={"apps/web/**\npackages/ui/**\n!**/*.md"}
                            rows={4}
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                        />
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
            const result = await deployActions.addDomainAction({
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
                                <div key={domain.id} className="flex items-center gap-2">
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
                                        <span className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground line-through">
                                            <Globe className="size-3 shrink-0" /> {domain.hostname}
                                        </span>
                                    )}
                                    <Switch
                                        checked={domain.enabled}
                                        onChange={(next) =>
                                            startTransition(async () => {
                                                await deployActions.setDomainEnabledAction(domain.id, next);
                                                onChanged();
                                            })
                                        }
                                        aria-label={domain.enabled ? "Disable domain" : "Enable domain"}
                                    />
                                </div>
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
    // Tint the whole chip by tone so state reads in color at a glance, Railway-style.
    const chip = {
        success: "border-success/25 bg-success/10 text-success",
        warning: "border-warning/25 bg-warning/10 text-warning",
        danger: "border-danger/25 bg-danger/10 text-danger",
        idle: "border-border/60 bg-surface text-muted-foreground"
    }[tone];
    return (
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${chip}`}>
            <span className={`size-1.5 rounded-full ${dot} ${tone === "warning" ? "animate-pulse" : ""}`} />
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

    return (
        <LogViewer
            log={log}
            name={deploymentId}
            header={<StatusPill tone={dbTone(status)} label={`Status: ${status}`} />}
        />
    );
}

/** A service's state and what it is consuming, on its card. Painted from the last
 *  reading the tab held for it, then kept current - a badge that appears a second
 *  after the card it belongs to is a card that moves under the pointer. */
function MetricsBadge({ applicationId }: { applicationId: string }) {
    const { data } = useServiceMetrics(applicationId, SERVICE_LIST_METRICS_MS);

    if (!data?.state) return null;
    const parts = [data.state];
    if (typeof data.cpuPercent === "number") parts.push(`${data.cpuPercent.toFixed(0)}% cpu`);
    if (typeof data.memPercent === "number") parts.push(`${data.memPercent.toFixed(0)}% mem`);
    return <Badge>{parts.join(" · ")}</Badge>;
}
