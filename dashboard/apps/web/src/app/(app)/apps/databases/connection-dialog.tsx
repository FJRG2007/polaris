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
import { dataText } from "@/lib/data/words";
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    const t = useTranslations("databases");
    const tcommon = useTranslations("common");
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
        value.trim() === "" ? undefined : dataText(t, issues[key]);

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
                    <DialogTitle>{connection ? t("dialog.editTitle") : t("dialog.newTitle")}</DialogTitle>
                    <DialogDescription>{t("dialog.intro")}</DialogDescription>
                </DialogHeader>

                <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto overscroll-contain px-0.5">
                    <SegmentedControl
                        className="self-start"
                        aria-label={t("dialog.which")}
                        value={kind}
                        onValueChange={(next) => setKind(next)}
                        options={[
                            { value: "managed", label: t("dialog.managed") },
                            { value: "manual", label: t("dialog.manual") }
                        ]}
                    />

                    <Field label={t("dialog.name")} error={shown("name", name)}>
                        <Input
                            autoFocus
                            value={name}
                            placeholder={t("dialog.namePlaceholder")}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </Field>

                    {kind === "managed" ? (
                        managed.length === 0 ? (
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Database className="size-4 shrink-0" />
                                {t("dialog.noManaged")}
                            </p>
                        ) : (
                            <>
                                <Field label={t("dialog.database")}>
                                    <Select
                                        value={managedId}
                                        onValueChange={setManagedId}
                                        aria-label={t("dialog.whichManaged")}
                                        placeholder={t("dialog.pickOne")}
                                        options={managed.map((entry) => ({
                                            value: entry.id,
                                            label: `${entry.name} - ${entry.where}`
                                        }))}
                                    />
                                </Field>
                                {chosenManaged?.refusal ? (
                                    <p className="text-xs text-warning">{dataText(t, chosenManaged.refusal)}</p>
                                ) : (
                                    chosenManaged &&
                                    !chosenManaged.reachable && (
                                        <p className="text-xs text-warning">
                                            {t("dialog.unreachable")}
                                        </p>
                                    )
                                )}
                            </>
                        )
                    ) : (
                        <>
                            <div className="flex gap-3">
                                <Field label={t("dialog.engine")} className="flex-1">
                                    <DbEngineSelect
                                        engines={core.DB_ENGINES}
                                        value={engine}
                                        onValueChange={(next) => setEngine(next as typeof engine)}
                                    />
                                </Field>
                                <Field label={t("dialog.port")} className="w-28" error={shown("port", port)}>
                                    <Input
                                        inputMode="numeric"
                                        value={port}
                                        onChange={(event) => setPort(event.target.value)}
                                    />
                                </Field>
                            </div>
                            <Field
                                label={t("dialog.host")}
                                error={shown("host", host)}
                                hint={tunnelled ? t("dialog.hostHint") : undefined}
                            >
                                <Input
                                    value={host}
                                    placeholder={tunnelled ? "127.0.0.1" : "db.example.com"}
                                    onChange={(event) => setHost(event.target.value)}
                                />
                            </Field>
                            <div className="flex gap-3">
                                <Field label={t("dialog.database")} className="flex-1">
                                    <Input
                                        value={database}
                                        placeholder={engine === "redis" ? "0" : "app"}
                                        onChange={(event) => setDatabase(event.target.value)}
                                    />
                                </Field>
                                <Field label={t("dialog.user")} className="flex-1">
                                    <Input
                                        value={username}
                                        onChange={(event) => setUsername(event.target.value)}
                                    />
                                </Field>
                            </div>
                            <Field
                                label={t("dialog.password")}
                                hint={connection ? t("dialog.keepSaved") : undefined}
                            >
                                <Input
                                    type="password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </Field>
                            <Toggle
                                label={t("dialog.tls")}
                                hint={t("dialog.tlsHint")}
                                checked={tls}
                                onChange={setTls}
                            />

                            <Toggle
                                label={t("dialog.ssh")}
                                hint={t("dialog.sshHint")}
                                checked={tunnelled}
                                onChange={setTunnelled}
                            />
                            {tunnelled && (
                                <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-3">
                                    <SegmentedControl
                                        className="self-start"
                                        aria-label={t("dialog.whichLogin")}
                                        value={tunnelKind}
                                        onValueChange={(next) =>
                                            setTunnelKind(next as "server" | "manual")
                                        }
                                        options={[
                                            { value: "server", label: t("dialog.serverLogin") },
                                            { value: "manual", label: t("dialog.otherLogin") }
                                        ]}
                                    />
                                    {tunnelKind === "server" ? (
                                        servers.length === 0 ? (
                                            <p className="text-sm text-muted-foreground">
                                                {t("dialog.noServers")}
                                            </p>
                                        ) : (
                                            <Field
                                                label={t("dialog.server")}
                                                error={
                                                    serverGone && serverId === ""
                                                        ? t("dialog.serverGone")
                                                        : undefined
                                                }
                                                hint={
                                                    serverId === ""
                                                        ? dataText(t, issues["ssh.hostId"])
                                                        : undefined
                                                }
                                            >
                                                <Select
                                                    value={serverId}
                                                    onValueChange={setServerId}
                                                    aria-label={t("dialog.tunnelServer")}
                                                    placeholder={t("dialog.pickOne")}
                                                    options={serverOptions}
                                                />
                                            </Field>
                                        )
                                    ) : (
                                        <>
                                            <div className="flex gap-3">
                                                <Field
                                                    label={t("dialog.sshHost")}
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
                                                    label={t("dialog.port")}
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
                                                label={t("dialog.sshUser")}
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
                                                aria-label={t("dialog.sshAuth")}
                                                value={sshAuth}
                                                onValueChange={(next) =>
                                                    setSshAuth(next as SshAuthMethod)
                                                }
                                                options={[
                                                    { value: "password", label: t("dialog.password") },
                                                    { value: "key", label: t("dialog.privateKey") }
                                                ]}
                                            />
                                            {sshAuth === "password" ? (
                                                <Field
                                                    label={t("dialog.sshPassword")}
                                                    hint={
                                                        keepsSshSecret
                                                            ? t("dialog.keepSaved")
                                                            : t("dialog.sshPasswordHint")
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
                                                        label={t("dialog.privateKey")}
                                                        hint={
                                                            keepsSshSecret
                                                                ? t("dialog.keepSaved")
                                                                : t("dialog.privateKeyHint")
                                                        }
                                                    >
                                                        <Textarea
                                                            rows={4}
                                                            spellCheck={false}
                                                            value={sshKey}
                                                            placeholder={t("dialog.keyPlaceholder")}
                                                            onChange={(event) =>
                                                                setSshKey(event.target.value)
                                                            }
                                                            className="font-mono text-xs"
                                                        />
                                                    </Field>
                                                    <Field
                                                        label={t("dialog.passphrase")}
                                                        hint={t("dialog.passphraseHint")}
                                                        error={shown(
                                                            "ssh.passphrase",
                                                            sshPassphrase
                                                        )}
                                                    >
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
                                                    label={t("dialog.jump")}
                                                    error={jumpUnpicked ? t("dialog.jumpGone") : undefined}
                                                    hint={t("dialog.jumpHint")}
                                                >
                                                    <Select
                                                        value={jumpId}
                                                        onValueChange={setJumpId}
                                                        aria-label={t("dialog.jumpServer")}
                                                        placeholder={t("dialog.pickOne")}
                                                        options={[
                                                            {
                                                                value: NO_JUMP,
                                                                label: t("dialog.straight")
                                                            },
                                                            ...serverOptions
                                                        ]}
                                                    />
                                                </Field>
                                            )}
                                        </>
                                    )}
                                    <p className="text-xs text-muted-foreground">
                                        {t("dialog.hostKeyNote")}
                                    </p>
                                </div>
                            )}
                        </>
                    )}

                    <Toggle
                        label={t("dialog.readOnly")}
                        hint={t("dialog.readOnlyHint")}
                        checked={readOnly}
                        onChange={setReadOnly}
                    />

                    {error && (
                        <p
                            role="alert"
                            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                        >
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {tcommon("actions.cancel")}
                    </Button>
                    <Button onClick={() => void save()} disabled={!complete || saving}>
                        {saving && <Loader2 className="size-4 animate-spin" />}
                        <Plug className="size-4" />
                        {connection ? tcommon("actions.save") : t("dialog.add")}
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
            {error ? (
                <span className="text-danger">{error}</span>
            ) : hint ? (
                <span>{hint}</span>
            ) : null}
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
