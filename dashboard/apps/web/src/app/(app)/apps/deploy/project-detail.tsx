"use client";

/**
 * Architecture: the project's services and how they connect, as a canvas or a
 * list. The project chrome - switchers, section rail, changeset banner - belongs
 * to ProjectShell; this screen is only the environment's contents.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { DeployCanvas } from "./deploy-canvas";
import { ServiceDetail } from "./service-detail";
import { useStagedChanges } from "./staged-changes";
import { isInFlightStatus } from "@/lib/deploy/status";
import { useEffect, useState, type ReactNode } from "react";
import { List, ShieldCheck, Waypoints } from "lucide-react";
import { EnvironmentServices, NewServiceButton, type ProjectApp, type ProjectSummary } from "./deploy-view";

export function ProjectDetail({
    project,
    canManage,
    localReady,
    activeEnvironmentId,
    openService
}: {
    project: ProjectSummary;
    canManage: boolean;
    localReady: boolean;
    /** Which environment the shell has selected, resolved from the URL. */
    activeEnvironmentId: string | null;
    /** Service to open on arrival, from the URL - a deploy alert or a shared link. */
    openService?: string | null;
}) {
    const router = useRouter();
    const { changes } = useStagedChanges();
    const refresh = () => router.refresh();

    const environments = project.environments;
    const defaultEnv = environments.find((environment) => environment.isDefault) ?? environments[0];
    // A link that names a service lands on the environment holding it, not on
    // whichever one the project happens to open with.
    const linked = openService
        ? environments.find((environment) => environment.applications.some((app) => app.id === openService))
        : undefined;
    const active =
        linked ?? environments.find((environment) => environment.id === activeEnvironmentId) ?? defaultEnv;

    // Something is building or provisioning, so the board has a reason to look again:
    // a deploy finishes on the server with nothing to tell the page about it, and
    // without this the service sat at "deploying" until it was reloaded by hand.
    const settling = environments.some(
        (environment) =>
            environment.applications.some((app) => isInFlightStatus(app.deployStatus)) ||
            environment.databases.some((database) => isInFlightStatus(database.status))
    );
    useEffect(() => {
        if (!settling) return;
        const timer = setInterval(refresh, 3000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settling]);

    const [view, setView] = useState<"canvas" | "list">("canvas");
    const [detailAppId, setDetailAppId] = useState<string | null>(openService ?? null);

    // Derived rather than stored, so refreshed data reaches the open panel (e.g.
    // after removing a domain) and a deleted service closes it instead of leaving
    // a stale snapshot on screen.
    const detailApp = environments.flatMap((env) => env.applications).find((app) => app.id === detailAppId) ?? null;

    // Ids queued for removal, so the canvas and the list can both mark them and
    // the panel can say so rather than offering a second delete. Read from the
    // shell's context rather than the server prop, so staging one marks it here
    // straight away instead of on the next full load.
    const stagedIds = new Set(changes.map((change) => change.targetId));

    /** Open or close the service panel, keeping the URL on the service so the page
     *  can be linked to, reloaded and shared where it was left. Written straight to
     *  history rather than navigated, since the panel is already rendered. */
    function showService(app: ProjectApp | null) {
        setDetailAppId(app?.id ?? null);
        const url = new URL(window.location.href);
        if (app) url.searchParams.set("service", app.id);
        else url.searchParams.delete("service");
        window.history.replaceState(null, "", url);
    }

    return (
        <div className="flex w-full flex-col gap-4">
            {!localReady && canManage && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-muted-foreground">
                    The local host is not ready to build and deploy. This needs the full edition with a running{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">polaris-hostd</code>.
                </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">{active && <EnvSummary environment={active} />}</div>
                <div className="flex flex-wrap items-center gap-2">
                    {canManage && active && <NewServiceButton environmentId={active.id} onChanged={refresh} />}
                    {canManage && (
                        <Link
                            href={`/apps/firewall?scope=project&id=${project.id}`}
                            aria-label="Firewall"
                            title="Firewall"
                            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <ShieldCheck className="size-4" />
                        </Link>
                    )}
                    <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                        <ViewToggle
                            active={view === "canvas"}
                            label="Canvas view"
                            onSelect={() => setView("canvas")}
                            icon={<Waypoints className="size-4" />}
                        />
                        <ViewToggle
                            active={view === "list"}
                            label="List view"
                            onSelect={() => setView("list")}
                            icon={<List className="size-4" />}
                        />
                    </div>
                </div>
            </div>

            {active ? (
                view === "canvas" ? (
                    <DeployCanvas
                        environment={active}
                        canManage={canManage}
                        stagedIds={stagedIds}
                        onOpenService={showService}
                    />
                ) : (
                    <EnvironmentServices
                        environment={active}
                        canManage={canManage}
                        stagedIds={stagedIds}
                        onChanged={refresh}
                        onOpenService={showService}
                    />
                )
            ) : (
                <p className="text-sm text-muted-foreground">This project has no environments.</p>
            )}

            {detailApp && (
                <ServiceDetail
                    app={detailApp}
                    staged={stagedIds.has(detailApp.id)}
                    onChanged={refresh}
                    onClose={() => showService(null)}
                />
            )}
        </div>
    );
}

function ViewToggle({
    active,
    label,
    icon,
    onSelect
}: {
    active: boolean;
    label: string;
    icon: ReactNode;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-label={label}
            title={label}
            aria-pressed={active}
            className={`rounded p-1.5 transition-colors ${active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
            {icon}
        </button>
    );
}

/** A tinted chip summarizing how many of the environment's services are online. */
function EnvSummary({ environment }: { environment: ProjectSummary["environments"][number] }) {
    const online =
        environment.applications.filter((app) => app.currentDeploymentId).length +
        environment.databases.filter((db) => ["running", "active", "healthy", "ready"].includes(db.status.toLowerCase()))
            .length;
    const total = environment.applications.length + environment.databases.length;
    const partial = total > 0 && online < total;
    const chip =
        total === 0
            ? "border-border/60 bg-surface text-muted-foreground"
            : partial
              ? "border-warning/25 bg-warning/10 text-warning"
              : "border-success/25 bg-success/10 text-success";
    const dot = total === 0 ? "bg-muted-foreground" : partial ? "bg-warning" : "bg-success";
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${chip}`}>
            <span className={`size-1.5 rounded-full ${dot} ${partial ? "animate-pulse" : ""}`} />
            {total === 0 ? "No services" : `${online}/${total} online`}
        </span>
    );
}
