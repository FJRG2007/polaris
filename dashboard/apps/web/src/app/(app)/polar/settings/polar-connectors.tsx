"use client";

/**
 * Connectors on Polar settings: one directory of MCP servers, the way Claude's
 * and ChatGPT's connector directories and the Polaris app store are drawn -
 * every server exactly once, the catalog and the servers this person added by
 * their address together, each with where it stands (Connected, Needs
 * attention, Connect). "Connected" is a view of that list, never a second one.
 * Pressing an entry opens its detail: its tools and what Polar may do with each
 * one, the connection test, sign in again, and disconnect.
 *
 * The directory is searched and paged by `/api/polar/connectors/directory`;
 * the first page is drawn here from the same pure function, so the list is on
 * screen at first paint, and a search narrows what is already shown while the
 * server answers.
 *
 * Every change is optimistic and put back when the server refuses it. The
 * server answers a connector without its secret (`ConnectorView`), so nothing
 * typed into the token fields ever comes back to the page.
 *
 * A sign-in may finish somewhere this page cannot see - the desktop app of an
 * older release hands the provider's page to the system browser, and another
 * tab may finish one - so the connections are read again from the server while
 * one is waiting, whenever the window comes back into view, and when another
 * tab of this screen says a sign-in came back.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ExternalLink, LogIn, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    SegmentedControl,
    SheetContent,
    Skeleton,
    Switch,
    cn
} from "@polaris/ui";
import { StoreFilters } from "@polaris/ui/store-layout";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ConnectDialog } from "./connector-catalog";
import type { ConnectorView } from "@/lib/polar/connectors/store";
import { ConnectorLogo } from "@/components/polar/connector-marks";
import { leavePage } from "@/lib/keep-call";
import * as directory from "@/lib/polar/connectors/directory";
import { catalogEntry, entryForUrl, type AvailableEntry } from "@/lib/polar/connectors/catalog";

type Policy = ConnectorView["tools"][number]["policy"];
type Auth = ConnectorView["auth"];
type Transport = ConnectorView["transport"];
type Query = directory.DirectoryQuery;
type Page = directory.DirectoryPage & { query: Query };

const AUTHS: Auth[] = ["none", "bearer", "oauth"];
const TRANSPORTS: Transport[] = ["http", "sse"];
const POLICIES: Policy[] = ["allow", "ask", "block"];
const ERRORS = [
    "failed",
    "invalid",
    "limit",
    "duplicate",
    "address",
    "host",
    "rate_limited",
    "connectors_off",
    "no_metadata",
    "no_pkce",
    "no_registration",
    "insecure",
    "token_refused",
    "invalid_answer",
    "refused",
    "unreachable"
] as const;
type ErrorCode = (typeof ERRORS)[number];
const isErrorCode = (code: unknown): code is ErrorCode =>
    typeof code === "string" && (ERRORS as readonly string[]).includes(code);

/** Whether a typed address can be a server at all; the server decides the rest. */
function looksLikeServer(value: string): boolean {
    try {
        const url = new URL(value.trim());
        return (url.protocol === "https:" || url.protocol === "http:") && !url.username;
    } catch {
        return false;
    }
}

async function send(path: string, init: RequestInit): Promise<{ ok: boolean; body: any }> {
    const response = await fetch(path, {
        ...init,
        headers: init.body ? { "content-type": "application/json" } : undefined
    }).catch(() => null);
    if (!response) return { ok: false, body: { error: "unreachable" } };
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, body };
}

/** How often, and for how long, a sign-in that left this page is checked on. */
const WAIT_EVERY_MS = 3_000;
const WAIT_MOST_MS = 120_000;
/** Where a tab of this screen says a sign-in came back. */
const CHANNEL = "polar-connectors";
/** How long typing settles before the server is asked. */
const SEARCH_DELAY_MS = 200;
const START: Query = { q: "", category: "all", view: "all" };
const NO_HOSTS: readonly string[] = [];

const sameQuery = (a: Query, b: Query) =>
    a.q.trim() === b.q.trim() && a.category === b.category && a.view === b.view;

/** The directory entry a connection belongs to. */
function keyFor(row: Pick<ConnectorView, "id" | "url">): string {
    const entry = entryForUrl(row.url);
    return entry ? `catalog:${entry.id}` : `custom:${row.id}`;
}

