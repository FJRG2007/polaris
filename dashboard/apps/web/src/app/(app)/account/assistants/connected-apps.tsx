"use client";

/**
 * Connected assistants: the assistants and editors this person let act for
 * them over MCP.
 *
 * One compact row per app - its mark, its name, whether anything still uses
 * it, and where it sends people back to (since its name is its own claim). What
 * it may do is a count until somebody opens it, grouped by area, because a list
 * of eleven permissions under every app is a page nobody finds their app on.
 * Past a handful of apps a search box narrows the list.
 *
 * Changing permissions and disconnecting both show at once and are put back if
 * the server refused.
 *
 * When the account's network rules restrict where it may be used from, a note
 * at the top says what that does to assistants calling from their own servers
 * and how one connection is let through.
 *
 * An app that holds a database permission is also told which databases it may
 * reach, in the same dialog as its permissions: every one the person can open,
 * or the ones they tick.
 */

import { useMemo, useState } from "react";
import { regionName } from "@/components/geo-picker";
import { ClientLogo } from "@/components/client-logo";
import { useRouter } from "next/navigation";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { scopeLabelKey } from "@/lib/mcp/oauth/scope-labels";
import type { ConnectedAppView } from "@/lib/mcp/oauth/grants";
import { groupScopes, scopeGroupKey } from "@/lib/api-key-scopes";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { expandScopes, scopeRequires, isMcpScope, type McpScope } from "@/lib/mcp/scope-table";
import { McpScopeChecklist } from "@/components/mcp-scope-checklist";
import { IpRuleDialog } from "./ip-rule-dialog";
import { DatabaseReachPicker, type DatabaseOption } from "./database-reach-picker";
import { sameDatabaseReach, type DatabaseReach } from "@/lib/mcp/oauth/database-reach";
import type { IpPolicy } from "@/lib/mcp/oauth/ip-policy";
import {
    exceptionIsEmpty,
    sameException,
    type NetworkException
} from "@/lib/mcp/oauth/network-exception";
import {
    Bot,
    ChevronRight,
    Database,
    Globe,
    Network,
    Pencil,
    Search,
    ShieldAlert,
    Unplug
} from "lucide-react";
import {
    changeAppScopesAction,
    disconnectAppAction,
    setAppDatabasesAction,
    setAppIpPolicyAction,
    setAppNetworkExceptionAction
} from "./connected-app-actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    cn
} from "@polaris/ui";

/** An app as the list draws it: what it holds, what it could be given, and
 *  which of those it never asked for. */
export type ConnectedAppRow = ConnectedAppView & {
    readonly offered: McpScope[];
    readonly unrequested: McpScope[];
};

/** More apps than this and the list gets a search box. */
const SEARCH_FROM = 6;
/** Used within this long reads as in use. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every((entry) => set.has(entry));
}

function samePolicy(a: IpPolicy, b: IpPolicy): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a set of scopes reaches the database tools at all. */
function holdsDatabases(scopes: Iterable<string>): boolean {
    for (const scope of scopes) if (scope.startsWith("databases.")) return true;
    return false;
}

