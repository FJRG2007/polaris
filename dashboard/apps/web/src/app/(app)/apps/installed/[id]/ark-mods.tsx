"use client";

/**
 * The mods an ARK server runs.
 *
 * ARK's mods are Steam Workshop items, and the server downloads each one when it
 * starts - so this screen changes what the next start installs and never a running
 * world. Every row says which of the two it is in: already on disk, or waiting for
 * a restart. That distinction is the whole screen, because the gap between them is
 * a 3 GB download and an operator who cannot tell is an operator who restarts twice.
 *
 * Order matters and is not sorted away: ARK loads mods in the order given and later
 * ones override earlier ones, so two mods that touch the same creature behave
 * differently depending on which is second.
 *
 * Adding by link needs nothing configured - Steam answers for a Workshop id without
 * a key. Searching does need one, so the search box says that rather than pretending
 * there are no results.
 */

import Image from "next/image";
import * as actions from "./ark-actions";
import { useCallback, useEffect, useState } from "react";
import type { ArkModsView } from "@/lib/apps/ark/mods-service";
import { workshopUrl, type WorkshopItem } from "@/lib/apps/ark/workshop";
import { MAX_MODS, movedMod, withoutMod, withMod } from "@/lib/apps/ark/mods";
import { Badge, Button, Card, CardBody, Input, Skeleton, cn } from "@polaris/ui";
import {
    AlertTriangle,
    ArrowDown,
    ArrowUp,
    ExternalLink,
    Loader2,
    Plus,
    RefreshCw,
    RotateCcw,
    Search,
    Trash2
} from "lucide-react";

/** Steam gives sizes in bytes and mods are measured in hundreds of megabytes. */
function size(bytes: number | null): string {
    if (bytes === null || bytes <= 0) return "";
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function ArkMods({
    installedAppId,
    canManage,
    running
}: {
    installedAppId: string;
    canManage: boolean;
    /** Whether the server is up. What is on disk can only be read from a running
     *  container, and the restart is only offered against one. */
    running: boolean;
}) {
    const [mods, setMods] = useState<ArkModsView | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [changed, setChanged] = useState(false);
    const [restarting, setRestarting] = useState(false);

    const load = useCallback(async () => {
        const result = await actions.readArkModsAction(installedAppId);
        setLoading(false);
        if (result.mods) setMods(result.mods);
        else setError(result.error ?? "The mods could not be read");
    }, [installedAppId]);

    useEffect(() => {
        void load();
    }, [load]);

    const details = useCallback(
        (id: string): WorkshopItem | null => mods?.items.find((item) => item.id === id) ?? null,
        [mods]
    );

    async function save(ids: readonly string[]): Promise<void> {
        setBusy(true);
        setError(null);
        const result = await actions.setArkModsAction(installedAppId, [...ids]);
        setBusy(false);
        if (result.error || !result.mods) {
            setError(result.error ?? "That could not be saved");
            return;
        }
        setMods(result.mods);
        setChanged(true);
    }

    async function setMap(id: string | null): Promise<void> {
        setBusy(true);
        setError(null);
        const result = await actions.setArkMapModAction(installedAppId, id);
        setBusy(false);
        if (result.error || !result.mods) {
            setError(result.error ?? "That could not be saved");
            return;
        }
        setMods(result.mods);
        setChanged(true);
    }

    async function restart(): Promise<void> {
        setRestarting(true);
        setError(null);
        const result = await actions.restartArkServerAction(installedAppId);
        setRestarting(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setChanged(false);
        void load();
    }

    const ids = mods?.ids ?? [];

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">
                    Mods are downloaded when the server starts. Players who join a modded server get
                    them from Steam by themselves - nobody has to subscribe to anything first.
                </p>
                <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto"
                    aria-label="Read the mods again"
                    title="Read the mods again"
                    disabled={loading}
                    onClick={() => {
                        setLoading(true);
                        void load();
                    }}
                >
                    <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
                </Button>
            </div>

            {error && (
                <Card>
                    <CardBody className="flex items-start gap-2 py-3 text-sm text-danger">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>{error}</span>
                    </CardBody>
                </Card>
            )}

            {changed && canManage && running && (
                <Card className="border-warning/40 bg-warning/5">
                    <CardBody className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">Saved, and not yet installed</p>
                            <p className="text-xs text-muted-foreground">
                                The server downloads what it is missing while it comes back, which for a
                                large mod is several minutes. The world is saved first.
                            </p>
                        </div>
                        <Button variant="secondary" disabled={restarting} onClick={() => void restart()}>
                            {restarting ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <RotateCcw className="size-4" />
                            )}
                            Restart it now
                        </Button>
                    </CardBody>
                </Card>
            )}

            {canManage && (
                <AddMod
                    installedAppId={installedAppId}
                    busy={busy}
                    onAdd={(id) => void save(withMod(ids, id))}
                    onSetMap={(id) => void setMap(id)}
                />
            )}

            {loading ? (
                <div className="flex flex-col gap-2">
                    {Array.from({ length: 3 }, (_, index) => (
                        <Skeleton key={index} className="h-16 w-full" />
                    ))}
                </div>
            ) : (
                <>
                    <div className="flex flex-col gap-1">
                        <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Map
                        </p>
                        <Card>
                            <CardBody className="py-0">
                                {mods?.mapModId ? (
                                    <ModRow
                                        installedAppId={installedAppId}
                                        id={mods.mapModId}
                                        item={details(mods.mapModId)}
                                        installed={mods.installed.includes(mods.mapModId)}
                                        knowsDisk={running}
                                        first
                                        busy={busy}
                                        canManage={canManage}
                                        onRemove={() => void setMap(null)}
                                    />
                                ) : (
                                    <p className="py-4 text-sm text-muted-foreground">
                                        This server runs one of the maps that come with the game. A
                                        Workshop map replaces it, and its world is kept separately from
                                        the one you have now.
                                    </p>
                                )}
                            </CardBody>
                        </Card>
                    </div>

                    <div className="flex flex-col gap-1">
                        <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Mods{ids.length > 0 ? ` - ${ids.length} of ${MAX_MODS}` : ""}
                        </p>
                        <Card>
                            <CardBody className="py-0">
                                {ids.length === 0 ? (
                                    <p className="py-4 text-sm text-muted-foreground">
                                        No mods. Paste a Workshop link above to add one.
                                    </p>
                                ) : (
                                    ids.map((id, index) => (
                                        <ModRow
                                            key={id}
                                            installedAppId={installedAppId}
                                            id={id}
                                            item={details(id)}
                                            installed={(mods?.installed ?? []).includes(id)}
                                            knowsDisk={running}
                                            first={index === 0}
                                            position={index + 1}
                                            busy={busy}
                                            canManage={canManage}
                                            onUp={index > 0 ? () => void save(movedMod(ids, id, -1)) : undefined}
                                            onDown={
                                                index < ids.length - 1
                                                    ? () => void save(movedMod(ids, id, 1))
                                                    : undefined
                                            }
                                            onRemove={() => void save(withoutMod(ids, id))}
                                        />
                                    ))
                                )}
                            </CardBody>
                        </Card>
                    </div>
                </>
            )}

            <p className="text-xs text-muted-foreground">
                Mods load in the order above and a later one wins over an earlier one, which is what
                decides the outcome when two of them change the same thing. Removing a mod stops the
                server loading it; anything it added to the world goes with it.
            </p>
        </div>
    );
}

