"use client";

/**
 * Where copies land.
 *
 * Four kinds, and the difference between them is the thing worth being plain
 * about: a copy beside the source is instant and dies with the disk it protects;
 * the data dir survives a mistake but not the machine; a storage connection or a
 * server survives both. The card says which is which, because somebody choosing
 * one is choosing what their backups survive.
 */

import { useEffect, useState } from "react";
import { formatBytes } from "@polaris/core";
import type { DestinationSummary } from "./types";
import { useDisplayFormat } from "@/components/display-format";
import { createDestinationAction, deleteDestinationAction, testDestinationAction } from "./actions";
import { AlertTriangle, CheckCircle2, HardDrive, Loader2, Plus, Server, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";

/** What each kind survives, in one line. */
const KIND_NOTE: Record<string, string> = {
    local: "On this machine's data dir. Survives a mistake, not a dead disk.",
    "source-local": "Beside the thing itself. Instant, and lost with the disk it protects.",
    connection: "On a storage connection - a NAS, a bucket, a linked drive.",
    host: "On another server you have connected, over SSH."
};

export function DestinationsPanel({
    destinations,
    loading,
    onChanged
}: {
    destinations: DestinationSummary[];
    loading: boolean;
    onChanged: () => Promise<void>;
}) {
    const format = useDisplayFormat();
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<DestinationSummary | null>(null);
    const [testing, setTesting] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function onTest(destination: DestinationSummary) {
        setTesting(destination.id);
        setError(null);
        const result = await testDestinationAction(destination.id);
        setTesting(null);
        if (!result.ok) setError(`${destination.name}: ${result.error ?? "it did not answer"}`);
        await onChanged();
    }

    async function onDelete() {
        if (!removing) return;
        const target = removing;
        setRemoving(null);
        const result = await deleteDestinationAction(target.id);
        if (result.error) setError(result.error);
        await onChanged();
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    A plan can write to several. That is what makes a backup survive the machine it was taken on.
                </p>
                <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus className="size-4" />
                    Add destination
                </Button>
            </div>

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {loading ? (
                <div className="flex flex-col gap-2">
                    {Array.from({ length: 2 }, (_, index) => (
                        <Skeleton key={index} className="h-20 w-full" />
                    ))}
                </div>
            ) : (
                <div className="grid gap-3 md:grid-cols-2">
                    {destinations.map((destination) => (
                        <Card key={destination.id}>
                            <CardBody className="flex flex-col gap-2">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="flex items-center gap-2 truncate font-medium">
                                            {destination.kind === "host" ? (
                                                <Server className="size-4 text-muted-foreground" />
                                            ) : (
                                                <HardDrive className="size-4 text-muted-foreground" />
                                            )}
                                            {destination.name}
                                            {destination.isDefault ? <Badge variant="neutral">Default</Badge> : null}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {KIND_NOTE[destination.kind] ?? destination.kind}
                                            {destination.via ? ` - ${destination.via}` : ""}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={testing === destination.id}
                                            onClick={() => void onTest(destination)}
                                        >
                                            {testing === destination.id ? (
                                                <Loader2 className="size-4 animate-spin" />
                                            ) : null}
                                            Test
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={`Delete ${destination.name}`}
                                            title="Delete this destination"
                                            onClick={() => setRemoving(destination)}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                    <span>
                                        {destination.copyCount} {destination.copyCount === 1 ? "copy" : "copies"}
                                    </span>
                                    <span>-</span>
                                    <span>{formatBytes(BigInt(destination.storedBytes))}</span>
                                    {destination.status === "unreachable" ? (
                                        <span className="flex items-center gap-1 text-danger">
                                            <AlertTriangle className="size-3.5" />
                                            {destination.lastError ?? "Not answering"}
                                        </span>
                                    ) : destination.lastCheckedAt ? (
                                        <span className="flex items-center gap-1 text-success">
                                            <CheckCircle2 className="size-3.5" />
                                            Answered {format.dateTime(destination.lastCheckedAt)}
                                        </span>
                                    ) : null}
                                </div>
                            </CardBody>
                        </Card>
                    ))}
                </div>
            )}

            {adding ? (
                <DestinationDialog onClose={() => setAdding(false)} onSaved={onChanged} />
            ) : null}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.name}
                    kind="destination"
                    requireTyping={removing.copyCount > 0}
                    description={
                        removing.copyCount > 0
                            ? `It still holds ${removing.copyCount} ${removing.copyCount === 1 ? "copy" : "copies"}. Polaris will refuse until they are gone, so they never become bytes nothing points at.`
                            : "It holds nothing, so nothing is lost."
                    }
                    confirmLabel="Delete destination"
                    onConfirm={() => void onDelete()}
                />
            ) : null}
        </div>
    );
}