export function ConnectedApps({
    apps: initial,
    restricted = false,
    canExcept = false,
    databases = []
}: {
    apps: ConnectedAppRow[];
    /** Whether the account's network rules restrict where it may be used from. */
    restricted?: boolean;
    /** Whether this person may let a connection past those rules. */
    canExcept?: boolean;
    /** The databases this person can open, for choosing which an app reaches. */
    databases?: DatabaseOption[];
}) {
    const t = useTranslations("mcp");
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [apps, setApps] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [editing, setEditing] = useState<ConnectedAppRow | null>(null);
    const [network, setNetwork] = useState<ConnectedAppRow | null>(null);

    const needle = query.trim().toLowerCase();
    const shown = useMemo(
        () =>
            needle
                ? apps.filter((app) =>
                      [app.name, app.redirectHost ?? "", app.lastUsedIp ?? ""].some((value) =>
                          value.toLowerCase().includes(needle)
                      )
                  )
                : apps,
        [apps, needle]
    );

    async function disconnect(app: ConnectedAppRow) {
        const name = app.name || t("consent.unnamed");
        const ok = await confirm({
            title: t("connectedApps.disconnectTitle", { app: name }),
            description: t("connectedApps.disconnectDescription"),
            confirmLabel: t("connectedApps.disconnect"),
            danger: true
        });
        if (!ok) return;
        setError(null);
        const before = apps;
        setApps((current) => current.filter((entry) => entry.id !== app.id));
        const result = await disconnectAppAction(app.id).catch(() => ({
            error: t("connectedApps.failed")
        }));
        if (result.error) {
            setApps(before);
            setError(result.error);
            return;
        }
        router.refresh();
    }

    async function save(app: ConnectedAppRow, picked: McpScope[], reach: DatabaseReach) {
        setEditing(null);
        // What the dialog did not show is kept as it was, here as on the server.
        const shown = new Set<string>(app.offered);
        const scopes = [...picked, ...app.scopes.filter((scope) => !shown.has(scope))];
        const scopesChanged = !sameSet(scopes, app.scopes);
        const reachChanged = holdsDatabases(scopes) && !sameDatabaseReach(reach, app.databaseIds);
        if (!scopesChanged && !reachChanged) return;
        setError(null);
        const before = apps;
        setApps((current) =>
            current.map((entry) =>
                entry.id === app.id
                    ? { ...entry, scopes, ...(reachChanged ? { databaseIds: reach } : {}) }
                    : entry
            )
        );
        if (scopesChanged) {
            const result = await changeAppScopesAction({ id: app.id, scopes }).catch(() => ({
                error: t("connectedApps.changeFailed"),
                scopes: undefined
            }));
            if (result.error || !result.scopes) {
                setApps(before);
                setError(result.error ?? t("connectedApps.changeFailed"));
                return;
            }
            const held = result.scopes;
            setApps((current) =>
                current.map((entry) => (entry.id === app.id ? { ...entry, scopes: held } : entry))
            );
        }
        if (reachChanged) {
            const result = await setAppDatabasesAction({ id: app.id, databaseIds: reach }).catch(
                () => ({ error: t("connectedApps.databases.failed"), databaseIds: undefined })
            );
            if (result.error || result.databaseIds === undefined) {
                // The permissions, when they changed, did save: only the
                // databases go back.
                setApps((current) =>
                    current.map((entry) =>
                        entry.id === app.id ? { ...entry, databaseIds: app.databaseIds } : entry
                    )
                );
                setError(result.error ?? t("connectedApps.databases.failed"));
                router.refresh();
                return;
            }
            const held = result.databaseIds;
            setApps((current) =>
                current.map((entry) =>
                    entry.id === app.id ? { ...entry, databaseIds: held } : entry
                )
            );
        }
        router.refresh();
    }

    async function saveNetwork(
        app: ConnectedAppRow,
        policy: IpPolicy,
        exception: NetworkException
    ) {
        setNetwork(null);
        setError(null);
        const policyChanged = !samePolicy(policy, app.ipPolicy);
        const exceptionChanged = !sameException(exception, app.networkException);
        const before = apps;
        setApps((current) =>
            current.map((entry) =>
                entry.id !== app.id
                    ? entry
                    : {
                          ...entry,
                          networkException: exception,
                          ...(policyChanged
                              ? { ipPolicy: policy, lastRefusedAt: null, lastRefusedIp: null }
                              : {})
                      }
            )
        );
        if (policyChanged) {
            const result = await setAppIpPolicyAction({ id: app.id, policy }).catch(() => ({
                error: t("connectedApps.ip.failed"),
                policy: undefined
            }));
            if (result.error || !result.policy) {
                setApps(before);
                setError(result.error ?? t("connectedApps.ip.failed"));
                return;
            }
        }
        if (exceptionChanged) {
            const result = await setAppNetworkExceptionAction({ id: app.id, exception }).catch(
                () => ({ error: t("connectedApps.exception.failed"), exception: undefined })
            );
            if (result.error || !result.exception) {
                // The address rule, when it changed, did save: only the
                // exception goes back.
                setApps((current) =>
                    current.map((entry) =>
                        entry.id === app.id
                            ? { ...entry, networkException: app.networkException }
                            : entry
                    )
                );
                setError(result.error ?? t("connectedApps.exception.failed"));
                router.refresh();
                return;
            }
        }
        router.refresh();
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Bot className="size-4" aria-hidden />
                    {t("connectedApps.title")}
                    {apps.length > 0 ? <Badge variant="neutral">{apps.length}</Badge> : null}
                </CardTitle>
                <p className="text-sm text-muted-foreground">{t("connectedApps.intro")}</p>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 text-sm">
                {restricted ? (
                    <RestrictionNotice
                        canExcept={canExcept}
                        single={apps.length === 1 ? apps[0]! : null}
                        onOpen={(app) => setNetwork(app)}
                    />
                ) : null}
                {error ? (
                    <p role="alert" className="text-danger">
                        {error}
                    </p>
                ) : null}
                {apps.length > SEARCH_FROM ? (
                    <span className="relative">
                        <Search
                            className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden
                        />
                        <Input
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t("connectedApps.search")}
                            aria-label={t("connectedApps.search")}
                            autoComplete="off"
                            className="pl-8"
                        />
                    </span>
                ) : null}
                {apps.length === 0 ? (
                    <p className="text-muted-foreground">
                        <a href="#connect" className="underline-offset-2 hover:underline">
                            {t("connectedApps.empty")}
                        </a>
                    </p>
                ) : shown.length === 0 ? (
                    <p className="text-muted-foreground">
                        {t("connectedApps.noMatch", { query: query.trim() })}
                    </p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border/60">
                        {shown.map((app) => (
                            <AppRow
                                key={app.id}
                                app={app}
                                onEdit={() => setEditing(app)}
                                onNetwork={() => setNetwork(app)}
                                onDisconnect={() => void disconnect(app)}
                            />
                        ))}
                    </ul>
                )}
            </CardBody>
            {editing ? (
                <EditScopes
                    app={editing}
                    databases={databases}
                    onCancel={() => setEditing(null)}
                    onSave={(scopes, reach) => void save(editing, scopes, reach)}
                />
            ) : null}
            {network ? (
                <IpRuleDialog
                    name={network.name || t("consent.unnamed")}
                    current={network.ipPolicy}
                    approvedIp={network.approvedIp}
                    exception={network.networkException}
                    restricted={restricted}
                    canExcept={canExcept}
                    onCancel={() => setNetwork(null)}
                    onSave={(policy, exception) => void saveNetwork(network, policy, exception)}
                />
            ) : null}
            {confirmElement}
        </Card>
    );
}

