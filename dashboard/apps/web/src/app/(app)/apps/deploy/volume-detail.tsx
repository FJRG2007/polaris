"use client";

/**
 * A volume, opened.
 *
 * It is a service in its own right - it has usage, a size, files, a place it
 * lives, and two ways to destroy it - so it opens the way every other service here
 * does: the same right-hand panel, the same header and tab strip, over what you
 * were looking at rather than pushing it around. Its settings are edited in that
 * panel too, in place, rather than in a dialog stacked on top of it.
 *
 * The panel paints as soon as the row is read. How full the volume is arrives
 * separately, because measuring it means reaching into a container on the server
 * that holds it and walking the tree - seconds on a NAS, and sometimes never.
 * Waiting for that before drawing anything left the panel blank for the whole
 * measurement.
 *
 * The two destructive actions are deliberately different. Wiping keeps the volume
 * and destroys what is in it; deleting keeps nothing. Both are typed-confirmation
 * gated, and deleting is refused outright while the volume is the only thing
 * standing between a service and a missing mount.
 */

import { FilesPanel } from "./files-panel";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { VolumeForm, type EditVolume } from "./volume-form";
import type { VolumeDetail } from "@/lib/deploy-volume-service";
import { MetricsHistory, type MetricSpec } from "@/components/metrics-history";
import { dropSnapshots, readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { stageVolumeDeleteAction, volumeDetailAction, volumeUsageAction, wipeVolumeAction } from "./project-actions";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogTitle,
    Switch,
    cn
} from "@polaris/ui";
import {
    Database,
    Eraser,
    HardDrive,
    Loader2,
    Maximize2,
    Minimize2,
    Server,
    Trash2,
    TriangleAlert
} from "lucide-react";

const TABS = ["Metrics", "Files", "Settings"] as const;
export type VolumeTab = (typeof TABS)[number];
type Tab = VolumeTab;

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

/** A measurement in flight or done. `bytes` is the figure to put on screen - the
 *  last one taken while a fresh measurement is in flight - and null means there is
 *  none yet or it could not be measured. */
type Usage = { state: "measuring" | "done"; bytes: number | null };

/** Under this, the last measurement stands and the tree is not walked again:
 *  reopening a volume should not cost a `du` on somebody's disk. */
const USAGE_TTL_MS = 60_000;

/** Past this, the last measurement is not even worth painting while a fresh one
 *  runs - a figure from a minute ago says something about the volume, one from
 *  this morning says something about a volume that has since been written to. */
const USAGE_PAINT_MAX_AGE_MS = 3_600_000;

/** Kept in the tab rather than in a module Map, so a reload paints the size too. */
function usageKey(volumeId: string): string {
    return `deploy.volume-usage.${volumeId}`;
}

