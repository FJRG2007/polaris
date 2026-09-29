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
 * there are no results, and a shelf of the mods most private servers end up running
 * is offered underneath it: an empty search box is not a catalogue, and an instance
 * with no key would otherwise have nothing to browse at all.
 */

import Image from "next/image";
import { useGameText } from "../game-text";
import * as actions from "./ark-actions";
import { hostUi } from "@polaris/app-host/client";
import { RestartPlanner } from "./restart-planner";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArkModsView } from "../../lib/ark/mods-service";
import type { ArkModSuggestion } from "../../lib/ark/mod-catalog";
import { workshopUrl, type WorkshopItem } from "../../lib/ark/workshop";
import { MAX_MODS, movedMod, withoutMod, withMod } from "../../lib/ark/mods";
import { Badge, Button, Card, CardBody, Input, Skeleton, cn } from "@polaris/ui";
import {
    AlertTriangle,
    ArrowDown,
    ArrowUp,
    ExternalLink,
    Loader2,
    Plus,
    RefreshCw,
    Search,
    Trash2
} from "lucide-react";

const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;
const { mergeUnchanged } = hostUi.structuralMerge;

/** How old a kept list may be and still paint first on a revisit. */
const KEPT_MODS_MS = 24 * 3_600_000;

/** The suggested mods, grouped, each with what Steam says about it. */
type ModShelves = readonly {
    group: string;
    entries: { suggestion: ArkModSuggestion; item: WorkshopItem | null }[];
}[];

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
    const t = useGameText("ark");
    // What this tab last read paints first, so a revisit is not a skeleton while
    // the server and Steam are asked again; the read replaces what moved.
    const modsKey = `ark-mods:${installedAppId}`;
    const [mods, setMods] = useState<ArkModsView | null>(null);
    const [loading, setLoading] = useState(true);
    useKeptSnapshot<ArkModsView>(modsKey, KEPT_MODS_MS, (kept) => {
        setMods((current) => current ?? kept.value);
        setLoading(false);
    });
    // Whether this visit's own read has answered. The kept list only paints: every
    // change below writes the whole list, so none of them is offered on a copy
    // another admin may have changed since.
    const [fresh, setFresh] = useState(false);
    const freshRef = useRef(false);
    useEffect(() => {
        if (fresh && mods) writeSnapshot(modsKey, mods);
    }, [fresh, modsKey, mods]);
    const [busy, setBusy] = useState(false);
    const locked = busy || !fresh;
    const [error, setError] = useState<string | null>(null);
    const [changed, setChanged] = useState(false);

    const load = useCallback(async () => {
        const result = await actions.readArkModsAction(installedAppId);
        setLoading(false);
        const found = result.mods;
        if (found) {
            setMods((current) => mergeUnchanged(current, found));
            freshRef.current = true;
            setFresh(true);
        } else {
            if (!freshRef.current) setMods(null);
            setError(result.error ?? "The mods could not be read");
        }
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

    const ids = mods?.ids ?? [];

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">
                    {t("mods.modsAreDownloadedWhenThe")}
                </p>
                <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto"
                    aria-label={t("mods.readTheModsAgain")}
                    title={t("mods.readTheModsAgain")}
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

            {canManage && (
                <RestartPlanner
                    installedAppId={installedAppId}
                    running={running}
                    changed={changed}
                    reason="a change to the mods"
                    onRestarted={() => {
                        setChanged(false);
                        void load();
                    }}
                />
            )}

            {canManage && (
                <AddMod
                    installedAppId={installedAppId}
                    busy={locked}
                    onAdd={(id) => void save(withMod(ids, id))}
                    onSetMap={(id) => void setMap(id)}
                />
            )}

            {/* Something to install, for a server that has nothing. Steam's own
                index cannot be browsed without a key, so this is Polaris' short
                list with Steam's own names and pictures on it. */}
            {canManage && (
                <ModShelves
                    installedAppId={installedAppId}
                    busy={locked}
                    installedIds={[...ids, ...(mods?.mapModId ? [mods.mapModId] : [])]}
                    onAdd={(id) => void save(withMod(ids, id))}
                    onSetMap={(id) => void setMap(id)}
                />
            )}

            {/* Both headings are drawn at once; only what is under them waits
                for the server's files. */}
            <div className="flex flex-col gap-1">
                <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("mods.map")}
                </p>
                <Card>
                    <CardBody className="py-0">
                        {loading || !mods ? (
                            <ListPending loading={loading} rows={1} />
                        ) : mods.mapModId ? (
                            <ModRow
                                installedAppId={installedAppId}
                                id={mods.mapModId}
                                item={details(mods.mapModId)}
                                installed={mods.installed.includes(mods.mapModId)}
                                knowsDisk={running}
                                first
                                busy={locked}
                                canManage={canManage}
                                onRemove={() => void setMap(null)}
                            />
                        ) : (
                            <p className="py-4 text-sm text-muted-foreground">
                                {t("mods.thisServerRunsOneOf")}
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
                        {loading || !mods ? (
                            <ListPending loading={loading} rows={2} />
                        ) : ids.length === 0 ? (
                            <p className="py-4 text-sm text-muted-foreground">
                                {t("mods.noModsPasteAWorkshop")}
                            </p>
                        ) : (
                            ids.map((id, index) => (
                                <ModRow
                                    key={id}
                                    installedAppId={installedAppId}
                                    id={id}
                                    item={details(id)}
                                    installed={mods.installed.includes(id)}
                                    knowsDisk={running}
                                    first={index === 0}
                                    position={index + 1}
                                    busy={locked}
                                    canManage={canManage}
                                    onUp={
                                        index > 0
                                            ? () => void save(movedMod(ids, id, -1))
                                            : undefined
                                    }
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

            <p className="text-xs text-muted-foreground">{t("mods.modsLoadInTheOrder")}</p>
        </div>
    );
}

/** What stands in a list while it is read, and what it says once reading it has
 *  failed - the error above says why, and "no mods" would be a claim nothing
 *  checked. */
function ListPending({ loading, rows }: { loading: boolean; rows: number }) {
    const t = useGameText("ark");
    if (!loading) {
        return <p className="py-4 text-sm text-muted-foreground">{t("mods.couldNotBeRead")}</p>;
    }
    return (
        <div className="flex flex-col gap-2 py-3" aria-busy="true">
            {Array.from({ length: rows }, (_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
            ))}
        </div>
    );
}

/**
 * What to install when you have installed nothing.
 *
 * Steam's index cannot be browsed without a Web API key, so an empty search box is
 * all a fresh instance would have. This is Polaris' own short list - the mods a
 * private server actually reaches for - with every name, size and picture read
 * from Steam as the screen draws, so a row can never describe something that has
 * since changed.
 */
function ModShelves({
    installedAppId,
    busy,
    installedIds,
    onAdd,
    onSetMap
}: {
    installedAppId: string;
    busy: boolean;
    /** What this server already runs. Those rows are dropped: a shelf offering to
     *  add what is already installed is a shelf nobody trusts. */
    installedIds: readonly string[];
    onAdd: (id: string) => void;
    onSetMap: (id: string) => void;
}) {
    const t = useGameText("ark");
    const shelvesKey = `ark-mod-shelves:${installedAppId}`;
    const [shelves, setShelves] = useState<ModShelves>([]);
    useKeptSnapshot<ModShelves>(shelvesKey, KEPT_MODS_MS, (kept) =>
        setShelves((current) => (current.length > 0 ? current : kept.value))
    );
    const [open, setOpen] = useState(true);

    useEffect(() => {
        void actions.readArkModShelvesAction(installedAppId).then((answer) => {
            setShelves((current) => mergeUnchanged<ModShelves>(current, answer.shelves));
            writeSnapshot(shelvesKey, answer.shelves);
        });
    }, [installedAppId, shelvesKey]);

    const shown = shelves
        .map((shelf) => ({
            ...shelf,
            entries: shelf.entries.filter((entry) => !installedIds.includes(entry.suggestion.id))
        }))
        .filter((shelf) => shelf.entries.length > 0);
    if (shown.length === 0) return null;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("mods.worthALook")}</p>
                        <p className="text-xs text-muted-foreground">
                            {t("mods.theOnesMostPrivateServers")}
                        </p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
                        {open ? t("mods.hide") : t("mods.show")}
                    </Button>
                </div>

                {open &&
                    shown.map((shelf) => (
                        <div key={shelf.group} className="flex flex-col gap-2">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {shelf.group}
                            </p>
                            {shelf.entries.map(({ suggestion, item }) => (
                                <div
                                    key={suggestion.id}
                                    className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2"
                                >
                                    {item ? (
                                        <Preview installedAppId={installedAppId} item={item} />
                                    ) : (
                                        <div
                                            className="size-12 shrink-0 rounded-md bg-muted"
                                            aria-hidden
                                        />
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">
                                            {item?.title ?? suggestion.name}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {suggestion.why}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {[
                                                size(item?.sizeBytes ?? null),
                                                item?.subscriptions
                                                    ? `${item.subscriptions.toLocaleString()} subscribers`
                                                    : ""
                                            ]
                                                .filter(Boolean)
                                                .join(" - ")}
                                        </p>
                                    </div>
                                    <a
                                        href={workshopUrl(suggestion.id)}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        title={t("mods.openItOnSteam")}
                                        aria-label={`Open ${item?.title ?? suggestion.name} on Steam`}
                                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <ExternalLink className="size-4" />
                                    </a>
                                    {suggestion.kind === "map" ? (
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            disabled={busy}
                                            onClick={() => onSetMap(suggestion.id)}
                                        >
                                            {t("mods.useAsTheMap")}
                                        </Button>
                                    ) : (
                                        <Button
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => onAdd(suggestion.id)}
                                        >
                                            <Plus className="size-4" /> {t("mods.add")}
                                        </Button>
                                    )}
                                </div>
                            ))}
                        </div>
                    ))}
            </CardBody>
        </Card>
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
    const t = useGameText("ark");
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
            if (answer.error || !answer.item)
                setError(answer.error ?? "Steam does not know that id");
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
                            aria-label={t("mods.aWorkshopLinkAnId")}
                            placeholder={t("mods.pasteAWorkshopLinkOr")}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                void go();
                            }}
                        />
                    </div>
                    <Button
                        disabled={busy || looking || query.trim().length === 0}
                        onClick={() => void go()}
                    >
                        {looking ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Search className="size-4" />
                        )}
                        {t("mods.lookItUp")}
                    </Button>
                </div>

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                {needsKey && (
                    <p className="text-xs text-muted-foreground">
                        {t("mods.searchingTheWorkshopNeedsA")}
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
                    <p className="text-sm text-muted-foreground">
                        {t("mods.nothingOnTheWorkshopMatches")}
                    </p>
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
    const t = useGameText("ark");
    return (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2">
            <Preview installedAppId={installedAppId} item={item} />
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={item.title}>
                    {item.title}
                </p>
                {/* The author's own description, quoted rather than rendered: it is
                    somebody else's text and it arrives with the Workshop's own
                    markup in it. */}
                {item.summary && (
                    <p className="truncate text-xs text-muted-foreground">{item.summary}</p>
                )}
                <p className="truncate text-xs text-muted-foreground">
                    {[
                        size(item.sizeBytes),
                        item.subscriptions
                            ? `${item.subscriptions.toLocaleString()} subscribers`
                            : ""
                    ]
                        .filter(Boolean)
                        .join(" - ")}
                </p>
            </div>
            <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={onSetMap}
                title={t("mods.runThisAsTheMap")}
            >
                {t("mods.useAsTheMap")}
            </Button>
            <Button size="sm" disabled={busy} onClick={onAdd}>
                <Plus className="size-4" /> {t("mods.add")}
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
    const t = useGameText("ark");
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
                {item?.gone && <Badge variant="danger">{t("mods.takenDown")}</Badge>}
                {item && !item.forArk && <Badge variant="warning">{t("mods.notAnArkMod")}</Badge>}
                {!knowsDisk ? (
                    <Badge title={t("mods.theServerIsNotRunning")}>unknown</Badge>
                ) : installed ? (
                    <Badge variant="success">installed</Badge>
                ) : (
                    <Badge variant="warning">{t("mods.installsAtTheNextStart")}</Badge>
                )}
                <a
                    href={workshopUrl(id)}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={t("mods.openItOnSteam")}
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
                        title={t("mods.loadItEarlier")}
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
                        title={t("mods.loadItLater")}
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
                        title={t("mods.removeIt")}
                        onClick={onRemove}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                )}
            </div>
        </div>
    );
}
