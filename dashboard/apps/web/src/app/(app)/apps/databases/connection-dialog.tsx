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
 * A database on a machine that publishes nothing is reached over SSH, the way a
 * desktop client does it: through a server already registered in Servers, whose
 * login and pinned key Polaris has, or through an SSH login typed here. The
 * database's own address is then what the SSH server sees - usually
 * `127.0.0.1` - which is said on the field rather than left to be worked out.
 *
 * Read-only is a tick, off unless somebody makes the choice: the browser refuses
 * writes when it is on, and defaulting it on made every new connection a
 * surprise on the first UPDATE.
 *
 * Every field is checked as it is typed against the schema the server parses the
 * save with, so a value the server would refuse is refused here first, in the
 * same words. Secrets are left empty on an edit and only replace the stored one
 * when something is typed: asking for the password again to rename a connection
 * is how people end up keeping it in a text file.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plug, Database } from "lucide-react";
import { DbEngineSelect } from "@/components/db-engine-select";
import type { DataConnectionView, ManagedOption } from "@/lib/data/connections";
import {
    connectionIssues,
    type SaveConnectionInput,
    type SshAuthMethod,
    type SshTunnelInput
} from "@/lib/data/connection-schema";
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
    Textarea,
    cn
} from "@polaris/ui";

interface Engine {
    id: string;
    label: string;
    port: number;
}

interface TunnelServer {
    id: string;
    name: string;
    address: string;
}

/** What "no jump server" is called in a picker, since a menu cannot hold an
 *  empty value. */
const NO_JUMP = "none";

/** A jump picker nobody has answered yet. Only reached when the saved bastion was
 *  removed: "straight to it" is then a choice to make, not a state to inherit. */
const JUMP_UNPICKED = "";