/** What the account's network rules do to assistants that call from their own
 *  servers, and the way one connection is let through. */
function RestrictionNotice({
    canExcept,
    single,
    onOpen
}: {
    canExcept: boolean;
    single: ConnectedAppRow | null;
    onOpen: (app: ConnectedAppRow) => void;
}) {
    const t = useTranslations("mcp");
    return (
        <div
            role="note"
            className="flex min-w-0 items-start gap-2 rounded-md bg-warning-soft p-3 text-xs"
        >
            <Globe className="mt-0.5 size-3.5 shrink-0 text-warning-ink" aria-hidden />
            <div className="flex min-w-0 flex-col gap-1.5">
                <p className="[overflow-wrap:anywhere]">{t("connectedApps.restricted.body")}</p>
                <p className="text-muted-foreground [overflow-wrap:anywhere]">
                    {canExcept
                        ? t("connectedApps.restricted.howTo")
                        : t("connectedApps.restricted.askAdmin")}{" "}
                    <a href="/account/access" className="underline underline-offset-2">
                        {t("connectedApps.restricted.rules")}
                    </a>
                </p>
                {canExcept && single ? (
                    <Button
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        onClick={() => onOpen(single)}
                    >
                        <Network className="size-3.5" aria-hidden />
                        {t("connectedApps.restricted.allow", {
                            app: single.name || t("consent.unnamed")
                        })}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

/** The places a connection's exception lets it call from, named. */
function exceptionSummary(
    t: ReturnType<typeof useTranslations<"mcp">>,
    tc: ReturnType<typeof useTranslations<"components">>,
    locale: string,
    exception: NetworkException
): string {
    return [
        ...(exception.presets.includes("openai")
            ? [t("connectedApps.exception.openai.short")]
            : []),
        ...exception.allowedContinents.map((code) =>
            tc(`geo.continentNames.${code}` as NamespaceKey<"components">)
        ),
        ...exception.allowedCountries.map((code) => regionName(code, locale)),
        ...exception.allowedCidrs
    ].join(", ");
}

/** The connection's address rule in a few words. */
function ruleSummary(t: ReturnType<typeof useTranslations<"mcp">>, app: ConnectedAppRow): string {
    const policy = app.ipPolicy;
    if (policy.mode === "origin")
        return t("connectedApps.ip.summary.origin", { ip: app.approvedIp ?? "" });
    if (policy.mode === "sessions") return t("connectedApps.ip.summary.sessions");
    if (policy.mode === "list")
        return t("connectedApps.ip.summary.list", {
            allow: policy.allow.length,
            deny: policy.deny.length
        });
    return t("connectedApps.ip.summary.none");
}

function AppRow({
    app,
    onEdit,
    onNetwork,
    onDisconnect
}: {
    app: ConnectedAppRow;
    onEdit: () => void;
    onNetwork: () => void;
    onDisconnect: () => void;
}) {
    const t = useTranslations("mcp");
    const tc = useTranslations("components");
    const locale = useLocale();
    const [open, setOpen] = useState(false);
    const name = app.name || t("consent.unnamed");
    const recent =
        app.lastUsedAt !== null && Date.now() - new Date(app.lastUsedAt).getTime() < RECENT_MS;
    const status = recent ? t("connectedApps.recent") : t("connectedApps.idle");
    const listId = `scopes-${app.id}`;

    return (
        <li className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0">
            <ClientLogo brand={app.brand} name={name} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="truncate font-medium" title={name}>
                    {name}
                </p>
                <p className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
                    <span
                        className={cn(
                            "mt-1 size-2 shrink-0 rounded-full",
                            recent ? "bg-success" : "bg-muted-foreground/40"
                        )}
                        role="img"
                        aria-label={status}
                        title={status}
                    />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                        {app.lastUsedAt
                            ? app.lastUsedIp
                                ? t.rich("connectedApps.lastUsedFrom", {
                                      time: <RelativeTime key="time" iso={app.lastUsedAt} />,
                                      ip: app.lastUsedIp
                                  })
                                : t.rich("connectedApps.lastUsed", {
                                      time: <RelativeTime key="time" iso={app.lastUsedAt} />
                                  })
                            : t("connectedApps.neverUsed")}
                    </span>
                </p>
                <p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {app.redirectHost ? (
                        <span title={app.redirectHost}>
                            {t("connectedApps.returnsTo", { host: app.redirectHost })}
                            {" - "}
                        </span>
                    ) : null}
                    {t.rich("connectedApps.connected", {
                        time: <RelativeTime key="time" iso={app.createdAt} />
                    })}
                </p>
                {app.ipPolicy.mode !== "none" ? (
                    <p className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
                        <Network className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                            {ruleSummary(t, app)}
                        </span>
                    </p>
                ) : null}
                {!exceptionIsEmpty(app.networkException) ? (
                    <p className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
                        <Globe className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                            {t("connectedApps.exception.summary", {
                                places: exceptionSummary(t, tc, locale, app.networkException)
                            })}
                        </span>
                    </p>
                ) : null}
                {holdsDatabases(app.scopes) ? (
                    <p className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
                        <Database className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                            {app.databaseIds === null
                                ? t("connectedApps.databases.summaryAll")
                                : t("connectedApps.databases.summaryChosen", {
                                      count: app.databaseIds.length
                                  })}
                        </span>
                    </p>
                ) : null}
                {app.lastRefusedAt ? (
                    <p className="flex min-w-0 items-start gap-1.5 text-xs text-warning-ink">
                        <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                            {t.rich("connectedApps.ip.refused", {
                                time: <RelativeTime key="time" iso={app.lastRefusedAt} />,
                                ip: app.lastRefusedIp ?? t("connectedApps.ip.unknownIp")
                            })}
                        </span>
                    </p>
                ) : null}
                <button
                    type="button"
                    className="mt-1 inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    aria-expanded={open}
                    aria-controls={listId}
                    title={t("connectedApps.showScopes")}
                    onClick={() => setOpen((value) => !value)}
                >
                    <ChevronRight
                        className={cn("size-3.5 transition-transform", open && "rotate-90")}
                        aria-hidden
                    />
                    {t("connectedApps.scopeCount", { count: app.scopes.length })}
                </button>
                {open ? <ScopeGroups id={listId} scopes={app.scopes} /> : null}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("connectedApps.editNamed", { app: name })}
                    title={t("connectedApps.edit")}
                    onClick={onEdit}
                >
                    <Pencil className="size-3.5" aria-hidden />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("connectedApps.ip.editNamed", { app: name })}
                    title={t("connectedApps.ip.edit")}
                    onClick={onNetwork}
                >
                    <Network className="size-3.5" aria-hidden />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="hover:text-danger"
                    aria-label={t("connectedApps.disconnectNamed", { app: name })}
                    title={t("connectedApps.disconnect")}
                    onClick={onDisconnect}
                >
                    <Unplug className="size-3.5" aria-hidden />
                </Button>
            </div>
        </li>
    );
}

/** What an app may do, one line per area, each permission a chip. */
function ScopeGroups({ id, scopes }: { id: string; scopes: readonly string[] }) {
    const t = useTranslations("mcp");
    const ta = useTranslations("account");
    // A finer scope sits in the area of the permission it stands on.
    const { groups, rest } = groupScopes(scopes, (scope) =>
        isMcpScope(scope) ? scopeRequires(scope) : scope
    );
    const areaName = (title: string) => {
        const key = scopeGroupKey(title);
        return ta.has(key) ? ta(key as NamespaceKey<"account">) : title;
    };
    const rows = [
        ...groups.map((group) => ({
            title: areaName(group.title),
            scopes: group.scopes as string[]
        })),
        ...(rest.length > 0 ? [{ title: ta("apiKeys.scopes.other"), scopes: rest }] : [])
    ];
    return (
        <dl id={id} className="mt-1 flex flex-col gap-1.5">
            {rows.map((row) => (
                <div key={row.title} className="flex min-w-0 flex-col gap-1 sm:flex-row sm:gap-2">
                    <dt className="w-28 shrink-0 text-xs text-muted-foreground">{row.title}</dt>
                    <dd className="flex min-w-0 flex-wrap gap-1">
                        {row.scopes.map((scope) => (
                            <Badge key={scope} variant="neutral" title={scope}>
                                {t(scopeLabelKey(scope))}
                            </Badge>
                        ))}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

/** The consent screen's boxes, for an app that is already connected. */
function EditScopes({
    app,
    databases,
    onCancel,
    onSave
}: {
    app: ConnectedAppRow;
    databases: readonly DatabaseOption[];
    onCancel: () => void;
    onSave: (scopes: McpScope[], reach: DatabaseReach) => void;
}) {
    const t = useTranslations("mcp");
    const tc = useTranslations("common");
    const offered = app.offered;
    const holding = useMemo(
        () => offered.filter((scope) => app.scopes.includes(scope)),
        [offered, app.scopes]
    );
    const [selected, setSelected] = useState<McpScope[]>(holding);
    const effective = useMemo(
        () => new Set(expandScopes(selected).filter((scope) => offered.includes(scope))),
        [selected, offered]
    );
    const unrequested = useMemo(() => new Set(app.unrequested), [app.unrequested]);
    // Only ids the person can open now are drawn, and only those are kept.
    const openable = useMemo(() => new Set(databases.map((entry) => entry.id)), [databases]);
    const initialReach = useMemo<DatabaseReach>(
        () => app.databaseIds && app.databaseIds.filter((id) => openable.has(id)),
        [app.databaseIds, openable]
    );
    const [reach, setReach] = useState<DatabaseReach>(initialReach);
    const showDatabases = holdsDatabases(effective);
    const chosenReach = sameDatabaseReach(reach, initialReach) ? app.databaseIds : reach;
    const name = app.name || t("consent.unnamed");
    const unchanged =
        sameSet([...effective], holding) &&
        (!showDatabases || sameDatabaseReach(chosenReach, app.databaseIds));
    const empty = effective.size === 0;

    return (
        <Dialog open onOpenChange={(open) => !open && onCancel()}>
            <DialogContent className="w-[calc(100%-2rem)] max-w-md">
                <DialogHeader>
                    <DialogTitle className="break-words pr-6 [overflow-wrap:anywhere]">
                        {t("connectedApps.editTitle", { app: name })}
                    </DialogTitle>
                    <DialogDescription>{t("connectedApps.editHint")}</DialogDescription>
                </DialogHeader>
                <McpScopeChecklist
                    offered={offered}
                    selected={selected}
                    effective={effective}
                    unrequested={unrequested}
                    onToggle={(scope, checked) =>
                        setSelected((current) =>
                            checked
                                ? [...current, scope]
                                : current.filter((entry) => entry !== scope)
                        )
                    }
                />
                {empty ? <p className="text-xs text-danger">{t("connectedApps.pickOne")}</p> : null}
                {showDatabases ? (
                    <DatabaseReachPicker databases={databases} reach={reach} onChange={setReach} />
                ) : null}
                <div className="mt-4 flex justify-end gap-2">
                    <Button variant="ghost" onClick={onCancel}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button
                        disabled={unchanged || empty}
                        onClick={() => onSave([...effective], chosenReach)}
                    >
                        {t("connectedApps.save")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
