"use client";

/**
 * Adding a database to the browser, or changing one.
 *
 * Two kinds behind one form, because they are the same decision made two ways.
 * A database Polaris runs is picked from a list - there is nothing to type, and
 * the address and the credentials are read from the deploy row every time it is
 * opened, so nothing here can go stale. Anything else is a host, a port and a
 * secret, which is what a client asks for everywhere.
 *
 * Read-only is on by default and says why. The password field is left empty on an
 * edit and only replaces the stored one when something is typed into it: asking
 * for the password again to rename a connection is how people end up keeping it
 * in a text file.
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Loader2, Plug, Database } from "lucide-react";
import type { DataConnectionView, ManagedOption } from "@/lib/data/connections";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Select,
    Switch,
    cn
} from "@polaris/ui";

interface Engine {
    id: string;
    label: string;
    port: number;
}

export function ConnectionDialog({
    connection,
    onClose,
    onSaved
}: {
    /** The one being changed, or null for a new one. */
    connection: DataConnectionView | null;
    onClose: () => void;
    onSaved: (id: string) => void;
}) {
    const [engines, setEngines] = useState<Engine[]>([]);
    const [managed, setManaged] = useState<ManagedOption[]>([]);
    const [kind, setKind] = useState<"managed" | "manual">(
        connection?.managedDatabaseId ? "managed" : "manual"
    );
    const [name, setName] = useState(connection?.name ?? "");
    const [engine, setEngine] = useState(connection?.engine ?? "postgres");
    const [managedId, setManagedId] = useState(connection?.managedDatabaseId ?? "");
    const [host, setHost] = useState(connection?.where.split(":")[0] ?? "");
    const [port, setPort] = useState(connection?.where.split(":")[1] ?? "");
    const [database, setDatabase] = useState(connection?.database ?? "");
    const [username, setUsername] = useState(connection?.username ?? "");
    const [password, setPassword] = useState("");
    const [tls, setTls] = useState(connection?.tls ?? false);
    const [readOnly, setReadOnly] = useState(connection?.readOnly ?? true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        void actions.engineOptionsAction().then((result) => setEngines(result.engines));
        void actions.listManagedAction().then((result) => setManaged(result.databases ?? []));
    }, []);

    // The port follows the engine until somebody types one, so picking MySQL
    // does not leave 5432 in a field nobody looked at.
    useEffect(() => {
        if (connection) return;
        const chosen = engines.find((entry) => entry.id === engine);
        if (chosen) setPort(String(chosen.port));
    }, [engine, engines, connection]);

    const chosenManaged = managed.find((entry) => entry.id === managedId) ?? null;
    const complete =
        name.trim() !== "" &&
        (kind === "managed" ? managedId !== "" : host.trim() !== "" && port.trim() !== "");

    const save = async () => {
        if (!complete || saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () =>
                actions.saveConnectionAction({
                    id: connection?.id ?? null,
                    name: name.trim(),
                    engine: (kind === "managed" ? (chosenManaged?.engine ?? engine) : engine) as never,
                    managedDatabaseId: kind === "managed" ? managedId : null,
                    host: kind === "manual" ? host.trim() : null,
                    port: kind === "manual" ? Number(port) : null,
                    database: kind === "manual" ? database.trim() || null : null,
                    username: kind === "manual" ? username.trim() || null : null,
                    password: password || null,
                    tls,
                    readOnly
                }),
            setError
        );
        setSaving(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        if (result.id) onSaved(result.id);
    };

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{connection ? "Edit connection" : "New connection"}</DialogTitle>
                    <DialogDescription>
                        A database Polaris runs, or one somewhere else you have the credentials for.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <SegmentedControl
                        className="self-start"
                        aria-label="Which database"
                        value={kind}
                        onValueChange={(next) => setKind(next)}
                        options={[
                            { value: "managed", label: "One Polaris runs" },
                            { value: "manual", label: "Somewhere else" }
                        ]}
                    />

                    <Field label="Name">
                        <Input
                            autoFocus
                            value={name}
                            placeholder="Production"
                            onChange={(event) => setName(event.target.value)}
                        />
                    </Field>

                    {kind === "managed" ? (
                        managed.length === 0 ? (
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Database className="size-4 shrink-0" />
                                Polaris is not running any databases yet.
                            </p>
                        ) : (
                            <>
                                <Field label="Database">
                                    <Select
                                        value={managedId}
                                        onValueChange={setManagedId}
                                        aria-label="Which database Polaris runs"
                                        placeholder="Pick one..."
                                        options={managed.map((entry) => ({
                                            value: entry.id,
                                            label: `${entry.name} - ${entry.where}`
                                        }))}
                                    />
                                </Field>
                                {chosenManaged && !chosenManaged.reachable && (
                                    <p className="text-xs text-warning">
                                        This one runs on another server and is not published on a
                                        port, so Polaris cannot reach it from here. Publish it on a
                                        port from the database&apos;s own screen first.
                                    </p>
                                )}
                            </>
                        )
                    ) : (
                        <>
                            <div className="flex gap-3">
                                <Field label="Engine" className="flex-1">
                                    <Select
                                        value={engine}
                                        onValueChange={(next) => setEngine(next as typeof engine)}
                                        aria-label="Engine"
                                        options={engines.map((entry) => ({
                                            value: entry.id,
                                            label: entry.label
                                        }))}
                                    />
                                </Field>
                                <Field label="Port" className="w-28">
                                    <Input
                                        inputMode="numeric"
                                        value={port}
                                        onChange={(event) => setPort(event.target.value)}
                                    />
                                </Field>
                            </div>
                            <Field label="Host">
                                <Input
                                    value={host}
                                    placeholder="db.example.com"
                                    onChange={(event) => setHost(event.target.value)}
                                />
                            </Field>
                            <div className="flex gap-3">
                                <Field label="Database" className="flex-1">
                                    <Input
                                        value={database}
                                        placeholder={engine === "redis" ? "0" : "app"}
                                        onChange={(event) => setDatabase(event.target.value)}
                                    />
                                </Field>
                                <Field label="User" className="flex-1">
                                    <Input
                                        value={username}
                                        onChange={(event) => setUsername(event.target.value)}
                                    />
                                </Field>
                            </div>
                            <Field
                                label="Password"
                                hint={connection ? "Leave empty to keep the saved one." : undefined}
                            >
                                <Input
                                    type="password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </Field>
                            <Toggle
                                label="Encrypted connection"
                                hint="TLS to the server. The certificate is not verified, so a self-signed one still works."
                                checked={tls}
                                onChange={setTls}
                            />
                        </>
                    )}

                    <Toggle
                        label="Read-only"
                        hint="Refuses anything that would change the database. Leave it on unless you came here to write."
                        checked={readOnly}
                        onChange={setReadOnly}
                    />

                    {error && (
                        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={() => void save()} disabled={!complete || saving}>
                        {saving && <Loader2 className="size-4 animate-spin" />}
                        <Plug className="size-4" />
                        {connection ? "Save" : "Add it"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Field({
    label,
    hint,
    className,
    children
}: {
    label: string;
    hint?: string;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <label className={cn("flex flex-col gap-1 text-xs text-muted-foreground", className)}>
            {label}
            {children}
            {hint && <span>{hint}</span>}
        </label>
    );
}

function Toggle({
    label,
    hint,
    checked,
    onChange
}: {
    label: string;
    hint: string;
    checked: boolean;
    onChange: (next: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <Switch checked={checked} onChange={onChange} aria-label={label} />
        </div>
    );
}