export function ConnectionDialog({
    connection,
    prefill = null,
    onClose,
    onSaved
}: {
    /** The one being changed, or null for a new one. */
    connection: DataConnectionView | null;
    /** A database Polaris runs that the list already offered, being saved so it
     *  can be named or written to. Nothing is stored for it yet. */
    prefill?: {
        managedDatabaseId: string;
        name: string;
        engine: DataConnectionView["engine"];
    } | null;
    onClose: () => void;
    onSaved: (id: string) => void;
}) {
    const saved = connection?.tunnel ?? null;
    const [engines, setEngines] = useState<Engine[]>([]);
    const [managed, setManaged] = useState<ManagedOption[]>([]);
    const [servers, setServers] = useState<TunnelServer[]>([]);
    const [kind, setKind] = useState<"managed" | "manual">(
        connection?.managedDatabaseId || prefill ? "managed" : "manual"
    );
    const [name, setName] = useState(connection?.name ?? prefill?.name ?? "");
    const [engine, setEngine] = useState(connection?.engine ?? prefill?.engine ?? "postgres");
    const [managedId, setManagedId] = useState(
        connection?.managedDatabaseId ?? prefill?.managedDatabaseId ?? ""
    );
    const [host, setHost] = useState(connection?.host ?? "");
    const [port, setPort] = useState(connection?.port ? String(connection.port) : "");
    const [database, setDatabase] = useState(connection?.database ?? "");
    const [username, setUsername] = useState(connection?.username ?? "");
    const [password, setPassword] = useState("");
    const [tls, setTls] = useState(connection?.tls ?? false);
    const [readOnly, setReadOnly] = useState(connection?.readOnly ?? false);

    // The tunnel, if there is one. Held whether or not it is switched on, so
    // turning it off to try something and back on does not empty the form.
    const [tunnelled, setTunnelled] = useState(saved !== null);
    const [tunnelKind, setTunnelKind] = useState<"server" | "manual">(saved?.mode ?? "server");
    const [serverId, setServerId] = useState(saved?.mode === "server" ? (saved.hostId ?? "") : "");
    const [sshHost, setSshHost] = useState(saved?.mode === "manual" ? saved.host : "");
    const [sshPort, setSshPort] = useState(saved?.mode === "manual" ? String(saved.port) : "22");
    const [sshUser, setSshUser] = useState(saved?.mode === "manual" ? saved.username : "");
    const [sshAuth, setSshAuth] = useState<SshAuthMethod>(
        saved?.mode === "manual" ? saved.authMethod : "password"
    );
    const [sshPassword, setSshPassword] = useState("");
    const [sshKey, setSshKey] = useState("");
    const [sshPassphrase, setSshPassphrase] = useState("");
    const [jumpId, setJumpId] = useState(
        saved?.mode === "manual"
            ? saved.jumpMissing
                ? JUMP_UNPICKED
                : (saved.jumpHostId ?? NO_JUMP)
            : NO_JUMP
    );

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        void actions.engineOptionsAction().then((result) => setEngines(result.engines));
        void actions.listManagedAction().then((result) => setManaged(result.databases ?? []));
        void actions.listTunnelServersAction().then((result) => setServers(result.servers));
    }, []);

    // The port follows the engine until somebody types one, so picking MySQL
    // does not leave 5432 in a field nobody looked at.
    useEffect(() => {
        if (connection) return;
        const chosen = engines.find((entry) => entry.id === engine);
        if (chosen) setPort(String(chosen.port));
    }, [engine, engines, connection]);

    const chosenManaged = managed.find((entry) => entry.id === managedId) ?? null;

    const ssh = useMemo<SshTunnelInput | null>(() => {
        if (kind !== "manual" || !tunnelled) return null;
        if (tunnelKind === "server") return { mode: "server", hostId: serverId };
        return {
            mode: "manual",
            host: sshHost,
            port: Number(sshPort),
            username: sshUser,
            authMethod: sshAuth,
            password: sshAuth === "password" ? sshPassword : null,
            privateKey: sshAuth === "key" ? sshKey : null,
            passphrase: sshAuth === "key" ? sshPassphrase : null,
            jumpHostId: jumpId === NO_JUMP || jumpId === JUMP_UNPICKED ? null : jumpId
        };
    }, [
        kind,
        tunnelled,
        tunnelKind,
        serverId,
        sshHost,
        sshPort,
        sshUser,
        sshAuth,
        sshPassword,
        sshKey,
        sshPassphrase,
        jumpId
    ]);

    const draft = useMemo<SaveConnectionInput>(
        () => ({
            id: connection?.id ?? null,
            name,
            engine: (kind === "managed" ? (chosenManaged?.engine ?? engine) : engine) as never,
            managedDatabaseId: kind === "managed" ? managedId || null : null,
            host: kind === "manual" ? host : null,
            port: kind === "manual" ? Number(port) : null,
            database: kind === "manual" ? database : null,
            username: kind === "manual" ? username : null,
            password: password || null,
            tls,
            readOnly,
            ssh
        }),
        [
            connection,
            name,
            kind,
            chosenManaged,
            engine,
            managedId,
            host,
            port,
            database,
            username,
            password,
            tls,
            readOnly,
            ssh
        ]
    );

    // The same schema the action parses. A field with nothing in it yet is
    // incomplete rather than wrong, so its message is held back until something
    // has been typed into it - see `shown`.
    const issues = connectionIssues(draft);
    const shown = (key: string, value: string): string | undefined =>
        value.trim() === "" ? undefined : issues[key];

    // A stored SSH secret is only kept when the login still signs in the same
    // way: switching from a password to a key leaves nothing to keep, so it has
    // to be asked for here rather than refused by the server after a round trip.
    const keepsSshSecret = saved?.mode === "manual" && saved.authMethod === sshAuth;
    const missingSecret =
        ssh?.mode === "manual" &&
        !keepsSshSecret &&
        (sshAuth === "password" ? sshPassword === "" : sshKey === "");

    // The bastion this tunnel went through was removed, so its picker starts
    // unanswered: a connection quietly becoming a direct one is nobody's choice.
    const jumpGone = saved?.mode === "manual" && saved.jumpMissing;
    const jumpUnpicked = ssh?.mode === "manual" && jumpGone && jumpId === JUMP_UNPICKED;

    // The same for a tunnel through a registered server that was removed.
    const serverGone = saved?.mode === "server" && saved.hostId === null;

    const complete =
        Object.keys(issues).length === 0 &&
        (kind === "managed" ? managedId !== "" && !chosenManaged?.refusal : true) &&
        !missingSecret &&
        !jumpUnpicked;

    const save = async () => {
        if (!complete || saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(() => actions.saveConnectionAction(draft), setError);
        setSaving(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        if (result.id) onSaved(result.id);
    };

    const serverOptions = servers.map((server) => ({
        value: server.id,
        label: `${server.name} - ${server.address}`
    }));

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{connection ? "Edit connection" : "New connection"}</DialogTitle>
                    <DialogDescription>
                        A database Polaris runs, or one somewhere else you have the credentials for.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto overscroll-contain px-0.5">
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

                    <Field label="Name" error={shown("name", name)}>
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
                                {chosenManaged?.refusal ? (
                                    <p className="text-xs text-warning">{chosenManaged.refusal}</p>
                                ) : (
                                    chosenManaged &&
                                    !chosenManaged.reachable && (
                                        <p className="text-xs text-warning">
                                            This one runs on another server and is not published on a
                                            port, so Polaris cannot reach it from here. Publish it on a
                                            port from the database&apos;s own screen first.
                                        </p>
                                    )
                                )}
                            </>
                        )
                    ) : (
                        <>
                            <div className="flex gap-3">
                                <Field label="Engine" className="flex-1">
                                    <DbEngineSelect
                                        engines={core.DB_ENGINES}
                                        value={engine}
                                        onValueChange={(next) => setEngine(next as typeof engine)}
                                    />
                                </Field>
                                <Field label="Port" className="w-28" error={shown("port", port)}>
                                    <Input
                                        inputMode="numeric"
                                        value={port}
                                        onChange={(event) => setPort(event.target.value)}
                                    />
                                </Field>
                            </div>
                            <Field
                                label="Host"
                                error={shown("host", host)}
                                hint={
                                    tunnelled
                                        ? "As the SSH server sees it - usually 127.0.0.1."
                                        : undefined
                                }
                            >
                                <Input
                                    value={host}
                                    placeholder={tunnelled ? "127.0.0.1" : "db.example.com"}
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

                            <Toggle
                                label="Reach it over SSH"
                                hint="For a database that is not published on the network: Polaris signs in to a server that can see it and forwards the port."
                                checked={tunnelled}
                                onChange={setTunnelled}
                            />
                            {tunnelled && (
                                <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-3">
                                    <SegmentedControl
                                        className="self-start"
                                        aria-label="Which SSH login"
                                        value={tunnelKind}
                                        onValueChange={(next) =>
                                            setTunnelKind(next as "server" | "manual")
                                        }
                                        options={[
                                            { value: "server", label: "A server in Polaris" },
                                            { value: "manual", label: "Another login" }
                                        ]}
                                    />
                                    {tunnelKind === "server" ? (
                                        servers.length === 0 ? (
                                            <p className="text-sm text-muted-foreground">
                                                No servers are connected yet. Add one under Servers, or
                                                use another login here.
                                            </p>
                                        ) : (
                                            <Field
                                                label="Server"
                                                error={
                                                    serverGone && serverId === ""
                                                        ? "The server this connection tunnelled through was removed from Servers. Pick another."
                                                        : undefined
                                                }
                                                hint={serverId === "" ? issues["ssh.hostId"] : undefined}
                                            >
                                                <Select
                                                    value={serverId}
                                                    onValueChange={setServerId}
                                                    aria-label="Server to tunnel through"
                                                    placeholder="Pick one..."
                                                    options={serverOptions}
                                                />
                                            </Field>
                                        )
                                    ) : (
                                        <>
                                            <div className="flex gap-3">
                                                <Field
                                                    label="SSH host"
                                                    className="flex-1"
                                                    error={shown("ssh.host", sshHost)}
                                                >
                                                    <Input
                                                        value={sshHost}
                                                        placeholder="ssh.example.com"
                                                        onChange={(event) =>
                                                            setSshHost(event.target.value)
                                                        }
                                                    />
                                                </Field>
                                                <Field
                                                    label="Port"
                                                    className="w-24"
                                                    error={shown("ssh.port", sshPort)}
                                                >
                                                    <Input
                                                        inputMode="numeric"
                                                        value={sshPort}
                                                        onChange={(event) =>
                                                            setSshPort(event.target.value)
                                                        }
                                                    />
                                                </Field>
                                            </div>
                                            <Field
                                                label="SSH user"
                                                error={shown("ssh.username", sshUser)}
                                            >
                                                <Input
                                                    value={sshUser}
                                                    placeholder="root"
                                                    onChange={(event) =>
                                                        setSshUser(event.target.value)
                                                    }
                                                />
                                            </Field>
                                            <SegmentedControl
                                                className="self-start"
                                                aria-label="How to sign in over SSH"
                                                value={sshAuth}
                                                onValueChange={(next) =>
                                                    setSshAuth(next as SshAuthMethod)
                                                }
                                                options={[
                                                    { value: "password", label: "Password" },
                                                    { value: "key", label: "Private key" }
                                                ]}
                                            />
                                            {sshAuth === "password" ? (
                                                <Field
                                                    label="SSH password"
                                                    hint={
                                                        keepsSshSecret
                                                            ? "Leave empty to keep the saved one."
                                                            : "Needed to sign in to the SSH server."
                                                    }
                                                >
                                                    <Input
                                                        type="password"
                                                        value={sshPassword}
                                                        onChange={(event) =>
                                                            setSshPassword(event.target.value)
                                                        }
                                                    />
                                                </Field>
                                            ) : (
                                                <>
                                                    <Field
                                                        label="Private key"
                                                        hint={
                                                            keepsSshSecret
                                                                ? "Leave empty to keep the saved one."
                                                                : "The key itself, not a path to it. Needed to sign in."
                                                        }
                                                    >
                                                        <Textarea
                                                            rows={4}
                                                            spellCheck={false}
                                                            value={sshKey}
                                                            placeholder="Paste the key here"
                                                            onChange={(event) =>
                                                                setSshKey(event.target.value)
                                                            }
                                                            className="font-mono text-xs"
                                                        />
                                                    </Field>
                                                    <Field label="Key passphrase" hint="If it has one.">
                                                        <Input
                                                            type="password"
                                                            value={sshPassphrase}
                                                            onChange={(event) =>
                                                                setSshPassphrase(event.target.value)
                                                            }
                                                        />
                                                    </Field>
                                                </>
                                            )}
                                            {(servers.length > 0 || jumpGone) && (
                                                <Field
                                                    label="Jump through"
                                                    error={
                                                        jumpUnpicked
                                                            ? "The server this tunnel jumped through was removed from Servers. Pick another, or reach it straight."
                                                            : undefined
                                                    }
                                                    hint="A server Polaris already has, used to reach that SSH host."
                                                >
                                                    <Select
                                                        value={jumpId}
                                                        onValueChange={setJumpId}
                                                        aria-label="Server to jump through"
                                                        placeholder="Pick one..."
                                                        options={[
                                                            { value: NO_JUMP, label: "Straight to it" },
                                                            ...serverOptions
                                                        ]}
                                                    />
                                                </Field>
                                            )}
                                        </>
                                    )}
                                    <p className="text-xs text-muted-foreground">
                                        The SSH server&apos;s key is remembered when this is saved, and
                                        checked on every connection after.
                                    </p>
                                </div>
                            )}
                        </>
                    )}

                    <Toggle
                        label="Read-only"
                        hint="Refuses anything that would change the database. Turn it on for a database you came here to read."
                        checked={readOnly}
                        onChange={setReadOnly}
                    />

                    {error && (
                        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
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
    error,
    className,
    children
}: {
    label: string;
    hint?: string;
    /** What is wrong with what is in it, drawn in place of the hint. */
    error?: string;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <label className={cn("flex flex-col gap-1 text-xs text-muted-foreground", className)}>
            {label}
            {children}
            {error ? <span className="text-danger">{error}</span> : hint ? <span>{hint}</span> : null}
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