/** A directory entry with its catalog listing and its connections as they are now. */
interface Shown extends directory.DirectoryItem {
    entry: AvailableEntry | null;
    connections: ConnectorView[];
}

export function PolarConnectors({
    initial,
    returned,
    hosts = NO_HOSTS
}: {
    initial: ConnectorView[];
    /** The administrator's host allowlist; empty allows every host. */
    hosts?: readonly string[];
    /** How a sign-in that just came back went, from the callback. */
    returned: "signed_in" | "failed" | null;
}) {
    const t = useTranslations("account");
    const [rows, setRows] = useState(initial);
    const [filters, setFilters] = useState<Query>(START);
    const [page, setPage] = useState<Page>(() => ({
        ...directory.pageDirectory(directory.buildDirectory(initial, hosts), START),
        query: START
    }));
    const [loading, setLoading] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [adding, setAdding] = useState(false);
    const [connecting, setConnecting] = useState<AvailableEntry | null>(null);
    const [detail, setDetail] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(
        returned === "failed" ? t("polarConnectors.errors.signInFailed") : null
    );
    const [busy, setBusy] = useState<string | null>(null);
    const [removing, setRemoving] = useState<ConnectorView | null>(null);
    const [signedInNow, setSignedInNow] = useState(false);
    /** The connector a sign-in left this page for, and since when. */
    const [waiting, setWaiting] = useState<{ id: string; since: number } | null>(null);
    const waitingRef = useRef(waiting);
    waitingRef.current = waiting;
    const filtersRef = useRef(filters);
    filtersRef.current = filters;
    /** The newest directory request; an older answer is dropped. */
    const request = useRef(0);
    const loadingRef = useRef(false);

    /** One page of the directory from the server, with the connections as they are now. */
    const load = useCallback(async (query: Query, cursor: number) => {
        const id = ++request.current;
        loadingRef.current = true;
        setLoading(true);
        const params = new URLSearchParams({
            q: query.q.trim(),
            category: query.category,
            view: query.view,
            cursor: String(cursor)
        });
        const answer = await send(`/api/polar/connectors/directory?${params}`, { method: "GET" });
        if (id !== request.current) return;
        loadingRef.current = false;
        setLoading(false);
        if (!answer.ok || !Array.isArray(answer.body.items)) {
            setLoadFailed(true);
            return;
        }
        setLoadFailed(false);
        const body = answer.body as directory.DirectoryPage & { connectors?: ConnectorView[] };
        if (Array.isArray(body.connectors)) setRows(body.connectors);
        setPage((current) => {
            const items =
                cursor > 0 && sameQuery(current.query, query)
                    ? [
                          ...current.items,
                          ...body.items.filter(
                              (item) => !current.items.some((held) => held.key === item.key)
                          )
                      ]
                    : body.items;
            return { items, next: body.next, total: body.total, counts: body.counts, query };
        });
    }, []);

    // The first page is already drawn; a changed search or filter asks again.
    const firstFilters = useRef(true);
    useEffect(() => {
        if (firstFilters.current) {
            firstFilters.current = false;
            return;
        }
        const timer = window.setTimeout(
            () => void load(filters, 0),
            filters.q.trim() ? SEARCH_DELAY_MS : 0
        );
        return () => window.clearTimeout(timer);
    }, [filters, load]);

    /** The directory as these connections make it, kept on the current search. */
    const rebuild = useCallback(
        (next: ConnectorView[]) =>
            setPage((current) => ({
                ...directory.pageDirectory(
                    directory.buildDirectory(next, hosts),
                    filtersRef.current,
                    0,
                    Math.max(current.items.length, directory.DIRECTORY_PAGE_SIZE)
                ),
                query: filtersRef.current
            })),
        [hosts]
    );

    /** The connections as the server has them now; the server decides what is signed in. */
    const reload = useCallback(async () => {
        const answer = await send("/api/polar/connectors", { method: "GET" });
        if (!answer.ok || !Array.isArray(answer.body.connectors)) return;
        const next = answer.body.connectors as ConnectorView[];
        setRows(next);
        const wait = waitingRef.current;
        const row = wait && next.find((entry) => entry.id === wait.id);
        if (wait && (!row || (row.signedIn && row.status !== "sign_in"))) {
            setWaiting(null);
            setBusy(null);
            if (row) {
                setError(null);
                setSignedInNow(true);
            }
        }
    }, []);

    useEffect(() => {
        if (!waiting) return;
        const timer = window.setInterval(() => {
            if (Date.now() - waiting.since > WAIT_MOST_MS) {
                setWaiting(null);
                setBusy(null);
                return;
            }
            void reload();
        }, WAIT_EVERY_MS);
        return () => window.clearInterval(timer);
    }, [waiting, reload]);

    useEffect(() => {
        const visible = () => {
            if (document.visibilityState === "visible") void reload();
        };
        // Back from the provider's page through the browser's cache: the
        // page is as it was left, so its sign-in button is freed again.
        const shown = (event: PageTransitionEvent) => {
            if (!event.persisted) return;
            setWaiting(null);
            setBusy(null);
            void reload();
        };
        window.addEventListener("focus", visible);
        document.addEventListener("visibilitychange", visible);
        window.addEventListener("pageshow", shown);
        let channel: BroadcastChannel | null = null;
        if (typeof BroadcastChannel !== "undefined") {
            channel = new BroadcastChannel(CHANNEL);
            channel.onmessage = () => void reload();
            if (returned === "signed_in") channel.postMessage("signed_in");
        }
        return () => {
            window.removeEventListener("focus", visible);
            document.removeEventListener("visibilitychange", visible);
            window.removeEventListener("pageshow", shown);
            channel?.close();
        };
    }, [reload, returned]);

    const say = (code: unknown) =>
        setError(t(`polarConnectors.errors.${isErrorCode(code) ? code : "failed"}`));
    const errorText = (code: unknown) =>
        t(`polarConnectors.errors.${isErrorCode(code) ? code : "failed"}`);
    const replace = (view: ConnectorView) =>
        setRows((current) => current.map((row) => (row.id === view.id ? view : row)));

    async function patch(row: ConnectorView, optimistic: ConnectorView, body: unknown) {
        setError(null);
        replace(optimistic);
        const answer = await send(`/api/polar/connectors/${row.id}`, {
            method: "PATCH",
            body: JSON.stringify(body)
        });
        if (answer.ok) replace(answer.body.connector);
        else {
            replace(row);
            say(answer.body.error);
        }
    }

    async function test(row: ConnectorView) {
        setError(null);
        setBusy(row.id);
        const answer = await send(`/api/polar/connectors/${row.id}/test`, { method: "POST" });
        setBusy(null);
        if (answer.ok) replace(answer.body.connector);
        else say(answer.body.error);
    }

    /**
     * Sends the window to the sign-in route, which forwards it to the
     * provider: a round trip the desktop app keeps in its own window. Should
     * the page stay - the provider opened somewhere else - it waits for the
     * server to say the connector is signed in. The same route signs a
     * connector in again once its sign-in ran out.
     */
    function signIn(row: ConnectorView) {
        setError(null);
        setSignedInNow(false);
        setBusy(row.id);
        setWaiting({ id: row.id, since: Date.now() });
        // In a new tab while a call is on: the provider's sign-in is a round
        // trip of minutes, and the wait below hears when it is done.
        leavePage(`/api/polar/connectors/${row.id}/sign-in`);
    }

    /** A connection just made: in the list at once, its detail open. */
    function adopt(view: ConnectorView) {
        setError(null);
        const next = [...rows.filter((row) => row.id !== view.id), view];
        setRows(next);
        rebuild(next);
        setDetail(keyFor(view));
        if (view.auth === "oauth" && !view.signedIn) signIn(view);
    }

    async function remove(row: ConnectorView) {
        setError(null);
        setRemoving(null);
        const next = rows.filter((entry) => entry.id !== row.id);
        setRows(next);
        rebuild(next);
        const answer = await send(`/api/polar/connectors/${row.id}`, { method: "DELETE" });
        if (!answer.ok && answer.body.error !== "not_found") {
            setRows((current) => [...current, row]);
            rebuild([...next, row]);
            say(answer.body.error);
        }
    }

    const join = useCallback(
        (item: directory.DirectoryItem, byId: Map<string, ConnectorView>): Shown => {
            const connections = item.connectionIds
                .map((id) => byId.get(id))
                .filter((row): row is ConnectorView => Boolean(row));
            return {
                ...item,
                entry: catalogEntry(item.entryId),
                connections,
                state: directory.stateOf(connections, item.state === "unavailable")
            };
        },
        []
    );
    const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
    const full = useMemo(() => directory.buildDirectory(rows, hosts), [rows, hosts]);
    const counts = useMemo(() => directory.directoryCounts(full), [full]);
    const settled = sameQuery(page.query, filters);
    // While the server answers a new search, what is shown narrows at once.
    const shown = (settled ? page.items : directory.queryDirectory(page.items, filters))
        .map((item) => join(item, byId))
        .filter((item) => item.kind === "catalog" || item.connections.length > 0);
    const opened = useMemo(() => {
        const item = detail ? full.find((entry) => entry.key === detail) : null;
        return item ? join(item, byId) : null;
    }, [detail, full, byId, join]);
    const canMore = settled && page.next !== null;

    const more = useCallback(() => {
        if (loadingRef.current || page.next === null) return;
        void load(page.query, page.next);
    }, [load, page]);
    const sentinel = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const node = sentinel.current;
        if (!node || !canMore || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            (entries) => entries.some((entry) => entry.isIntersecting) && more(),
            { rootMargin: "400px" }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [canMore, more]);

    const setQuery = (q: string) => setFilters((current) => ({ ...current, q }));

    return (
        <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 basis-64">
                    <h2 className="text-sm font-semibold">{t("polarConnectors.title")}</h2>
                    <p className="text-sm text-muted-foreground">{t("polarConnectors.intro")}</p>
                    <p className="text-xs text-foreground-subtle">
                        {t("polarConnectors.reverse")}{" "}
                        <Link href="/account/assistants" className="text-primary hover:underline">
                            {t("polarConnectors.reverseLink")}
                        </Link>
                    </p>
                </div>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => setAdding(true)}
                >
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                    {t("polarConnectors.add")}
                </Button>
            </div>
            {waiting ? (
                <p role="status" className="text-sm text-muted-foreground">
                    {t("polarConnectors.waiting")}
                </p>
            ) : returned === "signed_in" || signedInNow ? (
                <p role="status" className="text-sm text-success-ink">
                    {t("polarConnectors.signedIn")}
                </p>
            ) : null}
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            <div className="min-w-0 overflow-x-auto">
                <SegmentedControl<directory.DirectoryView>
                    size="sm"
                    value={filters.view}
                    aria-label={t("polarConnectors.directory.viewsLabel")}
                    options={directory.DIRECTORY_VIEWS.map((value) => ({
                        value,
                        label: t(`polarConnectors.directory.views.${value}`, {
                            count: counts[value]
                        })
                    }))}
                    onValueChange={(view) => setFilters((current) => ({ ...current, view }))}
                />
            </div>
            <StoreFilters<string, directory.DirectoryCategory | "all">
                query={filters.q}
                onQueryChange={setQuery}
                category={filters.category}
                onCategoryChange={(category) =>
                    setFilters((current) => ({ ...current, category }))
                }
                categories={(["all", ...directory.DIRECTORY_CATEGORIES] as const).map((value) => ({
                    value,
                    label: t(`polarConnectors.directory.categories.${value}`)
                }))}
                words={{
                    search: t("polarConnectors.search"),
                    categories: t("polarConnectors.directory.categoriesLabel")
                }}
            />
            {loadFailed && shown.length > 0 ? (
                <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
                    {t("polarConnectors.directory.loadFailed")}
                    <Button type="button" size="sm" variant="ghost" onClick={() => void load(filters, 0)}>
                        {t("polarConnectors.directory.retry")}
                    </Button>
                </p>
            ) : null}
            {shown.length === 0 ? (
                !settled && loading ? (
                    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
                        {Array.from({ length: 6 }, (_, index) => (
                            <li key={index} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                                <Skeleton className="size-9 shrink-0 rounded-md" />
                                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                    <Skeleton className="h-3.5 w-2/3" />
                                    <Skeleton className="h-3 w-1/3" />
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : !settled && loadFailed ? (
                    <EmptyState
                        title={t("polarConnectors.directory.loadFailed")}
                        action={
                            <Button type="button" size="sm" onClick={() => void load(filters, 0)}>
                                {t("polarConnectors.directory.retry")}
                            </Button>
                        }
                    />
                ) : filters.view === "connected" && !filters.q.trim() && filters.category === "all" ? (
                    <EmptyState
                        icon={<Plug className="size-5 text-muted-foreground" />}
                        title={t("polarConnectors.directory.noConnected")}
                        description={t("polarConnectors.directory.noConnectedHint")}
                        action={
                            <Button
                                type="button"
                                size="sm"
                                onClick={() => setFilters((current) => ({ ...current, view: "all" }))}
                            >
                                {t("polarConnectors.directory.browseAll")}
                            </Button>
                        }
                    />
                ) : filters.view === "attention" && !filters.q.trim() && filters.category === "all" ? (
                    <EmptyState title={t("polarConnectors.directory.allWorking")} />
                ) : (
                    <EmptyState
                        title={t("polarConnectors.noMatch")}
                        description={t("polarConnectors.directory.noMatchHint")}
                        action={
                            <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
                                {t("polarConnectors.directory.addByUrl")}
                            </Button>
                        }
                    />
                )
            ) : (
                <ul
                    className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
                    aria-busy={loading || undefined}
                    aria-label={t("polarConnectors.title")}
                >
                    {shown.map((item) => (
                        <DirectoryCard
                            key={item.key}
                            item={item}
                            onOpen={() => setDetail(item.key)}
                            onConnect={() => item.entry && setConnecting(item.entry)}
                        />
                    ))}
                </ul>
            )}
            {canMore ? (
                <div ref={sentinel} className="flex justify-center">
                    <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={more}>
                        {t("polarConnectors.directory.showMore")}
                    </Button>
                </div>
            ) : null}
            <Dialog open={opened !== null} onOpenChange={(next) => !next && setDetail(null)}>
                {opened ? (
                    <SheetContent className="sm:w-[30rem]">
                        <ConnectorDetail
                            item={opened}
                            busy={busy}
                            onConnect={() => {
                                setDetail(null);
                                if (opened.entry) setConnecting(opened.entry);
                            }}
                            onSignIn={signIn}
                            onTest={(row) => void test(row)}
                            onPatch={(row, optimistic, body) => void patch(row, optimistic, body)}
                            onRemove={(row) => {
                                setDetail(null);
                                setRemoving(row);
                            }}
                        />
                    </SheetContent>
                ) : null}
            </Dialog>
            <AddConnector open={adding} onOpenChange={setAdding} onAdded={(view) => {
                setAdding(false);
                adopt(view);
            }} />
            <ConnectDialog
                entry={connecting}
                hosts={hosts}
                send={send}
                errorText={errorText}
                onClose={() => setConnecting(null)}
                onAdded={(view) => {
                    setConnecting(null);
                    adopt(view);
                }}
            />
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(next) => !next && setRemoving(null)}
                name={removing?.name ?? ""}
                kind={t("polarConnectors.kind")}
                description={t("polarConnectors.removeHint")}
                onConfirm={() => removing && void remove(removing)}
            />
        </section>
    );
}

/** An entry's mark: the vendor's, or a plug for a server added by its address. */
function EntryMark({ item, size = "md" }: { item: Shown; size?: "md" | "lg" }) {
    return (
        <span
            className={cn(
                "grid shrink-0 place-items-center rounded-md border border-border bg-surface text-foreground",
                size === "lg" ? "size-11" : "size-9"
            )}
        >
            {item.entry ? (
                <ConnectorLogo
                    logo={item.entry.logo}
                    name={item.entry.vendor}
                    className={size === "lg" ? "size-6" : "size-5"}
                />
            ) : (
                <Plug className={cn("text-muted-foreground", size === "lg" ? "size-5" : "size-4")} />
            )}
        </span>
    );
}

function StateBadge({ state }: { state: directory.DirectoryState }) {
    const t = useTranslations("account");
    const variant =
        state === "connected" ? "success" : state === "attention" ? "warning" : "neutral";
    return (
        <Badge variant={variant} className="shrink-0">
            {t(`polarConnectors.directory.state.${state}`)}
        </Badge>
    );
}

function useSubtitle(item: Shown): string {
    const t = useTranslations("account");
    return item.kind === "custom"
        ? `${t("polarConnectors.directory.custom")} · ${item.vendor}`
        : `${item.vendor} · ${t(`polarConnectors.directory.categories.${item.category}`)}`;
}

function DirectoryCard({
    item,
    onOpen,
    onConnect
}: {
    item: Shown;
    onOpen: () => void;
    onConnect: () => void;
}) {
    const t = useTranslations("account");
    const subtitle = useSubtitle(item);
    return (
        <li className="min-w-0">
            <div className="flex h-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-muted/40">
                <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-start"
                    onClick={onOpen}
                >
                    <EntryMark item={item} />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium" title={item.name}>
                            {item.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground" title={subtitle}>
                            {subtitle}
                        </span>
                    </span>
                </button>
                {item.state === "available" && item.entry ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        aria-label={t("polarConnectors.directory.connectLabel", { name: item.name })}
                        onClick={onConnect}
                    >
                        {t("polarConnectors.directory.connect")}
                    </Button>
                ) : item.state !== "available" ? (
                    <StateBadge state={item.state} />
                ) : null}
            </div>
        </li>
    );
}

function ConnectorDetail({
    item,
    busy,
    onConnect,
    onSignIn,
    onTest,
    onPatch,
    onRemove
}: {
    item: Shown;
    busy: string | null;
    onConnect: () => void;
    onSignIn: (row: ConnectorView) => void;
    onTest: (row: ConnectorView) => void;
    onPatch: (row: ConnectorView, optimistic: ConnectorView, body: unknown) => void;
    onRemove: (row: ConnectorView) => void;
}) {
    const t = useTranslations("account");
    const tp = useTranslations("polar");
    const subtitle = useSubtitle(item);
    const description = item.entry
        ? tp(`settings.connectorCatalog.entries.${item.entry.id}` as never)
        : t("polarConnectors.directory.customHint");
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
            <DialogHeader>
                <div className="flex min-w-0 items-center gap-3 pe-8">
                    <EntryMark item={item} size="lg" />
                    <div className="min-w-0 flex-1">
                        <DialogTitle className="truncate" title={item.name}>
                            {item.name}
                        </DialogTitle>
                        <p className="truncate text-xs text-muted-foreground" title={subtitle}>
                            {subtitle}
                        </p>
                    </div>
                </div>
                <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
                {item.state !== "available" ? <StateBadge state={item.state} /> : null}
                {item.entry ? (
                    <a
                        href={item.entry.docs}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                        {tp("settings.connectorCatalog.docs")}
                        <ExternalLink className="size-3 shrink-0" />
                    </a>
                ) : null}
            </div>
            {item.state === "unavailable" ? (
                <p className="text-sm text-warning-ink">{tp("settings.connectorCatalog.hostBlocked")}</p>
            ) : null}
            {item.connections.length === 0 && item.entry && item.state === "available" ? (
                <Button type="button" className="self-start" onClick={onConnect}>
                    <Plug className="h-3.5 w-3.5 shrink-0" />
                    {t("polarConnectors.directory.connect")}
                </Button>
            ) : null}
            {item.connections.map((row) => (
                <ConnectionSection
                    key={row.id}
                    row={row}
                    showUrl={item.kind === "custom" || item.connections.length > 1 || Boolean(item.entry?.field)}
                    busy={busy === row.id}
                    onSignIn={() => onSignIn(row)}
                    onTest={() => onTest(row)}
                    onPatch={(optimistic, body) => onPatch(row, optimistic, body)}
                    onRemove={() => onRemove(row)}
                />
            ))}
            {item.entry?.field && item.connections.length > 0 ? (
                <Button type="button" variant="outline" className="self-start" onClick={onConnect}>
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                    {t("polarConnectors.directory.connectAnother")}
                </Button>
            ) : null}
        </div>
    );
}

function ConnectionSection({
    row,
    showUrl,
    busy,
    onSignIn,
    onTest,
    onPatch,
    onRemove
}: {
    row: ConnectorView;
    showUrl: boolean;
    busy: boolean;
    onSignIn: () => void;
    onTest: () => void;
    onPatch: (optimistic: ConnectorView, body: unknown) => void;
    onRemove: () => void;
}) {
    const t = useTranslations("account");
    const needsSignIn = row.auth === "oauth" && (!row.signedIn || row.status === "sign_in");
    return (
        <section className="flex min-w-0 flex-col gap-3 border-t border-border pt-4">
            <div className="flex min-w-0 items-center gap-3">
                <div className="min-w-0 flex-1">
                    {showUrl ? (
                        <p className="truncate text-sm" title={row.url}>
                            {row.url}
                        </p>
                    ) : (
                        <p className="text-sm font-medium">{t("polarConnectors.directory.connection")}</p>
                    )}
                </div>
                <StatusBadge row={row} />
                <Switch
                    checked={row.enabled}
                    aria-label={t("polarConnectors.enabled", { name: row.name })}
                    onChange={(enabled) => onPatch({ ...row, enabled }, { enabled })}
                />
            </div>
            {row.status === "error" ? (
                <p role="status" className="text-xs text-danger">
                    {t(`polarConnectors.errors.${isErrorCode(row.lastError) ? row.lastError : "failed"}`)}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
                {needsSignIn ? (
                    <Button type="button" size="sm" disabled={busy} onClick={onSignIn}>
                        <LogIn className="h-3.5 w-3.5 shrink-0" />
                        {t("polarConnectors.signIn")}
                    </Button>
                ) : null}
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onTest}>
                    <RefreshCw className={cn("h-3.5 w-3.5 shrink-0", busy && "animate-spin")} />
                    {t("polarConnectors.test")}
                </Button>
                {row.auth === "oauth" && !needsSignIn ? (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onSignIn}>
                        <LogIn className="h-3.5 w-3.5 shrink-0" />
                        {t("polarConnectors.directory.reconnect")}
                    </Button>
                ) : null}
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={t("polarConnectors.removeLabel", { name: row.name })}
                    onClick={onRemove}
                >
                    <Trash2 className="h-3.5 w-3.5 shrink-0" />
                    {t("polarConnectors.directory.disconnect")}
                </Button>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
                <h3 className="text-xs font-medium text-muted-foreground">
                    {t("polarConnectors.directory.tools", { count: row.tools.length })}
                </h3>
                {row.tools.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("polarConnectors.noTools")}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border">
                        {row.tools.map((tool) => (
                            <li key={tool.name} className="flex flex-col gap-2 py-2">
                                <div className="min-w-0">
                                    <p className="flex min-w-0 items-center gap-2 text-sm">
                                        <span className="truncate" title={tool.name}>
                                            {tool.title}
                                        </span>
                                        {!tool.readOnly ? (
                                            <Badge variant={tool.destructive ? "warning" : "neutral"}>
                                                {t("polarConnectors.writes")}
                                            </Badge>
                                        ) : null}
                                    </p>
                                    {tool.description ? (
                                        <p
                                            className="line-clamp-2 text-xs text-muted-foreground"
                                            title={tool.description}
                                        >
                                            {tool.description}
                                        </p>
                                    ) : null}
                                </div>
                                <SegmentedControl<Policy>
                                    size="sm"
                                    value={tool.policy}
                                    aria-label={t("polarConnectors.policyLabel", { tool: tool.title })}
                                    options={POLICIES.map((value) => ({
                                        value,
                                        label: t(`polarConnectors.policy.${value}`)
                                    }))}
                                    onValueChange={(policy) =>
                                        onPatch(
                                            {
                                                ...row,
                                                tools: row.tools.map((entry) =>
                                                    entry.name === tool.name ? { ...entry, policy } : entry
                                                )
                                            },
                                            { tool: { name: tool.name, policy } }
                                        )
                                    }
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}

function StatusBadge({ row }: { row: ConnectorView }) {
    const t = useTranslations("account");
    const status = row.auth === "oauth" && !row.signedIn ? "sign_in" : row.status;
    const variant =
        status === "ok"
            ? "success"
            : status === "error"
              ? "danger"
              : status === "sign_in"
                ? "warning"
                : "neutral";
    return (
        <Badge variant={variant} className="shrink-0">
            {t(`polarConnectors.status.${status}`)}
        </Badge>
    );
}

function AddConnector({
    open,
    onOpenChange,
    onAdded
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdded: (view: ConnectorView) => void;
}) {
    const t = useTranslations("account");
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [auth, setAuth] = useState<Auth>("none");
    const [transport, setTransport] = useState<Transport>("http");
    const [token, setToken] = useState("");
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [advanced, setAdvanced] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const urlBad = url.trim() !== "" && !looksLikeServer(url);
    const complete =
        name.trim() !== "" && looksLikeServer(url) && (auth !== "bearer" || token.trim() !== "");

    // Closing starts over: a secret typed into a dialog that was put away does
    // not wait in the page for the next one.
    function reset() {
        setName("");
        setUrl("");
        setAuth("none");
        setTransport("http");
        setToken("");
        setClientId("");
        setClientSecret("");
        setAdvanced(false);
        setError(null);
    }

    function close() {
        if (pending) return;
        reset();
        onOpenChange(false);
    }

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!complete || pending) return;
        setPending(true);
        setError(null);
        const answer = await send("/api/polar/connectors", {
            method: "POST",
            body: JSON.stringify({
                name,
                url,
                auth,
                transport,
                ...(auth === "bearer" ? { token } : {}),
                ...(auth === "oauth" && clientId.trim()
                    ? { clientId, ...(clientSecret.trim() ? { clientSecret } : {}) }
                    : {})
            })
        });
        setPending(false);
        if (answer.ok) {
            reset();
            onAdded(answer.body.connector);
            return;
        }
        const code: unknown = answer.body.error;
        setError(t(`polarConnectors.errors.${isErrorCode(code) ? code : "failed"}`));
    }

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("polarConnectors.dialogTitle")}</DialogTitle>
                    <DialogDescription>{t("polarConnectors.dialogBody")}</DialogDescription>
                </DialogHeader>
                <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("polarConnectors.name")} *</span>
                        <Input
                            value={name}
                            maxLength={40}
                            autoFocus
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("polarConnectors.namePlaceholder")}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("polarConnectors.url")} *</span>
                        <Input
                            value={url}
                            maxLength={2048}
                            inputMode="url"
                            aria-invalid={urlBad || undefined}
                            onChange={(event) => setUrl(event.target.value)}
                            placeholder={t("polarConnectors.urlPlaceholder")}
                        />
                        {urlBad ? (
                            <span className="text-xs text-danger">
                                {t("polarConnectors.urlInvalid")}
                            </span>
                        ) : null}
                    </label>
                    <div className="flex flex-col gap-1 text-sm">
                        <span>{t("polarConnectors.auth")}</span>
                        <SegmentedControl<Auth>
                            size="sm"
                            value={auth}
                            aria-label={t("polarConnectors.auth")}
                            options={AUTHS.map((value) => ({
                                value,
                                label: t(`polarConnectors.authKind.${value}`)
                            }))}
                            onValueChange={setAuth}
                        />
                    </div>
                    {auth === "bearer" ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span>{t("polarConnectors.token")} *</span>
                            <Input
                                type="password"
                                autoComplete="off"
                                value={token}
                                maxLength={4096}
                                onChange={(event) => setToken(event.target.value)}
                            />
                        </label>
                    ) : null}
                    {auth === "oauth" ? (
                        <p className="text-xs text-muted-foreground">
                            {t("polarConnectors.oauthHint")}
                        </p>
                    ) : null}
                    <button
                        type="button"
                        className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
                        aria-expanded={advanced}
                        onClick={() => setAdvanced(!advanced)}
                    >
                        <ChevronDown
                            className={cn(
                                "h-3.5 w-3.5 shrink-0 transition-transform",
                                advanced ? "" : "-rotate-90"
                            )}
                        />
                        {t("polarConnectors.advanced")}
                    </button>
                    {advanced ? (
                        <div className="flex flex-col gap-3">
                            {auth === "oauth" ? (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span>{t("polarConnectors.clientId")}</span>
                                    <Input
                                        value={clientId}
                                        maxLength={512}
                                        autoComplete="off"
                                        onChange={(event) => setClientId(event.target.value)}
                                    />
                                </label>
                            ) : null}
                            {auth === "oauth" && clientId.trim() ? (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span>{t("polarConnectors.clientSecret")}</span>
                                    <Input
                                        type="password"
                                        autoComplete="off"
                                        value={clientSecret}
                                        maxLength={4096}
                                        onChange={(event) => setClientSecret(event.target.value)}
                                    />
                                </label>
                            ) : null}
                            <div className="flex flex-col gap-1 text-sm">
                                <span>{t("polarConnectors.transport")}</span>
                                <SegmentedControl<Transport>
                                    size="sm"
                                    value={transport}
                                    aria-label={t("polarConnectors.transport")}
                                    options={TRANSPORTS.map((value) => ({
                                        value,
                                        label: t(`polarConnectors.transportKind.${value}`)
                                    }))}
                                    onValueChange={setTransport}
                                />
                            </div>
                        </div>
                    ) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={pending} onClick={close}>
                            {t("polarConnectors.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={!complete || pending}
                            disabled={pending}
                        >
                            {auth === "oauth"
                                ? t("polarConnectors.addAndSignIn")
                                : t("polarConnectors.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
