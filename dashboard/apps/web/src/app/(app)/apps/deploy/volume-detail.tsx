"use client";

/**
 * A volume, opened.
 *
 * Clicking a volume used to drop an edit form into the page. It is a service in
 * its own right - it has usage, a size, a place it lives, and two ways to destroy
 * it - so it gets what every other service here gets: a panel with Metrics and
 * Settings, opened over what you were looking at rather than pushing it around.
 *
 * The two destructive actions are deliberately different. Wiping keeps the volume
 * and destroys what is in it; deleting keeps nothing. Both are typed-confirmation
 * gated, and deleting is refused outright while the volume is the only thing
 * standing between a service and a missing mount.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { VolumeDetail } from "@/lib/deploy-volume-service";
import { EditVolumeDialog, type EditVolume } from "./volume-form";
import { MetricsHistory, type MetricSpec } from "@/components/metrics-history";
import { stageVolumeDeleteAction, volumeDetailAction, wipeVolumeAction } from "./project-actions";
import { Database, Eraser, HardDrive, Loader2, Pencil, Server, Trash2, TriangleAlert } from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Switch,
    cn
} from "@polaris/ui";

const TABS = ["Metrics", "Settings"] as const;
type Tab = (typeof TABS)[number];

function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The usage chart. One series: how much is in the volume over time. The declared
 *  cap rides along as the reading beside it, so a number has something to be big
 *  relative to. */
const VOLUME_METRICS: MetricSpec[] = [
    {
        key: "disk",
        label: "Volume usage",
        value: (point) => point.diskUsedBytes,
        describe: (point) =>
            point.diskTotalBytes && point.diskUsedBytes
                ? `${Math.round((point.diskUsedBytes / point.diskTotalBytes) * 100)}% of ${formatBytes(point.diskTotalBytes)}`
                : null,
        format: formatBytes,
        tone: "primary"
    }
];

