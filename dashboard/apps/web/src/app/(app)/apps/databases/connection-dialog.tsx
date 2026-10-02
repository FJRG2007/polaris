"use client";

// enigma:allow-no-breach-check these password fields hold the credentials of
// somebody else's database or SSH server, which this form does not create.
// enigma:allow-identity-password same reason: there is no account password here.

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
 * Encryption is the four modes every client names the same way (libpq's
 * `sslmode`), and a mode that checks nothing is only ever the reader's choice,
 * said as what it is when picked. A self-signed server is trusted the way the SSH
 * key below it is: its certificate is read when the connection is saved and
 * checked every time after.
 *
 * Read-only is a tick, off unless somebody makes the choice: the browser refuses
 * writes when it is on, and defaulting it on made every new connection a
 * surprise on the first UPDATE.
 *
 * Every field is checked as it is typed against the schema the server parses the
 * save with, so a value the server would refuse is refused here first, in the
 * same words. No secret comes back from the server: a stored password, key or
 * client certificate is said to be there, never shown, and is kept when its
 * field is left empty - unless the connection now points somewhere else, which
 * asks for it again.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { dataText } from "@/lib/data/words";
import { runAction } from "@/lib/run-action";
import { useEffect, useMemo, useRef, useState } from "react";
import { DbEngineSelect } from "@/components/db-engine-select";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DataConnectionView, ManagedOption } from "@/lib/data/connections";
import { Loader2, Plug, Database, Upload, KeyRound, ShieldAlert, Activity } from "lucide-react";
import * as schema from "@/lib/data/connection-schema";
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
    const savedTls = connection?.tls ?? null;
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
    const [readOnly, setReadOnly] = useState(connection?.readOnly ?? false);

    // Encryption. A new connection's mode follows the host until somebody picks
    // one: a public name starts on full verification, anything else off.
    const [tlsMode, setTlsMode] = useState<schema.TlsMode>(savedTls?.mode ?? "disable");
    const [tlsPicked, setTlsPicked] = useState(connection !== null);
    const [tlsTrust, setTlsTrust] = useState<schema.TlsTrust>(savedTls?.trust ?? "system");
    const [caCert, setCaCert] = useState("");
    const [clientAuth, setClientAuth] = useState(Boolean(savedTls?.clientCertificate));
    const [clientCert, setClientCert] = useState("");
    const [clientKey, setClientKey] = useState("");

    // The tunnel, if there is one. Held whether or not it is switched on, so
    // turning it off to try something and back on does not empty the form.
    const [tunnelled, setTunnelled] = useState(saved !== null);
    const [tunnelKind, setTunnelKind] = useState<"server" | "manual">(saved?.mode ?? "server");
    const [serverId, setServerId] = useState(saved?.mode === "server" ? (saved.hostId ?? "") : "");
    const [sshHost, setSshHost] = useState(saved?.mode === "manual" ? saved.host : "");
    const [sshPort, setSshPort] = useState(saved?.mode === "manual" ? String(saved.port) : "22");
    const [sshUser, setSshUser] = useState(saved?.mode === "manual" ? saved.username : "");
    const [sshAuth, setSshAuth] = useState<schema.SshAuthMethod>(
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
    const [testing, setTesting] = useState(false);
    const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);
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

    useEffect(() => {
        if (tlsPicked) return;
        setTlsMode(schema.looksPublic(host) && !tunnelled ? "verify-full" : "disable");
    }, [host, tunnelled, tlsPicked]);

    const chosenManaged = managed.find((entry) => entry.id === managedId) ?? null;

    const ssh = useMemo<schema.SshTunnelInput | null>(() => {
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

    const verifying = tlsMode === "verify-ca" || tlsMode === "verify-full";
    const draft = useMemo<schema.SaveConnectionInput>(
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
            tlsMode: kind === "manual" ? tlsMode : "disable",
            tlsTrust: verifying ? tlsTrust : "system",
            tlsCaCert: verifying && tlsTrust === "upload" ? caCert || null : null,
            tlsClientAuth: kind === "manual" && tlsMode !== "disable" && clientAuth,
            tlsClientCert: clientAuth ? clientCert || null : null,
            tlsClientKey: clientAuth ? clientKey || null : null,
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
            tlsMode,
            verifying,
            tlsTrust,
            caCert,
            clientAuth,
            clientCert,
            clientKey,
            readOnly,
            ssh
        ]
    );

    // The same schema the action parses. A field with nothing in it yet is
    // incomplete rather than wrong, so its message is held back until something
    // has been typed into it - see `shown`.
    const issues = schema.connectionIssues(draft);
    const shown = (key: string, value: string): string | undefined =>
        value.trim() === "" ? undefined : dataText(t, issues[key]);

    // A stored secret is only kept while the connection still points where it
    // was saved for. The server enforces it; the form says it before a round trip.
    const sameDestination =
        connection !== null &&
        connection.engine === engine &&
        (connection.host ?? "") === host.trim() &&
        String(connection.port ?? "") === port.trim() &&
        sameTunnel(saved, ssh);
    const passwordAgain = connection?.hasPassword === true && !sameDestination && password === "";

    // A stored SSH secret is only kept when the login still signs in the same
    // way, to the same server: anything else leaves nothing to keep.
    const keepsSshSecret =
        saved?.mode === "manual" &&
        saved.authMethod === sshAuth &&
        saved.host === sshHost.trim() &&
        String(saved.port) === sshPort.trim() &&
        saved.username === sshUser.trim();
    const [replacingKey, setReplacingKey] = useState(false);
    const missingSecret =
        ssh?.mode === "manual" &&
        !keepsSshSecret &&
        (sshAuth === "password" ? sshPassword === "" : sshKey === "");

    const keyShape = sshKey.trim() ? schema.sshKeyShape(sshKey) : null;
    const keyLocked = keyShape?.kind === "private" && keyShape.encrypted;

    // What ssh2 itself makes of the key, asked once the text settles.
    const [keyRead, setKeyRead] = useState<{ text: string; error?: string; summary?: string } | null>(null);
    useEffect(() => {
        if (sshAuth !== "key" || !sshKey.trim() || keyShape?.kind !== "private") {
            setKeyRead(null);
            return;
        }
        if (keyLocked && !sshPassphrase) {
            setKeyRead(null);
            return;
        }
        let live = true;
        const timer = setTimeout(() => {
            void actions.inspectKeyAction(sshKey, sshPassphrase || null).then((result) => {
                if (!live) return;
                setKeyRead(
                    result.error
                        ? { text: sshKey, error: result.error }
                        : { text: sshKey, summary: `${result.type} ${result.fingerprint}` }
                );
            });
        }, 500);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [sshAuth, sshKey, sshPassphrase, keyShape?.kind, keyLocked]);
    const keyError =
        shown("ssh.privateKey", sshKey) ?? (keyRead?.text === sshKey ? keyRead.error : undefined);

    // The bastion this tunnel went through was removed, so its picker starts
    // unanswered: a connection quietly becoming a direct one is nobody's choice.
    const jumpGone = saved?.mode === "manual" && saved.jumpMissing;
    const jumpUnpicked = ssh?.mode === "manual" && jumpGone && jumpId === JUMP_UNPICKED;

    // The same for a tunnel through a registered server that was removed.
    const serverGone = saved?.mode === "server" && saved.hostId === null;

    const caMissing =
        kind === "manual" &&
        verifying &&
        tlsTrust === "upload" &&
        !caCert &&
        !(savedTls?.trust === "upload" && savedTls.authority);
    const clientMissing =
        kind === "manual" &&
        tlsMode !== "disable" &&
        clientAuth &&
        !clientCert &&
        !(savedTls?.clientCertificate && sameDestination);

    const complete =
        Object.keys(issues).length === 0 &&
        (kind === "managed" ? managedId !== "" && !chosenManaged?.refusal : true) &&
        !missingSecret &&
        !jumpUnpicked &&
        !passwordAgain &&
        !caMissing &&
        !clientMissing &&
        !(keyRead?.text === sshKey && keyRead.error);

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

    const test = async () => {
        if (!complete || testing) return;
        setTesting(true);
        setTested(null);
        const result = await runAction(() => actions.testDraftAction(draft), setError);
        setTesting(false);
        if (!result) return;
        setTested(
            result.error
                ? { ok: false, text: result.error }
                : { ok: true, text: t("dialog.testOk", { version: result.version ?? "" }) }
        );
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
                                <Field label={t("dialog.engine")} className="min-w-0 flex-1">
                                    <DbEngineSelect
                                        engines={core.DB_ENGINES}
                                        value={engine}
                                        onValueChange={(next) => setEngine(next as typeof engine)}
                                    />
                                </Field>
                                <Field label={t("dialog.port")} className="w-24 shrink-0" error={shown("port", port)}>
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
                                <Field label={t("dialog.database")} className="min-w-0 flex-1">
                                    <Input
                                        value={database}
                                        placeholder={engine === "redis" ? "0" : "app"}
                                        onChange={(event) => setDatabase(event.target.value)}
                                    />
                                </Field>
                                <Field label={t("dialog.user")} className="min-w-0 flex-1">
                                    <Input
                                        value={username}
                                        onChange={(event) => setUsername(event.target.value)}
                                    />
                                </Field>
                            </div>
                            <Field
                                label={t("dialog.password")}
                                error={passwordAgain ? t("dialog.passwordAgain") : undefined}
                                hint={connection?.hasPassword ? t("dialog.keepSaved") : undefined}
                            >
                                <Input
                                    type="password"
                                    autoComplete="new-password"
                                    value={password}
                                    placeholder={connection?.hasPassword ? t("dialog.savedSecret") : undefined}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </Field>

                            <Field label={t("dialog.tls")} hint={t(`dialog.tlsModes.${tlsMode}.hint`)}>
                                <Select
                                    value={tlsMode}
                                    onValueChange={(next) => {
                                        setTlsPicked(true);
                                        setTlsMode(next as schema.TlsMode);
                                    }}
                                    aria-label={t("dialog.tls")}
                                    options={(["disable", "require", "verify-ca", "verify-full"] as const).map(
                                        (mode) => ({ value: mode, label: t(`dialog.tlsModes.${mode}.label`) })
                                    )}
                                />
                            </Field>
                            {tlsMode === "require" && (
                                <p className="flex items-start gap-2 text-xs text-warning">
                                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                                    {savedTls?.legacy ? t("dialog.tlsLegacy") : t("dialog.tlsUnverified")}
                                </p>
                            )}
                            {verifying && (
                                <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
                                    <Field label={t("dialog.tlsTrust")}>
                                        <Select
                                            value={tlsTrust}
                                            onValueChange={(next) => setTlsTrust(next as schema.TlsTrust)}
                                            aria-label={t("dialog.tlsTrust")}
                                            options={(["system", "upload", "server"] as const).map((trust) => ({
                                                value: trust,
                                                label: t(`dialog.tlsTrusts.${trust}`)
                                            }))}
                                        />
                                    </Field>
                                    {tlsTrust === "upload" && (
                                        <FileField
                                            label={t("dialog.caCert")}
                                            accept=".pem,.crt,.cer,.ca-bundle"
                                            maxBytes={schema.MAX_CERT_BYTES}
                                            value={caCert}
                                            onChange={setCaCert}
                                            saved={
                                                savedTls?.trust === "upload" && savedTls.authority
                                                    ? savedTls.authority.subject
                                                    : null
                                            }
                                            error={shown("tlsCaCert", caCert)}
                                        />
                                    )}
                                    {tlsTrust === "server" && (
                                        <>
                                            <p className="text-xs text-muted-foreground">{t("dialog.tlsServerNote")}</p>
                                            {connection &&
                                                savedTls?.trust === "server" &&
                                                savedTls.authority &&
                                                sameDestination && (
                                                    <CertificateCheck
                                                        connectionId={connection.id}
                                                        trusted={savedTls.authority}
                                                    />
                                                )}
                                        </>
                                    )}
                                </div>
                            )}
                            {tlsMode !== "disable" && (
                                <>
                                    <Toggle
                                        label={t("dialog.clientCert")}
                                        hint={t("dialog.clientCertHint")}
                                        checked={clientAuth}
                                        onChange={setClientAuth}
                                    />
                                    {clientAuth && (
                                        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
                                            <FileField
                                                label={t("dialog.clientCertFile")}
                                                accept=".pem,.crt,.cer"
                                                maxBytes={schema.MAX_CERT_BYTES}
                                                value={clientCert}
                                                onChange={setClientCert}
                                                saved={
                                                    sameDestination
                                                        ? (savedTls?.clientCertificate?.subject ?? null)
                                                        : null
                                                }
                                                error={shown("tlsClientCert", clientCert)}
                                            />
                                            <FileField
                                                label={t("dialog.clientKeyFile")}
                                                accept=".pem,.key"
                                                maxBytes={schema.MAX_KEY_BYTES}
                                                value={clientKey}
                                                onChange={setClientKey}
                                                saved={null}
                                                secret
                                                error={shown("tlsClientKey", clientKey)}
                                            />
                                        </div>
                                    )}
                                </>
                            )}

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
                                                    className="min-w-0 flex-1"
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
                                                    className="w-20 shrink-0"
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
                                                    setSshAuth(next as schema.SshAuthMethod)
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
                                                        autoComplete="new-password"
                                                        value={sshPassword}
                                                        placeholder={keepsSshSecret ? t("dialog.savedSecret") : undefined}
                                                        onChange={(event) =>
                                                            setSshPassword(event.target.value)
                                                        }
                                                    />
                                                </Field>
                                            ) : keepsSshSecret && !replacingKey && saved?.mode === "manual" ? (
                                                <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-xs">
                                                    <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="font-medium text-foreground">{t("dialog.keySaved")}</p>
                                                        {saved.keyFingerprint && (
                                                            <p
                                                                className="truncate font-mono text-muted-foreground"
                                                                title={`${saved.keyType ?? ""} ${saved.keyFingerprint}`}
                                                            >
                                                                {saved.keyType} {saved.keyFingerprint}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => setReplacingKey(true)}
                                                    >
                                                        {t("dialog.replace")}
                                                    </Button>
                                                </div>
                                            ) : (
                                                <>
                                                    <FileField
                                                        label={t("dialog.privateKey")}
                                                        accept=".pem,.key,.ppk,.openssh,application/x-pem-file,*"
                                                        maxBytes={schema.MAX_KEY_BYTES}
                                                        value={sshKey}
                                                        onChange={setSshKey}
                                                        saved={null}
                                                        secret
                                                        placeholder={t("dialog.keyPlaceholder")}
                                                        hint={
                                                            keyRead?.text === sshKey && keyRead.summary
                                                                ? keyRead.summary
                                                                : t("dialog.privateKeyHint")
                                                        }
                                                        error={keyError}
                                                    />
                                                    {(keyLocked || sshPassphrase !== "") && (
                                                        <Field
                                                            label={t("dialog.passphrase")}
                                                            hint={t("dialog.passphraseHint")}
                                                            error={shown("ssh.passphrase", sshPassphrase)}
                                                        >
                                                            <Input
                                                                type="password"
                                                                autoComplete="off"
                                                                value={sshPassphrase}
                                                                onChange={(event) =>
                                                                    setSshPassphrase(event.target.value)
                                                                }
                                                            />
                                                        </Field>
                                                    )}
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
                                            {connection &&
                                                saved?.mode === "manual" &&
                                                saved.hostKeyFingerprint &&
                                                keepsSshSecret && (
                                                    <HostKeyCheck
                                                        connectionId={connection.id}
                                                        pinned={saved.hostKeyFingerprint}
                                                    />
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

                    {tested && (
                        <p
                            role="status"
                            className={cn(
                                "rounded-md px-3 py-2 text-sm",
                                tested.ok ? "bg-success-soft text-success-ink" : "bg-danger-soft text-danger-ink"
                            )}
                        >
                            {tested.text}
                        </p>
                    )}
                    {error && (
                        <p
                            role="alert"
                            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                        >
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter className="flex-wrap gap-2">
                    {kind === "manual" && (
                        <Button
                            variant="outline"
                            className="sm:mr-auto"
                            onClick={() => void test()}
                            disabled={!complete || testing}
                        >
                            {testing ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
                            {t("dialog.test")}
                        </Button>
                    )}
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

/** Whether the tunnel in the form leads to the same place as the saved one. */
function sameTunnel(saved: DataConnectionView["tunnel"], ssh: schema.SshTunnelInput | null): boolean {
    if (!saved || !ssh) return !saved && !ssh;
    if (saved.mode === "server" || ssh.mode === "server") {
        return saved.mode === "server" && ssh.mode === "server" && saved.hostId === ssh.hostId;
    }
    return (
        saved.host === ssh.host.trim() &&
        saved.port === Number(ssh.port ?? 22) &&
        (saved.jumpHostId ?? null) === (ssh.jumpHostId ?? null)
    );
}

/**
 * A secret or a certificate given as a file or pasted: a textarea that takes a
 * drop, and a button that opens the file picker. The file is read here, in the
 * browser, and goes to the server the way a typed value does - never uploaded on
 * its own. A stored value is named, never shown, and replaced by giving a new one.
 */
function FileField({
    label,
    accept,
    maxBytes,
    value,
    onChange,
    saved,
    secret = false,
    placeholder,
    hint,
    error
}: {
    label: string;
    accept: string;
    maxBytes: number;
    value: string;
    onChange: (next: string) => void;
    /** What is stored, said as itself (a certificate's subject), or null. */
    saved: string | null;
    secret?: boolean;
    placeholder?: string;
    hint?: string;
    error?: string;
}) {
    const t = useTranslations("databases");
    const picker = useRef<HTMLInputElement>(null);
    const [over, setOver] = useState(false);
    const [refused, setRefused] = useState("");

    const take = (file: File | undefined) => {
        if (!file) return;
        setRefused("");
        if (file.size > maxBytes) {
            setRefused(t("refusals.fileTooLarge"));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => onChange(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => setRefused(t("dialog.fileUnreadable"));
        reader.readAsText(file);
    };

    const said = refused || error;
    return (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <div className="flex items-center justify-between gap-2">
                <span>{label}</span>
                <Button variant="ghost" size="xs" onClick={() => picker.current?.click()}>
                    <Upload />
                    {t("dialog.chooseFile")}
                </Button>
                <input
                    ref={picker}
                    type="file"
                    accept={accept}
                    className="hidden"
                    aria-hidden
                    tabIndex={-1}
                    onChange={(event) => {
                        take(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </div>
            <Textarea
                rows={4}
                spellCheck={false}
                autoComplete="off"
                aria-label={label}
                aria-invalid={said ? true : undefined}
                value={value}
                placeholder={saved ? t("dialog.savedFile", { what: saved }) : (placeholder ?? t("dialog.filePlaceholder"))}
                onChange={(event) => onChange(event.target.value)}
                onDragOver={(event) => {
                    event.preventDefault();
                    setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(event) => {
                    event.preventDefault();
                    setOver(false);
                    take(event.dataTransfer.files?.[0]);
                }}
                className={cn("font-mono text-xs", secret && value && "[-webkit-text-security:disc]", over && "border-primary")}
            />
            {said ? <span className="text-danger">{said}</span> : hint ? <span className="break-all">{hint}</span> : null}
        </div>
    );
}

/**
 * The SSH server's key, checked against the pinned one on request. A changed
 * key is shown next to the old one, and trusted only by pressing the button
 * under it - after which the server re-reads it and refuses if it changed again.
 */
function HostKeyCheck({ connectionId, pinned }: { connectionId: string; pinned: string }) {
    const t = useTranslations("databases");
    const [state, setState] = useState<
        | { kind: "idle" }
        | { kind: "busy" }
        | { kind: "same" }
        | { kind: "changed"; presented: string }
        | { kind: "trusted"; fingerprint: string }
        | { kind: "failed"; text: string }
    >({ kind: "idle" });
    const current = state.kind === "trusted" ? state.fingerprint : pinned;

    const check = async () => {
        setState({ kind: "busy" });
        const result = await actions.checkHostKeyAction(connectionId);
        if (result.error || !result.check) return setState({ kind: "failed", text: result.error ?? "" });
        setState(result.check.matches ? { kind: "same" } : { kind: "changed", presented: result.check.presented });
    };
    const trust = async (fingerprint: string) => {
        setState({ kind: "busy" });
        const result = await actions.trustHostKeyAction(connectionId, fingerprint);
        if (result.error) return setState({ kind: "failed", text: result.error });
        setState({ kind: "trusted", fingerprint: result.fingerprint ?? fingerprint });
    };

    return (
        <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-xs">
            <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground">{t("dialog.hostKey")}</p>
                    <p className="truncate font-mono text-muted-foreground" title={current}>
                        {current}
                    </p>
                </div>
                <Button variant="outline" size="sm" disabled={state.kind === "busy"} onClick={() => void check()}>
                    {state.kind === "busy" && <Loader2 className="size-4 animate-spin" />}
                    {t("dialog.checkKey")}
                </Button>
            </div>
            {state.kind === "same" && <p className="text-success-ink">{t("dialog.keySame")}</p>}
            {state.kind === "trusted" && <p className="text-success-ink">{t("dialog.keyTrusted")}</p>}
            {state.kind === "failed" && <p className="text-danger">{state.text}</p>}
            {state.kind === "changed" && (
                <div role="alert" className="flex flex-col gap-2 rounded-md bg-danger-soft p-2 text-danger-ink">
                    <p className="font-medium">{t("dialog.keyDifferent")}</p>
                    <p className="break-all font-mono">{state.presented}</p>
                    <p>{t("dialog.keyDifferentHint")}</p>
                    <Button variant="danger" size="sm" className="self-start" onClick={() => void trust(state.presented)}>
                        {t("dialog.trustKey")}
                    </Button>
                </div>
            )}
        </div>
    );
}

/** The trusted server certificate, checked against the presented one on request. */
function CertificateCheck({
    connectionId,
    trusted
}: {
    connectionId: string;
    trusted: NonNullable<DataConnectionView["tls"]["authority"]>;
}) {
    const t = useTranslations("databases");
    const [state, setState] = useState<
        | { kind: "idle" }
        | { kind: "busy" }
        | { kind: "same" }
        | { kind: "changed"; subject: string; fingerprint: string }
        | { kind: "trusted" }
        | { kind: "failed"; text: string }
    >({ kind: "idle" });

    const check = async () => {
        setState({ kind: "busy" });
        const result = await actions.checkCertificateAction(connectionId);
        if (result.error || !result.check) return setState({ kind: "failed", text: result.error ?? "" });
        setState(
            result.check.matches
                ? { kind: "same" }
                : {
                      kind: "changed",
                      subject: result.check.presented.subject,
                      fingerprint: result.check.presented.fingerprint
                  }
        );
    };
    const trust = async (fingerprint: string) => {
        setState({ kind: "busy" });
        const result = await actions.trustCertificateAction(connectionId, fingerprint);
        if (result.error) return setState({ kind: "failed", text: result.error });
        setState({ kind: "trusted" });
    };

    return (
        <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-xs">
            <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground" title={trusted.subject}>
                        {trusted.subject}
                    </p>
                    <p className="truncate font-mono text-muted-foreground" title={trusted.fingerprint}>
                        {trusted.fingerprint}
                    </p>
                </div>
                <Button variant="outline" size="sm" disabled={state.kind === "busy"} onClick={() => void check()}>
                    {state.kind === "busy" && <Loader2 className="size-4 animate-spin" />}
                    {t("dialog.checkCert")}
                </Button>
            </div>
            {state.kind === "same" && <p className="text-success-ink">{t("dialog.certSame")}</p>}
            {state.kind === "trusted" && <p className="text-success-ink">{t("dialog.certTrusted")}</p>}
            {state.kind === "failed" && <p className="text-danger">{state.text}</p>}
            {state.kind === "changed" && (
                <div role="alert" className="flex flex-col gap-2 rounded-md bg-danger-soft p-2 text-danger-ink">
                    <p className="font-medium">{t("dialog.certDifferent")}</p>
                    <p className="break-all">{state.subject}</p>
                    <p className="break-all font-mono">{state.fingerprint}</p>
                    <Button
                        variant="danger"
                        size="sm"
                        className="self-start"
                        onClick={() => void trust(state.fingerprint)}
                    >
                        {t("dialog.trustCert")}
                    </Button>
                </div>
            )}
        </div>
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
