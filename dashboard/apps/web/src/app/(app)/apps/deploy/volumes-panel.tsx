"use client";

/**
 * Volume manager for a service: attach a persistent path so data (e.g. a `secrets`
 * folder of files) survives redeploys. The add form is the shared VolumeForm; this
 * panel owns the list and the delete action. Changes are applied to the running
 * service automatically (on the next recreate).
 */

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { HardDrive, Plus, Server, Settings2, Trash2 } from "lucide-react";
import { Button } from "@polaris/ui";
import { deleteVolumeAction, listVolumesAction } from "./actions";
import { VolumeForm, type EditVolume } from "./volume-form";
import { useProjectCan } from "./access-context";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ProjectApp } from "./deploy-view";

type Volume = Awaited<ReturnType<typeof listVolumesAction>>[number];

/** Where a volume opens in Drive: a nas volume at its NAS connection + folder; any
 *  other kind at the container's filesystem under the mount path. */
function volumeDriveHref(appId: string, volume: Volume): string {
    if (volume.kind === "nas" && volume.connectionId) {
        return `/drive?c=${volume.connectionId}&p=${encodeURIComponent(volume.source)}`;
    }
    return `/drive?c=container:${appId}&p=${encodeURIComponent(volume.mountPath.replace(/^\/+|\/+$/g, ""))}`;
}

export function VolumesTab({ app }: { app: ProjectApp }) {
    const t = useTranslations("deployData");
    const can = useProjectCan();
    const [items, setItems] = useState<Volume[] | null>(null);
    const [showAdd, setShowAdd] = useState(false);
    const [editVolume, setEditVolume] = useState<EditVolume | null>(null);
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
                    {t("volumes.count", { count: items ? items.length : 0 })}
                </span>
                {can("volumes.manage") && (
                    <Button
                        size="sm"
                        onClick={() => {
                            setEditVolume(null);
                            setShowAdd((open) => !open);
                        }}
                    >
                        <Plus className="size-4" /> {t("volumes.new")}
                    </Button>
                )}
            </div>

            {showAdd && (
                <div className="rounded-md border border-border p-3">
                    <VolumeForm
                        applicationId={app.id}
                        onSaved={() => {
                            setShowAdd(false);
                            reload();
                        }}
                        onCancel={() => setShowAdd(false)}
                    />
                </div>
            )}

            {editVolume && (
                <div className="rounded-md border border-border p-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                        {t("volumes.editing", { name: editVolume.name })}
                    </p>
                    <VolumeForm
                        applicationId={app.id}
                        volume={editVolume}
                        onSaved={() => {
                            setEditVolume(null);
                            reload();
                        }}
                        onCancel={() => setEditVolume(null)}
                    />
                </div>
            )}

            {error && <p className="text-xs text-danger">{error}</p>}

            <div className="overflow-hidden rounded-md border border-border">
                {items && items.length === 0 && (
                    <p className="p-3 text-xs text-muted-foreground">{t("volumes.empty")}</p>
                )}
                {items?.map((volume) => (
                    <div
                        key={volume.id}
                        className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-0"
                    >
                        <div className="flex min-w-0 items-center gap-2">
                            {volume.kind === "nas" ? (
                                <HardDrive className="size-4 shrink-0 text-sky-400" />
                            ) : (
                                <Server className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{volume.name}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {volume.kind === "nas" && volume.connectionName
                                        ? `${volume.connectionName}: `
                                        : ""}
                                    {volume.source} {"->"} {volume.mountPath}
                                    {volume.sizeLimit ? ` · ${volume.sizeLimit}` : ""}
                                </p>
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            {can("volumes.manage") && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        setShowAdd(false);
                                        setEditVolume(volume);
                                    }}
                                    title={t("volumes.options")}
                                    aria-label={t("volumes.optionsNamed", { name: volume.name })}
                                >
                                    <Settings2 className="size-4" />
                                </Button>
                            )}
                            <Button asChild variant="ghost" size="sm" title={t("volumes.viewInDrive")}>
                                <Link href={volumeDriveHref(app.id, volume)}>
                                    <HardDrive className="size-4" />
                                </Link>
                            </Button>
                            {can("volumes.manage") && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => remove(volume)}
                                    disabled={pending}
                                    title={t("volumes.remove")}
                                    aria-label={t("volumes.removeNamed", { name: volume.name })}
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
