"use client";

/**
 * The Game servers list: what is running, who is on it, and where to connect -
 * one row per server, whatever edition it is, with the live numbers filled in
 * from the page's API once they arrive. Creating another server is the same
 * install the marketplace performs, with the edition picked up front.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { Gamepad2, Loader2, Plus, Users } from "lucide-react";
import { findApp, promptedEnvVars } from "@/lib/apps/catalog";
import type { GameServerRow } from "@/lib/apps/games-service";
import { defaultInstallInput } from "@/lib/apps/install-defaults";
import { appInstallInputSchema } from "@/lib/apps/install-schema";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Badge, Button, Card, CardBody, Dialog, DialogContent, DialogHeader, DialogTitle, Input, PageHeader, Select, Skeleton, cn } from "@polaris/ui";
import {
    createGameServerAction,
    listGameEditionsAction,
    listGameTargetsAction,
    type GameEditionOption,
    type GameTargetOption
} from "./actions";

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

export function GamesView({ servers }: { servers: GameServerSeed[] }) {
    const [live, setLive] = useState<Map<string, GameServerRow>>(new Map());
    const [creating, setCreating] = useState(false);

    const load = useCallback(async () => {
        try {
            const response = await fetch("/api/apps/games", { cache: "no-store" });
            if (!response.ok) return;
            const data = (await response.json()) as { servers?: GameServerRow[] };
            setLive(new Map((data.servers ?? []).map((row) => [row.id, row])));
        } catch {
            // Transient; the next poll retries.
        }
    }, []);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    const playing = useMemo(
        () => [...live.values()].reduce((total, row) => total + row.online, 0),
        [live]
    );

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
                        <p className="text-sm font-medium">No game servers yet</p>
                        <p className="max-w-md text-sm text-muted-foreground">
                            A server runs on this machine or on any server you have connected, closed to everyone but the
                            players you allow. Java is the PC edition; Bedrock is phones, consoles and the Windows app.
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

function ServerCard({ server, live }: { server: GameServerSeed; live: GameServerRow | null }) {
    return (
        <Card className="transition-colors hover:border-border">
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface">
                        <Gamepad2 className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <Link href={`/apps/installed/${server.id}`} className="truncate text-sm font-medium hover:underline">
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

/** Create a server: the edition, a name, where it runs, and the few settings
 *  worth deciding before the world is generated. Everything else has a default
 *  and can be changed on the server's own page. */
function NewServerDialog({ onClose }: { onClose: () => void }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [editions, setEditions] = useState<GameEditionOption[] | null>(null);
    const [targets, setTargets] = useState<GameTargetOption[]>([]);
    const [catalogId, setCatalogId] = useState("minecraft");
    const [name, setName] = useState("");
    const [serverId, setServerId] = useState("local");
    const [env, setEnv] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);

    const manifest = findApp(catalogId);
    // The choices that only matter before the world exists; the rest live on the
    // server's Settings screen, where changing them is a restart away.
    const upfront = useMemo(
        () =>
            manifest
                ? promptedEnvVars(manifest).filter((field) =>
                      ["TYPE", "VERSION", "MEMORY", "SEED", "LEVEL_SEED"].includes(field.key)
                  )
                : [],
        [manifest]
    );

    useEffect(() => {
        let active = true;
        void Promise.all([listGameEditionsAction(), listGameTargetsAction()])
            .then(([loadedEditions, loadedTargets]) => {
                if (!active) return;
                setEditions(loadedEditions);
                setTargets(loadedTargets);
                setCatalogId((current) => (loadedEditions.some((item) => item.catalogId === current) ? current : (loadedEditions[0]?.catalogId ?? current)));
            })
            .catch(() => active && setError("Could not load your servers"));
        return () => {
            active = false;
        };
    }, []);

    // Each edition brings its own defaults; switching resets the fields to them
    // rather than carrying a value the other edition does not have.
    useEffect(() => {
        const chosen = findApp(catalogId);
        setEnv(Object.fromEntries(promptedEnvVars(chosen ?? { template: {} } as never).map((field) => [field.key, field.default ?? ""])));
    }, [catalogId]);

    function submit(): void {
        setError(null);
        if (!manifest) return;
        const base = defaultInstallInput(manifest, serverId);
        const input = {
            ...base,
            name: name.trim() || manifest.name,
            env: base.env.map((entry) => ({ key: entry.key, value: env[entry.key] ?? entry.value }))
        };
        const parsed = appInstallInputSchema.safeParse(input);
        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the details and try again");
            return;
        }
        startTransition(async () => {
            const result = await createGameServerAction(parsed.data);
            if (result.error || !result.installedAppId) {
                setError(result.error ?? "Could not create the server");
                return;
            }
            router.push(`/apps/installed/${result.installedAppId}`);
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Gamepad2 className="size-5" /> New game server
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">Edition</span>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {(editions ?? []).map((edition) => (
                                <button
                                    key={edition.catalogId}
                                    type="button"
                                    onClick={() => setCatalogId(edition.catalogId)}
                                    className={cn(
                                        "rounded-md border p-3 text-left transition-colors",
                                        catalogId === edition.catalogId
                                            ? "border-primary bg-primary/5"
                                            : "border-border hover:border-border"
                                    )}
                                >
                                    <p className="text-sm font-medium">{edition.name}</p>
                                    <p className="text-xs text-muted-foreground">{edition.summary}</p>
                                </button>
                            ))}
                            {editions === null && <Skeleton className="h-16 w-full" />}
                        </div>
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={manifest?.name ?? "Survival"}
                        />
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Runs on</span>
                        <Select
                            value={serverId}
                            onValueChange={setServerId}
                            options={targets.map((target) => ({ value: target.id, label: target.name }))}
                            placeholder="Choose a machine"
                        />
                    </label>

                    {upfront.map((field) => (
                        <label key={field.key} className="flex flex-col gap-1 text-sm">
                            <span>{field.label}</span>
                            {field.options ? (
                                <Select
                                    value={env[field.key] ?? field.default ?? ""}
                                    onValueChange={(value) => setEnv((current) => ({ ...current, [field.key]: value }))}
                                    options={field.options}
                                />
                            ) : (
                                <Input
                                    value={env[field.key] ?? ""}
                                    onChange={(event) => setEnv((current) => ({ ...current, [field.key]: event.target.value }))}
                                />
                            )}
                            {field.help && <span className="text-xs text-muted-foreground">{field.help}</span>}
                        </label>
                    ))}

                    <p className="text-xs text-muted-foreground">
                        It starts closed: authentication required and only players you allow can join. Add them from the
                        server&apos;s Players screen.
                        {manifest?.consent && (
                            <>
                                {" "}
                                Creating it accepts the{" "}
                                <a
                                    href={manifest.consent.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline underline-offset-2 hover:text-foreground"
                                >
                                    {manifest.consent.label}
                                </a>
                                .
                            </>
                        )}
                    </p>

                    {error && <p className="text-sm text-danger">{error}</p>}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending || !manifest}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Create server
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
