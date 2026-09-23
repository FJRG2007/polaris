"use client";

/**
 * Modpacks.
 *
 * A modpack is not another mod: it decides the loader, the release and every mod
 * on the server, and the image installs it over whatever was chosen before. So it
 * gets a card of its own rather than a row among the mods, and choosing one is a
 * confirmation rather than a tick - what it costs is the server's current mod
 * list and, often, the readability of its world.
 *
 * The world is deliberately left alone. A modded world is the mods that made it,
 * so a pack that does not include them will generate new chunks around blocks it
 * does not know and may refuse to load the old ones - which is worth saying
 * before, and is not worth deciding for somebody by wiping their world.
 */

import { useEffect, useState, useTransition } from "react";
import { Boxes, ExternalLink, Loader2, Search } from "lucide-react";
import type { ModrinthProject } from "../../lib/minecraft/modrinth";
import { searchModpacksAction, setModpackAction } from "./minecraft-actions";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Skeleton } from "@polaris/ui";

export function ModpacksCard({
    installedAppId,
    /** What the server runs now: the pack, or blank for a server that runs none. */
    modpack,
    onSaved
}: {
    installedAppId: string;
    modpack: string;
    onSaved: () => void;
}) {
    const [query, setQuery] = useState("");
    const [packs, setPacks] = useState<ModrinthProject[] | null>(null);
    const [chosen, setChosen] = useState<ModrinthProject | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let active = true;
        const timer = setTimeout(() => {
            void searchModpacksAction(installedAppId, query).then((answer) => {
                if (active) setPacks(answer.packs ?? []);
            });
        }, 250);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [installedAppId, query]);

    function apply(slug: string): void {
        setError(null);
        startTransition(async () => {
            const result = await setModpackAction({ installedAppId, modpack: slug, restart: true });
            if (result.error) {
                setError(result.error);
                return;
            }
            setChosen(null);
            onSaved();
        });
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Boxes className="size-4 text-primary" />
                    Modpacks
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                    A pack brings its own mod loader, its own release and its own mods, and replaces whatever this
                    server installs now. Only packs with a server side are listed - a pack whose mods are all for
                    the player installs nothing a server can run.
                </p>

                {modpack.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
                        <span className="text-xs text-muted-foreground">Running</span>
                        <span className="text-sm font-medium">{modpack}</span>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto"
                            disabled={pending}
                            onClick={() => apply("")}
                        >
                            Stop running it
                        </Button>
                    </div>
                )}

                <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search modpacks"
                        className="pl-8"
                    />
                </div>

                <div className="flex flex-col gap-2">
                    {packs === null ? (
                        <>
                            <Skeleton className="h-14 w-full" />
                            <Skeleton className="h-14 w-full" />
                        </>
                    ) : packs.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            Nothing came back. Modrinth may be unreachable from here rather than empty.
                        </p>
                    ) : (
                        packs.map((pack) => (
                            <div
                                key={pack.slug}
                                className="flex items-start gap-3 rounded-md border border-border p-2"
                            >
                                {pack.iconUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={pack.iconUrl} alt="" className="size-8 shrink-0 rounded" />
                                ) : (
                                    <div className="size-8 shrink-0 rounded bg-surface-raised" />
                                )}
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <a
                                            href={`https://modrinth.com/modpack/${pack.slug}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-sm font-medium hover:underline"
                                        >
                                            {pack.title}
                                            <ExternalLink className="ml-1 inline size-3 shrink-0" />
                                        </a>
                                        {pack.slug === modpack && <Badge variant="success">running</Badge>}
                                    </div>
                                    <p className="line-clamp-2 text-xs text-muted-foreground">
                                        {pack.description}
                                    </p>
                                </div>
                                {pack.slug !== modpack && (
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        disabled={pending}
                                        onClick={() => setChosen(pack)}
                                    >
                                        Install
                                    </Button>
                                )}
                            </div>
                        ))
                    )}
                </div>

                {chosen && (
                    <div className="flex flex-col gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2">
                        <p className="text-sm font-medium">Install {chosen.title}?</p>
                        <p className="text-xs text-muted-foreground">
                            The pack decides this server{"'"}s mod loader, release and mods, so everything it
                            installs now is replaced. The world stays where it is - a world built with other mods
                            may not be one this pack can read. The server restarts to install it.
                        </p>
                        <div className="flex items-center gap-2">
                            <Button size="sm" disabled={pending} onClick={() => apply(chosen.slug)}>
                                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                                Install it
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setChosen(null)}>
                                Cancel
                            </Button>
                        </div>
                    </div>
                )}

                {error && <p className="text-xs text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}
