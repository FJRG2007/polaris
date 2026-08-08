"use client";

/**
 * The manager: every server this owner runs, what each is doing, and the way to
 * make another. Rows paint from what the page already knows and the live parts -
 * who is playing, whether it is answering - arrive from the page's own API, so
 * opening it never waits on a container.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { installManagerAction } from "./actions";
import { CopyButton } from "@/components/copy-button";
import { NewServerDialog } from "./new-server-dialog";
import { Gamepad2, Loader2, Plus, Users } from "lucide-react";
import type { GameServerRow } from "@/lib/apps/games-service";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Badge, Button, Card, CardBody, PageHeader, Skeleton } from "@polaris/ui";

const POLL_MS = 6000;

/** What the page knows before anything is polled. */
export interface GameServerSeed {
    id: string;
    name: string;
    catalogId: string;
    catalogName: string;
    edition: "java" | "bedrock";
    status: string;
}

export function GamesView({ servers, managerInstalled }: { servers: GameServerSeed[]; managerInstalled: boolean }) {
    const [live, setLive] = useState<Map<string, GameServerRow>>(new Map());
    const [creating, setCreating] = useState(false);

    const load = useCallback(async () => {
        if (!managerInstalled) return;
        try {
            const response = await fetch("/api/apps/games", { cache: "no-store" });
            if (!response.ok) return;
            const data = (await response.json()) as { servers?: GameServerRow[] };
            setLive(new Map((data.servers ?? []).map((row) => [row.id, row])));
        } catch {
            // Transient; the next poll retries.
        }
    }, [managerInstalled]);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    const playing = useMemo(() => [...live.values()].reduce((total, row) => total + row.online, 0), [live]);

    if (!managerInstalled) return <InstallManager />;

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                title="Game servers"
                description={
                    servers.length === 0
                        ? "Run Minecraft servers on your own machines."
                        : `${servers.length} ${servers.length === 1 ? "server" : "servers"}, ${playing} playing right now.`
                }
                actions={
                    <Button onClick={() => setCreating(true)}>
                        <Plus className="size-4" /> New server
                    </Button>
                }
            />

            {servers.length === 0 ? (
                <Card>
                    <CardBody className="flex flex-col items-center gap-3 py-12 text-center">
                        <Gamepad2 className="size-8 text-muted-foreground" />
                        <p className="text-sm font-medium">No servers yet</p>
                        <p className="max-w-md text-sm text-muted-foreground">
                            Pick who it is for and what it plays, and Polaris sizes it, protects it and gives it an
                            address. Java is the PC edition, Bedrock is phones and consoles, and one server can take
                            both.
                        </p>
                        <Button onClick={() => setCreating(true)}>
                            <Plus className="size-4" /> New server
                        </Button>
                    </CardBody>
                </Card>
            ) : (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {servers.map((server) => (
                        <ServerCard key={server.id} server={server} live={live.get(server.id) ?? null} />
                    ))}
                </div>
            )}

            {creating && <NewServerDialog onClose={() => setCreating(false)} />}
        </div>
    );
}

/** The manager is an app: it is installed, and until it is there is nothing here
 *  to manage. One button rather than a trip to the marketplace to find it. */
function InstallManager() {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    return (
        <div className="flex flex-col gap-6">
            <PageHeader title="Game servers" description="Run Minecraft servers on your own machines." />
            <Card>
                <CardBody className="flex flex-col items-center gap-3 py-12 text-center">
                    <Gamepad2 className="size-8 text-muted-foreground" />
                    <p className="text-sm font-medium">Install the Minecraft manager</p>
                    <p className="max-w-md text-sm text-muted-foreground">
                        It adds this page for real: create as many servers as you want, Java or Bedrock, each with its
                        own address, console, players and mods. Nothing runs until you create a server.
                    </p>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <Button
                        onClick={() =>
                            startTransition(async () => {
                                const result = await installManagerAction();
                                if (result.error) {
                                    setError(result.error);
                                    return;
                                }
                                router.refresh();
                            })
                        }
                        disabled={pending}
                    >
                        {pending && <Loader2 className="size-4 animate-spin" />}
                        Install
                    </Button>
                    <p className="text-xs text-muted-foreground">
                        Creating a server accepts the{" "}
                        <a
                            href="https://www.minecraft.net/eula"
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-2 hover:text-foreground"
                        >
                            Minecraft EULA
                        </a>
                        .
                    </p>
                </CardBody>
            </Card>
        </div>
    );
}

function ServerCard({ server, live }: { server: GameServerSeed; live: GameServerRow | null }) {
    return (
        <Card className="transition-colors hover:border-border">
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface">
                        <Gamepad2 className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <Link
                            href={`/apps/installed/${server.id}`}
                            className="truncate text-sm font-medium hover:underline"
                        >
                            {server.name}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                            {[server.catalogName, live?.serverName].filter(Boolean).join(" - ")}
                        </p>
                    </div>
                    <StatusBadge live={live} status={server.status} />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                    {live === null ? (
                        <Skeleton className="h-5 w-40" />
                    ) : live.address ? (
                        <div className="flex min-w-0 items-center gap-1">
                            <code className="truncate font-mono text-xs" title={live.address}>{live.address}</code>
                            <CopyButton value={live.address} label={`Copy the address of ${server.name}`} />
                        </div>
                    ) : (
                        <span className="text-xs text-muted-foreground">{live.message ?? "No address yet"}</span>
                    )}

                    {live?.answering && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Users className="size-3" />
                            {live.online} / {live.max}
                        </span>
                    )}
                </div>

                {live && live.players.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                        {live.players.map((player) => (
                            <span key={player} className="rounded border border-border px-1.5 py-0.5 text-xs">
                                {player}
                            </span>
                        ))}
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

function StatusBadge({ live, status }: { live: GameServerRow | null; status: string }) {
    if (live === null) return <Badge>{status === "failed" ? "Failed" : "Loading"}</Badge>;
    if (!live.running) return <Badge>Stopped</Badge>;
    if (!live.answering) return <Badge className="border-warning/40 text-warning">Starting</Badge>;
    return <Badge className="border-success/40 text-success">Online</Badge>;
}
