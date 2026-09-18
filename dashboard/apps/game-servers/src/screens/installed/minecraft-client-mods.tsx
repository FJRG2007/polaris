"use client";

/**
 * The mods the players install, and the one line that installs them.
 *
 * A modded server is only half an install. Everything on its own list that draws
 * anything has to be in each player's `mods` folder too, at the same build - and
 * on top of that there are the mods that only ever run in the player's game: a
 * minimap, a world map, a HUD. Those cannot go on the server's list at all,
 * because the image would try to load them and the boot would end; so they are
 * kept here, and the two lists are handed out together.
 *
 * The screen before this one shows the server's list. This one is about the
 * people who join it: the server's mods they need too, which are shown here and
 * changed there, what they need that the server does not run, and the command
 * that puts all of it into their game and keeps it in step afterwards. Nothing
 * here restarts anything: the server does not load the players' own list.
 */

import { CopyButton } from "@polaris/ui";
import { ProjectIcon } from "./minecraft-project-icon";
import * as modrinth from "../../lib/minecraft/modrinth";
import { updateClientModsAction } from "./minecraft-actions";
import type { PackEntry } from "../../lib/minecraft/client-pack";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Badge, Button, Card, CardBody, Input, Skeleton } from "@polaris/ui";
import { Download, ExternalLink, Loader2, Plus, Search, Trash2 } from "lucide-react";

const SEARCH_DEBOUNCE_MS = 400;

/** What each command is for, in the order somebody scans for their own machine. */
const SYSTEMS = [
    { key: "windows", label: "Windows" },
    { key: "mac", label: "macOS" },
    { key: "linux", label: "Linux" }
] as const;

