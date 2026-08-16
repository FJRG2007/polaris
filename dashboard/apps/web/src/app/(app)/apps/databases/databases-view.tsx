"use client";

/**
 * The database browser: the databases somebody can open, and the one they did.
 *
 * The list is not only what was saved here. A database Polaris runs for this
 * account, and Polaris' own for whoever runs the instance, are already known -
 * address, credentials and all - so they are listed as they stand, read-only,
 * and saving a connection is what somebody does to rename one or to write to it.
 * An empty screen asking for a host and a password that Polaris is holding two
 * tables away is the thing this avoids.
 *
 * The list is the screen until something is opened, and the connection stays in
 * the address so a link to a database is a link to that database rather than to
 * whatever this browser last had selected.
 *
 * Connections load after the shell paints. There is nothing above them waiting
 * on the answer, and a screen that renders nothing until a list of four rows
 * arrives is a screen that feels slower than the thing it is listing.
 */

import * as actions from "./actions";
import { Workbench } from "./workbench";
import { ConnectionDialog } from "./connection-dialog";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { DbEngineIcon } from "@/components/db-engine-icon";
import { useRouter, useSearchParams } from "next/navigation";
import type { DataConnectionView } from "@/lib/data/connections";
import { Badge, Button, Card, CardBody, EmptyState, Skeleton } from "@polaris/ui";
import { ArrowLeft, Check, Database, Loader2, Pencil, Plug, Plus, Trash2 } from "lucide-react";

