"use client";

/**
 * Every server Polaris manages: the box it runs on - always listed first and never
 * removable - plus the SSH hosts registered for Containers (Docker) and Drive
 * (SFTP). Each row carries where the server lives, because that decides how a
 * domain is pointed at it; a server Polaris could not classify is flagged so the
 * operator answers before exposing anything. Delete uses an inline two-step
 * confirm (no native dialog).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Server, Trash2, TriangleAlert } from "lucide-react";
import type { ServerEnvironment } from "@polaris/core";
import { Badge, Button } from "@polaris/ui";
import { deleteHostAction } from "./actions";
import { HostDialog } from "./host-dialog";
import { ENVIRONMENT_META } from "./environment-meta";
import { EnvironmentDialog, type EnvironmentTarget } from "./environment-dialog";

export interface ServerRow {
    /** "local" for the Polaris box, otherwise the Host id. */
    id: string;
    kind: "local" | "host";
    name: string;
    /** Hostname for the local box, the SSH user for a registered host. */
    detail: string;
    address: string;
    port: number | null;
    authMethod: string | null;
    environment: ServerEnvironment;
    /** Wildcard domain pointed at this server, empty when none is configured. */
    wildcardDomain: string;
    /** What Polaris detected, offered as the default when the environment is unset. */
    suggested: ServerEnvironment;
    /** False while the value is only Polaris's guess, not the operator's answer. */
    confirmed: boolean;
}

export function ServersView({ servers }: { servers: ServerRow[] }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [target, setTarget] = useState<EnvironmentTarget | null>(null);

    const unset = servers.filter((server) => server.environment === "unknown");
    const remotes = servers.filter((server) => server.kind === "host");

    function onDelete(id: string) {
        startTransition(async () => {
            await deleteHostAction(id);
            setConfirmId(null);
            router.refresh();
        });
    }

    function askEnvironment(server: ServerRow) {
        setTarget({
            hostId: server.kind === "host" ? server.id : null,
            name: server.name,
            current: server.environment,
            wildcardDomain: server.wildcardDomain,
            suggested: server.suggested,
            confirmed: server.confirmed
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-muted-foreground">Servers</h2>
                <HostDialog />
            </div>

            {unset.length > 0 ? (
                <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    Set where{" "}
                    {unset.length === 1 ? (
                        <b className="font-medium text-foreground">{unset[0]!.name}</b>
                    ) : (
                        `${unset.length} servers`
                    )}{" "}
                    {unset.length === 1 ? "lives" : "live"}: a home server behind a router and a data-centre box are
                    exposed in different ways, so Polaris needs the answer before it can tell you how to point a domain.
                </p>
            ) : null}

            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">Server</th>
                            <th className="px-3 py-2 font-medium">Address</th>
                            <th className="px-3 py-2 font-medium">Location</th>
                            <th className="px-3 py-2 font-medium">Auth</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {servers.map((server) => (
                            <tr key={server.id} className="border-t border-border hover:bg-card-hover">
                                <td className="px-3 py-2">
                                    <span className="flex items-center gap-2 font-medium">
                                        <Server className="size-4 text-muted-foreground" />
                                        {server.name}
                                        {server.kind === "local" ? <Badge variant="primary">This machine</Badge> : null}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">{server.detail}</span>
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">
                                    {server.address}
                                    {server.port ? `:${server.port}` : ""}
                                </td>
                                <td className="px-3 py-2">
                                    <EnvironmentCell server={server} onPick={() => askEnvironment(server)} />
                                </td>
                                <td className="px-3 py-2">
                                    {server.authMethod ? (
                                        <Badge variant="neutral">{server.authMethod}</Badge>
                                    ) : (
                                        <span className="text-xs text-muted-foreground">Local</span>
                                    )}
                                </td>
                                <td className="px-3 py-2">
                                    <div className="flex justify-end gap-1">
                                        {server.kind === "local" ? null : confirmId === server.id ? (
                                            <>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => setConfirmId(null)}
                                                    disabled={pending}
                                                >
                                                    Cancel
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    onClick={() => onDelete(server.id)}
                                                    disabled={pending}
                                                >
                                                    Remove
                                                </Button>
                                            </>
                                        ) : (
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label={`Remove ${server.name}`}
                                                onClick={() => setConfirmId(server.id)}
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {remotes.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    Add an SSH host to manage another server from Containers (Docker) and Drive (SFTP).
                </p>
            ) : null}

            <EnvironmentDialog target={target} onClose={() => setTarget(null)} />
        </div>
    );
}

/** The location cell: a clickable badge, or a call to action when it is unset. */
function EnvironmentCell({ server, onPick }: { server: ServerRow; onPick: () => void }) {
    const meta = ENVIRONMENT_META[server.environment];

    if (server.environment === "unknown") {
        return (
            <Button size="sm" variant="secondary" onClick={onPick}>
                <MapPin className="size-3.5" /> Set location
            </Button>
        );
    }

    return (
        <button
            type="button"
            onClick={onPick}
            aria-label={`Change where ${server.name} lives`}
            className="flex items-center gap-2"
        >
            <Badge variant={meta.tone}>{meta.label}</Badge>
            {/* Detected but never confirmed: say so rather than pass a guess off as settled. */}
            {server.confirmed ? null : <span className="text-xs text-muted-foreground">detected</span>}
        </button>
    );
}
