"use client";

/**
 * Mods and plugins, browsed the way a marketplace is browsed.
 *
 * The server installs what its MODRINTH_PROJECTS lists when it boots and removes
 * what has been taken off it, so this screen edits that list rather than pushing
 * files into a running container - which means the list here and what is actually
 * loaded cannot drift apart, and applying it is the same restart as any other
 * setting.
 *
 * What changed is everything around that. A search box over the whole of Modrinth
 * offers a server the things it cannot run: a mod for another loader, a plugin
 * with no build for the release this server is on, a client-side mod that does
 * nothing on a server at all. None of those fail loudly - they fail as a server
 * that boots without the thing, hours later. So the server's own software and
 * version are part of every query, what is already installed is shown as the
 * projects they are rather than as a column of slugs, and the incompatibilities
 * the publishers themselves declare are read back and shown before the restart
 * instead of after it.
 */

import { useConfirm } from "@/components/confirm-dialog";
import { updateServerSettingsAction } from "./minecraft-actions";
import type { InstalledAppSetting } from "@/lib/apps/install-service";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Badge, Button, Card, CardBody, Input, Select, Skeleton, cn } from "@polaris/ui";
import {
    ArrowUpCircle,
    Download,
    ExternalLink,
    Loader2,
    Plus,
    RotateCw,
    Search,
    Trash2,
    TriangleAlert
} from "lucide-react";
import {
    categoriesForLoader,
    formatProjectList,
    loaderForType,
    parseProjectList,
    repinEntry,
    type InstalledProject,
    type ModrinthConflict,
    type ModrinthProject
} from "@/lib/apps/minecraft/modrinth";

const PROJECTS_KEY = "MODRINTH_PROJECTS";
const DEPENDENCIES_KEY = "MODRINTH_DOWNLOAD_DEPENDENCIES";
const VERSION_KEY = "VERSION";
const SEARCH_DEBOUNCE_MS = 400;

/** A version the browse can actually filter on. `LATEST` is the default and names
 *  no particular release, so nothing is filtered by it and nothing is claimed
 *  about whether an installed project fits. */
function pinnedVersion(value: string | undefined): string {
    const version = (value ?? "").trim();
    return /^[0-9][0-9.]*$/.test(version) ? version : "";
}

