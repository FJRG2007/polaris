"use client";

/**
 * Volume manager for a service: attach a persistent path so data (e.g. a `secrets`
 * folder of files) survives redeploys. The add form is the shared VolumeForm; this
 * panel owns the list and the delete action. Changes are applied to the running
 * service automatically (on the next recreate).
 */

import { useEffect, useState, useTransition } from "react";
import { HardDrive, Plus, Server, Trash2 } from "lucide-react";
import { Button } from "@polaris/ui";
import { deleteVolumeAction, listVolumesAction } from "./actions";
import { VolumeForm } from "./volume-form";
import type { ProjectApp } from "./deploy-view";

type Volume = Awaited<ReturnType<typeof listVolumesAction>>[number];

export function VolumesTab({ app }: { app: ProjectApp }) {
    const [items, setItems] = useState<Volume[] | null>(null);
    const [showAdd, setShowAdd] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function reload() {
        setItems(null);
        void listVolumesAction(app.id).then(setItems);
    }
    useEffect(reload, [app.id]);

    function remove(volume: Volume) {
        startTransition(async () => {
            const result = await deleteVolumeAction({ id: volume.id, applicationId: app.id });
            if (result.error) setError(result.error);
            else reload();
        });
    }

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
                <div className="rounded-md border border-border/60 p-3">
                    <VolumeForm applicationId={app.id} onCreated={() => { setShowAdd(false); reload(); }} onCancel={() => setShowAdd(false)} />
                </div>
            )}

            {error && <p className="text-xs text-red-400">{error}</p>}

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
