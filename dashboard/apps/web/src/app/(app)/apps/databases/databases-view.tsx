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
 * arrives is a screen that feels slower than the thing it is listing. A return to
 * the screen paints the list this tab last read while the fresh one is fetched.
 */

import * as actions from "./actions";
import { Workbench } from "./workbench";
import * as list from "./connection-list";
import { ConnectionTable } from "./connection-table";
import { ConnectionDialog } from "./connection-dialog";
import { DbEngineIcon } from "@/components/db-engine-icon";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Database, Plus, Search } from "lucide-react";
import type { DataConnectionView } from "@/lib/data/connections";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, ConfirmDeleteDialog, EmptyState, Input, Select } from "@polaris/ui";

/** The list as this tab last read it, so a return to the screen paints rows at once
 *  while the request that replaces them is still out. */
const CACHE_KEY = "databases.connections";
const MAX_AGE_MS = 60_000;

export function DatabasesView() {
    const router = useRouter();
    const params = useSearchParams();
    const openId = params.get("c");

    const [connections, setConnections] = useState<DataConnectionView[] | null>(null);
    const [editing, setEditing] = useState<DataConnectionView | null>(null);
    const [saving, setSaving] = useState<DataConnectionView | null>(null);
    /** Kept after the dialog closes, so its closing frames still name the row. */
    const [removing, setRemoving] = useState<DataConnectionView | null>(null);
    const [confirmingRemove, setConfirmingRemove] = useState(false);
    const [adding, setAdding] = useState(false);
    const [filters, setFilters] = useState<list.ConnectionFilters>(list.NO_FILTERS);
    const [tested, setTested] = useState<Record<string, list.TestOutcome>>({});
    const [testing, setTesting] = useState<string | null>(null);
    const [error, setError] = useState("");
    /** The list as it stands, for a rollback that must not resurrect what a later
     *  read already dropped. */
    const current = useRef<DataConnectionView[] | null>(null);

    /** Every change to the list goes through here, so the kept copy never lags. */
    const store = useCallback((next: DataConnectionView[]) => {
        current.current = next;
        setConnections(next);
        writeSnapshot(CACHE_KEY, next);
    }, []);

    const load = useCallback(async () => {
        const result = await actions.listDatabasesAction();
        if (result.error) {
            setError(result.error);
            // A failed refresh keeps what is already on screen rather than blanking it.
            setConnections((shown) => shown ?? []);
            return;
        }
        setError("");
        store(result.connections ?? []);
    }, [store]);

    useEffect(() => {
        // The kept copy first, from an effect rather than the initial state: this
        // renders on the server too, and seeding it from sessionStorage during render
        // would hydrate what the HTML does not contain.
        const kept = readSnapshot<DataConnectionView[]>(CACHE_KEY, MAX_AGE_MS);
        if (kept) {
            current.current = kept.value;
            setConnections(kept.value);
        }
        void load();
    }, [load]);

    const open = connections?.find((entry) => entry.id === openId) ?? null;
    const engines = useMemo(() => list.enginesIn(connections ?? []), [connections]);
    const shown = useMemo(
        () => (connections ? list.filterConnections(connections, filters) : null),
        [connections, filters]
    );

    // A connection that is gone - deleted in another tab - must not leave the
    // workbench pointed at nothing.
    useEffect(() => {
        if (openId && connections && !open) router.replace("/apps/databases");
    }, [openId, connections, open, router]);

    const openConnection = useCallback(
        (connection: DataConnectionView) =>
            router.push(`/apps/databases?c=${encodeURIComponent(connection.id)}`),
        [router]
    );

    const test = useCallback(async (connection: DataConnectionView) => {
        setTesting(connection.id);
        const result = await actions.testConnectionAction(connection.id);
        setTesting(null);
        setTested((known) => ({
            ...known,
            [connection.id]: result.error
                ? { ok: false, detail: result.error }
                : { ok: true, detail: result.version ?? "" }
        }));
    }, []);

    /** Gone from the list at once; put back where it was if the server refuses. */
    const remove = useCallback(
        async (connection: DataConnectionView) => {
            setConfirmingRemove(false);
            const before = current.current ?? [];
            const at = before.findIndex((entry) => entry.id === connection.id);
            store(before.filter((entry) => entry.id !== connection.id));
            setError("");
            const result = await actions.deleteConnectionAction(connection.id);
            if (!result.error) return;
            const now = current.current ?? [];
            if (!now.some((entry) => entry.id === connection.id)) {
                const restored = [...now];
                restored.splice(Math.min(Math.max(at, 0), restored.length), 0, connection);
                store(restored);
            }
            setError(result.error);
        },
        [store]
    );

    if (openId && open) {
        return (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => router.push("/apps/databases")}
                    >
                        <ArrowLeft className="size-4" />
                        Connections
                    </Button>
                    <DbEngineIcon engine={open.engine} className="size-4 shrink-0" />
                    <span className="min-w-0 truncate text-sm font-medium" title={open.name}>
                        {open.name}
                    </span>
                    {open.readOnly && <Badge>read-only</Badge>}
                    <span className="truncate text-xs text-muted-foreground" title={open.where}>
                        {open.where}
                    </span>
                </div>
                <Workbench connectionId={open.id} readOnly={open.readOnly} />
            </div>
        );
    }

    return (
        // The screen it sits in fills the window and clips what overflows - that
        // is what lets the workbench's three panes scroll on their own. This
        // branch is a growing list rather than a set of panes, so it has to carry
        // its own scroller: without one it was simply cut off at the bottom of
        // the window, and the connections past the fold could not be reached at
        // all.
        <div className="flex min-h-0 flex-1 flex-col gap-4">
            {/* Above the scroller, so the way to add one and the way to narrow the
                list do not scroll away from somebody who has more than fit. */}
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
                {connections?.length !== 0 && (
                    <>
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                className="pl-9"
                                placeholder="Search by name, host or database"
                                aria-label="Search connections"
                                autoComplete="off"
                                value={filters.search}
                                onChange={(event) =>
                                    setFilters((now) => ({ ...now, search: event.target.value }))
                                }
                            />
                        </div>
                        <Select
                            className="sm:w-44"
                            aria-label="Filter by engine"
                            value={filters.engine}
                            onValueChange={(engine) => setFilters((now) => ({ ...now, engine }))}
                            options={[{ value: "all", label: "All engines" }, ...engines]}
                        />
                    </>
                )}
                <Button className="sm:ml-auto" onClick={() => setAdding(true)}>
                    <Plus className="size-4" />
                    New connection
                </Button>
            </div>

            {error && (
                <p
                    role="alert"
                    className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                >
                    {error}
                </p>
            )}

            {connections?.length === 0 ? (
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
                <ConnectionTable
                    rows={shown}
                    tested={tested}
                    testing={testing}
                    onOpen={openConnection}
                    onTest={(connection) => void test(connection)}
                    onEdit={setEditing}
                    onSave={setSaving}
                    onRemove={(connection) => {
                        setRemoving(connection);
                        setConfirmingRemove(true);
                    }}
                    noMatch={
                        <span className="flex flex-col items-center gap-2 text-muted-foreground">
                            No connection matches that.
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setFilters(list.NO_FILTERS)}
                            >
                                Clear filters
                            </Button>
                        </span>
                    }
                />
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

            <ConfirmDeleteDialog
                open={confirmingRemove}
                onOpenChange={setConfirmingRemove}
                name={removing?.name ?? ""}
                kind="connection"
                requireTyping={false}
                title="Remove connection"
                question={
                    <>
                        Remove <span className="font-medium text-foreground">{removing?.name}</span>
                        ?
                    </>
                }
                description="The connection goes; the database itself is untouched."
                confirmLabel="Remove"
                onConfirm={() => removing && void remove(removing)}
            />
        </div>
    );
}