export function VolumeDetailDialog({
    volumeId,
    tab: openOn = "Metrics",
    onOpenChange,
    onChanged
}: {
    /** Null closes the panel. Passing an id opens it and loads that volume. */
    volumeId: string | null;
    /** The tab this open lands on, so "Edit mount" arrives at the mount itself. */
    tab?: VolumeTab;
    onOpenChange: (open: boolean) => void;
    onChanged: () => void;
}) {
    const router = useRouter();
    const [tab, setTab] = useState<Tab>(openOn);
    const [full, setFull] = useState(false);
    const [data, setData] = useState<{ volume: VolumeDetail; canManage: boolean } | null>(null);
    const [usage, setUsage] = useState<Usage>({ state: "measuring", bytes: null });
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!volumeId) return;
        // Each open starts clean: a panel that briefly shows the last volume's
        // figures under this volume's name is worse than one that shows nothing.
        setData(null);
        setError(null);
        setTab(openOn);
        let active = true;

        void volumeDetailAction(volumeId).then((result) => {
            if (!active) return;
            if (result.error || !result.volume) {
                setError(result.error ?? "Could not load the volume");
                return;
            }
            setData({ volume: result.volume, canManage: result.canManage ?? false });
        });

        // Measured alongside, not after: the panel is already on screen and
        // usable while this is still walking the volume - and it shows the last
        // size it knows while that happens, rather than the word "Measuring".
        const kept = readSnapshot<number | null>(usageKey(volumeId), USAGE_PAINT_MAX_AGE_MS);
        if (kept && Date.now() - kept.at < USAGE_TTL_MS) {
            setUsage({ state: "done", bytes: kept.value });
        } else {
            setUsage({ state: "measuring", bytes: kept?.value ?? null });
            void volumeUsageAction(volumeId).then((result) => {
                const bytes = result.usedBytes ?? null;
                writeSnapshot(usageKey(volumeId), bytes);
                if (active) setUsage({ state: "done", bytes });
            });
        }

        return () => {
            active = false;
        };
    }, [openOn, volumeId]);

    const volume = data?.volume ?? null;

    function reload() {
        onChanged();
        router.refresh();
        if (!volumeId) return;
        // What the volume holds has changed under it, so the kept figure is the
        // one thing that must not be reused - not even to paint while the fresh
        // measurement runs.
        dropSnapshots(usageKey(volumeId));
        setUsage({ state: "measuring", bytes: null });
        void volumeDetailAction(volumeId).then((result) => {
            if (result.volume) setData({ volume: result.volume, canManage: result.canManage ?? false });
        });
        void volumeUsageAction(volumeId).then((result) => {
            const bytes = result.usedBytes ?? null;
            writeSnapshot(usageKey(volumeId), bytes);
            setUsage({ state: "done", bytes });
        });
    }

    return (
        <Dialog open={volumeId !== null} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    "left-auto right-0 top-0 flex h-full max-h-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none rounded-l-xl border-y-0 border-r-0 p-0 data-[state=open]:slide-in-from-right-4",
                    full ? "w-full max-w-none" : "w-full max-w-none sm:w-[820px] sm:max-w-[calc(100vw-2rem)]"
                )}
            >
                <div className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
                    <HardDrive className={cn("size-5 shrink-0", volume?.kind === "nas" && "text-sky-400")} />
                    <div className="min-w-0 flex-1">
                        <DialogTitle className="truncate text-base font-semibold">
                            {volume?.name ?? "Volume"}
                        </DialogTitle>
                        {volume && (
                            <p className="truncate text-xs text-muted-foreground">
                                {volume.applicationName
                                    ? `Mounted in ${volume.applicationName} at ${volume.mountPath}`
                                    : `Mounted at ${volume.mountPath}`}
                            </p>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => setFull((value) => !value)}
                        title={full ? "Exit full screen" : "Full screen"}
                        aria-label={full ? "Exit full screen" : "Full screen"}
                        className="mr-8 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                    </button>
                </div>

                <div className="flex items-center gap-1 border-b border-border/60 px-5 text-sm">
                    {TABS.map((entry) => (
                        <button
                            key={entry}
                            type="button"
                            onClick={() => setTab(entry)}
                            aria-current={tab === entry ? "page" : undefined}
                            className={cn(
                                "-mb-px whitespace-nowrap border-b-2 px-3 py-2 transition-colors",
                                tab === entry
                                    ? "border-primary text-foreground"
                                    : "border-transparent text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {entry}
                        </button>
                    ))}
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4">
                    {error && <p className="text-sm text-danger">{error}</p>}

                    {!volume && !error && (
                        <div className="flex items-center justify-center py-12 text-muted-foreground">
                            <Loader2 className="size-5 animate-spin" />
                        </div>
                    )}

                    {volume && tab === "Metrics" && <MetricsTab volume={volume} usage={usage} />}
                    {volume && tab === "Files" && <FilesTab volume={volume} />}
                    {volume && tab === "Settings" && (
                        <SettingsTab
                            volume={volume}
                            canManage={data?.canManage ?? false}
                            onChanged={reload}
                            onClosed={() => onOpenChange(false)}
                        />
                    )}
                </div>
            </DialogContent>
        </Dialog>
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

/**
 * What is actually in the volume. All three kinds - a named volume, a server
 * folder and a NAS folder - appear at the mount path inside the service that
 * mounts it, which is the one place the same browser can reach any of them. The
 * browser is rooted there, so it opens on the volume's own contents and cannot
 * wander out into the rest of the container.
 */
function FilesTab({ volume }: { volume: VolumeDetail }) {
    if (!volume.applicationId) {
        return (
            <Notice
                title="Nothing to browse through"
                body="This volume is not attached to a service, and its data is only reachable from inside the container that mounts it."
            />
        );
    }
    if (!volume.serviceRunning) {
        return (
            <Notice
                title="The service is not running"
                body={`Files are read from inside ${volume.applicationName ?? "the service"}. Deploy it to browse ${volume.mountPath}.`}
            />
        );
    }
    return (
        <div className="flex flex-col gap-2">
            <FilesPanel applicationId={volume.applicationId} root={volume.mountPath} />
            <p className="text-xs text-muted-foreground">
                {volume.applicationName
                    ? `Read from inside ${volume.applicationName} at ${volume.mountPath}.`
                    : `Read from inside the service at ${volume.mountPath}.`}
            </p>
        </div>
    );
}

function Notice({ title, body }: { title: string; body: string }) {
    return (
        <div className="rounded-lg border border-border/60 px-4 py-6 text-center">
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{body}</p>
        </div>
    );
}

function MetricsTab({ volume, usage }: { volume: VolumeDetail; usage: Usage }) {
    const measuring = usage.state === "measuring";
    const usedBytes = usage.bytes;
    return (
        <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
                <Stat
                    label="In use"
                    // The last size stands while a fresh measurement runs: a number
                    // being re-read is worth more than the word "Measuring".
                    value={
                        usedBytes != null
                            ? formatBytes(usedBytes)
                            : measuring
                              ? "Measuring"
                              : "Not measurable"
                    }
                    pending={measuring && usedBytes == null}
                    hint={
                        measuring
                            ? "Reading the volume from inside the service"
                            : usedBytes == null
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

function Stat({
    label,
    value,
    hint,
    pending
}: {
    label: string;
    value: string;
    hint?: string | null;
    /** Marks a figure that is still being worked out, rather than one that is late. */
    pending?: boolean;
}) {
    return (
        <div className="rounded-lg border border-border/60 p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm font-medium" title={value}>
                {pending && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
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
    onChanged,
    onClosed
}: {
    volume: VolumeDetail;
    canManage: boolean;
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

    // The mount is editable in place, not through a dialog on top of the panel -
    // but only when it has a service to be mounted in, since that is what the
    // change is applied to.
    const editable = canManage && volume.applicationId !== null;

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
        <div className="flex flex-col gap-5">
            <Section
                title="Mount"
                hint="Where this volume comes from and where the service sees it. Changes apply the next time the service is recreated."
            >
                {editable ? (
                    <VolumeForm applicationId={volume.applicationId ?? ""} volume={toEditVolume(volume)} onSaved={onChanged} />
                ) : (
                    <Rows>
                        <Row label="Mount path" value={volume.mountPath} icon={<HardDrive className="size-4" />} />
                        <Row
                            label="Source"
                            value={volume.source}
                            icon={volume.kind === "nas" ? <Database className="size-4" /> : <Server className="size-4" />}
                        />
                        <Row label="Size limit" value={volume.sizeLimit ?? "No limit"} icon={<HardDrive className="size-4" />} />
                    </Rows>
                )}
            </Section>

            <Section title="Region" hint="Volumes live on the same server as the service that mounts them.">
                <Rows>
                    <Row label="Server" value={volume.serverName} icon={<Server className="size-4" />} />
                </Rows>
            </Section>

            {canManage && (
                <>
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
        <section className="flex flex-col gap-2">
            <div>
                <h3 className="text-sm font-medium">{title}</h3>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            {children}
        </section>
    );
}

/** The framed list a section falls back to when its values are read-only. */
function Rows({ children }: { children: React.ReactNode }) {
    return <div className="overflow-hidden rounded-md border border-border/60">{children}</div>;
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