export function MinecraftClientMods({
    installedAppId,
    loader,
    version,
    entries,
    serverEntries,
    packCommands
}: {
    installedAppId: string;
    loader: string | null;
    /** The release the server is pinned to, or empty for one that follows the
     *  newest - in which case nothing can be filtered by release. */
    version: string;
    entries: readonly string[];
    /** The server's list as the screen above holds it. */
    serverEntries: readonly string[];
    packCommands: Readonly<Record<"windows" | "mac" | "linux", string>> | null;
}) {
    const [list, setList] = useState<string[]>([...entries]);
    const [rows, setRows] = useState<modrinth.InstalledProject[] | null>(null);
    const [query, setQuery] = useState("");
    const [pack, setPack] = useState<PackEntry[] | "unread" | null>(null);
    const [results, setResults] = useState<modrinth.ModrinthProject[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // What the screen was given is what is saved; a list edited and not saved is
    // the only thing that differs from it.
    const changed = list.join(",") !== [...entries].join(",");

    const query_ = useCallback(
        (extra: Record<string, string>) =>
            new URLSearchParams({
                loader: loader ?? "",
                ...(version ? { version } : {}),
                ...extra
            }).toString(),
        [loader, version]
    );

    /** What is on this list, as the projects they are rather than as slugs. */
    const readList = useCallback(
        async (wanted: readonly string[], signal: AbortSignal) => {
            if (!loader || wanted.length === 0) {
                setRows([]);
                return;
            }
            try {
                const response = await fetch(
                    `/api/apps/installed/${installedAppId}/minecraft/modrinth?${query_({ installed: wanted.join(",") })}`,
                    { cache: "no-store", signal }
                );
                if (!response.ok) throw new Error("unread");
                const data = (await response.json()) as { projects?: modrinth.InstalledProject[] };
                setRows(data.projects ?? []);
            } catch {
                if (signal.aborted) return;
                // Drawn as themselves rather than left on skeletons: the list is
                // still editable when Modrinth cannot be reached.
                setRows(
                    wanted.map((entry) => ({
                        entry,
                        slug: modrinth.projectSlug(entry) ?? entry,
                        title: modrinth.projectSlug(entry) ?? entry,
                        description: "",
                        downloads: 0,
                        categories: [],
                        iconUrl: null,
                        author: null,
                        clientOnly: true,
                        serverOnly: false,
                        known: true,
                        fitsVersion: null,
                        fitsLoader: true
                    }))
                );
            }
        },
        [installedAppId, loader, query_]
    );

    /** Everything the install command hands out for these two lists, read from
     *  the same place the command reads it. */
    const readPack = useCallback(
        async (player: readonly string[], server: readonly string[], signal: AbortSignal) => {
            if (!loader) return;
            try {
                const response = await fetch(
                    `/api/apps/installed/${installedAppId}/minecraft/modrinth?${query_({ pack: "1", server: server.join(","), player: player.join(",") })}`,
                    { cache: "no-store", signal }
                );
                if (!response.ok) throw new Error("unread");
                const data = (await response.json()) as { pack?: PackEntry[] };
                setPack(data.pack ?? []);
            } catch {
                if (!signal.aborted) setPack("unread");
            }
        },
        [installedAppId, loader, query_]
    );

    /**
     * The search, over what a player can install rather than what a server can run.
     *
     * The other screen's search asks for the mods with a server side, which is
     * exactly the set this one is not about: a minimap has none, and is missing
     * from every result there. Here the filter is the client side instead.
     */
    const browse = useCallback(
        async (term: string, signal: AbortSignal) => {
            if (!loader) {
                setResults(null);
                return;
            }
            setSearching(true);
            try {
                const response = await fetch(
                    `/api/apps/installed/${installedAppId}/minecraft/modrinth?${query_({ query: term.trim(), side: "player" })}`,
                    { cache: "no-store", signal }
                );
                const data = (await response.json()) as { projects?: modrinth.ModrinthProject[] };
                setResults(response.ok ? (data.projects ?? []) : []);
            } catch {
                if (!signal.aborted) setResults([]);
            } finally {
                if (!signal.aborted) setSearching(false);
            }
        },
        [installedAppId, loader, query_]
    );

    useEffect(() => {
        const abort = new AbortController();
        void readList(list, abort.signal);
        return () => abort.abort();
    }, [list, readList]);

    useEffect(() => {
        const abort = new AbortController();
        void readPack(list, serverEntries, abort.signal);
        return () => abort.abort();
    }, [list, serverEntries, readPack]);

    useEffect(() => {
        const abort = new AbortController();
        const timer = setTimeout(() => void browse(query, abort.signal), SEARCH_DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            abort.abort();
        };
    }, [query, browse]);

    function save(): void {
        setError(null);
        startTransition(async () => {
            const result = await updateClientModsAction(installedAppId, list);
            if (result.error) setError(result.error);
        });
    }

    const fromServer = Array.isArray(pack) ? pack.filter((mod) => mod.where === "server") : [];

    if (!loader || modrinth.isPluginLoader(loader)) return null;

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <h3 className="text-sm font-medium">What the players install</h3>
                        <p className="text-xs text-muted-foreground">
                            Everything a player needs in their own game to join: the server&apos;s
                            mods, and the ones that only run in the game.
                        </p>
                    </div>
                    {changed && (
                        <Button size="sm" onClick={save} disabled={pending}>
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                            Save
                        </Button>
                    )}
                </div>

                {error && <p className="text-sm text-danger">{error}</p>}

                <div className="flex flex-col gap-2">
                    <div>
                        <h4 className="text-xs font-medium">From the server</h4>
                        <p className="text-xs text-muted-foreground">
                            These run on both sides. Change them in the server&apos;s list above.
                        </p>
                    </div>
                    {pack === null ? (
                        <Skeleton className="h-12 w-full" />
                    ) : pack === "unread" ? (
                        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                            Modrinth could not be reached, so this list is not shown. The command
                            below still installs all of it.
                        </p>
                    ) : fromServer.length === 0 ? (
                        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                            None of the server&apos;s mods run in the game.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {fromServer.map((project) => (
                                <li
                                    key={project.key}
                                    className="flex items-center gap-3 rounded-md border border-border p-2"
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
                                        <p className="truncate text-xs text-muted-foreground">
                                            {project.neededBy.length > 0
                                                ? `Needed by ${project.neededBy.join(", ")}`
                                                : project.description}
                                        </p>
                                    </div>
                                    <a
                                        href={`https://modrinth.com/project/${encodeURIComponent(project.key)}`}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        className="text-muted-foreground hover:text-foreground"
                                        title={`Open ${project.title} on Modrinth`}
                                    >
                                        <ExternalLink className="size-3.5" />
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div>
                    <h4 className="text-xs font-medium">Only in the game</h4>
                    <p className="text-xs text-muted-foreground">
                        A minimap, a world map, a HUD. The server never loads these, so nothing here
                        restarts it.
                    </p>
                </div>

                {rows === null ? (
                    <Skeleton className="h-12 w-full" />
                ) : rows.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                        Nothing yet. What you add here is handed to the players along with the
                        server&apos;s own mods.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {rows.map((project) => (
                            <li
                                key={project.entry}
                                className="flex items-center gap-3 rounded-md border border-border p-2"
                            >
                                <ProjectIcon installedAppId={installedAppId} project={project} />
                                <div className="min-w-0 flex-1">
                                    <p
                                        className="truncate text-sm font-medium"
                                        title={project.title}
                                    >
                                        {project.title}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {project.description}
                                    </p>
                                </div>
                                {project.fitsVersion === false && version && (
                                    <Badge variant="warning">No build for {version}</Badge>
                                )}
                                <a
                                    href={`https://modrinth.com/project/${project.slug}`}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="text-muted-foreground hover:text-foreground"
                                    title={`Open ${project.title} on Modrinth`}
                                >
                                    <ExternalLink className="size-3.5" />
                                </a>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={`Remove ${project.title}`}
                                    onClick={() =>
                                        setList((current) =>
                                            current.filter((item) => item !== project.entry)
                                        )
                                    }
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}

                <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="pl-9"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search mods the players install"
                        aria-label="Search Modrinth for a client mod"
                    />
                    {searching && (
                        <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                    )}
                </div>

                {results !== null && results.length > 0 && (
                    <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                        {results.slice(0, 10).map((project) => {
                            const added = list.some(
                                (entry) => modrinth.projectSlug(entry) === project.slug
                            );
                            return (
                                <li
                                    key={project.slug}
                                    className="flex items-start gap-3 rounded-md border border-border p-3"
                                >
                                    <ProjectIcon
                                        installedAppId={installedAppId}
                                        project={project}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">
                                            {project.title}
                                        </p>
                                        <p className="line-clamp-2 text-xs text-muted-foreground">
                                            {project.description}
                                        </p>
                                        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                                            <Download className="size-3" />
                                            {project.downloads.toLocaleString()}
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={added ? "ghost" : "secondary"}
                                        disabled={added}
                                        onClick={() =>
                                            setList((current) => [...current, project.slug])
                                        }
                                    >
                                        <Plus className="size-4" />
                                        {added ? "Added" : "Add"}
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {packCommands && (
                    <div className="flex flex-col gap-2 border-t border-border pt-4">
                        <div>
                            <h3 className="text-sm font-medium">Send this to the players</h3>
                            <p className="text-xs text-muted-foreground">
                                One line installs{" "}
                                {Array.isArray(pack) ? `the ${pack.length} mods` : "the mods"} for
                                this server into their game, and running it again is how they
                                update: it replaces what changed and takes away what came off the
                                lists. Anything else in their mods folder is left alone. The link
                                needs no account here.
                            </p>
                            {changed && (
                                <p className="mt-1 text-xs text-warning">
                                    What you just changed is not in it yet. Save first.
                                </p>
                            )}
                        </div>
                        {SYSTEMS.map((system) => (
                            <div key={system.key} className="flex items-center gap-2">
                                <span className="w-16 shrink-0 text-xs text-muted-foreground">
                                    {system.label}
                                </span>
                                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs">
                                    {packCommands[system.key]}
                                </code>
                                <CopyButton
                                    value={packCommands[system.key]}
                                    label={`the ${system.label} command`}
                                />
                            </div>
                        ))}
                        <p className="text-xs text-muted-foreground">
                            A launcher that keeps its instances elsewhere - Prism, MultiMC,
                            CurseForge - is told where to install by setting POLARIS_MC_DIR to that
                            instance&apos;s mods folder before running the line.
                        </p>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
