"use client";

/**
 * The apps signed in to this account, beside the browsers that are.
 *
 * A session and a client are different credentials and they were shown in
 * different places, which is why somebody who connected the extension and then
 * came here to check found nothing: this page listed browsers, and the extension
 * is not one. It was recorded, named and revocable the whole time - under the
 * vault, on a screen nobody goes to looking for "where am I signed in".
 *
 * So the list is here too. It is read from what the clients themselves reported
 * when they connected, which is why the name is a hint rather than a fact, the
 * same caveat the session table carries: a client chooses what to call itself.
 * What it cannot choose is when it last asked this account for something, and
 * that is the column worth reading.
 *
 * Ending one lives on the vault's own client screen rather than being repeated
 * here. Disconnecting a client is not the same act as signing a browser out - it
 * takes the key with it - and a one-click version of that sitting in a table of
 * sessions is a click somebody makes by analogy with the row above it.
 */

import Link from "next/link";
import type { VaultClientKind } from "@polaris/core";
import { RelativeTime } from "@/components/relative-time";
import type { VaultClientRow } from "@/lib/vault/devices";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { Blocks, Monitor, PanelRightOpen, Puzzle, Smartphone, Terminal } from "lucide-react";

/** The mark beside a client, by what kind of thing it said it was. */
function KindIcon({ kind }: { kind: VaultClientKind }) {
    const className = "size-4 shrink-0 text-muted-foreground";
    if (kind === "extension") return <Puzzle className={className} />;
    if (kind === "mobile") return <Smartphone className={className} />;
    if (kind === "desktop") return <Monitor className={className} />;
    if (kind === "cli") return <Terminal className={className} />;
    return <Blocks className={className} />;
}

export function ConnectedClientsCard({ clients }: { clients: VaultClientRow[] }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">Connected apps</h2>
                        <p className="text-xs text-muted-foreground">
                            The browser extension and any other client signed in to your vault.
                        </p>
                    </div>
                    <Link href="/vault/clients">
                        <Button variant="outline" size="sm">
                            <PanelRightOpen className="size-4" />
                            Manage
                        </Button>
                    </Link>
                </div>

                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                        <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                            {/* The same column ladder the tables above use: nothing
                                arrives at md, where the navigation rail appears and
                                the content area is narrower than a breakpoint
                                earlier. */}
                            <tr>
                                <th className="w-full max-w-0 px-3 py-2 font-medium">App</th>
                                <th className="hidden px-3 py-2 font-medium lg:table-cell">Kind</th>
                                <th className="hidden px-3 py-2 font-medium 2xl:table-cell">
                                    Connected
                                </th>
                                <th className="px-3 py-2 font-medium">Last active</th>
                            </tr>
                        </thead>
                        <tbody>
                            {clients.length === 0 ? (
                                <tr>
                                    <td
                                        colSpan={4}
                                        className="px-3 py-8 text-center text-muted-foreground"
                                    >
                                        No app is connected. The browser extension appears here once
                                        you let it in.
                                    </td>
                                </tr>
                            ) : (
                                clients.map((client) => (
                                    <tr key={client.id} className="border-t border-border">
                                        <td className="w-full max-w-0 px-3 py-2">
                                            <div className="flex items-center gap-3">
                                                <KindIcon kind={client.kind} />
                                                <div className="min-w-0">
                                                    <p className="flex flex-wrap items-center gap-1.5">
                                                        <span className="min-w-0 truncate">
                                                            {client.name}
                                                        </span>
                                                        {client.kind === "extension" ? (
                                                            <Badge variant="neutral">
                                                                Extension
                                                            </Badge>
                                                        ) : null}
                                                    </p>
                                                    <p className="truncate text-xs text-muted-foreground lg:hidden">
                                                        {client.label}
                                                    </p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                            {client.label}
                                        </td>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground 2xl:table-cell">
                                            <RelativeTime iso={client.firstSeenAt} />
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                                            <RelativeTime iso={client.lastSeenAt} />
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </CardBody>
        </Card>
    );
}
