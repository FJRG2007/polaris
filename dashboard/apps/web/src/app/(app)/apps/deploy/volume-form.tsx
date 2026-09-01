"use client";

/**
 * Volume form, shared by the per-service Volumes tab, the canvas "New volume"
 * dialog (service picker), and the volume panel's Settings tab. Three confined
 * kinds - Docker volume, a folder on the service's server, or a folder on a
 * host-mounted NAS connection. The daemon re-confines every source. In edit mode
 * the kind and service are fixed; only paths, size cap, and the connection change.
 */

import { FolderSearch } from "lucide-react";
import { FolderPicker } from "./folder-picker";
import { useEffect, useState, useTransition } from "react";
import { createVolumeAction, updateVolumeAction, listNasConnectionsAction } from "./actions";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, SegmentedControl, Select } from "@polaris/ui";

type Kind = "volume" | "bind" | "nas";
type NasConnection = Awaited<ReturnType<typeof listNasConnectionsAction>>[number];

export interface EditVolume {
    id: string;
    name: string;
    mountPath: string;
    kind: Kind;
    source: string;
    connectionId: string | null;
    sizeLimit: string | null;
}

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

export function VolumeForm({
    applicationId,
    services,
    volume,
    onSaved,
    onCancel
}: {
    /** Fixed target service (create in a tab, or edit). Omit for a service picker. */
    applicationId?: string;
    /** Selectable services, when no fixed applicationId is given (create only). */
    services?: { id: string; name: string }[];
    /** When set, the form edits this volume instead of creating a new one. */
    volume?: EditVolume;
    onSaved: () => void;
    onCancel?: () => void;
}) {
    const editing = Boolean(volume);
    const [serviceId, setServiceId] = useState(applicationId ?? services?.[0]?.id ?? "");
    const [connections, setConnections] = useState<NasConnection[]>([]);
    const [kind, setKind] = useState<Kind>(volume?.kind ?? "bind");
    const [name, setName] = useState(volume?.name ?? "");
    const [mountPath, setMountPath] = useState(volume?.mountPath ?? "");
    const [sizeLimit, setSizeLimit] = useState(volume?.sizeLimit ?? "");
    // Auto: Polaris generates a structured path. Custom: typed/picked subpath. Edit
    // always starts in custom with the existing path.
    const [pathMode, setPathMode] = useState<"auto" | "custom">(editing ? "custom" : "auto");
    const [source, setSource] = useState(volume?.source ?? "");
    const [connectionId, setConnectionId] = useState(volume?.connectionId ?? "");
    const [pickerOpen, setPickerOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // Keyed on whether this form creates or edits, not on the volume itself: an
    // inline form is handed a fresh object on every render of its panel, and
    // depending on that identity would re-fetch the connections forever.
    useEffect(() => {
        void listNasConnectionsAction().then((rows) => {
            setConnections(rows);
            // Pre-select when there's a single usable connection (create only - edit
            // keeps the volume's own connection).
            if (editing) return;
            const usable = rows.filter((row) => row.active);
            const only = usable[0];
            if (only && usable.length === 1) setConnectionId(only.id);
        });
    }, [editing]);

    function save() {
        setError(null);
        const targetId = applicationId ?? serviceId;
        if (!targetId) {
            setError("Pick a service for this volume");
            return;
        }
        startTransition(async () => {
            let result: { error?: string };
            if (volume) {
                result = await updateVolumeAction({
                    id: volume.id,
                    applicationId: targetId,
                    name: name.trim(),
                    mountPath: mountPath.trim(),
                    source: kind === "volume" ? undefined : source.trim() || undefined,
                    connectionId: kind === "nas" ? connectionId : undefined,
                    // "" clears the cap; a value sets it.
                    sizeLimit: sizeLimit.trim()
                });
            } else {
                // Auto path and named volumes are generated server-side; custom sends
                // the typed/picked subpath.
                const resolvedSource = kind === "volume" || pathMode === "auto" ? undefined : source.trim() || undefined;
                result = await createVolumeAction({
                    applicationId: targetId,
                    name: name.trim(),
                    mountPath: mountPath.trim(),
                    kind,
                    source: resolvedSource,
                    connectionId: kind === "nas" ? connectionId : undefined,
                    sizeLimit: sizeLimit.trim() || undefined
                });
            }
            if (result.error) {
                setError(result.error);
                return;
            }
            onSaved();
        });
    }

    const needsService = !editing && !applicationId && (services?.length ?? 0) > 0;
    const usesCustomPath = editing || pathMode === "custom";
    // Editing a volume back to the values it already has is not a save.
    const unchanged =
        volume !== undefined &&
        kind === volume.kind &&
        name.trim() === volume.name &&
        mountPath.trim() === volume.mountPath &&
        sizeLimit.trim() === (volume.sizeLimit ?? "") &&
        source.trim() === (volume.source ?? "") &&
        connectionId === (volume.connectionId ?? "");
    const canSave =
        (applicationId || serviceId) &&
        name.trim() &&
        mountPath.trim() &&
        (kind !== "nas" || connectionId) &&
        (kind === "volume" || !usesCustomPath || source.trim()) &&
        !unchanged;

    return (
        <div className="flex flex-col gap-3">
            {needsService && (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Service
                    <Select
                        value={serviceId}
                        onValueChange={setServiceId}
                        aria-label="Service"
                        options={(services ?? []).map((service) => ({ value: service.id, label: service.name }))}
                    />
                </label>
            )}

            {editing ? (
                <p className="text-xs text-muted-foreground">{KIND_LABELS[kind]} - {KIND_HELP[kind]}</p>
            ) : (
                <>
                    <SegmentedControl
                        aria-label="Kind of storage"
                        className="flex"
                        value={kind}
                        onValueChange={setKind}
                        options={(Object.keys(KIND_LABELS) as Kind[]).map((value) => ({
                            value,
                            label: KIND_LABELS[value],
                            title: KIND_HELP[value]
                        }))}
                    />
                    <p className="text-xs text-muted-foreground">{KIND_HELP[kind]}</p>
                </>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Name
                    <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="secrets" />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Mount path (in container)
                    <Input value={mountPath} onChange={(event) => setMountPath(event.target.value)} placeholder="/app/secrets" />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Size limit (optional)
                    <Input value={sizeLimit} onChange={(event) => setSizeLimit(event.target.value)} placeholder="10G" />
                </label>
            </div>

            {kind === "nas" && (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Storage connection
                    <Select
                        value={connectionId}
                        onValueChange={setConnectionId}
                        placeholder="Select a NAS connection"
                        aria-label="Storage connection"
                        options={connections.map((connection) => ({
                            value: connection.id,
                            label: connection.active ? connection.name : `${connection.name} (not connected)`,
                            disabled: !connection.active
                        }))}
                    />
                    {connections.length === 0 && (
                        <span className="text-[0.6875rem] text-muted-foreground">
                            No NAS connections found. Add an NFS, SMB, or UniFi UNAS connection in Drive first.
                        </span>
                    )}
                </label>
            )}

            {kind !== "volume" && (
                <div className="flex flex-col gap-2">
                    {!editing && (
                        <SegmentedControl
                            aria-label="Where the folder lives"
                            className="flex"
                            value={pathMode}
                            onValueChange={setPathMode}
                            options={[
                                { value: "auto", label: "Auto" },
                                { value: "custom", label: "Choose folder" }
                            ]}
                        />
                    )}
                    {!usesCustomPath ? (
                        <p className="text-[0.6875rem] text-muted-foreground">
                            Polaris creates and organizes it under <code className="text-foreground">polaris/deploy/&lt;project&gt;/&lt;service&gt;/{name.trim() || "name"}</code>.
                        </p>
                    ) : (
                        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                            {kind === "nas" ? "Folder on the NAS" : "Folder on the server"}
                            <div className="flex items-center gap-2">
                                <Input value={source} onChange={(event) => setSource(event.target.value)} placeholder="data/uploads" />
                                {kind === "nas" && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={!connectionId}
                                        onClick={() => setPickerOpen(true)}
                                        title={connectionId ? "Browse folders" : "Select a NAS connection first"}
                                    >
                                        <FolderSearch className="size-4" /> Browse
                                    </Button>
                                )}
                            </div>
                            <span className="text-[0.6875rem] text-muted-foreground">A subpath (no leading slash, no `..`). Created if it does not exist.</span>
                        </label>
                    )}
                    {kind === "nas" && connectionId && (
                        <FolderPicker
                            connectionId={connectionId}
                            open={pickerOpen}
                            onOpenChange={setPickerOpen}
                            onPick={(picked) => {
                                setSource(picked);
                                if (!editing) setPathMode("custom");
                            }}
                        />
                    )}
                </div>
            )}

            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex items-center justify-end gap-2">
                {onCancel && (
                    <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
                        Cancel
                    </Button>
                )}
                <Button size="sm" onClick={save} disabled={pending || !canSave}>
                    {editing ? "Save changes" : "Add volume"}
                </Button>
            </div>
        </div>
    );
}

/** The canvas "New volume" flow: pick a service and attach a volume to it. */
export function NewVolumeDialog({
    open,
    services,
    onOpenChange,
    onCreated
}: {
    open: boolean;
    services: { id: string; name: string }[];
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>New volume</DialogTitle>
                </DialogHeader>
                {services.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Add a service first - a volume mounts into a service's container.</p>
                ) : (
                    <VolumeForm
                        services={services}
                        onSaved={() => {
                            onOpenChange(false);
                            onCreated();
                        }}
                        onCancel={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
