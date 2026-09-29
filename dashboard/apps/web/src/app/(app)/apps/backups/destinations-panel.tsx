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
import { readJson, readReasonText, reasonFor } from "@/lib/read-json";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
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
/** The kinds of destination, and what each one survives: `destinations.notes.<kind>`. */
const DESTINATION_KINDS = new Set(["local", "source-local", "connection", "host"]);

function kindNote(t: NamespaceTranslator<"backups">, kind: string): string {
    if (!DESTINATION_KINDS.has(kind)) return kind;
    return t(`destinations.notes.${kind === "source-local" ? "sourceLocal" : kind}` as NamespaceKey<"backups">);
}

export function DestinationsPanel({
    destinations,
    loading,
    onChanged
}: {
    destinations: DestinationSummary[];
    loading: boolean;
    onChanged: () => Promise<void>;
}) {
    const t = useTranslations("backups");
    const tc = useTranslations("components");
    const format = useDisplayFormat();
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<DestinationSummary | null>(null);
    const [testing, setTesting] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Each of these catches its own failure, because an error thrown out of a
    // Server Action is rethrown in the React tree: unguarded, one that refused
    // replaced the console with "This page stopped working" instead of a line
    // saying what refused.
    async function onTest(destination: DestinationSummary) {
        setTesting(destination.id);
        setError(null);
        try {
            const result = await testDestinationAction(destination.id);
            if (!result.ok) {
                setError(
                    t("destinations.testFailed", {
                        name: destination.name,
                        reason: result.error ?? t("destinations.noAnswer")
                    })
                );
            }
        } catch (caught) {
            setError(t("destinations.testFailed", { name: destination.name, reason: readReasonText(tc, reasonFor(caught)) }));
        } finally {
            setTesting(null);
        }
        await onChanged();
    }

    async function onDelete() {
        if (!removing) return;
        const target = removing;
        setRemoving(null);
        try {
            const result = await deleteDestinationAction(target.id);
            if (result.error) setError(result.error);
        } catch (caught) {
            setError(readReasonText(tc, reasonFor(caught)));
        }
        await onChanged();
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    {t("destinations.intro")}
                </p>
                <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus className="size-4" />
                    {t("destinations.add")}
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
                                            {destination.isDefault ? <Badge variant="neutral">{t("table.default")}</Badge> : null}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {kindNote(t, destination.kind)}
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
                                            {t("destinations.test")}
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={t("plans.deleteNamed", { name: destination.name })}
                                            title={t("destinations.delete")}
                                            onClick={() => setRemoving(destination)}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                    <span>
                                        {t("destinations.copies", { count: destination.copyCount })}
                                    </span>
                                    <span>-</span>
                                    <span>{formatBytes(BigInt(destination.storedBytes))}</span>
                                    {destination.status === "unreachable" ? (
                                        <span className="flex items-center gap-1 text-danger">
                                            <AlertTriangle className="size-3.5" />
                                            {destination.lastError ?? t("plans.notAnswering")}
                                        </span>
                                    ) : destination.lastCheckedAt ? (
                                        <span className="flex items-center gap-1 text-success">
                                            <CheckCircle2 className="size-3.5" />
                                            {t("destinations.answered", { when: format.dateTime(destination.lastCheckedAt) })}
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
                    kind={t("destinations.kind")}
                    requireTyping={removing.copyCount > 0}
                    description={
                        removing.copyCount > 0
                            ? t("destinations.deleteBody", { count: removing.copyCount })
                            : t("destinations.deleteEmpty")
                    }
                    confirmLabel={t("destinations.deleteConfirm")}
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
    const t = useTranslations("backups");
    const tc = useTranslations("components");
    const tcommon = useTranslations("common");
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
        void readJson<{ connections: ConnectionOption[]; hosts: ConnectionOption[] }>(
            "/api/backups/targets"
        ).then((data) => {
            if (!live) return;
            const answer = data.ok ? data.value : { connections: [], hosts: [] };
            setConnections(answer.connections);
            setHosts(answer.hosts);
            setConnectionId(answer.connections[0]?.id ?? "");
            setHostId(answer.hosts[0]?.id ?? "");
            if (!data.ok) setError(readReasonText(tc, data.reason));
        });
        return () => {
            live = false;
        };
    }, [tc]);

    const needsConnection = kind === "connection";
    const needsHost = kind === "host";
    const ready =
        name.trim().length > 0 &&
        (!needsConnection || connectionId.length > 0) &&
        (!needsHost || (hostId.length > 0 && basePath.trim().length > 0));

    async function onSave() {
        setPending(true);
        setError(null);
        try {
            await create();
        } catch (caught) {
            setError(readReasonText(tc, reasonFor(caught)));
        } finally {
            setPending(false);
        }
    }

    async function create() {
        const payload =
            kind === "connection"
                ? { kind, name: name.trim(), connectionId, basePath }
                : kind === "host"
                  ? { kind, name: name.trim(), hostId, basePath }
                  : kind === "local"
                    ? { kind, name: name.trim(), basePath }
                    : { kind, name: name.trim() };
        const result = await createDestinationAction(payload);
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
                    <DialogTitle>{t("destinations.title")}</DialogTitle>
                    <DialogDescription>{t("destinations.dialogIntro")}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("destinations.kindLabel")}</span>
                        <Select
                            value={kind}
                            onValueChange={setKind}
                            aria-label={t("destinations.kindLabel")}
                            options={[
                                { value: "connection", label: t("destinations.kinds.connection") },
                                { value: "host", label: t("destinations.kinds.host") },
                                { value: "local", label: t("destinations.kinds.local") },
                                { value: "source-local", label: t("destinations.kinds.sourceLocal") }
                            ]}
                        />
                        <span className="text-xs text-muted-foreground">{kindNote(t, kind)}</span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("table.columns.name")}</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("destinations.namePlaceholder")}
                        />
                    </label>

                    {needsConnection ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("destinations.connection")}</span>
                            {connections === null ? (
                                <Skeleton className="h-9 w-full" />
                            ) : connections.length === 0 ? (
                                <span className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                                    {t("destinations.noConnections")}
                                </span>
                            ) : (
                                <Select
                                    value={connectionId}
                                    onValueChange={setConnectionId}
                                    aria-label={t("destinations.connection")}
                                    options={connections.map((entry) => ({ value: entry.id, label: entry.name }))}
                                />
                            )}
                        </label>
                    ) : null}

                    {needsHost ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("destinations.server")}</span>
                            {hosts === null ? (
                                <Skeleton className="h-9 w-full" />
                            ) : hosts.length === 0 ? (
                                <span className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                                    {t("destinations.noServers")}
                                </span>
                            ) : (
                                <Select
                                    value={hostId}
                                    onValueChange={setHostId}
                                    aria-label={t("destinations.server")}
                                    options={hosts.map((entry) => ({ value: entry.id, label: entry.name }))}
                                />
                            )}
                        </label>
                    ) : null}

                    {kind !== "source-local" ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("destinations.folder")}</span>
                            <Input
                                value={basePath}
                                onChange={(event) => setBasePath(event.target.value)}
                                placeholder={kind === "host" ? "/var/backups/polaris" : "polaris-backups"}
                            />
                            <span className="text-xs text-muted-foreground">
                                {t("destinations.folderHint")}
                            </span>
                        </label>
                    ) : null}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button variant="ghost">{tcommon("actions.cancel")}</Button>
                        </DialogClose>
                        <Button onClick={() => void onSave()} disabled={pending || !ready}>
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                            {t("destinations.addShort")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