/** Paste a link, see what it is, then decide what to do with it. */
function AddMod({
    installedAppId,
    busy,
    onAdd,
    onSetMap
}: {
    installedAppId: string;
    busy: boolean;
    onAdd: (id: string) => void;
    onSetMap: (id: string) => void;
}) {
    const [query, setQuery] = useState("");
    const [looking, setLooking] = useState(false);
    const [found, setFound] = useState<WorkshopItem | null>(null);
    const [results, setResults] = useState<readonly WorkshopItem[] | null>(null);
    const [needsKey, setNeedsKey] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** A pasted link is looked up by id; anything else is searched for. The two
     *  are the same box because they are the same intention. */
    async function go(): Promise<void> {
        const text = query.trim();
        if (text.length === 0) return;
        setLooking(true);
        setError(null);
        setFound(null);
        setResults(null);
        if (/^\d{6,12}$/.test(text) || text.includes("id=")) {
            const answer = await actions.lookUpArkModAction(installedAppId, text);
            setLooking(false);
            if (answer.error || !answer.item) setError(answer.error ?? "Steam does not know that id");
            else setFound(answer.item);
            return;
        }
        const answer = await actions.searchArkModsAction(installedAppId, text);
        setLooking(false);
        setNeedsKey(Boolean(answer.needsKey));
        if (answer.error) setError(answer.error);
        else setResults(answer.items ?? []);
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-56 flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            className="pl-9"
                            value={query}
                            aria-label="A Workshop link, an id, or something to search for"
                            placeholder="Paste a Workshop link, or search by name"
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                void go();
                            }}
                        />
                    </div>
                    <Button disabled={busy || looking || query.trim().length === 0} onClick={() => void go()}>
                        {looking ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                        Look it up
                    </Button>
                </div>

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                {needsKey && (
                    <p className="text-xs text-muted-foreground">
                        Searching the Workshop needs a Steam Web API key, which Polaris asks for under
                        Integrations. Without one, paste a mod&apos;s link here and it is added the same
                        way.
                    </p>
                )}

                {found && (
                    <Candidate
                        installedAppId={installedAppId}
                        item={found}
                        busy={busy}
                        onAdd={() => {
                            onAdd(found.id);
                            setFound(null);
                            setQuery("");
                        }}
                        onSetMap={() => {
                            onSetMap(found.id);
                            setFound(null);
                            setQuery("");
                        }}
                    />
                )}

                {results !== null && results.length === 0 && !needsKey && (
                    <p className="text-sm text-muted-foreground">Nothing on the Workshop matches that.</p>
                )}

                {results !== null && results.length > 0 && (
                    <div className="flex flex-col gap-2">
                        {results.map((item) => (
                            <Candidate
                                key={item.id}
                                installedAppId={installedAppId}
                                item={item}
                                busy={busy}
                                onAdd={() => {
                                    onAdd(item.id);
                                    setResults(null);
                                    setQuery("");
                                }}
                                onSetMap={() => {
                                    onSetMap(item.id);
                                    setResults(null);
                                    setQuery("");
                                }}
                            />
                        ))}
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

/** One mod somebody is deciding about, with both things it could be. */
function Candidate({
    installedAppId,
    item,
    busy,
    onAdd,
    onSetMap
}: {
    installedAppId: string;
    item: WorkshopItem;
    busy: boolean;
    onAdd: () => void;
    onSetMap: () => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2">
            <Preview installedAppId={installedAppId} item={item} />
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={item.title}>{item.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                    {[size(item.sizeBytes), item.subscriptions ? `${item.subscriptions.toLocaleString()} subscribers` : ""]
                        .filter(Boolean)
                        .join(" - ")}
                </p>
            </div>
            <Button size="sm" variant="secondary" disabled={busy} onClick={onSetMap} title="Run this as the map">
                Use as the map
            </Button>
            <Button size="sm" disabled={busy} onClick={onAdd}>
                <Plus className="size-4" /> Add
            </Button>
        </div>
    );
}

/** Steam's own picture, fetched by Polaris rather than by the browser. */
function Preview({ installedAppId, item }: { installedAppId: string; item: WorkshopItem }) {
    if (!item.previewUrl) {
        return <div className="size-12 shrink-0 rounded-md bg-muted" aria-hidden />;
    }
    return (
        <Image
            src={`/api/apps/installed/${installedAppId}/ark/workshop-icon?url=${encodeURIComponent(item.previewUrl)}`}
            alt=""
            width={48}
            height={48}
            unoptimized
            className="size-12 shrink-0 rounded-md object-cover"
        />
    );
}

function ModRow({
    installedAppId,
    id,
    item,
    installed,
    knowsDisk,
    first,
    position,
    busy,
    canManage,
    onUp,
    onDown,
    onRemove
}: {
    installedAppId: string;
    id: string;
    /** What Steam says about it, or null when Steam could not be reached. The row
     *  still draws: the id is what the server runs. */
    item: WorkshopItem | null;
    installed: boolean;
    /** Whether anything could be read off the server's disk at all. A stopped
     *  server knows nothing, which is not the same as "not installed". */
    knowsDisk: boolean;
    first: boolean;
    position?: number;
    busy: boolean;
    canManage: boolean;
    onUp?: () => void;
    onDown?: () => void;
    onRemove: () => void;
}) {
    return (
        <div
            className={cn(
                "flex flex-wrap items-center gap-3 py-3",
                !first && "border-t border-border"
            )}
        >
            {position !== undefined && (
                <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                    {position}
                </span>
            )}
            {item ? (
                <Preview installedAppId={installedAppId} item={item} />
            ) : (
                <div className="size-12 shrink-0 rounded-md bg-muted" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item?.title ?? id}</p>
                <p className="truncate text-xs text-muted-foreground">
                    {[
                        size(item?.sizeBytes ?? null),
                        item?.updatedAt ? `updated ${new Date(item.updatedAt).getFullYear()}` : "",
                        item ? "" : "Steam could not be asked about this one"
                    ]
                        .filter(Boolean)
                        .join(" - ")}
                </p>
            </div>
            <div className="flex items-center gap-1">
                {item?.gone && <Badge variant="danger">taken down</Badge>}
                {item && !item.forArk && <Badge variant="warning">not an ARK mod</Badge>}
                {!knowsDisk ? (
                    <Badge title="The server is not running, so what it has downloaded cannot be read.">
                        unknown
                    </Badge>
                ) : installed ? (
                    <Badge variant="success">installed</Badge>
                ) : (
                    <Badge variant="warning">installs at the next start</Badge>
                )}
                <a
                    href={workshopUrl(id)}
                    target="_blank"
                    rel="noreferrer noopener"
                    title="Open it on Steam"
                    aria-label={`Open ${item?.title ?? id} on Steam`}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ExternalLink className="size-4" />
                </a>
                {canManage && onUp && (
                    <Button
                        size="icon"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Load ${item?.title ?? id} earlier`}
                        title="Load it earlier"
                        onClick={onUp}
                    >
                        <ArrowUp className="size-4" />
                    </Button>
                )}
                {canManage && onDown && (
                    <Button
                        size="icon"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Load ${item?.title ?? id} later`}
                        title="Load it later"
                        onClick={onDown}
                    >
                        <ArrowDown className="size-4" />
                    </Button>
                )}
                {canManage && (
                    <Button
                        size="icon"
                        variant="ghost"
                        disabled={busy}
                        className="text-danger hover:text-danger"
                        aria-label={`Remove ${item?.title ?? id}`}
                        title="Remove it"
                        onClick={onRemove}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                )}
            </div>
        </div>
    );
}
