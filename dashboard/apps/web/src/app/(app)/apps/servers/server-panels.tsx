"use client";

/**
 * The pieces a single server's page is built from: what to call it, whether it is
 * answering, and how to reach it from outside Polaris.
 *
 * The commands are the point of the last one. Polaris connects over its own pinned
 * SSH session, and an operator who wants a terminal or a file manager of their own
 * has to type the same details in by hand; they are all here, ready to copy, with
 * the one thing that is NOT shared spelled out - the key Polaris signs in with
 * stays in Polaris, so these connect as whoever runs them.
 */

import { useState } from "react";
import { Button, Input } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import type { LocalPath } from "@/lib/server-local-path";
import { findLocalPathAction, renameServerAction, adoptLocalPathAction } from "./actions";
import { CopyButton } from "@/components/copy-button";
import type { ServerRow, ServerStatus } from "./types";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** Name the server. Save stays disabled until the value actually differs, so a
 *  field touched and put back cannot write the name it already had. */
export function RenameForm({ server, onRenamed }: { server: ServerRow; onRenamed: () => void }) {
    const t = useTranslations("servers");
    const tcommon = useTranslations("common");
    const [name, setName] = useState(server.name);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const local = server.kind === "local";
    const clean = name.trim();
    const changed = clean !== server.name && (local || clean.length > 0);

    async function save(): Promise<void> {
        setPending(true);
        setError(null);
        const result = await renameServerAction({ hostId: local ? null : server.id, name: clean });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onRenamed();
    }

    return (
        <label className="flex flex-col gap-1 text-sm">
            {t("host.name")}
            <span className="flex gap-2">
                <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={local ? t("enroll.thisServer") : undefined}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                />
                <Button variant="secondary" disabled={!changed || pending} onClick={() => void save()}>
                    {pending ? tcommon("actions.saving") : tcommon("actions.save")}
                </Button>
            </span>
            {error ? <span className="text-xs text-danger">{error}</span> : null}
        </label>
    );
}

/** Whether it answered, and how long it took. The local box is never probed - it
 *  is the machine serving this page. */
export function Reachability({ server, status }: { server: ServerRow; status: ServerStatus | null }) {
    const t = useTranslations("servers");
    if (server.kind === "local") {
        return <p className="text-sm text-muted-foreground">{t("reach.local")}</p>;
    }
    if (!status) return <p className="text-sm text-muted-foreground">{t("reach.checking")}</p>;
    if (status.state === "up") {
        return (
            <p className="text-sm text-success">
                {status.latencyMs === null
                    ? t("reach.up", { port: server.port ?? 22 })
                    : t("reach.upIn", { port: server.port ?? 22, ms: status.latencyMs })}
            </p>
        );
    }
    return (
        <p className="text-sm text-danger">
            {t("reach.down", { reason: status.detail ?? t("reach.noReason") })}
        </p>
    );
}

/** The Polaris box has no SSH login of its own to hand out - nothing enrolled it,
 *  so there is no account and no key. Say what to do instead of leaving an empty
 *  section where the commands are for every other server. */
export function LocalNote() {
    const t = useTranslations("servers");
    return (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {t("connect.localNote")}
        </p>
    );
}

/**
 * Whether Polaris is reaching this machine the long way round, and moving it.
 *
 * A server enrolled through its public name is connected to at that name for the
 * rest of its life, even when it turns out to be on the same switch: out to the
 * router, back in through the port forward, for every file listing and every
 * byte of every transfer. Nothing looks wrong, which is why nobody reports it -
 * it is simply slower than it needs to be, and it stops working when the line
 * does.
 *
 * Asked rather than watched. The check costs a connection to the machine and a
 * connection to each address it names, so it happens when somebody presses the
 * button rather than every time this page opens.
 *
 * Nothing moves without being verified: an address is only offered after it has
 * answered with the host key this server is already pinned to, and it is checked
 * again before it is written down.
 */
