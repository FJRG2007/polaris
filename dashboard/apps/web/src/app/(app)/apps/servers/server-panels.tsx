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
import { renameServerAction } from "./actions";
import { CopyButton } from "@/components/copy-button";
import type { ServerRow, ServerStatus } from "./types";

/** Name the server. Save stays disabled until the value actually differs, so a
 *  field touched and put back cannot write the name it already had. */
export function RenameForm({ server, onRenamed }: { server: ServerRow; onRenamed: () => void }) {
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
            Name
            <span className="flex gap-2">
                <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={local ? "This server" : undefined}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                />
                <Button variant="secondary" disabled={!changed || pending} onClick={() => void save()}>
                    {pending ? "Saving..." : "Save"}
                </Button>
            </span>
            {error ? <span className="text-xs text-danger">{error}</span> : null}
        </label>
    );
}

/** Whether it answered, and how long it took. The local box is never probed - it
 *  is the machine serving this page. */
export function Reachability({ server, status }: { server: ServerRow; status: ServerStatus | null }) {
    if (server.kind === "local") {
        return <p className="text-sm text-muted-foreground">Running Polaris, so it is up by definition.</p>;
    }
    if (!status) return <p className="text-sm text-muted-foreground">Checking whether it answers...</p>;
    if (status.state === "up") {
        return (
            <p className="text-sm text-success">
                Answering on port {server.port ?? 22}
                {status.latencyMs === null ? "" : ` in ${status.latencyMs} ms`}.
            </p>
        );
    }
    return <p className="text-sm text-danger">Not answering: {status.detail ?? "no reason given"}.</p>;
}

/** The Polaris box has no SSH login of its own to hand out - nothing enrolled it,
 *  so there is no account and no key. Say what to do instead of leaving an empty
 *  section where the commands are for every other server. */
export function LocalNote() {
    return (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Polaris has no login of its own on this machine, so there is nothing to copy here. Sign in the way you
            already do, or add it with Add server to get a shell and its files in Polaris too.
        </p>
    );
}

/** Everything an operator needs to reach the machine with their own tools. */
export function Connect({ server }: { server: ServerRow }) {
    const port = server.port ?? 22;
    const account = `${server.detail}@${server.address}`;
    const ssh = port === 22 ? `ssh ${account}` : `ssh -p ${port} ${account}`;
    const sftp = port === 22 ? `sftp ${account}` : `sftp -P ${port} ${account}`;

    return (
        <div className="flex flex-col gap-3">
            <Command label="a shell" value={ssh} />
            <Command label="a file transfer" value={sftp} />

            <div className="flex flex-col gap-1">
                <span className="text-sm">Or in a file manager</span>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border p-3 text-xs">
                    <Field label="Protocol" value="SFTP (SSH)" />
                    <Field label="Host" value={server.address} copyable />
                    <Field label="Port" value={String(port)} />
                    <Field label="Username" value={server.detail} copyable />
                    <Field label="Sign in with" value={server.authMethod === "key" ? "Private key" : "Password"} />
                </dl>
            </div>

            <p className="text-xs text-muted-foreground">
                {server.authMethod === "key"
                    ? "The key Polaris uses stays in Polaris, so these connect with your own credentials for that account."
                    : "Use the password this server was registered with."}
            </p>
        </div>
    );
}

function Command({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">For {label}</span>
            <span className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <code className="flex-1 break-all font-mono text-xs">{value}</code>
                <CopyButton value={value} label="the command" />
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
