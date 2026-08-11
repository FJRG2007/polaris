"use client";

/**
 * The name players type, and changing it.
 *
 * A deployed service can be moved onto any hostname from its own page, and a game
 * server had no such control at all - its address was decided once, at creation,
 * and a typo in it meant deleting the world and starting again. The records are
 * Polaris's to write, so this writes them: the A record at this machine, and for
 * Java the SRV record that keeps the port out of what anybody has to remember.
 */

import { useState, useTransition } from "react";
import { CopyButton } from "@/components/copy-button";
import { Globe, Loader2, PencilLine } from "lucide-react";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { setGameHostnameAction, setGameRoutedAction } from "./minecraft-actions";

export function MinecraftDomain({
    installedAppId,
    hostname,
    suffix,
    address,
    routed = false,
    canRoute = false
}: {
    installedAppId: string;
    /** The name it answers to today, when it has one. */
    hostname: string | null;
    /** What every game server's name ends in here (".mc.example.com"), or null
     *  when no domain is configured. */
    suffix: string | null;
    /** What a player actually types, port included where the name does not carry it. */
    address: string | null;
    /** Whether it answers on the shared port rather than one of its own. */
    routed?: boolean;
    /** Whether it could - only a client that names the address in its handshake. */
    canRoute?: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const [label, setLabel] = useState(() => (hostname && suffix ? hostname.slice(0, -suffix.length) : ""));
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function toggleRouted(): void {
        setError(null);
        startTransition(async () => {
            const result = await setGameRoutedAction(installedAppId, !routed);
            if (result.error) setError(result.error);
        });
    }

    const normalized = label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const preview = suffix && normalized ? `${normalized}${suffix}` : null;

    function save(): void {
        setError(null);
        startTransition(async () => {
            const result = await setGameHostnameAction(installedAppId, normalized);
            if (result.error) {
                setError(result.error);
                return;
            }
            setEditing(false);
        });
    }

    if (!suffix) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-1">
                    <p className="text-sm font-medium">Address</p>
                    <p className="text-xs text-muted-foreground">
                        No domain is configured, so players connect to this machine&apos;s address and port. Add one
                        under Admin, Domains and servers can take names on it.
                    </p>
                </CardBody>
            </Card>
        );
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm font-medium">
                        <Globe className="size-4" /> Address
                    </p>
                    {!editing && (
                        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                            <PencilLine className="size-4" /> Change
                        </Button>
                    )}
                </div>

                {editing ? (
                    <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <Input
                                value={label}
                                onChange={(event) => setLabel(event.target.value)}
                                placeholder="survival"
                                className="min-w-36 flex-1"
                                aria-label="Subdomain"
                            />
                            <span className="font-mono text-sm text-muted-foreground">{suffix}</span>
                            <Button size="sm" onClick={save} disabled={pending || normalized.length === 0}>
                                {pending && <Loader2 className="size-4 animate-spin" />} Save
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    setEditing(false);
                                    setError(null);
                                }}
                                disabled={pending}
                            >
                                Cancel
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {preview ? (
                                <>
                                    Players will connect to <code className="font-mono">{preview}</code>. The old name
                                    keeps resolving until you remove its record.
                                </>
                            ) : (
                                "Give it a label, and the rest of the name follows."
                            )}
                        </p>
                        {error && <p className="text-xs text-danger">{error}</p>}
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            {address ? (
                                <>
                                    <code className="truncate font-mono text-sm" title={address}>
                                        {address}
                                    </code>
                                    <CopyButton value={address} label="Copy the server address" />
                                </>
                            ) : (
                                <span className="text-xs text-muted-foreground">
                                    No name yet. Give it one and Polaris writes the records.
                                </span>
                            )}
                        </div>

                        {/* Offered only where it can work, and only once there is a name
                            to route: the router matches on the address a player typed,
                            so a server without one has nothing for it to match. */}
                        {canRoute && hostname && (
                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
                                <p className="text-xs text-muted-foreground">
                                    {routed
                                        ? "Shares port 25565 with the other Java servers, so the address needs no port and no DNS record of its own. Players connect from the router's address, so the player list cannot be bound to addresses."
                                        : "Give it its own port, or put it behind the shared one: an address with no port, and no DNS record per server. Its player list can then only be closed by username."}
                                </p>
                                <Button size="sm" variant="secondary" onClick={toggleRouted} disabled={pending}>
                                    {pending && <Loader2 className="size-4 animate-spin" />}
                                    {routed ? "Give it its own port" : "Use the shared port"}
                                </Button>
                            </div>
                        )}
                        {error && <p className="text-xs text-danger">{error}</p>}
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