export function LocalPathPanel({ server }: { server: ServerRow }) {
    const t = useTranslations("servers");
    const [path, setPath] = useState<LocalPath | null>(null);
    const [busy, setBusy] = useState(false);
    const [moved, setMoved] = useState("");
    const [error, setError] = useState("");
    const router = useRouter();

    if (!server.hostId) return null;
    const hostId = server.hostId;

    const check = async () => {
        setBusy(true);
        setError("");
        setPath(null);
        const result = await runAction(() => findLocalPathAction(hostId), setError);
        setBusy(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setPath(result.path ?? null);
    };

    const move = async (address: string) => {
        setBusy(true);
        setError("");
        const result = await runAction(() => adoptLocalPathAction({ hostId, address }), setError);
        setBusy(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setMoved(address);
        setPath(null);
        router.refresh();
    };

    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col">
                    <span className="text-sm font-medium">{t("lan.title")}</span>
                    <span className="text-xs text-muted-foreground">
                        {t("lan.intro", { address: server.address })}
                    </span>
                </div>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
                    {busy ? t("status.checking") : t("lan.check")}
                </Button>
            </div>

            {moved ? (
                <p className="text-sm text-success">{t("lan.moved", { address: moved })}</p>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {path?.kind === "found" ? (
                <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm">
                        {/* Found by looking rather than by asking, which means the
                            address on record had stopped reaching it - almost always
                            a DHCP lease that moved. */}
                        {t.rich(path.moved ? "lan.foundMoved" : "lan.found", {
                            address: path.address,
                            mono: (chunks) => (
                                <span key="address" className="font-mono">
                                    {chunks}
                                </span>
                            )
                        })}
                    </p>
                    <Button size="sm" disabled={busy} onClick={() => void move(path.address)}>
                        {t("lan.use")}
                    </Button>
                </div>
            ) : null}
            {path?.kind === "already" ? (
                <p className="text-sm text-muted-foreground">
                    {t("lan.already", { address: path.address })}
                </p>
            ) : null}
            {path?.kind === "none" ? (
                <p className="text-sm text-muted-foreground">
                    {t("lan.none")}
                </p>
            ) : null}
            {path?.kind === "unreachable" ? (
                <p className="text-sm text-muted-foreground">
                    {t("lan.unreachable")}
                </p>
            ) : null}
            {path?.kind === "unknown" ? (
                <p className="text-sm text-muted-foreground">
                    {t("lan.unknown")}
                </p>
            ) : null}
        </div>
    );
}

/** Everything an operator needs to reach the machine with their own tools. */
export function Connect({ server }: { server: ServerRow }) {
    const t = useTranslations("servers");
    const port = server.port ?? 22;
    const account = `${server.detail}@${server.address}`;
    const ssh = port === 22 ? `ssh ${account}` : `ssh -p ${port} ${account}`;
    const sftp = port === 22 ? `sftp ${account}` : `sftp -P ${port} ${account}`;

    return (
        <div className="flex flex-col gap-3">
            <Command label={t("connect.forShell")} value={ssh} />
            <Command label={t("connect.forTransfer")} value={sftp} />

            <div className="flex flex-col gap-1">
                <span className="text-sm">{t("connect.fileManager")}</span>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border p-3 text-xs">
                    <Field label={t("connect.protocol")} value="SFTP (SSH)" />
                    <Field label={t("connect.host")} value={server.address} copyable />
                    <Field label={t("host.port")} value={String(port)} />
                    <Field label={t("host.username")} value={server.detail} copyable />
                    <Field
                        label={t("connect.signInWith")}
                        value={server.authMethod === "key" ? t("host.privateKey") : t("host.password")}
                    />
                </dl>
            </div>

            <p className="text-xs text-muted-foreground">
                {server.authMethod === "key"
                    ? t("connect.keyNote")
                    : t("connect.passwordNote")}
            </p>
        </div>
    );
}

function Command({ label, value }: { label: string; value: string }) {
    const t = useTranslations("servers");
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">{label}</span>
            <span className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <code className="flex-1 break-all font-mono text-xs">{value}</code>
                <CopyButton value={value} label={t("connect.theCommand")} />
            </span>
        </div>
    );
}

function Field({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="flex items-center gap-2 font-mono">
                <span className="break-all">{value}</span>
                {copyable ? <CopyButton value={value} label={label.toLowerCase()} /> : null}
            </dd>
        </>
    );
}
