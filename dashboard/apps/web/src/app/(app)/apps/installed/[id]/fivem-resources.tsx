"use client";

/**
 * A FiveM server's resources: what it has, what is running, and what may be done
 * to one.
 *
 * A resource is what a mod is on this game, and it is the whole of what makes one
 * server different from another - a stock FiveM server is an empty map. So this is
 * the screen an operator lives on, and the two questions it answers are different
 * questions: what is on disk, and what the server has actually started. A resource
 * that is installed and stopped is the ordinary state a minute after somebody adds
 * one, and a screen that only listed the running ones would show nothing they had
 * just done.
 *
 * Adding one has two doors on purpose. A link is the ordinary case - resources are
 * published as release archives - and it is fetched inside the container so a
 * few hundred megabytes of assets never travel through the dashboard. A folder
 * somebody already has goes in through Drive, which browses the same volume; there
 * is no third way, and no screen here asks anybody to open a terminal.
 */

import Link from "next/link";
import * as actions from "./fivem-actions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PlayersTable, PlayerIconAction } from "@/components/game-players-table";
import { isResourceUrl, RESOURCE_URL_HINT, type FivemResource } from "@/lib/apps/fivem/resources";
import { AlertTriangle, FolderOpen, Play, Plus, RefreshCw, RotateCw, Square } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Skeleton,
    cn
} from "@polaris/ui";

const COLUMNS = [
    { label: "Resource" },
    { label: "Folder", className: "hidden md:table-cell" },
    { label: "State" }
];