export function DatabasesView() {
    const router = useRouter();
    const params = useSearchParams();
    const [confirm, confirmDialog] = useConfirm();
    const openId = params.get("c");

    const [connections, setConnections] = useState<DataConnectionView[] | null>(null);
    const [editing, setEditing] = useState<DataConnectionView | null>(null);
    const [saving, setSaving] = useState<DataConnectionView | null>(null);
    const [adding, setAdding] = useState(false);
    const [tested, setTested] = useState<Record<string, string>>({});
    const [testing, setTesting] = useState<string | null>(null);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        const result = await actions.listDatabasesAction();
        if (result.error) {
            setError(result.error);
            setConnections([]);
            return;
        }
        setConnections(result.connections ?? []);
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const open = connections?.find((entry) => entry.id === openId) ?? null;

    // A connection that is gone - deleted in another tab - must not leave the
    // workbench pointed at nothing.
    useEffect(() => {
        if (openId && connections && !open) router.replace("/apps/databases");
    }, [openId, connections, open, router]);

    if (openId && open) {
        return (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => router.push("/apps/databases")}>
                        <ArrowLeft className="size-4" />
                        Connections
                    </Button>
                    <DbEngineIcon engine={open.engine} className="size-4 shrink-0" />
                    <span className="min-w-0 truncate text-sm font-medium" title={open.name}>{open.name}</span>
                    {open.readOnly && <Badge>read-only</Badge>}
                    <span className="truncate text-xs text-muted-foreground" title={open.where}>{open.where}</span>
                </div>
                <Workbench connectionId={open.id} readOnly={open.readOnly} />
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    Browse and query the databases Polaris runs, and any other you have the
                    credentials for.
                </p>
                <Button onClick={() => setAdding(true)}>
                    <Plus className="size-4" />
                    New connection
                </Button>
            </div>

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error}
                </p>
            )}

            {connections === null ? (
                <div className="flex flex-col gap-2" aria-hidden="true">
                    {[0, 1, 2].map((row) => (
                        <Skeleton key={row} className="h-16 w-full rounded-lg" />
                    ))}
                </div>
            ) : connections.length === 0 ? (
                <EmptyState
                    icon={<Database />}
                    title="Nothing to open yet."
                    description="Polaris is not running a database for you, and none has been added. Point one at any PostgreSQL, MySQL, MariaDB, MongoDB or Redis you have the credentials for."
                    action={
                        <Button onClick={() => setAdding(true)}>
                            <Plus className="size-4" />
                            New connection
                        </Button>
                    }
                />
            ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {connections.map((connection) => (
                        <Card key={connection.id}>
                            <CardBody className="flex flex-col gap-3">
                                <button
                                    type="button"
                                    onClick={() =>
                                        router.push(
                                            `/apps/databases?c=${encodeURIComponent(connection.id)}`
                                        )
                                    }
                                    className="flex min-w-0 items-center gap-3 text-left"
                                >
                                    <DbEngineIcon engine={connection.engine} className="size-8 shrink-0" />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-1.5">
                                            <span className="truncate text-sm font-medium">
                                                {connection.name}
                                            </span>
                                            {(connection.managedDatabaseId ||
                                                connection.origin === "polaris") && <Badge>Polaris</Badge>}
                                            {connection.readOnly && <Badge>read-only</Badge>}
                                        </span>
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {connection.where}
                                        </span>
                                    </span>
                                </button>

                                <div className="flex items-center gap-1">
                                    <span
                                        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                                        title={connection.note ?? undefined}
                                    >
                                        {tested[connection.id] ??
                                            connection.note ??
                                            (connection.origin !== "saved" ? (
                                                ""
                                            ) : connection.lastUsedAt ? (
                                                <>
                                                    opened <RelativeTime iso={connection.lastUsedAt} />
                                                </>
                                            ) : (
                                                "never opened"
                                            ))}
                                    </span>
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        title="Test it"
                                        aria-label={`Test ${connection.name}`}
                                        disabled={testing === connection.id}
                                        onClick={async () => {
                                            setTesting(connection.id);
                                            const result = await actions.testConnectionAction(
                                                connection.id
                                            );
                                            setTesting(null);
                                            setTested((current) => ({
                                                ...current,
                                                [connection.id]: result.error ?? result.version ?? ""
                                            }));
                                        }}
                                    >
                                        {testing === connection.id ? (
                                            <Loader2 className="size-4 animate-spin" />
                                        ) : tested[connection.id] ? (
                                            <Check className="size-4" />
                                        ) : (
                                            <Plug className="size-4" />
                                        )}
                                    </Button>
                                    {connection.origin === "saved" ? (
                                        <>
                                            <Button
                                                size="icon-sm"
                                                variant="ghost"
                                                title="Edit"
                                                aria-label={`Edit ${connection.name}`}
                                                onClick={() => setEditing(connection)}
                                            >
                                                <Pencil className="size-4" />
                                            </Button>
                                            <Button
                                                size="icon-sm"
                                                variant="ghost"
                                                title="Remove"
                                                aria-label={`Remove ${connection.name}`}
                                                onClick={async () => {
                                                    const sure = await confirm({
                                                        title: `Remove ${connection.name}?`,
                                                        description:
                                                            "The connection goes; the database itself is untouched.",
                                                        confirmLabel: "Remove"
                                                    });
                                                    if (!sure) return;
                                                    await actions.deleteConnectionAction(connection.id);
                                                    await load();
                                                }}
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </>
                                    ) : (
                                        connection.origin === "managed" && (
                                            // The way to give it a name of your own, or to write to
                                            // it: what is listed here is read-only on purpose.
                                            <Button
                                                size="icon-sm"
                                                variant="ghost"
                                                title="Save it as a connection"
                                                aria-label={`Save ${connection.name} as a connection`}
                                                onClick={() => setSaving(connection)}
                                            >
                                                <Plus className="size-4" />
                                            </Button>
                                        )
                                    )}
                                </div>
                            </CardBody>
                        </Card>
                    ))}
                </div>
            )}

            {(adding || editing || saving) && (
                <ConnectionDialog
                    connection={editing}
                    prefill={
                        saving?.managedDatabaseId
                            ? {
                                  managedDatabaseId: saving.managedDatabaseId,
                                  name: saving.name,
                                  engine: saving.engine
                              }
                            : null
                    }
                    onClose={() => {
                        setAdding(false);
                        setEditing(null);
                        setSaving(null);
                    }}
                    onSaved={async (id) => {
                        setAdding(false);
                        setEditing(null);
                        setSaving(null);
                        await load();
                        if (!editing) router.push(`/apps/databases?c=${encodeURIComponent(id)}`);
                    }}
                />
            )}

            {confirmDialog}
        </div>
    );
}