export function MinecraftMods({
    installedAppId,
    settings,
    playersOnline,
    onSaved
}: {
    installedAppId: string;
    settings: InstalledAppSetting[];
    playersOnline: number;
    onSaved: () => void;
}) {
    const projectsSetting = settings.find((setting) => setting.key === PROJECTS_KEY);
    const dependenciesSetting = settings.find((setting) => setting.key === DEPENDENCIES_KEY);
    const serverType = settings.find((setting) => setting.key === "TYPE")?.value ?? "";
    const loader = loaderForType(serverType);
    const version = pinnedVersion(settings.find((setting) => setting.key === VERSION_KEY)?.value);

    const installed = useMemo(
        () => parseProjectList(projectsSetting?.value ?? ""),
        [projectsSetting?.value]
    );
    const [projects, setProjects] = useState<string[]>(installed);
    const [dependencies, setDependencies] = useState(dependenciesSetting?.value ?? "required");
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState("");
    const [results, setResults] = useState<ModrinthProject[] | null>(null);
    const [searching, setSearching] = useState(false);
    /** What is on the list, as real projects. Null until the first read answers. */
    const [onList, setOnList] = useState<InstalledRow[] | null>(null);
    const [conflicts, setConflicts] = useState<ModrinthConflict[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    const categories = useMemo(() => (loader ? categoriesForLoader(loader) : []), [loader]);
    const changed =
        formatProjectList(projects) !== formatProjectList(installed) ||
        dependencies !== (dependenciesSetting?.value ?? "required");

    /** Everything the server has to be described by, on every request: what it
     *  runs, what release it is on, and what it is already carrying. */
    const serverQuery = useCallback(
        (extra: Record<string, string>) =>
            new URLSearchParams({
                loader: loader ?? "",
                ...(version ? { version } : {}),
                ...extra
            }).toString(),
        [loader, version]
    );

    const browse = useCallback(
        async (term: string, tag: string) => {
            if (!loader) {
                setResults(null);
                return;
            }
            setSearching(true);
            try {
                const response = await fetch(
                    `/api/apps/installed/${installedAppId}/minecraft/modrinth?${serverQuery({ query: term.trim(), category: tag })}`,
                    { cache: "no-store" }
                );
                const data = (await response.json()) as {
                    projects?: ModrinthProject[];
                    error?: string;
                };
                setResults(data.projects ?? []);
                setError(response.ok ? null : (data.error ?? "Could not search Modrinth"));
            } catch {
                setError("Could not reach Modrinth");
            } finally {
                setSearching(false);
            }
        },
        [installedAppId, loader, serverQuery]
    );

    /**
     * What the list actually holds, and what any two of them say about each other.
     *
     * Read against what is on screen rather than against what is deployed, so a
     * project added a moment ago is checked before the restart that would install
     * it - which is the only moment at which finding out is worth anything.
     */
    const readList = useCallback(
        async (entries: readonly string[]) => {
            if (!loader || entries.length === 0) {
                setOnList([]);
                setConflicts([]);
                return;
            }
            try {
                const response = await fetch(
                    `/api/apps/installed/${installedAppId}/minecraft/modrinth?${serverQuery({ installed: entries.join(",") })}`,
                    { cache: "no-store" }
                );
                if (!response.ok) return;
                const data = (await response.json()) as {
                    projects?: InstalledRow[];
                    conflicts?: ModrinthConflict[];
                };
                setOnList(data.projects ?? []);
                setConflicts(data.conflicts ?? []);
            } catch {
                // The list still renders from what is on screen; only the titles
                // and the warnings are missing, and the next edit asks again.
            }
        },
        [installedAppId, loader, serverQuery]
    );

    // Browse as it is typed, but not on every keystroke. With nothing typed this
    // is the popular list for the chosen shelf, which is what a marketplace opens
    // on rather than an empty page asking to be searched.
    useEffect(() => {
        const timer = setTimeout(() => void browse(query, category), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, category, browse]);

    useEffect(() => {
        void readList(projects);
    }, [projects, readList]);

    /**
     * Taking a project off the list.
     *
     * Asked about first because nothing here puts it back: the row goes on one
     * click, and what is lost with it is the build it was pinned to and the search
     * that found it in the first place.
     */
    async function removeProject(entry: string, title: string): Promise<void> {
        if (
            !(await confirm({
                title: `Remove ${title}?`,
                description:
                    "It comes off the list now. The server uninstalls it when you save and restart.",
                confirmLabel: "Remove",
                danger: true
            }))
        ) {
            return;
        }
        setProjects((current) => current.filter((item) => item !== entry));
    }

    async function save(): Promise<void> {
        setError(null);
        const warning =
            playersOnline > 0
                ? `${playersOnline} ${playersOnline === 1 ? "player is" : "players are"} connected and will be disconnected.`
                : "The server restarts to install and remove what changed.";
        if (
            !(await confirm({
                title: "Restart to apply the changes?",
                description: warning,
                confirmLabel: "Save and restart"
            }))
        ) {
            return;
        }
        startTransition(async () => {
            const result = await updateServerSettingsAction(installedAppId, [
                { key: PROJECTS_KEY, value: formatProjectList(projects) },
                { key: DEPENDENCIES_KEY, value: dependencies }
            ]);
            if (result.error) {
                setError(result.error);
                return;
            }
            onSaved();
        });
    }

    if (!loader) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-2 py-8 text-center">
                    <p className="text-sm">
                        {serverType
                            ? `This server runs ${serverType.toLowerCase()}, which cannot load mods.`
                            : "Bedrock servers do not load mods or plugins."}
                    </p>
                    {serverType && (
                        <p className="text-sm text-muted-foreground">
                            Change the server software under Settings to Paper for plugins, or
                            Fabric, Forge or NeoForge for mods.
                        </p>
                    )}
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {error && <p className="text-sm text-danger">{error}</p>}

            <InstalledList
                installedAppId={installedAppId}
                entries={projects}
                projects={onList}
                conflicts={conflicts}
                version={version}
                dependencies={dependencies}
                dependencyOptions={
                    dependenciesSetting?.options ?? [{ value: "required", label: "Required only" }]
                }
                onDependencies={setDependencies}
                onRemove={(entry, title) => void removeProject(entry, title)}
                onRepin={(entry, build) =>
                    setProjects((current) =>
                        current.map((item) => (item === entry ? repinEntry(item, build) : item))
                    )
                }
            />

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                className="pl-9"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={`Search ${loader} mods and plugins`}
                                aria-label="Search Modrinth"
                            />
                        </div>
                        {searching && (
                            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                        )}
                    </div>

                    {/* Shelves rather than a blank search box. Somebody who knows
                        what they want types it; everybody else is here to find out
                        what there is. */}
                    <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                        {categories.map((entry) => (
                            <button
                                key={entry.value || "all"}
                                type="button"
                                onClick={() => setCategory(entry.value)}
                                className={cn(
                                    "whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                                    category === entry.value
                                        ? "bg-primary text-primary-foreground"
                                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                )}
                            >
                                {entry.label}
                            </button>
                        ))}
                    </div>

                    <p className="text-xs text-muted-foreground">
                        {version
                            ? `Only what runs on ${loader} and has a build for ${version}.`
                            : `Only what runs on ${loader}. This server is on LATEST, so nothing can be filtered by release - check a project supports the version it ends up on.`}
                    </p>

                    {results === null ? (
                        <div className="flex flex-col gap-2">
                            {[0, 1, 2].map((row) => (
                                <Skeleton key={row} className="h-16 w-full" />
                            ))}
                        </div>
                    ) : results.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                            Nothing on Modrinth matches that for this server.
                        </p>
                    ) : (
                        <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                            {results.map((project) => (
                                <ProjectCard
                                    key={project.slug}
                                    installedAppId={installedAppId}
                                    project={project}
                                    added={projects.some(
                                        (entry) => entry.replace(/\?+$/, "") === project.slug
                                    )}
                                    onAdd={() =>
                                        setProjects((current) => [...current, project.slug])
                                    }
                                />
                            ))}
                        </ul>
                    )}
                </CardBody>
            </Card>

            <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    {changed ? "Changes apply on the next restart." : "Nothing to apply."}
                </p>
                <Button onClick={() => void save()} disabled={pending || !changed}>
                    {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <RotateCw className="size-4" />
                    )}
                    Save and restart
                </Button>
            </div>

            {confirmElement}
        </div>
    );
}