export function FivemResources({
    installedAppId,
    applicationId,
    canManage,
    running
}: {
    installedAppId: string;
    /** The service behind it, for the link into Drive. Null before it deployed. */
    applicationId: string | null;
    canManage: boolean;
    /** Whether the server is up. Everything here is asked of the running server,
     *  so a stopped one can be neither listed nor changed. */
    running: boolean;
}) {
    const [resources, setResources] = useState<readonly FivemResource[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [adding, setAdding] = useState(false);

    const load = useCallback(
        async (rescan = false) => {
            // A folder dropped in through Drive is on disk and unknown to the
            // server until it is told to look again, so the refresh button does
            // both - listing what is there and would-be-startable is the whole
            // point of pressing it.
            if (rescan && canManage) await actions.refreshFivemResourcesAction(installedAppId);
            const result = await actions.listFivemResourcesAction(installedAppId);
            setResources(result.resources ?? null);
            setError(result.error ?? null);
            setLoading(false);
        },
        [installedAppId, canManage]
    );

    useEffect(() => {
        void load();
    }, [load]);

    const shown = useMemo(() => {
        const wanted = query.trim().toLowerCase();
        const all = resources ?? [];
        return wanted.length === 0
            ? all
            : all.filter((entry) => `${entry.name} ${entry.group ?? ""}`.toLowerCase().includes(wanted));
    }, [resources, query]);

    async function act(resource: FivemResource, action: "start" | "stop" | "restart"): Promise<void> {
        setBusy(resource.name);
        setError(null);
        const result = await actions.actOnFivemResourceAction(installedAppId, resource.name, action);
        setBusy(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        await load();
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">
                    What this server runs. A resource that has just been added has to be started before it does
                    anything.
                </p>
                <div className="ml-auto flex items-center gap-1">
                    {applicationId && (
                        <Link href={`/drive?c=container:${applicationId}&p=/config/resources`}>
                            <Button size="sm" variant="secondary">
                                <FolderOpen className="size-4" /> Open the folder
                            </Button>
                        </Link>
                    )}
                    {canManage && (
                        <Button size="sm" onClick={() => setAdding(true)} disabled={!running}>
                            <Plus className="size-4" /> Add from a link
                        </Button>
                    )}
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Read the list again"
                        title="Read the list again"
                        disabled={loading}
                        onClick={() => {
                            setLoading(true);
                            void load(true);
                        }}
                    >
                        <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
                    </Button>
                </div>
            </div>

            {error && (
                <Card>
                    <CardBody className="flex items-start gap-2 py-3 text-sm text-danger">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>{error}</span>
                    </CardBody>
                </Card>
            )}

            {loading ? (
                <div className="flex flex-col gap-2">
                    {Array.from({ length: 5 }, (_, index) => (
                        <Skeleton key={index} className="h-11 w-full" />
                    ))}
                </div>
            ) : (
                <PlayersTable
                    columns={COLUMNS}
                    minWidth="34rem"
                    search={query}
                    onSearch={setQuery}
                    searchPlaceholder="Search resources"
                    isEmpty={shown.length === 0}
                    empty={
                        !running
                            ? "The server is not running, so there is nothing to list."
                            : resources && resources.length > 0
                              ? `Nothing here matches “${query}”.`
                              : "No resources yet. Add one from a link, or drop a folder into the resources folder."
                    }
                    rows={shown.map((resource) => (
                        <tr key={resource.name} className="border-t border-border">
                            <td className="px-3 py-2">
                                <span className="flex min-w-0 items-center gap-2">
                                    <span className="truncate font-medium" title={resource.name}>{resource.name}</span>
                                    {resource.managed && (
                                        <Badge className="shrink-0 text-[11px]">Polaris</Badge>
                                    )}
                                </span>
                                {resource.managed && (
                                    <span className="text-xs text-muted-foreground">
                                        Keeps players off the server. Open it to everyone from the Security screen
                                        instead of stopping this.
                                    </span>
                                )}
                            </td>
                            <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">
                                {resource.group ?? "resources"}
                            </td>
                            <td className="px-3 py-2">
                                <span className={cn("text-xs", resource.running ? "text-success" : "text-muted-foreground")}>
                                    {resource.running ? "Running" : "Stopped"}
                                </span>
                            </td>
                            <td className="px-3 py-2">
                                <div className="flex items-center justify-end gap-0.5">
                                    {resource.running ? (
                                        <>
                                            <PlayerIconAction
                                                label={`Restart ${resource.name}`}
                                                icon={<RotateCw className="size-4" />}
                                                disabled={!canManage || busy !== null}
                                                onClick={() => void act(resource, "restart")}
                                            />
                                            <PlayerIconAction
                                                label={`Stop ${resource.name}`}
                                                icon={<Square className="size-4" />}
                                                disabled={!canManage || busy !== null || resource.managed}
                                                danger
                                                onClick={() => void act(resource, "stop")}
                                            />
                                        </>
                                    ) : (
                                        <PlayerIconAction
                                            label={`Start ${resource.name}`}
                                            icon={<Play className="size-4" />}
                                            disabled={!canManage || busy !== null}
                                            onClick={() => void act(resource, "start")}
                                        />
                                    )}
                                </div>
                            </td>
                        </tr>
                    ))}
                />
            )}

            <p className="text-xs text-muted-foreground">
                Starting a resource here lasts until the server restarts. To have one start every time, add an{" "}
                <code className="font-mono">ensure</code> line for it in the server config - Polaris does that for the
                resources it installs itself.
            </p>

            {adding && (
                <AddResourceDialog
                    installedAppId={installedAppId}
                    onClose={() => setAdding(false)}
                    onAdded={() => {
                        setAdding(false);
                        void load();
                    }}
                />
            )}
        </div>
    );
}

/** Fetch a resource from a link. The name is suggested from the link and can be
 *  changed: it is the folder the server will know it by. */
function AddResourceDialog({
    installedAppId,
    onClose,
    onAdded
}: {
    installedAppId: string;
    onClose: () => void;
    onAdded: () => void;
}) {
    const [url, setUrl] = useState("");
    const [name, setName] = useState("");
    /** Whether the name was typed. Once it has been, the link stops overwriting it. */
    const [named, setNamed] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const linkError = url.trim().length === 0 || isResourceUrl(url) ? null : RESOURCE_URL_HINT;

    useEffect(() => {
        if (named || !isResourceUrl(url)) return;
        let live = true;
        void actions.suggestFivemResourceNameAction(url).then((result) => {
            if (live && result.name) setName(result.name);
        });
        return () => {
            live = false;
        };
    }, [url, named]);

    async function install(): Promise<void> {
        setPending(true);
        setError(null);
        const result = await actions.installFivemResourceAction(installedAppId, url.trim(), name.trim());
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onAdded();
    }

    return (
        <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add a resource</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Link</span>
                        <Input
                            value={url}
                            onChange={(event) => setUrl(event.target.value)}
                            placeholder="https://github.com/.../releases/download/v1.0/resource.zip"
                            autoComplete="off"
                            spellCheck={false}
                        />
                        <span className={cn("text-xs", linkError ? "text-danger" : "text-muted-foreground")}>
                            {linkError ?? RESOURCE_URL_HINT}
                        </span>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Folder name</span>
                        <Input
                            value={name}
                            onChange={(event) => {
                                setNamed(true);
                                setName(event.target.value);
                            }}
                            placeholder="es_extended"
                            className="font-mono"
                            autoComplete="off"
                            spellCheck={false}
                        />
                        <span className="text-xs text-muted-foreground">
                            What the server will know it by. A folder of this name is replaced outright if there is
                            one.
                        </span>
                    </label>
                    {error && <p className="text-sm text-danger">{error}</p>}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={pending}>
                        Cancel
                    </Button>
                    <Button
                        onClick={() => void install()}
                        disabled={pending || !isResourceUrl(url) || name.trim().length === 0}
                    >
                        {pending ? "Fetching..." : "Add"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
