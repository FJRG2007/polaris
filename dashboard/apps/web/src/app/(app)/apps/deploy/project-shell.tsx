"use client";

/**
 * The frame every screen inside a project sits in.
 *
 * Three things live here because they belong to the project rather than to any
 * one of its screens: the project and environment switchers (portalled into the
 * app header, where there is room beside the app switcher), the section rail,
 * and the changeset banner.
 *
 * The selected environment is held in the URL rather than in state, so it
 * survives moving between sections, reloading, and being sent to somebody else -
 * and so a page can read it server-side without the shell having to hand it down.
 */

import Link from "next/link";
import { createPortal } from "react-dom";
import { createProjectAction } from "./actions";
import { Plus, type LucideIcon } from "lucide-react";
import type { StagedChangeView } from "@/lib/deploy-staged-changes";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Activity, LayoutGrid, ScrollText, Settings } from "lucide-react";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { StagedChangesBanner, StagedChangesProvider } from "./staged-changes";
import { NEW_ENVIRONMENT, NewEnvironmentDialog, newEnvironmentOption } from "./new-environment-dialog";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Select, cn } from "@polaris/ui";

/** Picking this opens the create dialog instead of switching to it. */
const NEW_PROJECT = "__new_project__";

export interface ShellEnvironment {
    id: string;
    name: string;
    isDefault: boolean;
}

export interface ShellProject {
    id: string;
    name: string;
    environments: ShellEnvironment[];
}

interface Section {
    label: string;
    /** Appended to the project's own path; "" is the project root. */
    path: string;
    icon: LucideIcon;
    hint: string;
}

const SECTIONS: Section[] = [
    { label: "Architecture", path: "", icon: LayoutGrid, hint: "Services and how they connect" },
    { label: "Observability", path: "/observability", icon: Activity, hint: "Metrics across the environment" },
    { label: "Logs", path: "/logs", icon: ScrollText, hint: "Every service's output in one stream" },
    { label: "Settings", path: "/settings", icon: Settings, hint: "Project configuration" }
];

export function ProjectShell({
    project,
    projects,
    staged,
    canManage,
    children
}: {
    project: ShellProject;
    projects: { id: string; name: string }[];
    staged: StagedChangeView[];
    canManage: boolean;
    children: ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();

    const base = `/apps/deploy/${project.id}`;
    const defaultEnv = project.environments.find((environment) => environment.isDefault) ?? project.environments[0];
    // A link that names an environment wins; otherwise the project's default. An
    // id belonging to another project simply falls back rather than 404ing.
    const requested = search.get("env");
    const active =
        project.environments.find((environment) => environment.id === requested) ?? defaultEnv ?? null;

    const [showNewProject, setShowNewProject] = useState(false);
    const [showNewEnv, setShowNewEnv] = useState(false);

    /** Move to a section, carrying the environment so switching screen never
     *  silently puts the reader on a different one. */
    function sectionHref(path: string): string {
        const suffix = active && !active.isDefault ? `?env=${active.id}` : "";
        return `${base}${path}${suffix}`;
    }

    function selectEnvironment(id: string): void {
        if (id === NEW_ENVIRONMENT) {
            setShowNewEnv(true);
            return;
        }
        const params = new URLSearchParams(search.toString());
        params.set("env", id);
        // A service panel belongs to the environment being left, so it does not
        // travel with the switch.
        params.delete("service");
        router.push(`${pathname}?${params.toString()}`);
    }

    const newProjectOption = canManage
        ? [{ value: NEW_PROJECT, label: "New project", icon: <Plus className="size-3.5 text-muted-foreground" /> }]
        : [];
    const newEnvOption = newEnvironmentOption(canManage);

    const projectSelect = (
        <Select
            value={project.id}
            onValueChange={(id) => (id === NEW_PROJECT ? setShowNewProject(true) : router.push(`/apps/deploy/${id}`))}
            options={[...projects.map((item) => ({ value: item.id, label: item.name })), ...newProjectOption]}
            className="h-8 min-w-0 flex-1 font-medium md:w-44 md:min-w-[11rem] md:flex-none"
            aria-label="Project"
        />
    );
    const environmentSelect = (
        <Select
            value={active?.id ?? ""}
            onValueChange={selectEnvironment}
            options={[
                ...project.environments.map((environment) => ({ value: environment.id, label: environment.name })),
                ...newEnvOption
            ]}
            className="h-8 min-w-0 flex-1 md:w-52 md:min-w-[13rem] md:flex-none"
            aria-label="Environment"
        />
    );

    return (
        <StagedChangesProvider projectId={project.id} initial={staged}>
        <div className="flex w-full flex-col gap-4">
            {/* The switchers sit in the top bar where there is room for them beside
                the app switcher, and at the top of the page where there is not -
                the same controls, never both visible at once. */}
            <HeaderPortal>
                <span className="hidden text-muted-foreground/40 md:inline">/</span>
                <span className="hidden items-center gap-2 md:flex">
                    {projectSelect}
                    <span className="text-muted-foreground/40">/</span>
                    {environmentSelect}
                </span>
            </HeaderPortal>

            <div className="flex items-center gap-2 md:hidden">
                {projectSelect}
                {environmentSelect}
            </div>

            {canManage && active && (
                <StagedChangesBanner
                    projectId={project.id}
                    environmentId={active.id}
                    environments={project.environments}
                />
            )}

            <div className="flex flex-col gap-4 lg:flex-row lg:gap-6">
                <ProjectNav base={base} pathname={pathname} sectionHref={sectionHref} />
                <div className="min-w-0 flex-1">{children}</div>
            </div>

            <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
            <NewEnvironmentDialog
                projectId={project.id}
                open={showNewEnv}
                onOpenChange={setShowNewEnv}
                onCreated={(id) => selectEnvironment(id)}
            />
        </div>
        </StagedChangesProvider>
    );
}

/**
 * The section rail. A column beside the content on a wide screen; a scrolling
 * row of the same links above it on a narrow one, where a vertical rail would
 * cost more height than the content it introduces.
 */
function ProjectNav({
    base,
    pathname,
    sectionHref
}: {
    base: string;
    pathname: string;
    sectionHref: (path: string) => string;
}) {
    function isActive(path: string): boolean {
        const target = `${base}${path}`;
        // The root is the only one that must match exactly, or it would stay lit
        // while a sibling section is open.
        return path === "" ? pathname === base : pathname === target || pathname.startsWith(`${target}/`);
    }

    return (
        <nav className="lg:w-52 lg:shrink-0">
            <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
                {SECTIONS.map((section) => {
                    const active = isActive(section.path);
                    const Icon = section.icon;
                    return (
                        <li key={section.label} className="shrink-0 lg:shrink">
                            <Link
                                href={sectionHref(section.path)}
                                title={section.hint}
                                aria-current={active ? "page" : undefined}
                                className={cn(
                                    "flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted",
                                    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
                                )}
                            >
                                <Icon className="size-4 shrink-0" />
                                {section.label}
                            </Link>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}

/** Render children into the app-shell header slot (right of the app switcher). */
function HeaderPortal({ children }: { children: ReactNode }) {
    const [target, setTarget] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setTarget(document.getElementById("polaris-header-slot"));
    }, []);
    return target ? createPortal(children, target) : null;
}

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const router = useRouter();
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
            onOpenChange(false);
            if (result.id) router.push(`/apps/deploy/${result.id}`);
            else router.refresh();
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>New project</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Project name</span>
                        <Input
                            autoFocus
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="my-project"
                            onKeyDown={(event) => event.key === "Enter" && submit()}
                        />
                    </label>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending || !name.trim()}>
                            Create
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
