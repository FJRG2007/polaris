"use client";

/**
 * Reusable volume-creation form, shared by the per-service Volumes tab (fixed
 * service) and the canvas "New volume" dialog (service picker). Three confined
 * kinds - Docker volume, a folder on the service's server, or a folder on a
 * host-mounted NAS connection. The daemon re-confines every source.
 */

import { useEffect, useState, useTransition } from "react";
import { FolderSearch } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@polaris/ui";
import { createVolumeAction, listNasConnectionsAction } from "./actions";
import { FolderPicker } from "./folder-picker";

type Kind = "volume" | "bind" | "nas";
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

const SELECT_CLASS =
    "rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function VolumeForm({
    applicationId,
    services,
    onCreated,
    onCancel
}: {
    /** Fixed target service. Omit to render a service picker from `services`. */
    applicationId?: string;
    /** Selectable services, when no fixed applicationId is given. */
    services?: { id: string; name: string }[];
    onCreated: () => void;
    onCancel?: () => void;
}) {
    const [serviceId, setServiceId] = useState(applicationId ?? services?.[0]?.id ?? "");
    const [connections, setConnections] = useState<NasConnection[]>([]);
    const [kind, setKind] = useState<Kind>("bind");
    const [name, setName] = useState("");
    const [mountPath, setMountPath] = useState("");
    const [sizeLimit, setSizeLimit] = useState("");
    // Auto: Polaris generates a structured path under polaris/deploy/... Custom: the
    // user types the subpath or picks it with the folder browser.
    const [pathMode, setPathMode] = useState<"auto" | "custom">("auto");
    const [source, setSource] = useState("");
    const [connectionId, setConnectionId] = useState("");
    const [pickerOpen, setPickerOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        void listNasConnectionsAction().then((rows) => {
            setConnections(rows);
            // Pre-select when there's a single usable connection - no point making the
            // user pick from a list of one.
            const usable = rows.filter((row) => row.active);
            const only = usable[0];
            if (only && usable.length === 1) setConnectionId(only.id);
        });
    }, []);

    function add() {
        setError(null);
        const targetId = applicationId ?? serviceId;
        if (!targetId) {
            setError("Pick a service for this volume");
            return;
        }
        // Auto path and named volumes are generated server-side; custom sends the
        // typed/picked subpath.
        const resolvedSource = kind === "volume" || pathMode === "auto" ? undefined : source.trim() || undefined;
        startTransition(async () => {
            const result = await createVolumeAction({
                applicationId: targetId,
                name: name.trim(),
                mountPath: mountPath.trim(),
                kind,
                source: resolvedSource,
                connectionId: kind === "nas" ? connectionId : undefined,
                sizeLimit: sizeLimit.trim() || undefined
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            onCreated();
        });
    }

    const needsService = !applicationId && (services?.length ?? 0) > 0;
    const canAdd =
        (applicationId || serviceId) &&
        name.trim() &&
        mountPath.trim() &&
        (kind !== "nas" || connectionId) &&
        (kind === "volume" || pathMode === "auto" || source.trim());

    return (
        <div className="flex flex-col gap-3">
            {needsService && (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Service
                    <select value={serviceId} onChange={(event) => setServiceId(event.target.value)} className={SELECT_CLASS}>
                        {services?.map((service) => (
                            <option key={service.id} value={service.id}>
                                {service.name}
                            </option>
                        ))}
                    </select>
                </label>
            )}

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
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Size limit (optional)
                    <Input value={sizeLimit} onChange={(event) => setSizeLimit(event.target.value)} placeholder="10G" />
                </label>
            </div>

            {kind === "nas" && (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Storage connection
                    <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)} className={SELECT_CLASS}>
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
                            No NAS connections found. Add an NFS, SMB, or UniFi UNAS connection in Drive first.
                        </span>
                    )}
                </label>
            )}

            {kind !== "volume" && (
                <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-sm">
                        {(["auto", "custom"] as const).map((value) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setPathMode(value)}
                                className={`rounded px-3 py-1.5 font-medium transition-colors ${
                                    pathMode === value ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                                }`}
                            >
                                {value === "auto" ? "Auto" : "Choose folder"}
                            </button>
                        ))}
                    </div>
                    {pathMode === "auto" ? (
                        <p className="text-[11px] text-muted-foreground">
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
                            <span className="text-[11px] text-muted-foreground">A subpath (no leading slash, no `..`). Created if it does not exist.</span>
                        </label>
                    )}
                    {kind === "nas" && connectionId && (
                        <FolderPicker
                            connectionId={connectionId}
                            open={pickerOpen}
                            onOpenChange={setPickerOpen}
                            onPick={(picked) => {
                                setSource(picked);
                                setPathMode("custom");
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
                <Button size="sm" onClick={add} disabled={pending || !canAdd}>
                    Add volume
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
                        onCreated={() => {
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