interface ConnectionOption {
    id: string;
    name: string;
}

function DestinationDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
    const [kind, setKind] = useState("connection");
    const [name, setName] = useState("");
    const [basePath, setBasePath] = useState("polaris-backups");
    const [connectionId, setConnectionId] = useState("");
    const [hostId, setHostId] = useState("");
    const [connections, setConnections] = useState<ConnectionOption[] | null>(null);
    const [hosts, setHosts] = useState<ConnectionOption[] | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Loaded on open rather than with the console: most visits never add one.
    useEffect(() => {
        let live = true;
        void fetch("/api/backups/targets", { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : { connections: [], hosts: [] }))
            .then((data: { connections: ConnectionOption[]; hosts: ConnectionOption[] }) => {
                if (!live) return;
                setConnections(data.connections);
                setHosts(data.hosts);
                setConnectionId(data.connections[0]?.id ?? "");
                setHostId(data.hosts[0]?.id ?? "");
            })
            .catch(() => {
                if (!live) return;
                setConnections([]);
                setHosts([]);
            });
        return () => {
            live = false;
        };
    }, []);

    const needsConnection = kind === "connection";
    const needsHost = kind === "host";
    const ready =
        name.trim().length > 0 &&
        (!needsConnection || connectionId.length > 0) &&
        (!needsHost || (hostId.length > 0 && basePath.trim().length > 0));

    async function onSave() {
        setPending(true);
        setError(null);
        const payload =
            kind === "connection"
                ? { kind, name: name.trim(), connectionId, basePath }
                : kind === "host"
                  ? { kind, name: name.trim(), hostId, basePath }
                  : kind === "local"
                    ? { kind, name: name.trim(), basePath }
                    : { kind, name: name.trim() };
        const result = await createDestinationAction(payload);
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        await onSaved();
        onClose();
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Add a destination</DialogTitle>
                    <DialogDescription>Somewhere copies are written.</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Kind</span>
                        <Select
                            value={kind}
                            onValueChange={setKind}
                            aria-label="Kind"
                            options={[
                                { value: "connection", label: "Storage connection (NAS, bucket, linked drive)" },
                                { value: "host", label: "A server you have connected" },
                                { value: "local", label: "This machine's data dir" },
                                { value: "source-local", label: "Beside the thing itself" }
                            ]}
                        />
                        <span className="text-xs text-muted-foreground">{KIND_NOTE[kind]}</span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Backblaze bucket"
                        />
                    </label>

                    {needsConnection ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Connection</span>
                            {connections === null ? (
                                <Skeleton className="h-9 w-full" />
                            ) : connections.length === 0 ? (
                                <span className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                                    No storage connections yet. Add one in Drive first.
                                </span>
                            ) : (
                                <Select
                                    value={connectionId}
                                    onValueChange={setConnectionId}
                                    aria-label="Connection"
                                    options={connections.map((entry) => ({ value: entry.id, label: entry.name }))}
                                />
                            )}
                        </label>
                    ) : null}

                    {needsHost ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Server</span>
                            {hosts === null ? (
                                <Skeleton className="h-9 w-full" />
                            ) : hosts.length === 0 ? (
                                <span className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                                    No servers connected yet.
                                </span>
                            ) : (
                                <Select
                                    value={hostId}
                                    onValueChange={setHostId}
                                    aria-label="Server"
                                    options={hosts.map((entry) => ({ value: entry.id, label: entry.name }))}
                                />
                            )}
                        </label>
                    ) : null}

                    {kind !== "source-local" ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Folder</span>
                            <Input
                                value={basePath}
                                onChange={(event) => setBasePath(event.target.value)}
                                placeholder={kind === "host" ? "/var/backups/polaris" : "polaris-backups"}
                            />
                            <span className="text-xs text-muted-foreground">
                                Everything is written under this, so backups never share a folder with anything else.
                            </span>
                        </label>
                    ) : null}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button variant="ghost">Cancel</Button>
                        </DialogClose>
                        <Button onClick={() => void onSave()} disabled={pending || !ready}>
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                            Add
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
