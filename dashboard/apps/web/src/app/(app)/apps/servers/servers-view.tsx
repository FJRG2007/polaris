"use client";

/**
 * Servers list. Each server is an SSH host reusable in Containers (Docker) and
 * Drive (SFTP). Delete uses an inline two-step confirm (no native dialog).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Server, Trash2 } from "lucide-react";
import { Badge, Button } from "@polaris/ui";
import { deleteHostAction } from "./actions";
import { HostDialog } from "./host-dialog";

export interface HostSummary {
    id: string;
    name: string;
    address: string;
    port: number;
    username: string;
    authMethod: string;
    status: string;
}

export function ServersView({ hosts }: { hosts: HostSummary[] }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [confirmId, setConfirmId] = useState<string | null>(null);

    function onDelete(id: string) {
        startTransition(async () => {
            await deleteHostAction(id);
            setConfirmId(null);
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-muted-foreground">Servers</h2>
                <HostDialog />
            </div>

            {hosts.length === 0 ? (
                <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                    No servers yet. Add an SSH host to use it in Containers (Docker) and Drive (SFTP).
                </div>
            ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-sm">
                        <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2 font-medium">Server</th>
                                <th className="px-3 py-2 font-medium">Address</th>
                                <th className="px-3 py-2 font-medium">Auth</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {hosts.map((host) => (
                                <tr key={host.id} className="border-t border-border hover:bg-card-hover">
                                    <td className="px-3 py-2">
                                        <span className="flex items-center gap-2 font-medium">
                                            <Server className="size-4 text-muted-foreground" />
                                            {host.name}
                                        </span>
                                        <span className="block text-xs text-muted-foreground">{host.username}</span>
                                    </td>
                                    <td className="px-3 py-2 text-muted-foreground">
                                        {host.address}:{host.port}
                                    </td>
                                    <td className="px-3 py-2">
                                        <Badge variant="neutral">{host.authMethod}</Badge>
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex justify-end gap-1">
                                            {confirmId === host.id ? (
                                                <>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => setConfirmId(null)}
                                                        disabled={pending}
                                                    >
                                                        Cancel
                                                    </Button>
                                                    <Button size="sm" onClick={() => onDelete(host.id)} disabled={pending}>
                                                        Remove
                                                    </Button>
                                                </>
                                            ) : (
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    aria-label={`Remove ${host.name}`}
                                                    onClick={() => setConfirmId(host.id)}
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
            )}
        </div>
    );
}
