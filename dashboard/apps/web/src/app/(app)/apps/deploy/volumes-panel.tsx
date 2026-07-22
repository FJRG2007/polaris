"use client";

/**
 * Volume manager for a service: attach a persistent path so data (e.g. a `secrets`
 * folder of files) survives redeploys. Three kinds, all confined - never an
 * arbitrary host path:
 *   - Docker volume: a named, docker-managed volume.
 *   - Server folder (bind): a folder on the service's own server.
 *   - NAS folder (nas): a folder on a host-mounted storage connection, so it lives
 *     on the NAS and can also be managed as an ordinary Drive folder.
 * Changes are applied to the running service automatically (on the next recreate).
 */

import { useEffect, useState, useTransition } from "react";
import { HardDrive, Plus, Server, Trash2 } from "lucide-react";
import { Button, Input } from "@polaris/ui";
import { createVolumeAction, deleteVolumeAction, listNasConnectionsAction, listVolumesAction } from "./actions";
import type { ProjectApp } from "./deploy-view";

type Kind = "volume" | "bind" | "nas";
type Volume = Awaited<ReturnType<typeof listVolumesAction>>[number];
type NasConnection = Awaited<ReturnType<typeof listNasConnectionsAction>>[number];

const KIND_LABELS: Record<Kind, string> = {
    volume: "Docker volume",
    bind: "Server folder",
    nas: "NAS folder"
};

const KIND_HELP: Record<Kind, string> = {
    volume: "A named volume managed by Docker. Good for opaque data like a database's files.",
    bind: "A folder on this service's server. Persists across redeploys and is browsable in the Files tab.",
    nas: "A folder on a host-mounted storage connection - it lives on the NAS and can be managed as a Drive folder."
};

export function VolumesTab({ app }: { app: ProjectApp }) {
    const [items, setItems] = useState<Volume[] | null>(null);
    const [connections, setConnections] = useState<NasConnection[]>([]);
    const [showAdd, setShowAdd] = useState(false);
    const [kind, setKind] = useState<Kind>("bind");
    const [name, setName] = useState("");
    const [mountPath, setMountPath] = useState("");
    const [source, setSource] = useState("");
    const [connectionId, setConnectionId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function reload() {
        setItems(null);
        void listVolumesAction(app.id).then(setItems);
    }
    useEffect(reload, [app.id]);
    useEffect(() => {
        void listNasConnectionsAction().then(setConnections);
    }, []);

    function reset() {
        setName("");
        setMountPath("");
        setSource("");
        setConnectionId("");
        setError(null);
    }

    function add() {
        setError(null);
        // Named volumes derive their source from the name; bind/nas use the subpath.
        const resolvedSource = kind === "volume" ? name.trim() : source.trim();
        startTransition(async () => {
            const result = await createVolumeAction({
                applicationId: app.id,
                name: name.trim(),
                mountPath: mountPath.trim(),
                kind,
                source: resolvedSource,
                connectionId: kind === "nas" ? connectionId : undefined
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            reset();
            setShowAdd(false);
            reload();
        });
    }

    function remove(volume: Volume) {
        startTransition(async () => {
            const result = await deleteVolumeAction({ id: volume.id, applicationId: app.id });
            if (result.error) setError(result.error);
            else reload();
        });
    }

    const canAdd = name.trim() && mountPath.trim() && (kind === "volume" || source.trim()) && (kind !== "nas" || connectionId);

    return (
        <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                    {items ? items.length : 0} volume{items && items.length === 1 ? "" : "s"}
                </span>
                <Button size="sm" onClick={() => setShowAdd((open) => !open)}>
                    <Plus className="size-4" /> New Volume
                </Button>
            </div>

            {showAdd && (
                <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
                    <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1 text-sm">
                        {(Object.keys(KIND_LABELS) as Kind[]).map((value) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setKind(value)}
                                className={`rounded px-3 py-1.5 font-medium transition-colors ${
                                    kind === value ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                                }`}
                            >
                                {KIND_LABELS[value]}
                            </button>
                        ))}
                    </div>
                    <p className="text-xs text-muted-foreground">{KIND_HELP[kind]}</p>

                    <div className="grid gap-2 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                            Name
                            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="secrets" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                            Mount path (in container)
                            <Input value={mountPath} onChange={(event) => setMountPath(event.target.value)} placeholder="/app/secrets" />
                        </label>
                    </div>

                    {kind === "nas" && (
                        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                            Storage connection
                            <select
                                value={connectionId}
                                onChange={(event) => setConnectionId(event.target.value)}
                                className="rounded-md border border-input bg-surface px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <option value="">Select a NAS connection...</option>
                                {connections.map((connection) => (
                                    <option key={connection.id} value={connection.id} disabled={!connection.active}>
                                        {connection.name}
                                        {connection.active ? "" : " (not connected)"}
                                    </option>
                                ))}
                            </select>
                            {connections.length === 0 && (
                                <span className="text-[11px] text-muted-foreground">
                                    No host-mounted storage connections yet. Add a NAS/UNAS connection in Drive first.
                                </span>
                            )}
                        </label>
                    )}

                    {kind !== "volume" && (
                        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                            {kind === "nas" ? "Folder on the NAS" : "Folder on the server"}
                            <Input value={source} onChange={(event) => setSource(event.target.value)} placeholder="api.tpeoficial.com/secrets" />
                            <span className="text-[11px] text-muted-foreground">
                                A subpath (no leading slash, no `..`). Created if it does not exist.
                            </span>
                        </label>
                    )}

                    {error && <p className="text-xs text-red-400">{error}</p>}
                    <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => { reset(); setShowAdd(false); }} disabled={pending}>
                            Cancel
                        </Button>
                        <Button size="sm" onClick={add} disabled={pending || !canAdd}>
                            Add volume
                        </Button>
                    </div>
                </div>
            )}

            {error && !showAdd && <p className="text-xs text-red-400">{error}</p>}

            <div className="overflow-hidden rounded-md border border-border/60">
                {items && items.length === 0 && <p className="p-3 text-xs text-muted-foreground">No volumes attached.</p>}
                {items?.map((volume) => (
                    <div key={volume.id} className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-0">
                        <div className="flex min-w-0 items-center gap-2">
                            {volume.kind === "nas" ? (
                                <HardDrive className="size-4 shrink-0 text-sky-400" />
                            ) : (
                                <Server className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{volume.name}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {volume.kind === "nas" && volume.connectionName ? `${volume.connectionName}: ` : ""}
                                    {volume.source} {"->"} {volume.mountPath}
                                </p>
                            </div>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => remove(volume)} disabled={pending} title="Remove">
                            <Trash2 className="size-4" />
                        </Button>
                    </div>
                ))}
            </div>
        </div>
    );
}
