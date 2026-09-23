"use client";

/**
 * Plugins from SpigotMC.
 *
 * A second shelf rather than a second source inside the first one, because the
 * two catalogues do not behave alike and pretending otherwise is what would
 * mislead. Modrinth publishes which loader and which release each build targets,
 * so the browser beside this one can say "this will not load here" before
 * anything is installed. SpigotMC publishes a page and a list of versions its
 * author says they tested, which is a claim - so nothing here refuses anything on
 * that basis, and the versions are shown as what they are.
 *
 * Only for a server that runs plugins at all. On a modded server every one of
 * these is a jar the server cannot read.
 */

import { useEffect, useState, useTransition } from "react";
import { Download, ExternalLink, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Skeleton } from "@polaris/ui";
import {
    readSpigotPluginsAction,
    saveSpigotPluginsAction,
    searchSpigotAction
} from "./minecraft-actions";
import { parseSpigetList, type SpigotPlugin } from "../../lib/minecraft/spiget";

export function SpigotPluginsCard({
    installedAppId,
    /** `SPIGET_RESOURCES` as the server holds it. */
    value,
    onSaved
}: {
    installedAppId: string;
    value: string;
    onSaved: () => void;
}) {
    const saved = parseSpigetList(value);
    const [ids, setIds] = useState<number[]>(saved);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<SpigotPlugin[] | null>(null);
    const [onList, setOnList] = useState<SpigotPlugin[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const changed = ids.join(",") !== saved.join(",");

    // What the search shows before anything is typed: the popular free ones,
    // which is a better empty state than a box and an instruction.
    useEffect(() => {
        let active = true;
        const timer = setTimeout(() => {
            void searchSpigotAction(installedAppId, query).then((answer) => {
                if (active) setResults(answer.plugins ?? []);
            });
        }, 250);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [installedAppId, query]);

    // The list as plugins rather than as numbers. A row of five-digit ids is not
    // something anybody can check.
    useEffect(() => {
        let active = true;
        if (saved.length === 0) {
            setOnList([]);
            return;
        }
        void readSpigotPluginsAction(installedAppId, saved).then((answer) => {
            if (active) setOnList(answer.plugins ?? []);
        });
        return () => {
            active = false;
        };
        // Keyed on what is stored rather than on what is being edited: adding one
        // should not re-read the whole list.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [installedAppId, value]);

    function save(): void {
        setError(null);
        startTransition(async () => {
            const result = await saveSpigotPluginsAction({ installedAppId, ids });
            if (result.error) {
                setError(result.error);
                return;
            }
            onSaved();
        });
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Download className="size-4 text-primary" />
                    SpigotMC plugins
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                    Most plugins are published here rather than on Modrinth. They are installed on the next
                    restart, by number, and SpigotMC says which releases each one was tested on - which is its
                    author saying so, not a build this can check.
                </p>

                <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search SpigotMC"
                        className="pl-8"
                    />
                </div>

                <div className="flex flex-col gap-2">
                    {results === null ? (
                        <>
                            <Skeleton className="h-14 w-full" />
                            <Skeleton className="h-14 w-full" />
                        </>
                    ) : results.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            Nothing came back. SpigotMC may be unreachable from here rather than empty.
                        </p>
                    ) : (
                        results.map((plugin) => (
                            <PluginRow
                                key={plugin.id}
                                plugin={plugin}
                                installed={ids.includes(plugin.id)}
                                onAdd={() => setIds((current) => [...current, plugin.id])}
                                onRemove={() => setIds((current) => current.filter((id) => id !== plugin.id))}
                            />
                        ))
                    )}
                </div>

                {onList !== null && onList.length > 0 && (
                    <div className="flex flex-col gap-2 border-t border-border pt-3">
                        <p className="text-sm font-medium">On this server</p>
                        {onList.map((plugin) => (
                            <PluginRow
                                key={plugin.id}
                                plugin={plugin}
                                installed={ids.includes(plugin.id)}
                                onAdd={() => setIds((current) => [...current, plugin.id])}
                                onRemove={() => setIds((current) => current.filter((id) => id !== plugin.id))}
                            />
                        ))}
                    </div>
                )}

                {error && <p className="text-xs text-danger">{error}</p>}

                <div className="flex items-center gap-2">
                    <Button size="sm" onClick={save} disabled={!changed || pending}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                        Save
                    </Button>
                    {changed && (
                        <span className="text-xs text-muted-foreground">
                            Installed when the server next restarts.
                        </span>
                    )}
                </div>
            </CardBody>
        </Card>
    );
}

function PluginRow({
    plugin,
    installed,
    onAdd,
    onRemove
}: {
    plugin: SpigotPlugin;
    installed: boolean;
    onAdd: () => void;
    onRemove: () => void;
}) {
    const newest = plugin.testedVersions.at(-1);
    return (
        <div className="flex items-start gap-3 rounded-md border border-border p-2">
            {plugin.iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={plugin.iconUrl} alt="" className="size-8 shrink-0 rounded" />
            ) : (
                <div className="size-8 shrink-0 rounded bg-surface-raised" />
            )}
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <a
                        href={plugin.pageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium hover:underline"
                    >
                        {plugin.name}
                        <ExternalLink className="ml-1 inline size-3 shrink-0" />
                    </a>
                    {newest && <Badge variant="neutral">tested to {newest}</Badge>}
                    {plugin.blocked && <Badge variant="warning">{plugin.blocked}</Badge>}
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">{plugin.summary}</p>
            </div>
            {plugin.blocked ? null : installed ? (
                <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${plugin.name}`}>
                    <Trash2 className="size-4" />
                </Button>
            ) : (
                <Button size="sm" variant="secondary" onClick={onAdd} aria-label={`Add ${plugin.name}`}>
                    <Plus className="size-4" />
                </Button>
            )}
        </div>
    );
}
