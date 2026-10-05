"use client";

/**
 * Service detail panel (Railway-style): opens on a service and exposes its
 * deployment history, environment variables, metrics, an interactive console, a
 * file browser, and settings (auto-deploy, keep-releases, domains) as tabs.
 * Reuses the existing terminal/files/logs building blocks.
 */

import Link from "next/link";
import { CronPanel } from "./cron-panel";
import { FilesPanel } from "./files-panel";
import * as deployActions from "./actions";
import { VolumesTab } from "./volumes-panel";
import { SettingsTab } from "./service-settings";
import { SettingsSection } from "./settings-kit";
import { TerminalPanel } from "./terminal-panel";
import { useProjectCan } from "./access-context";
import { relativeTime } from "@/lib/relative-time";
import { DeployCallouts } from "./deploy-callouts";
import { LogViewer } from "@/components/log-viewer";
import type { HttpLogEntry } from "@polaris/deploy";
import { VariablesEditor } from "./variables-editor";
import { Discussion } from "@/components/discussion";
import { isInFlightStatus } from "@/lib/deploy/status";
import { RuntimeLogs } from "@/components/runtime-logs";
import { deploySteps } from "@/lib/deploy/deploy-steps";
import { ActivityFeed } from "@/components/activity-feed";
import type { CommentView } from "@/lib/comments/comments";
import type { ActivityLine } from "@/lib/activity/activity";
import { isLocalDomain, primaryDomain } from "./domain-rank";
import { useDisplayFormat } from "@/components/display-format";
import { TabAttentionDot, tabAttention } from "./attention-dot";
import { DesktopServiceActions } from "@/components/desktop-app";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { SERVICE_METRICS_MS, useServiceMetrics } from "./service-metrics";
import { describeServiceEvent, unresolvedSetupFailure } from "./service-history";
import { DeployStepSegments, DeployStepper, useDeploySteps } from "./deploy-stepper";
import { RunStatePill, ServiceIcon, serviceKindOf, type ProjectApp } from "./deploy-view";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { DisplayFormat, ProjectCapability } from "@polaris/core";
import {
    CONSUMPTION_METRICS,
    MetricsHistory,
    percent,
    type MetricSpec
} from "@/components/metrics-history";
import {
    Badge,
    Button,
    Card,
    cn,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    EmptyState,
    Input,
    ScrollRow,
    SegmentedControl,
    Select
} from "@polaris/ui";
import {
    Activity,
    ArrowUpRight,
    Braces,
    Clock,
    FolderOpen,
    HardDrive,
    MessageSquare,
    Rocket,
    SquareTerminal,
    type LucideIcon,
    Bell,
    BellOff,
    ChartColumn,
    CheckCircle2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    CircleStop,
    Download,
    ExternalLink,
    Globe,
    Loader2,
    MapPin,
    Maximize2,
    Minimize2,
    MoreVertical,
    Pin,
    PinOff,
    Play,
    RotateCw,
    ScrollText,
    Search,
    ShieldCheck,
    Split,
    Square,
    Trash2,
    Undo2,
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
const TABS = [
    "Deployments",
    "Variables",
    "Metrics",
    "Console",
    "Files",
    "Volumes",
    "Cron",
    "Notes",
    "Settings"
] as const;
type Tab = (typeof TABS)[number];

type ServiceT = NamespaceTranslator<"deployService">;

const TAB_LABEL = {
    Deployments: "tabs.deployments",
    Variables: "tabs.variables",
    Metrics: "tabs.metrics",
    Console: "tabs.console",
    Files: "tabs.files",
    Volumes: "tabs.volumes",
    Cron: "tabs.cron",
    Notes: "tabs.notes",
    Settings: "tabs.settings"
} as const satisfies Record<Tab, string>;

/**
 * What each tab takes to open. A tab the reader cannot use is not drawn: the
 * variables tab in particular has to be absent rather than empty, since the whole
 * point of withholding it is that the names of the variables are not shown
 * either.
 */
const TAB_CAPABILITY: Record<Tab, readonly ProjectCapability[]> = {
    Deployments: ["project.read"],
    Variables: ["variables.read"],
    Metrics: ["project.read"],
    Console: ["console.use"],
    Files: ["files.read"],
    Volumes: ["project.read"],
    // Seeing jobs and their output is reading logs; changing or running one is
    // gated again inside, on the console.
    Cron: ["logs.read"],
    Notes: ["project.read"],
    // Settings holds three separate jobs - how the service is built, where it
    // answers, and removing it - so any one of them is enough to open it, and the
    // sections inside are gated one by one.
    Settings: ["service.configure", "domains.manage", "service.delete"]
};

const LINKED_TABS = [
    {
        label: "tabs.security",
        title: "tabs.openSecurity",
        icon: ShieldCheck,
        href: (id: string) => `/apps/firewall?scope=application&id=${id}`
    },
    {
        label: "tabs.analytics",
        title: "tabs.openAnalytics",
        icon: ChartColumn,
        href: (id: string) => `/apps/analytics?scope=application&id=${id}`
    }
] as const;

export function ServiceDetail({
    app,
    project,
    staged,
    onChanged,
    onClose
}: {
    app: ProjectApp;
    /** The project the service is in, for what the desktop app opens and names. */
    project: { id: string; name: string };
    /** Queued for removal in the changeset. The panel keeps working - the service
     *  is still up - but says so, and stops offering a second delete. */
    staged?: boolean;
    onChanged: () => void;
    onClose: () => void;
}) {
    const t = useTranslations("deployService");
    const [tab, setTab] = useState<Tab>("Deployments");
    const [full, setFull] = useState(false);
    const isGit = app.sourceType === "dockerfile" || app.sourceType === "nixpacks";
    const can = useProjectCan();
    const tabs = TABS.filter((name) => TAB_CAPABILITY[name].some(can));
    const dots = tabAttention(app.attention, t);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                // Its cards and switches are tuned for a raised surface
                // (globals.css, "The service panel's surface and switches").
                data-service-panel=""
                className={cn(
                    "right-0 left-auto top-0 flex h-full max-h-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none rounded-l-xl border-y-0 border-r-0 p-0 data-[state=open]:slide-in-from-right-4",
                    full
                        ? "w-full max-w-none"
                        : "w-full max-w-none sm:w-[820px] sm:max-w-[calc(100vw-2rem)]"
                )}
            >
                <div className="flex items-center gap-3 border-b border-border px-5 py-4">
                    <ServiceIcon
                        kind={serviceKindOf(app.sourceType)}
                        className="size-5 shrink-0 text-foreground"
                    />
                    <DialogTitle className="truncate text-base font-semibold">
                        {app.name}
                    </DialogTitle>
                    {app.deployStatus && <RunStatePill app={app} />}
                    {staged && (
                        <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            {t("panel.removalPending")}
                        </span>
                    )}
                    <div className="ml-auto mr-8 flex shrink-0 items-center gap-1">
                        <DesktopServiceActions
                            projectId={project.id}
                            projectName={project.name}
                            serviceId={app.id}
                            serviceName={app.name}
                            canReadLogs={can("logs.read")}
                            canDeploy={can("deploy.run")}
                        />
                        <FollowToggle applicationId={app.id} />
                        <button
                            type="button"
                            onClick={() => setFull((value) => !value)}
                            title={full ? t("panel.exitFullScreen") : t("panel.fullScreen")}
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            {full ? (
                                <Minimize2 className="size-4" />
                            ) : (
                                <Maximize2 className="size-4" />
                            )}
                        </button>
                    </div>
                </div>

                <ScrollRow className="no-scrollbar flex items-center gap-1 border-b border-border px-5 text-sm">
                    {tabs.map((name) => (
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
                            {t(TAB_LABEL[name])}
                            {dots[name] && (
                                <TabAttentionDot
                                    label={dots[name]}
                                    className="mb-0.5 ml-1.5 align-middle"
                                />
                            )}
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
                                title={t(entry.title, { name: app.name })}
                                className="-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <Icon className="size-3.5" />
                                {t(entry.label)}
                                <ArrowUpRight className="size-3 opacity-60" />
                            </Link>
                        );
                    })}
                </ScrollRow>

                {/* The dialog's own surface, as every other side panel has; the
                    cards on it are that surface with a hairline (globals.css). */}
                <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
                    {tab !== "Settings" && (
                        <TabFrame tab={tab} id={app.id}>
                            {tab === "Deployments" && (
                                <DeploymentsTab app={app} onChanged={onChanged} />
                            )}
                            {tab === "Variables" && <VariablesTab app={app} />}
                            {tab === "Metrics" && <MetricsTab applicationId={app.id} />}
                            {tab === "Console" && (
                                <TerminalPanel
                                    target={{ kind: "container", applicationId: app.id }}
                                    label={app.containerRef}
                                />
                            )}
                            {tab === "Files" && <FilesPanel applicationId={app.id} />}
                            {tab === "Volumes" && <VolumesTab app={app} />}
                            {tab === "Cron" && <CronPanel applicationId={app.id} />}
                            {tab === "Notes" && <NotesTab applicationId={app.id} />}
                        </TabFrame>
                    )}
                    {tab === "Settings" && (
                        <SettingsTab
                            app={app}
                            isGit={isGit}
                            staged={staged ?? false}
                            onChanged={onChanged}
                        />
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** Each tab's heading: what it is and what it is for, in one line. */
const TAB_FRAME: Record<
    Exclude<Tab, "Settings">,
    { icon: LucideIcon; intro: NamespaceKey<"deployService">; card: boolean }
> = {
    // Tabs whose content is already drawn as cards or as a full-bleed tool are not
    // put in another one; a card inside a card is a box for its own sake.
    Deployments: { icon: Rocket, intro: "tabIntro.deployments", card: false },
    Variables: { icon: Braces, intro: "tabIntro.variables", card: true },
    Metrics: { icon: Activity, intro: "tabIntro.metrics", card: false },
    Console: { icon: SquareTerminal, intro: "tabIntro.console", card: false },
    Files: { icon: FolderOpen, intro: "tabIntro.files", card: false },
    Volumes: { icon: HardDrive, intro: "tabIntro.volumes", card: false },
    Cron: { icon: Clock, intro: "tabIntro.cron", card: false },
    Notes: { icon: MessageSquare, intro: "tabIntro.notes", card: true }
};

/** A tab drawn in the same shape as the Settings sections: icon, title, one
 *  line, and the content on one card. */
function TabFrame({
    tab,
    id,
    children
}: {
    tab: Exclude<Tab, "Settings">;
    id: string;
    children: ReactNode;
}) {
    const t = useTranslations("deployService");
    const frame = TAB_FRAME[tab];
    return (
        <SettingsSection
            id={`tab-${tab.toLowerCase()}-${id}`}
            icon={frame.icon}
            title={t(TAB_LABEL[tab])}
            intro={t(frame.intro)}
        >
            {frame.card ? <Card className="min-w-0 px-4 py-3">{children}</Card> : children}
        </SettingsSection>
    );
}

type DepSummary = Awaited<ReturnType<typeof deployActions.listDeploymentsAction>>[number];

/** A deployment's state as one chip. Every chip on a row is a Badge, so the
 *  state, the rollback marks and the kept-image mark share one shape. */
function depBadge(deployment: DepSummary): {
    label:
        | "badge.active"
        | "badge.cancelled"
        | "badge.failed"
        | "badge.queued"
        | "badge.deploying"
        | "badge.removed";
    variant: "success" | "danger" | "warning" | "neutral";
} {
    if (deployment.isCurrent) return { label: "badge.active", variant: "success" };
    if (["failed", "cancelled", "rolled_back"].includes(deployment.status))
        return {
            label: deployment.status === "cancelled" ? "badge.cancelled" : "badge.failed",
            variant: "danger"
        };
    if (["queued", "deploying"].includes(deployment.status))
        return {
            label: deployment.status === "queued" ? "badge.queued" : "badge.deploying",
            variant: "warning"
        };
    return { label: "badge.removed", variant: "neutral" };
}

function StateBadge({ deployment }: { deployment: DepSummary }) {
    const t = useTranslations("deployService");
    const badge = depBadge(deployment);
    return (
        <Badge variant={badge.variant} className="shrink-0 uppercase tracking-wide">
            {t(badge.label)}
        </Badge>
    );
}

/** Whether a deployment has stopped moving. Everything else is still queued or
 *  building, and has no container behind it yet. */
function isSettled(deployment: DepSummary): boolean {
    return !isInFlightStatus(deployment.status);
}

function depTitle(deployment: DepSummary, t: ServiceT): string {
    if (deployment.commitMessage) return deployment.commitMessage;
    if (deployment.commitSha)
        return t("deployments.titleCommit", { sha: deployment.commitSha.slice(0, 7) });
    return t("deployments.titleManual");
}

/** Short source label for a deployment's subtitle ("via GitHub" / "via Registry"). */
function sourceLabel(app: ProjectApp, t: ServiceT): string {
    // i18n-ignore: a brand name
    return app.sourceType === "image" ? t("deployments.sourceRegistry") : "GitHub";
}

/** The commit author's avatar (GitHub), falling back to the source glyph. */
function DeployAvatar({ app, deployment }: { app: ProjectApp; deployment?: DepSummary | null }) {
    const t = useTranslations("deployService");
    if (deployment?.authorAvatarUrl) {
        // eslint-disable-next-line @next/next/no-img-element -- external avatar, no loader needed
        return (
            <img
                src={deployment.authorAvatarUrl}
                alt={deployment.authorName ?? t("deployments.author")}
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

/** Deployment subtitle: relative time, optional author, what started it, and how
 *  long it took once it has finished. A rollback or a restart with changed
 *  variables says so instead of naming a source, since nothing was built. */
function deploySubtitle(
    deployment: DepSummary,
    app: ProjectApp,
    format: DisplayFormat,
    t: ServiceT
): string {
    const by = deployment.authorName ? t("deployments.by", { name: deployment.authorName }) : "";
    const source = sourceLabel(app, t);
    const via = deployment.rollbackOfId
        ? t("deployments.viaRolledBack")
        : deployment.trigger === "variables"
          ? t("deployments.viaVariables")
          : deployment.trigger === "settings"
            ? t("deployments.viaSettings")
            : deployment.trigger === "scale"
              ? t("deployments.viaScale")
              : deployment.trigger === "upload"
                ? t("deployments.viaUpload")
                : deployment.trigger === "preview"
                  ? t("deployments.viaPreview", { source })
                  : deployment.trigger === "push"
                    ? t("deployments.viaPush", { source })
                    : t("deployments.via", { source });
    const took =
        deployment.durationMs !== null
            ? t("deployments.took", { duration: duration(deployment.durationMs) })
            : "";
    const built = deployment.builtOn
        ? t("deployments.builtOn", { machine: deployment.builtOn })
        : "";
    return `${relativeTime(deployment.createdAt, format)}${by}${via}${built}${took}`;
}

/** A deploy's length the way a person says it: "48s", "3m 12s". */
function duration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

/** Whether a version can be put back instantly, and whether it is being kept
 *  past the window. Only for versions that are not live: the live one is the
 *  one everything else would be rolled back from. */
function KeptChip({ deployment }: { deployment: DepSummary }) {
    const t = useTranslations("deployService");
    return (
        <>
            {deployment.rollbackOfId && (
                <Badge variant="neutral" className="shrink-0" title={t("kept.rollbackTitle")}>
                    {t("kept.rollback")}
                </Badge>
            )}
            {!deployment.isCurrent && deployment.imageKept && (
                <Badge
                    variant="primary"
                    className="shrink-0"
                    title={deployment.pinned ? t("kept.pinnedTitle") : t("kept.instantTitle")}
                >
                    {deployment.pinned ? t("kept.pinned") : t("kept.instant")}
                </Badge>
            )}
        </>
    );
}

/** The address one kept version answers on, beside the service's own. Only a
 *  version that is still up has one, so there is never a link to nothing. */
function ReleaseLink({ deployment }: { deployment: DepSummary }) {
    const t = useTranslations("deployService");
    if (!deployment.hostname) return null;
    return (
        <a
            href={`https://${deployment.hostname}`}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            aria-label={t("kept.openVersion", { host: deployment.hostname })}
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
    const t = useTranslations("deployService");
    if (!deployment?.commitSha) return null;
    const short = deployment.commitSha.slice(0, chars);
    if (!deployment.commitUrl) return <span className="font-mono">{short}</span>;
    return (
        <a
            href={deployment.commitUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            title={t("deployments.viewCommit", { sha: short })}
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
    const t = useTranslations("deployService");
    const can = useProjectCan();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const isActive = deployment.isCurrent;
    const stopped = deployment.status === "stopped";

    function run(action: () => Promise<{ error?: string }>) {
        startTransition(async () => {
            const result = await action().catch(() => ({ error: t("errors.notThrough") }));
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
                error: t("errors.deployNotStarted"),
                deploymentId: undefined
            }));
            setError(result.error ?? null);
            onAct();
            onChanged();
            if (result.deploymentId) onDeployStarted(result.deploymentId);
        });
    }

    /** Put this release back live from its kept image, and follow the new
     *  deployment the way a redeploy does. */
    function rollBack() {
        startTransition(async () => {
            const result = await deployActions
                .rollbackDeploymentAction(deployment.id)
                .catch(() => ({ error: t("errors.rollbackFailed"), deploymentId: undefined }));
            setError(result.error ?? null);
            onAct();
            onChanged();
            if (result.deploymentId) onDeployStarted(result.deploymentId);
        });
    }

    // Every item in this menu ships or tears down a release, so with no standing
    // to do that there is no menu - not one that opens onto nothing.
    if (!can("deploy.run")) return null;

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
                    aria-label={error ? t("menu.labelWithError", { error }) : t("menu.label")}
                >
                    {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <MoreVertical className="size-4" />
                    )}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                {deployment.rollbackable && (
                    <DropdownMenuItem onSelect={rollBack}>
                        <Undo2 className="size-4" /> {t("menu.rollBack")}
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={redeploy}>
                    <RotateCw className="size-4" />{" "}
                    {isActive ? t("menu.redeploy") : t("menu.deployLatest")}
                </DropdownMenuItem>
                {deployment.imageKept && (
                    <DropdownMenuItem
                        onSelect={() =>
                            run(() =>
                                deployActions.pinDeploymentAction(deployment.id, !deployment.pinned)
                            )
                        }
                    >
                        {deployment.pinned ? (
                            <PinOff className="size-4" />
                        ) : (
                            <Pin className="size-4" />
                        )}
                        {deployment.pinned ? t("menu.unpin") : t("menu.pin")}
                    </DropdownMenuItem>
                )}
                {deployment.canTakeTraffic &&
                    (deployment.trafficPercent !== null ? (
                        <DropdownMenuItem
                            onSelect={() =>
                                run(() =>
                                    deployActions.setDeploymentTrafficAction(deployment.id, null)
                                )
                            }
                        >
                            <Split className="size-4" />{" "}
                            {t("menu.stopTraffic", { percent: deployment.trafficPercent })}
                        </DropdownMenuItem>
                    ) : (
                        [10, 50].map((percent) => (
                            <DropdownMenuItem
                                key={percent}
                                onSelect={() =>
                                    run(() =>
                                        deployActions.setDeploymentTrafficAction(
                                            deployment.id,
                                            percent
                                        )
                                    )
                                }
                            >
                                <Split className="size-4" /> {t("menu.sendTraffic", { percent })}
                            </DropdownMenuItem>
                        ))
                    ))}
                {isActive && (
                    <>
                        <DropdownMenuItem
                            onSelect={() =>
                                run(() => deployActions.restartApplicationAction(app.id))
                            }
                        >
                            <RotateCw className="size-4" /> {t("menu.restart")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onSelect={() =>
                                run(() =>
                                    deployActions.setApplicationRunningAction(app.id, stopped)
                                )
                            }
                        >
                            {stopped ? <Play className="size-4" /> : <Square className="size-4" />}
                            {stopped ? t("menu.enable") : t("menu.disable")}
                        </DropdownMenuItem>
                    </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    variant="danger"
                    onSelect={() =>
                        run(() => deployActions.removeApplicationDeploymentAction(app.id))
                    }
                >
                    <Trash2 className="size-4" /> {t("menu.remove")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function DeploymentsTab({ app, onChanged }: { app: ProjectApp; onChanged: () => void }) {
    const t = useTranslations("deployService");
    const can = useProjectCan();
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
    // without a manual page reload; stop once everything has stopped moving. Asked
    // through `isSettled` rather than a second list of states kept here: the copy left
    // "running" out, so a service that had been up for hours went on polling every
    // three seconds with nothing left to learn.
    useEffect(() => {
        if (!items?.some((item) => !isSettled(item))) return;
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
    const region = primary
        ? t("deployments.regionDeployed")
        : app.sourceType === "image"
          ? t("deployments.sourceRegistry")
          : // i18n-ignore: a brand name
            "GitHub";

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
                            <Globe className="size-4 shrink-0 text-muted-foreground" />{" "}
                            {primary.hostname}
                            {isLocalDomain(primary) && (
                                <span className="shrink-0 rounded bg-warning-soft px-1 text-[0.625rem] font-medium text-warning-ink">
                                    {t("deployments.lan")}
                                </span>
                            )}
                        </a>
                    ) : (
                        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Globe className="size-4 shrink-0" /> {t("deployments.noDomain")}
                        </span>
                    )}
                    {app.ipUrl && (
                        <a
                            href={app.ipUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-w-0 items-center gap-1.5 truncate pl-[1.375rem] text-xs text-muted-foreground hover:text-primary hover:underline"
                            title={t("deployments.ipTitle")}
                        >
                            {app.ipUrl.replace(/^https?:\/\//, "")}
                        </a>
                    )}
                </div>
                <div className="ml-auto hidden items-center gap-4 text-xs text-muted-foreground sm:flex">
                    <span className="inline-flex items-center gap-1">
                        <MapPin className="size-3.5" /> {region}
                    </span>
                    <span>{t("deployments.replicas", { count: app.replicas })}</span>
                </div>
                {can("deploy.run") && (
                    <Button size="sm" disabled={busy} onClick={deploy}>
                        {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            t("deployments.deploy")
                        )}
                    </Button>
                )}
            </div>

            {items === null ? (
                <Loading />
            ) : items.length === 0 ? (
                <Empty text={t("deployments.empty")} />
            ) : (
                <>
                    <DeployCallouts
                        applicationId={app.id}
                        items={items}
                        canDeploy={can("deploy.run")}
                        busy={busy}
                        onDeploy={deploy}
                        onViewLog={setLogsFor}
                        canConfigure={can("service.configure")}
                        canSetVariables={can("variables.write")}
                        onFixed={() => {
                            reload();
                            onChanged();
                        }}
                    />
                    {active && (
                        <div className="overflow-hidden rounded-xl border border-success-edge bg-success/[0.06]">
                            <div className="flex items-center gap-3 p-3">
                                <StateBadge deployment={active} />
                                <DeployAvatar app={app} deployment={active} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-foreground">
                                        {depTitle(active, t)}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {deploySubtitle(active, app, format, t)}
                                    </p>
                                </div>
                                {active.commitSha && (
                                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                                        <CommitRef deployment={active} />
                                    </span>
                                )}
                                <KeptChip deployment={active} />
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="shrink-0 border-success-edge text-success-ink hover:bg-success-soft hover:text-success-ink"
                                    onClick={() => setLogsFor(active.id)}
                                >
                                    {t("deployments.viewLogs")}
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
                                className="flex w-full items-center gap-1.5 border-t border-success-edge px-3 py-2 text-xs text-success-ink"
                            >
                                <CheckCircle2 className="size-3.5" />
                                {active.status === "running"
                                    ? t("deployments.successful")
                                    : active.status === "stopped"
                                      ? t("deployments.disabled")
                                      : t("deployments.status", { status: active.status })}
                                <ChevronDown
                                    className={cn(
                                        "ml-auto size-3.5 transition-transform",
                                        successOpen && "rotate-180"
                                    )}
                                />
                            </button>
                            {successOpen && (
                                <div className="border-t border-success-edge px-3 py-2 text-xs text-muted-foreground">
                                    {active.commitSha ? (
                                        <CommitRef deployment={active} />
                                    ) : (
                                        t("deployments.titleManual")
                                    )}
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
                                    <ChevronRight
                                        className={cn(
                                            "size-3.5 transition-transform",
                                            historyOpen && "rotate-90"
                                        )}
                                    />
                                    {t("deployments.history")}
                                </button>
                            </div>
                            {historyOpen && (
                                <ul className="flex flex-col gap-2">
                                    {history.map((deployment) => {
                                        const failed = [
                                            "failed",
                                            "cancelled",
                                            "rolled_back"
                                        ].includes(deployment.status);
                                        return (
                                            <li
                                                key={deployment.id}
                                                onClick={() => setLogsFor(deployment.id)}
                                                className={cn(
                                                    "flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition-colors hover:border-muted-foreground/40",
                                                    failed
                                                        ? "border-danger-edge bg-danger-soft"
                                                        : "border-border"
                                                )}
                                            >
                                                <StateBadge deployment={deployment} />
                                                <DeployAvatar app={app} deployment={deployment} />
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate font-medium text-foreground">
                                                        {depTitle(deployment, t)}
                                                    </p>
                                                    <p className="truncate text-xs text-muted-foreground">
                                                        {deploySubtitle(deployment, app, format, t)}
                                                    </p>
                                                    {!isSettled(deployment) && (
                                                        <InFlightSteps
                                                            deploymentId={deployment.id}
                                                        />
                                                    )}
                                                </div>
                                                {deployment.commitSha && (
                                                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                                                        <CommitRef deployment={deployment} />
                                                    </span>
                                                )}
                                                <KeptChip deployment={deployment} />
                                                <ReleaseLink deployment={deployment} />
                                                {/* A deploy still in flight is listed
                                                    here, so this is where it is stopped
                                                    from - without first opening a log to
                                                    look for the control. */}
                                                {!isSettled(deployment) && (
                                                    <CancelDeployButton
                                                        deploymentId={deployment.id}
                                                        onCancelled={reload}
                                                    />
                                                )}
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

            <ServiceActivity applicationId={app.id} />
        </div>
    );
}

/**
 * Hear about this service, or stop hearing about it.
 *
 * The owner is told about a deploy either way - this is for the second person,
 * who spent the afternoon on it or wants to know when it comes back up. Written
 * optimistically because the answer is a boolean the server cannot disagree
 * with, and rolled back if it does.
 */
function FollowToggle({ applicationId }: { applicationId: string }) {
    const t = useTranslations("deployService");
    const [following, setFollowing] = useState<boolean | null>(null);

    useEffect(() => {
        setFollowing(null);
        void deployActions
            .serviceFollowStateAction(applicationId)
            .then((state) => setFollowing(state.following));
    }, [applicationId]);

    if (following === null) return null;

    const label = following ? t("panel.unfollow") : t("panel.follow");
    return (
        <button
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={following}
            onClick={async () => {
                const next = !following;
                setFollowing(next);
                const result = await deployActions.setServiceFollowAction({
                    applicationId,
                    following: next
                });
                if (result.error) setFollowing(!next);
            }}
            className={cn(
                "rounded p-1 transition-colors hover:bg-muted",
                following ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
        >
            {following ? <Bell className="size-4" /> : <BellOff className="size-4" />}
        </button>
    );
}

/**
 * What people have written down about this service. The history says what
 * happened; this is where somebody says why - "restarted, the disk was full",
 * "do not redeploy until the migration lands".
 *
 * Only the service's owner reaches this panel at all, and the server checks that
 * on every call rather than trusting the id in the request, so the reader
 * moderates the thread.
 */
function NotesTab({ applicationId }: { applicationId: string }) {
    const t = useTranslations("deployService");
    const [notes, setNotes] = useState<CommentView[] | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    function reload() {
        void deployActions.serviceCommentsAction(applicationId).then(setNotes);
    }
    useEffect(reload, [applicationId]);

    return (
        <div className="flex flex-col gap-3 py-2">
            {error ? <p className="text-[0.8125rem] text-danger">{error}</p> : null}
            <Discussion
                comments={notes}
                canModerate
                busy={busy}
                placeholder={t("notes.placeholder")}
                onPost={async (body) => {
                    setBusy(true);
                    setError("");
                    const result = await deployActions.postServiceCommentAction({
                        applicationId,
                        body
                    });
                    if (result.error) setError(result.error);
                    setBusy(false);
                    reload();
                }}
                onDelete={async (commentId) => {
                    setError("");
                    const result = await deployActions.deleteServiceCommentAction({
                        applicationId,
                        commentId
                    });
                    if (result.error) setError(result.error);
                    reload();
                }}
            />
        </div>
    );
}

/**
 * Everything that happened to this service that was not a release: who
 * restarted it, who stopped it, which variable changed. The releases above
 * answer "what is running"; this answers "what did somebody do to it", which is
 * the question after something stops working.
 */
function ServiceActivity({ applicationId }: { applicationId: string }) {
    const t = useTranslations("deployService");
    const [lines, setLines] = useState<ActivityLine[] | null>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        setLines(null);
        void deployActions.serviceHistoryAction(applicationId).then(setLines);
    }, [applicationId]);

    // Nothing yet means nothing to open, and a heading over an empty box is a
    // control that does nothing.
    if (lines !== null && lines.length === 0) return null;
    const failure = lines ? unresolvedSetupFailure(lines) : null;

    return (
        <div className="flex flex-col gap-2">
            {failure ? <SetupFailure applicationId={applicationId} failure={failure} /> : null}
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                className="inline-flex items-center gap-1 self-start text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
                <ChevronRight
                    className={cn("size-3.5 transition-transform", open && "rotate-90")}
                />
                {t("activity.title")}
            </button>
            {open ? (
                lines === null ? (
                    <Loading />
                ) : (
                    <ActivityFeed
                        lines={lines}
                        describe={(line) => describeServiceEvent(line, t)}
                    />
                )
            ) : null}
        </div>
    );
}

/**
 * A one-click service whose setup did not finish, said where its deploys are
 * rather than only inside the folded activity. A failed setup command can be run
 * again from here; a deploy that never started is fixed by deploying.
 */
function SetupFailure({
    applicationId,
    failure
}: {
    applicationId: string;
    failure: ActivityLine;
}) {
    const t = useTranslations("deployService");
    const can = useProjectCan();
    const [started, setStarted] = useState(false);
    const [error, setError] = useState("");
    const [pending, startTransition] = useTransition();
    const rerunnable = failure.action === "setup-failed" && can("service.configure");
    const hint = started
        ? t("activity.setupRunning")
        : failure.action === "setup-failed"
          ? null
          : t("activity.deployOnceFixed");

    function rerun() {
        setError("");
        startTransition(async () => {
            const result = await deployActions.rerunServiceSetupAction(applicationId);
            if (result.error) setError(result.error);
            else setStarted(true);
        });
    }

    return (
        <div className="flex flex-col gap-2 rounded-md border border-danger-edge bg-danger-soft p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0">
                    <span className="block text-sm font-medium">
                        {failure.action === "setup-failed"
                            ? t("activity.setupFailed")
                            : t("activity.notDeployed")}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                        {describeServiceEvent(failure, t)}
                    </span>
                    {hint ? (
                        <span className="block text-xs text-muted-foreground">{hint}</span>
                    ) : null}
                </span>
                {rerunnable && !started ? (
                    <Button variant="secondary" size="sm" onClick={rerun} disabled={pending}>
                        {pending && <Loader2 className="size-4 animate-spin" />}{" "}
                        {t("activity.rerun")}
                    </Button>
                ) : null}
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
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
    const CATS = [
        "Details",
        "Build Logs",
        "Deploy Logs",
        "HTTP Logs",
        "Network Flow Logs"
    ] as const;
    const CAT_LABEL = {
        Details: "logs.details",
        "Build Logs": "logs.build",
        "Deploy Logs": "logs.deploy",
        "HTTP Logs": "logs.http",
        "Network Flow Logs": "logs.network"
    } as const satisfies Record<(typeof CATS)[number], string>;
    const t = useTranslations("deployService");
    const format = useDisplayFormat();
    // While it is still going there is only one log worth opening: the build's. The
    // runtime log belongs to a container that does not exist yet, and landing on it
    // means being shown an error about the absence rather than the progress you came
    // to watch.
    //
    // Derived rather than picked once at mount, which is what put a just-started deploy
    // on the wrong one: this panel is opened by the deploy button before the row it
    // would read exists, so at mount there is nothing yet to say the build is running.
    // An unknown deployment counts as in flight for the same reason - that is what it
    // is, every time this is opened without one.
    const [chosen, setChosen] = useState<(typeof CATS)[number] | null>(null);
    const building = !deployment || !isSettled(deployment);
    const cat = chosen ?? (building ? "Build Logs" : "Deploy Logs");

    return (
        <div className="flex flex-col gap-2 py-2">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onBack}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={t("logs.back")}
                >
                    <ChevronLeft className="size-4" />
                </button>
                <ServiceIcon
                    kind={serviceKindOf(app.sourceType)}
                    className="size-4 shrink-0 text-foreground"
                />
                <span className="truncate text-sm font-semibold">{app.name}</span>
                {deployment?.commitSha && (
                    <>
                        <span className="text-muted-foreground/40">/</span>
                        <span className="text-xs text-muted-foreground">
                            <CommitRef deployment={deployment} />
                        </span>
                    </>
                )}
                {deployment && <StateBadge deployment={deployment} />}
                {deployment && (
                    <span className="ml-auto text-xs text-muted-foreground">
                        {format.dateTime(deployment.createdAt)}
                    </span>
                )}
                {deployment && !isSettled(deployment) && (
                    <CancelDeployButton deploymentId={deployment.id} onCancelled={onDone} />
                )}
            </div>

            <ScrollRow className="no-scrollbar flex items-center gap-3 border-b border-border text-sm">
                {CATS.map((name) => (
                    <button
                        key={name}
                        type="button"
                        onClick={() => setChosen(name)}
                        className={`-mb-px whitespace-nowrap border-b-2 px-1 py-1.5 transition-colors ${
                            cat === name
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {t(CAT_LABEL[name])}
                    </button>
                ))}
            </ScrollRow>

            {cat === "Details" ? (
                <DetailsPanel app={app} deployment={deployment} />
            ) : cat === "Build Logs" ? (
                <LogStream deploymentId={deploymentId} onDone={onDone} />
            ) : cat === "Deploy Logs" ? (
                <RuntimeLogView
                    appId={app.id}
                    deployment={deployment}
                    onSeeBuild={() => setChosen("Build Logs")}
                />
            ) : cat === "HTTP Logs" ? (
                <HttpLogsView appId={app.id} deploymentStart={deployment?.createdAt ?? null} />
            ) : cat === "Network Flow Logs" ? (
                <Empty text={t("logs.noNetwork")} />
            ) : (
                <LogStream deploymentId={deploymentId} onDone={onDone} />
            )}
        </div>
    );
}

/**
 * Stop a deploy that is still queued or building.
 *
 * Offered wherever an unfinished deploy is on screen, because the state it exists for
 * has no other way out: a build that wedges holds the service in DEPLOYING, and
 * before this the only recourse was restarting Polaris. It asks first - the build may
 * be minutes from finishing and the reader cannot tell from a spinner - but only for a
 * plain confirmation, since redeploying is one click away.
 */
function CancelDeployButton({
    deploymentId,
    onCancelled
}: {
    deploymentId: string;
    onCancelled: () => void;
}) {
    const t = useTranslations("deployService");
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    return (
        <>
            <button
                type="button"
                // The row this sits in opens the log; stopping the deploy is not asking
                // to read it.
                onClick={(event) => {
                    event.stopPropagation();
                    setOpen(true);
                }}
                disabled={pending}
                aria-label={t("cancel.label")}
                title={t("cancel.label")}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger disabled:opacity-50"
            >
                <CircleStop className="size-4" />
            </button>
            <ConfirmDeleteDialog
                open={open}
                onOpenChange={setOpen}
                // i18n-ignore: the component asks with the question below instead
                name="this deploy"
                kind="deploy"
                title={t("cancel.title")}
                question={t.rich("cancel.question", {
                    strong: (chunks) => (
                        <span key="name" className="font-medium text-foreground">
                            {chunks}
                        </span>
                    )
                })}
                requireTyping={false}
                confirmLabel={t("cancel.confirm")}
                description={t("cancel.description")}
                error={error}
                pending={pending}
                onConfirm={() =>
                    startTransition(async () => {
                        const result = await deployActions
                            .cancelDeploymentAction(deploymentId)
                            .catch(() => ({ error: t("errors.notThrough") }));
                        if (result?.error) {
                            setError(result.error);
                            return;
                        }
                        setOpen(false);
                        onCancelled();
                    })
                }
            />
        </>
    );
}

function DetailsPanel({ app, deployment }: { app: ProjectApp; deployment: DepSummary | null }) {
    const t = useTranslations("deployService");
    const format = useDisplayFormat();
    const rows: Array<[string, ReactNode]> = [
        [t("details.status"), deployment?.status ?? "-"],
        [
            t("details.commit"),
            deployment?.commitSha ? <CommitRef deployment={deployment} chars={12} /> : "-"
        ],
        [t("details.message"), deployment?.commitMessage ?? "-"],
        [t("details.started"), deployment ? format.dateTime(deployment.createdAt) : "-"],
        [t("details.domain"), (primaryDomain(app.domains) ?? app.domains[0])?.hostname ?? "-"]
    ];
    return (
        <div className="flex flex-col divide-y divide-border text-sm">
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

/** A deploy that is still moving, drawn as its steps under its row. */
function InFlightSteps({ deploymentId }: { deploymentId: string }) {
    const steps = useDeploySteps(deploymentId, true);
    return steps ? (
        <div className="mt-1">
            <DeployStepSegments steps={steps} />
        </div>
    ) : null;
}

/** Small pulsing "Live" badge shown above a log stream that is actively polling. */
function LivePill() {
    const t = useTranslations("deployService");
    return (
        <span className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-success-solid" />{" "}
            {t("logs.live")}
        </span>
    );
}

function LogStream({ deploymentId, onDone }: { deploymentId: string; onDone: () => void }) {
    const [log, setLog] = useState("");
    const [status, setStatus] = useState("queued");
    const [live, setLive] = useState(true);
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    useEffect(() => {
        let active = true;
        let done = false;
        let timer: ReturnType<typeof setTimeout>;
        setLive(true);
        async function poll(): Promise<void> {
            const res = await fetch(`/api/deploy/deployments/${deploymentId}/log`, {
                cache: "no-store"
            });
            if (!active) return;
            if (res.ok) {
                const data = (await res.json()) as { status: string; log: string };
                setLog(data.log);
                setStatus(data.status);
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
            <div className="rounded-lg border border-border bg-card px-3 pt-3">
                <DeployStepper steps={deploySteps(status, log)} />
            </div>
            {live && <LivePill />}
            <LogViewer log={log} name={deploymentId} searchable className="h-[26rem]" />
        </div>
    );
}

/**
 * Live runtime stdout/stderr of every container of the app - what it prints while
 * running, distinct from the build log - followed as it prints, with what was
 * kept over the last week one switch away.
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
    const t = useTranslations("deployService");
    const pending = deployment !== null && !isSettled(deployment);
    const failed =
        deployment !== null && ["failed", "cancelled", "rolled_back"].includes(deployment.status);

    if (pending || failed) {
        return (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                    {pending ? t("logs.stillBuilding") : t("logs.neverStarted")}
                </p>
                <Button size="sm" variant="outline" onClick={onSeeBuild}>
                    <ScrollText className="size-4" />
                    {pending ? t("logs.watchBuild") : t("logs.seeWhatWentWrong")}
                </Button>
            </div>
        );
    }
    return <RuntimeLogs serviceIds={[appId]} name={`${appId}-runtime`} className="h-[26rem]" />;
}

/** Color an HTTP status by its class: 2xx ok, 3xx redirect, 4xx client, 5xx server. */
function statusTone(status: number): string {
    if (status >= 500) return "bg-danger-soft text-danger-ink";
    if (status >= 400) return "bg-warning-soft text-warning-ink";
    if (status >= 300) return "bg-sky-500/10 text-sky-600 dark:text-sky-400";
    if (status >= 200) return "bg-success-soft text-success-ink";
    return "bg-muted text-muted-foreground";
}

/** Quote a CSV cell when it contains a comma, quote, or newline. */
function csvCell(value: string | number): string {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const HTTP_METHODS = ["all", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const STATUS_CLASSES = [
    { value: "all", label: "" },
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
function HttpLogsView({
    appId,
    deploymentStart
}: {
    appId: string;
    deploymentStart: string | null;
}) {
    const t = useTranslations("deployService");
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
                const res = await fetch(`/api/deploy/apps/${appId}/http-logs?tail=2000`, {
                    cache: "no-store"
                });
                if (!active) return;
                if (res.ok) {
                    const data = (await res.json()) as { entries: HttpLogEntry[] };
                    setEntries(data.entries);
                    setError(null);
                } else {
                    const data = (await res.json().catch(() => null)) as { error?: string } | null;
                    setError(data?.error ?? t("http.unreadable"));
                }
            } catch {
                if (active) setError(t("http.unreadable"));
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
        if (statusClass !== "all" && Math.floor(entry.status / 100) !== Number(statusClass))
            return false;
        if (fromMs !== null || toMs !== null) {
            const at = entry.time ? Date.parse(entry.time) : NaN;
            if (!Number.isFinite(at)) {
                if (fromMs !== null) return false;
            } else {
                if (fromMs !== null && at < fromMs) return false;
                if (toMs !== null && at > toMs) return false;
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
    const hasUserFilter =
        method !== "all" ||
        statusClass !== "all" ||
        query !== "" ||
        ipFilter !== null ||
        Boolean(from) ||
        Boolean(to);

    function exportCsv(): void {
        const header = [
            "time",
            "ip",
            "method",
            "path",
            "status",
            "host",
            "bytes",
            "referer",
            "user_agent",
            "duration_ms"
        ];
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
        anchor.download = ipFilter
            ? `${appId}-http-logs-${ipFilter.replace(/[^\w.-]/g, "_")}.csv`
            : `${appId}-http-logs.csv`;
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
                        placeholder={t("http.filterPlaceholder")}
                        className="pl-8 text-xs"
                    />
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={exportCsv}
                    disabled={!filtered.length}
                    className="shrink-0"
                >
                    <Download className="size-4" /> {t("http.export")}
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
                        scoped
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                >
                    {scoped ? t("http.thisDeployment") : t("http.allHistory")}
                </button>
                <Select
                    value={method}
                    onValueChange={setMethod}
                    options={HTTP_METHODS.map((m) => ({
                        value: m,
                        label: m === "all" ? t("http.anyMethod") : m
                    }))}
                    className="h-8 w-36 min-w-[9rem]"
                    aria-label={t("http.method")}
                />
                <Select
                    value={statusClass}
                    onValueChange={setStatusClass}
                    options={STATUS_CLASSES.map((option) =>
                        option.value === "all" ? { ...option, label: t("http.anyStatus") } : option
                    )}
                    className="h-8 w-36 min-w-[9rem]"
                    aria-label={t("http.status")}
                />
                <Input
                    type="datetime-local"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                    className="h-8 w-auto text-xs"
                    aria-label={t("http.from")}
                />
                <span className="text-muted-foreground">{t("http.to")}</span>
                <Input
                    type="datetime-local"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                    className="h-8 w-auto text-xs"
                    aria-label={t("http.toLabel")}
                />
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
                        <X className="size-3" /> {t("http.clear")}
                    </button>
                )}
            </div>

            {entries !== null && !error && all.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <LivePill />
                    <span>
                        {filtered.length !== all.length
                            ? t("http.countOf", { count: filtered.length, total: all.length })
                            : t("http.count", { count: filtered.length })}
                    </span>
                    {ipFilter && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-foreground">
                            <span className="text-muted-foreground">{t("http.ip")}</span>
                            <span className="font-mono">{ipFilter}</span>
                            <button
                                type="button"
                                onClick={() => setIpFilter(null)}
                                aria-label={t("http.clearIp")}
                                className="ml-0.5 rounded-full p-0.5 hover:bg-card-hover"
                            >
                                <X className="size-3" />
                            </button>
                        </span>
                    )}
                </div>
            )}

            {entries === null && !error ? (
                <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 size-4 animate-spin" /> {t("http.reading")}
                </div>
            ) : error ? (
                <Empty text={error} />
            ) : filtered.length === 0 ? (
                all.length > 0 && scoped && !hasUserFilter ? (
                    // Every request in the log predates this deployment: the scope clamp,
                    // not a user filter, is hiding them. Say so and offer the full history.
                    <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                        <p>
                            {deploymentStart
                                ? t("http.noneSinceAt", { time: format.dateTime(deploymentStart) })
                                : t("http.noneSince")}
                        </p>
                        <p className="text-xs">{t("http.earlier", { count: all.length })}</p>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setScopeDeploy(false)}
                        >
                            {t("http.showAll")}
                        </Button>
                    </div>
                ) : (
                    <Empty text={all.length > 0 ? t("http.noMatch") : t("http.empty")} />
                )
            ) : (
                <div className="max-h-[26rem] overflow-auto overscroll-contain rounded-md border border-border">
                    <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-card text-muted-foreground">
                            <tr className="border-b border-border text-left">
                                <th className="whitespace-nowrap px-3 py-2 font-medium">
                                    {t("http.time")}
                                </th>
                                <th className="px-3 py-2 font-medium">{t("http.method")}</th>
                                <th className="px-3 py-2 font-medium">{t("http.status")}</th>
                                <th className="px-3 py-2 font-medium">{t("http.path")}</th>
                                <th className="whitespace-nowrap px-3 py-2 font-medium">
                                    {t("http.clientIp")}
                                </th>
                                <th className="px-3 py-2 font-medium">{t("http.userAgent")}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {shown.map((entry, index) => (
                                <tr key={index} className="hover:bg-muted/40">
                                    <td
                                        className="whitespace-nowrap px-3 py-1.5 text-muted-foreground"
                                        title={entry.time ?? undefined}
                                    >
                                        {entry.time
                                            ? format.time(entry.time, { seconds: true })
                                            : "-"}
                                    </td>
                                    <td className="px-3 py-1.5 font-mono">{entry.method}</td>
                                    <td className="px-3 py-1.5">
                                        <span
                                            className={`rounded px-1.5 py-0.5 font-mono ${statusTone(entry.status)}`}
                                        >
                                            {entry.status}
                                        </span>
                                    </td>
                                    <td
                                        className="max-w-[18rem] truncate px-3 py-1.5 font-mono"
                                        title={entry.path}
                                    >
                                        {entry.path}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-1.5">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setIpFilter(ipFilter === entry.ip ? null : entry.ip)
                                            }
                                            title={t("http.onlyThisIp")}
                                            className={`font-mono hover:underline ${
                                                ipFilter === entry.ip
                                                    ? "text-foreground"
                                                    : "text-muted-foreground hover:text-foreground"
                                            }`}
                                        >
                                            {entry.ip}
                                        </button>
                                    </td>
                                    <td
                                        className="max-w-[16rem] truncate px-3 py-1.5 text-muted-foreground"
                                        title={entry.userAgent ?? undefined}
                                    >
                                        {entry.userAgent ?? "-"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {shown.length < filtered.length && (
                        <div ref={sentinelRef} className="h-8 w-full" />
                    )}
                </div>
            )}
        </div>
    );
}

function VariablesTab({ app }: { app: ProjectApp }) {
    const t = useTranslations("deployService");
    const can = useProjectCan();
    const [scope, setScope] = useState<"application" | "environment">("application");
    return (
        <div className="flex flex-col gap-4 py-2">
            <SegmentedControl
                aria-label={t("variables.which")}
                className="flex"
                value={scope}
                onValueChange={setScope}
                options={[
                    { value: "application", label: t("variables.service") },
                    { value: "environment", label: t("variables.environment") }
                ]}
            />
            <VariablesEditor
                scope={scope}
                scopeId={scope === "application" ? app.id : app.environmentId}
                canWrite={can("variables.write")}
                canDeploy={can("deploy.run")}
                redeployTarget={
                    scope === "application"
                        ? t("variables.redeployService")
                        : t("variables.redeployEnvironment")
                }
            />
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
    // Seeded from the last reading this tab held for the service and refreshed
    // while it is open: a live figure that only exists after a round trip is one
    // the screen should show, not wait for.
    const t = useTranslations("deployService");
    const { data, loading, stale } = useServiceMetrics(applicationId, SERVICE_METRICS_MS);

    return (
        <div className="flex flex-col gap-4 py-1">
            {stale ? (
                <p className="text-xs text-warning">
                    {t("metrics.lastReading", { reason: stale })}
                </p>
            ) : null}
            {loading ? (
                <Loading />
            ) : data?.state ? (
                <div className="grid gap-3 sm:grid-cols-2">
                    <Meter label={t("metrics.cpu")} value={data.cpuPercent} />
                    <Meter
                        label={t("metrics.memory")}
                        value={data.memPercent}
                        text={
                            typeof data.memUsedBytes === "number"
                                ? `${formatBytes(data.memUsedBytes)}${typeof data.memTotalBytes === "number" ? ` / ${formatBytes(data.memTotalBytes)}` : ""}`
                                : undefined
                        }
                    />
                    <div className="rounded-lg border border-border p-4 text-sm sm:col-span-2">
                        {t.rich("metrics.state", {
                            state: data.state,
                            strong: (chunks) => (
                                <span key="state" className="font-medium">
                                    {chunks}
                                </span>
                            )
                        })}
                    </div>
                </div>
            ) : (
                <Empty text={t("metrics.empty")} />
            )}
            <div>
                <h3 className="mb-1 text-sm font-medium">{t("metrics.history")}</h3>
                <MetricsHistory
                    endpoint={`/api/deploy/apps/${applicationId}/metrics/history`}
                    live={`/api/deploy/apps/${applicationId}/metrics/stream`}
                    metrics={CONSUMPTION_METRICS}
                />
            </div>
            <div>
                <h3 className="mb-1 text-sm font-medium">{t("metrics.http")}</h3>
                <MetricsHistory<HttpPoint>
                    endpoint={`/api/deploy/apps/${applicationId}/http-metrics`}
                    metrics={httpMetrics(t)}
                />
            </div>
        </div>
    );
}

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
const httpMetrics = (t: ServiceT): MetricSpec<HttpPoint>[] => [
    {
        key: "req",
        label: t("metrics.requests"),
        value: (point) => point.requests,
        format: (value) => String(Math.round(value)),
        tone: "primary",
        summary: "sum"
    },
    {
        key: "err",
        label: t("metrics.errorRate"),
        value: (point) => point.errorRate,
        format: percent,
        tone: "danger",
        max: 100,
        summary: "avg"
    },
    {
        key: "rt",
        label: t("metrics.responseTime"),
        value: (point) => point.avgResponseMs,
        format: (value) => `${Math.round(value)} ms`,
        tone: "warning",
        summary: "avg"
    },
    {
        key: "net",
        label: t("metrics.traffic"),
        value: (point) => point.bytesPerSec,
        format: formatRate,
        tone: "success",
        summary: "avg"
    }
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
        <div className="rounded-lg border border-border p-4">
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
function Loading() {
    const t = useTranslations("deployService");
    return (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t("panel.loading")}
        </div>
    );
}

function Empty({ text }: { text: string }) {
    return <EmptyState bare title={text} />;
}