/**
 * One project's own icon.
 *
 * Through Polaris rather than straight from the CDN: an `<img src>` at a third
 * party announces to them who is looking at this screen and from where, and every
 * other request this feature makes is proxied for exactly that reason. Its
 * initials for a project that never uploaded one, so a list never goes ragged.
 */
function ProjectIcon({
    installedAppId,
    project
}: {
    installedAppId: string;
    project: { title: string; iconUrl: string | null };
}) {
    if (!project.iconUrl) {
        return (
            <div className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface text-xs font-medium text-muted-foreground">
                {project.title.slice(0, 2).toUpperCase()}
            </div>
        );
    }
    return (
        <img
            src={`/api/apps/installed/${installedAppId}/minecraft/modrinth/icon?url=${encodeURIComponent(project.iconUrl)}`}
            alt=""
            aria-hidden
            loading="lazy"
            className="size-10 shrink-0 rounded-md border border-border object-cover"
        />
    );
}

function ProjectCard({
    installedAppId,
    project,
    added,
    onAdd
}: {
    installedAppId: string;
    project: ModrinthProject;
    added: boolean;
    onAdd: () => void;
}) {
    return (
        <li className="flex items-start gap-3 rounded-md border border-border p-3">
            <ProjectIcon installedAppId={installedAppId} project={project} />
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={project.title}>
                    {project.title}
                </p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{project.description}</p>
                <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                        <Download className="size-3" />
                        {project.downloads.toLocaleString()}
                    </span>
                    {project.author && <span className="truncate">by {project.author}</span>}
                    {/* The page it came from, for the description, the screenshots
                        and the changelog - none of which belong in a row here, and
                        all of which are what somebody checks before installing. */}
                    <a
                        href={`https://modrinth.com/project/${project.slug}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="ml-auto flex items-center gap-1 hover:text-foreground"
                        title={`Open ${project.title} on Modrinth`}
                    >
                        <ExternalLink className="size-3" />
                    </a>
                </p>
            </div>
            <Button
                size="sm"
                variant={added ? "ghost" : "secondary"}
                disabled={added}
                onClick={onAdd}
            >
                <Plus className="size-4" />
                {added ? "Added" : "Add"}
            </Button>
        </li>
    );
}

/**
 * What this server is carrying, and everything wrong with it.
 *
 * Drawn from what is on screen rather than from what is deployed, so the warnings
 * are about the list that is about to be applied. Three of them are worth the
 * space: a project Modrinth has never heard of, which installs nothing; one with
 * no build for the release the server is on, which is the commonest way a server
 * comes up without its plugins; and two that their own publishers say cannot both
 * be there.
 */
/** An installed entry as this screen reads it back: what Modrinth knows, plus what
 *  the entry is pinned to and the newer build it could move to. */
interface InstalledRow extends InstalledProject {
    readonly pinned?: string | null;
    readonly newest?: string | null;
}

function InstalledList({
    installedAppId,
    entries,
    projects,
    conflicts,
    onRepin,
    version,
    dependencies,
    dependencyOptions,
    onDependencies,
    onRemove
}: {
    installedAppId: string;
    entries: readonly string[];
    projects: InstalledRow[] | null;
    conflicts: readonly ModrinthConflict[];
    /** Move a pinned entry onto a newer build. */
    onRepin: (entry: string, build: string) => void;
    version: string;
    dependencies: string;
    dependencyOptions: ReadonlyArray<{ value: string; label: string }>;
    onDependencies: (value: string) => void;
    onRemove: (entry: string, title: string) => void;
}) {
    const conflictsFor = (slug: string): string[] =>
        conflicts
            .filter((entry) => entry.slug === slug || entry.withSlug === slug)
            .map((entry) => (entry.slug === slug ? entry.withSlug : entry.slug));

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <p className="text-sm font-medium">
                            Installed{" "}
                            <span className="text-muted-foreground">{entries.length || ""}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                            The server installs these when it boots and removes whatever is taken
                            off.
                        </p>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        Dependencies
                        <div className="w-44">
                            <Select
                                value={dependencies}
                                onValueChange={onDependencies}
                                options={[...dependencyOptions]}
                                aria-label="Which dependencies to install with a mod"
                            />
                        </div>
                    </label>
                </div>

                {entries.length === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">
                        Nothing installed yet. Browse below to add a mod or plugin.
                    </p>
                ) : projects === null ? (
                    // The names are a round trip away; the rows themselves are not.
                    <ul className="flex flex-col gap-2">
                        {entries.map((entry) => (
                            <Skeleton key={entry} className="h-14 w-full" />
                        ))}
                    </ul>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {projects.map((project) => {
                            const clashes = conflictsFor(project.slug);
                            return (
                                <li
                                    key={project.entry}
                                    className="flex items-start gap-3 rounded-md border border-border p-2"
                                >
                                    <ProjectIcon
                                        installedAppId={installedAppId}
                                        project={project}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p
                                            className="truncate text-sm font-medium"
                                            title={project.title}
                                        >
                                            {project.title}
                                        </p>
                                        {project.description && (
                                            <p className="line-clamp-1 text-xs text-muted-foreground">
                                                {project.description}
                                            </p>
                                        )}
                                        <div className="mt-1 flex flex-wrap items-center gap-1">
                                            {!project.known && (
                                                <Badge
                                                    variant="warning"
                                                    title="Modrinth has no project by this name"
                                                >
                                                    <TriangleAlert className="size-3" /> not on
                                                    Modrinth
                                                </Badge>
                                            )}
                                            {project.known && !project.fitsLoader && (
                                                <Badge variant="warning">
                                                    no build for this software
                                                </Badge>
                                            )}
                                            {project.known && project.fitsVersion === false && (
                                                <Badge variant="warning">
                                                    no build for {version}
                                                </Badge>
                                            )}
                                            {/* Only ever on an entry nailed to a
                                                build. One that follows the newest
                                                updates itself every boot and is
                                                never behind. */}
                                            {project.newest && (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        onRepin(
                                                            project.entry,
                                                            project.newest as string
                                                        )
                                                    }
                                                    title={`Pinned to ${project.pinned}. Move it to ${project.newest}.`}
                                                >
                                                    <Badge variant="primary">
                                                        <ArrowUpCircle className="size-3" />{" "}
                                                        {project.newest} available
                                                    </Badge>
                                                </button>
                                            )}
                                            {clashes.length > 0 && (
                                                <Badge
                                                    variant="danger"
                                                    title={`Its publisher says it cannot run alongside ${clashes.join(", ")}`}
                                                >
                                                    <TriangleAlert className="size-3" /> clashes
                                                    with {clashes.join(", ")}
                                                </Badge>
                                            )}
                                        </div>
                                    </div>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={`Remove ${project.title}`}
                                        title={`Remove ${project.title}`}
                                        className="text-danger hover:text-danger"
                                        onClick={() => onRemove(project.entry, project.title)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}