export function VolumeDetailDialog({
    volumeId,
    onOpenChange,
    onChanged
}: {
    /** Null closes the panel. Passing an id opens it and loads that volume. */
    volumeId: string | null;
    onOpenChange: (open: boolean) => void;
    onChanged: () => void;
}) {
    const router = useRouter();
    const [tab, setTab] = useState<Tab>("Metrics");
    const [data, setData] = useState<{ volume: VolumeDetail; usedBytes: number | null; canManage: boolean } | null>(
        null
    );
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);

    useEffect(() => {
        if (!volumeId) return;
        // Each open starts clean: a panel that briefly shows the last volume's
        // figures under this volume's name is worse than one that shows nothing.
        setData(null);
        setError(null);
        setTab("Metrics");
        let active = true;
        void volumeDetailAction(volumeId).then((result) => {
            if (!active) return;
            if (result.error || !result.volume) {
                setError(result.error ?? "Could not load the volume");
                return;
            }
            setData({
                volume: result.volume,
                usedBytes: result.usedBytes ?? null,
                canManage: result.canManage ?? false
            });
        });
        return () => {
            active = false;
        };
    }, [volumeId]);

    const volume = data?.volume ?? null;

    function reload() {
        onChanged();
        router.refresh();
        if (volumeId) {
            void volumeDetailAction(volumeId).then((result) => {
                if (result.volume) {
                    setData({
                        volume: result.volume,
                        usedBytes: result.usedBytes ?? null,
                        canManage: result.canManage ?? false
                    });
                }
            });
        }
    }

    return (
        <>
            <Dialog open={volumeId !== null} onOpenChange={onOpenChange}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <HardDrive className={cn("size-4", volume?.kind === "nas" && "text-sky-400")} />
                            {volume?.name ?? "Volume"}
                        </DialogTitle>
                        {volume && (
                            <DialogDescription>
                                {volume.applicationName
                                    ? `Mounted in ${volume.applicationName} at ${volume.mountPath}`
                                    : `Mounted at ${volume.mountPath}`}
                            </DialogDescription>
                        )}
                    </DialogHeader>

                    {error && <p className="text-sm text-danger">{error}</p>}

                    {!volume && !error && (
                        <div className="flex items-center justify-center py-12 text-muted-foreground">
                            <Loader2 className="size-5 animate-spin" />
                        </div>
                    )}

                    {volume && (
                        <div className="flex flex-col gap-4">
                            <div className="flex gap-1 border-b border-border/60">
                                {TABS.map((entry) => (
                                    <button
                                        key={entry}
                                        type="button"
                                        onClick={() => setTab(entry)}
                                        aria-current={tab === entry ? "page" : undefined}
                                        className={cn(
                                            "-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors",
                                            tab === entry
                                                ? "border-primary font-medium text-foreground"
                                                : "border-transparent text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        {entry}
                                    </button>
                                ))}
                            </div>

                            {tab === "Metrics" ? (
                                <MetricsTab volume={volume} usedBytes={data?.usedBytes ?? null} />
                            ) : (
                                <SettingsTab
                                    volume={volume}
                                    canManage={data?.canManage ?? false}
                                    onEdit={() => setEditing(true)}
                                    onChanged={reload}
                                    onClosed={() => onOpenChange(false)}
                                />
                            )}
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {volume?.applicationId && (
                <EditVolumeDialog
                    open={editing}
                    onOpenChange={setEditing}
                    applicationId={volume.applicationId}
                    volume={toEditVolume(volume)}
                    onSaved={() => {
                        setEditing(false);
                        reload();
                    }}
                />
            )}
        </>
    );
}

function toEditVolume(volume: VolumeDetail): EditVolume {
    return {
        id: volume.id,
        name: volume.name,
        mountPath: volume.mountPath,
        kind: volume.kind,
        source: volume.source,
        connectionId: volume.connectionId,
        sizeLimit: volume.sizeLimit
    };
}

function MetricsTab({ volume, usedBytes }: { volume: VolumeDetail; usedBytes: number | null }) {
    return (
        <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
                <Stat
                    label="In use"
                    value={usedBytes == null ? "Not measurable" : formatBytes(usedBytes)}
                    hint={
                        usedBytes == null
                            ? volume.serviceRunning
                                ? "The image has no du, so its size cannot be read."
                                : "The service is not running."
                            : volume.sizeLimit
                              ? `of ${volume.sizeLimit}`
                              : "No size cap set"
                    }
                />
                <Stat label="Kind" value={kindLabel(volume)} hint={volume.source} />
                <Stat label="Server" value={volume.serverName} hint={volume.serverKind === "local" ? "This host" : "Remote"} />
            </div>

            <div>
                <h3 className="mb-1 text-sm font-medium">History</h3>
                <MetricsHistory endpoint={`/api/deploy/volumes/${volume.id}/metrics/history`} metrics={VOLUME_METRICS} />
                <p className="mt-1 text-xs text-muted-foreground">
                    Usage is measured from inside the service that mounts the volume, so a stopped service leaves gaps.
                </p>
            </div>
        </div>
    );
}

function kindLabel(volume: VolumeDetail): string {
    if (volume.kind === "nas") return volume.connectionName ?? "NAS";
    return volume.kind === "bind" ? "Server folder" : "Named volume";
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
    return (
        <div className="rounded-lg border border-border/60 p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-0.5 truncate text-sm font-medium" title={value}>
                {value}
            </p>
            {hint && (
                <p className="truncate text-xs text-muted-foreground" title={hint}>
                    {hint}
                </p>
            )}
        </div>
    );
}

function SettingsTab({
    volume,
    canManage,
    onEdit,
    onChanged,
    onClosed
}: {
    volume: VolumeDetail;
    canManage: boolean;
    onEdit: () => void;
    onChanged: () => void;
    onClosed: () => void;
}) {
    const [wiping, setWiping] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [wipeOnDelete, setWipeOnDelete] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // A service that mounts a volume has a path it expects to exist. Removing the
    // last thing providing it is a decision about the service, not about the
    // volume, so it is refused here and pointed at the service instead.
    const blockedReason = !volume.applicationId
        ? "This volume is not attached to a service."
        : null;

    function wipe() {
        setError(null);
        startTransition(async () => {
            const result = await wipeVolumeAction(volume.id);
            if (result.error) {
                setError(result.error);
                return;
            }
            setWiping(false);
            onChanged();
        });
    }

    function remove() {
        setError(null);
        startTransition(async () => {
            const result = await stageVolumeDeleteAction({ volumeId: volume.id, wipe: wipeOnDelete });
            if (result.error) {
                setError(result.error);
                return;
            }
            setDeleting(false);
            onChanged();
            onClosed();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <Section title="Connection" hint="Where this volume appears inside the container.">
                <Row label="Mount path" value={volume.mountPath} icon={<HardDrive className="size-4" />} />
                <Row
                    label="Source"
                    value={volume.source}
                    icon={volume.kind === "nas" ? <Database className="size-4" /> : <Server className="size-4" />}
                />
            </Section>

            <Section title="Size" hint="The cap this volume is allowed to reach. You are only charged disk for what is actually stored.">
                <Row label="Size limit" value={volume.sizeLimit ?? "No limit"} icon={<HardDrive className="size-4" />} />
            </Section>

            <Section title="Region" hint="Volumes live on the same server as the service that mounts them.">
                <Row label="Server" value={volume.serverName} icon={<Server className="size-4" />} />
            </Section>

            {canManage && (
                <>
                    <div className="flex justify-end">
                        <Button variant="ghost" size="sm" onClick={onEdit}>
                            <Pencil className="size-4" /> Edit mount
                        </Button>
                    </div>

                    <div className="flex flex-col gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3">
                        <p className="flex items-center gap-1.5 text-sm font-medium text-danger">
                            <TriangleAlert className="size-4" /> Danger
                        </p>

                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="text-sm">Wipe volume</p>
                                <p className="text-xs text-muted-foreground">
                                    Destroys everything inside it and keeps the volume itself.
                                </p>
                            </div>
                            <Button
                                variant="danger"
                                size="sm"
                                disabled={!volume.serviceRunning}
                                title={volume.serviceRunning ? undefined : "The service has to be running to reach the data"}
                                onClick={() => setWiping(true)}
                            >
                                <Eraser className="size-4" /> Wipe
                            </Button>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-danger/20 pt-3">
                            <div className="min-w-0">
                                <p className="text-sm">Delete volume</p>
                                <p className="text-xs text-muted-foreground">
                                    Detaches the mount from the service. The next deploy starts without it.
                                </p>
                            </div>
                            <Button variant="danger" size="sm" onClick={() => setDeleting(true)}>
                                <Trash2 className="size-4" /> Delete
                            </Button>
                        </div>

                        {error && <p className="text-sm text-danger">{error}</p>}
                    </div>
                </>
            )}

            <ConfirmDeleteDialog
                open={wiping}
                onOpenChange={setWiping}
                name={volume.name}
                kind="volume contents"
                confirmLabel="Wipe volume"
                description="Everything in this volume is destroyed. The volume itself stays, so the service keeps its mount."
                error={error}
                pending={pending}
                onConfirm={wipe}
            />

            <ConfirmDeleteDialog
                open={deleting}
                onOpenChange={setDeleting}
                name={volume.name}
                kind="volume"
                confirmLabel="Stage removal"
                description="The mount is detached from the service. Whether the data goes with it is up to you."
                blockedReason={blockedReason}
                error={error}
                pending={pending}
                onConfirm={remove}
            >
                <label className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
                    <span className="min-w-0">
                        <span className="block text-sm">Also destroy the data</span>
                        <span className="block text-xs text-muted-foreground">
                            Off by default. Detaching a volume and destroying what is in it are two different
                            intentions, and only one of them can be taken back.
                        </span>
                    </span>
                    <Switch checked={wipeOnDelete} onChange={setWipeOnDelete} aria-label="Also destroy the data" />
                </label>
            </ConfirmDeleteDialog>
        </div>
    );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <div>
                <h3 className="text-sm font-medium">{title}</h3>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <div className="overflow-hidden rounded-md border border-border/60">{children}</div>
        </div>
    );
}

function Row({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-0">
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
                {icon}
                {label}
            </span>
            <span className="min-w-0 truncate font-mono text-xs" title={value}>
                {value}
            </span>
        </div>
    );
}
