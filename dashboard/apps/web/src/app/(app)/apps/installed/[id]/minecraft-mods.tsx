"use client";

/**
 * Mods and plugins, from Modrinth.
 *
 * The server installs what its MODRINTH_PROJECTS lists when it boots and removes
 * what has been taken off it, so this screen edits that list rather than pushing
 * files into a running container - which means the list here and what is actually
 * loaded cannot drift apart, and applying it is the same restart as any other
 * setting.
 */

import { useConfirm } from "@/components/confirm-dialog";
import { updateServerSettingsAction } from "./minecraft-actions";
import { Button, Card, CardBody, Input, Select } from "@polaris/ui";
import type { InstalledAppSetting } from "@/lib/apps/install-service";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Download, Loader2, Plus, RotateCw, Search, Trash2 } from "lucide-react";
import {
    formatProjectList,
    loaderForType,
    parseProjectList,
    type ModrinthProject
} from "@/lib/apps/minecraft/modrinth";

const PROJECTS_KEY = "MODRINTH_PROJECTS";
const DEPENDENCIES_KEY = "MODRINTH_DOWNLOAD_DEPENDENCIES";
const SEARCH_DEBOUNCE_MS = 400;

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

    const installed = useMemo(() => parseProjectList(projectsSetting?.value ?? ""), [projectsSetting?.value]);
    const [projects, setProjects] = useState<string[]>(installed);
    const [dependencies, setDependencies] = useState(dependenciesSetting?.value ?? "required");
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<ModrinthProject[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    const changed =
        formatProjectList(projects) !== formatProjectList(installed) ||
        dependencies !== (dependenciesSetting?.value ?? "required");

    const search = useCallback(
        async (term: string) => {
            if (!loader || term.trim().length === 0) {
                setResults(null);
                return;
            }
            setSearching(true);
            try {
                const response = await fetch(
                    `/api/apps/installed/${installedAppId}/minecraft/modrinth?query=${encodeURIComponent(term.trim())}&loader=${loader}`,
                    { cache: "no-store" }
                );
                const data = (await response.json()) as { projects?: ModrinthProject[]; error?: string };
                setResults(data.projects ?? []);
                setError(response.ok ? null : (data.error ?? "Could not search Modrinth"));
            } catch {
                setError("Could not reach Modrinth");
            } finally {
                setSearching(false);
            }
        },
        [installedAppId, loader]
    );

    // Search as it is typed, but not on every keystroke.
    useEffect(() => {
        const timer = setTimeout(() => void search(query), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, search]);

    async function save(): Promise<void> {
        setError(null);
        const warning =
            playersOnline > 0
                ? `${playersOnline} ${playersOnline === 1 ? "player is" : "players are"} connected and will be disconnected.`
                : "The server restarts to install and remove what changed.";
        if (!(await confirm({ title: "Restart to apply the changes?", description: warning, confirmLabel: "Save and restart" }))) {
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
                            Change the server software under Settings to Paper for plugins, or Fabric, Forge or NeoForge
                            for mods.
                        </p>
                    )}
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {error && <p className="text-sm text-danger">{error}</p>}

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                            Installed <span className="text-muted-foreground">{projects.length || ""}</span>
                        </p>
                        <div className="w-48">
                            <Select
                                value={dependencies}
                                onValueChange={setDependencies}
                                options={dependenciesSetting?.options ?? [{ value: "required", label: "Required only" }]}
                            />
                        </div>
                    </div>
                    {projects.length === 0 ? (
                        <p className="py-2 text-sm text-muted-foreground">
                            Nothing installed yet. Search below to add a mod or plugin.
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border/60">
                            {projects.map((project) => (
                                <li key={project} className="flex items-center gap-2 py-2">
                                    <span className="min-w-0 flex-1 truncate font-mono text-sm" title={project}>{project}</span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={`Remove ${project}`}
                                        title={`Remove ${project}`}
                                        className="text-danger hover:text-danger"
                                        onClick={() => setProjects((current) => current.filter((item) => item !== project))}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <Search className="size-4 text-muted-foreground" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={`Search Modrinth for ${loader} mods and plugins`}
                            aria-label="Search Modrinth"
                        />
                        {searching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                    </div>

                    {results !== null && results.length === 0 && !searching && (
                        <p className="py-2 text-sm text-muted-foreground">
                            Nothing on Modrinth matches that for {loader}.
                        </p>
                    )}

                    {results !== null && results.length > 0 && (
                        <ul className="flex flex-col divide-y divide-border/60">
                            {results.map((project) => {
                                const already = projects.includes(project.slug);
                                return (
                                    <li key={project.slug} className="flex items-start gap-3 py-2">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium" title={project.title}>{project.title}</p>
                                            <p className="line-clamp-2 text-xs text-muted-foreground">
                                                {project.description}
                                            </p>
                                            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                                                <Download className="size-3" />
                                                {project.downloads.toLocaleString()}
                                            </p>
                                        </div>
                                        <Button
                                            size="sm"
                                            variant={already ? "ghost" : "secondary"}
                                            disabled={already}
                                            onClick={() => setProjects((current) => [...current, project.slug])}
                                            title={already ? "Already on the list" : `Add ${project.title}`}
                                        >
                                            <Plus className="size-4" />
                                            {already ? "Added" : "Add"}
                                        </Button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </CardBody>
            </Card>

            <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    {changed ? "Changes apply on the next restart." : "Nothing to apply."}
                </p>
                <Button onClick={() => void save()} disabled={pending || !changed}>
                    {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                    Save and restart
                </Button>
            </div>

            {confirmElement}
        </div>
    );
}
