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

import { useState, useTransition, type ReactNode } from "react";
import { useGameText } from "../game-text";
import { Globe, Loader2, PencilLine } from "lucide-react";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { setGameHostnameAction, setGameRoutedAction } from "./minecraft-actions";
import { hostUi } from "@polaris/app-host/client";

const { CopyButton } = hostUi.copyButton;

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
    const t = useGameText("minecraft");
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
                    <p className="text-sm font-medium">{t("domain.address")}</p>
                    <p className="text-xs text-muted-foreground">
                        {t("domain.noDomainIsConfiguredSo")}
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
                        <Globe className="size-4" /> {t("domain.address")}
                    </p>
                    {!editing && (
                        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                            <PencilLine className="size-4" /> {t("domain.change")}
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
                                aria-label={t("domain.subdomain")}
                            />
                            <span className="font-mono text-sm text-muted-foreground">{suffix}</span>
                            <Button size="sm" onClick={save} disabled={pending || normalized.length === 0}>
                                {pending && <Loader2 className="size-4 animate-spin" />} {t("domain.save")}
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
                                {t("domain.cancel")}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {preview ? (
                                <>
                                    {t.rich<ReactNode>("domain.willConnect", {
                                        address: () => (
                                            <code key="address" className="font-mono">
                                                {preview}
                                            </code>
                                        )
                                    })}
                                </>
                            ) : (
                                t("domain.giveItALabelAnd")
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
                                    <CopyButton value={address} label={t("domain.copyTheServerAddress")} />
                                </>
                            ) : (
                                <span className="text-xs text-muted-foreground">
                                    {t("domain.noNameYetGiveIt")}
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
                                        ? t("domain.sharesPort25565WithThe")
                                        : t("domain.giveItItsOwnPort")}
                                </p>
                                <Button size="sm" variant="secondary" onClick={toggleRouted} disabled={pending}>
                                    {pending && <Loader2 className="size-4 animate-spin" />}
                                    {routed ? t("domain.giveItItsOwnPort2") : t("domain.useTheSharedPort")}
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
