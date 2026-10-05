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
 */

import { useMemo, useState } from "react";
import { ClientLogo } from "@/components/client-logo";
import { useRouter } from "next/navigation";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { scopeLabelKey } from "@/lib/mcp/oauth/scope-labels";
import type { ConnectedAppView } from "@/lib/mcp/oauth/grants";
import { groupScopes, scopeGroupKey } from "@/lib/api-key-scopes";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { expandPermissions, type Permission } from "@polaris/core";
import { McpScopeChecklist } from "@/components/mcp-scope-checklist";
import { Bot, ChevronRight, Pencil, Search, Unplug } from "lucide-react";
import { changeAppScopesAction, disconnectAppAction } from "./connected-app-actions";
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

/** An app as the list draws it: what it holds, and what it could be given. */
export type ConnectedAppRow = ConnectedAppView & { readonly offered: Permission[] };

/** More apps than this and the list gets a search box. */
const SEARCH_FROM = 6;
/** Used within this long reads as in use. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every((entry) => set.has(entry));
}

export function ConnectedApps({ apps: initial }: { apps: ConnectedAppRow[] }) {
    const t = useTranslations("mcp");
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [apps, setApps] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [editing, setEditing] = useState<ConnectedAppRow | null>(null);

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

    async function save(app: ConnectedAppRow, scopes: Permission[]) {
        setEditing(null);
        if (sameSet(scopes, app.scopes)) return;
        setError(null);
        const before = apps;
        setApps((current) =>
            current.map((entry) => (entry.id === app.id ? { ...entry, scopes } : entry))
        );
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
                                onDisconnect={() => void disconnect(app)}
                            />
                        ))}
                    </ul>
                )}
            </CardBody>
            {editing ? (
                <EditScopes
                    app={editing}
                    onCancel={() => setEditing(null)}
                    onSave={(scopes) => void save(editing, scopes)}
                />
            ) : null}
            {confirmElement}
        </Card>
    );
}

function AppRow({
    app,
    onEdit,
    onDisconnect
}: {
    app: ConnectedAppRow;
    onEdit: () => void;
    onDisconnect: () => void;
}) {
    const t = useTranslations("mcp");
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
    const { groups, rest } = groupScopes(scopes);
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
    onCancel,
    onSave
}: {
    app: ConnectedAppRow;
    onCancel: () => void;
    onSave: (scopes: Permission[]) => void;
}) {
    const t = useTranslations("mcp");
    const tc = useTranslations("common");
    const offered = app.offered;
    const [selected, setSelected] = useState<Permission[]>(() =>
        offered.filter((scope) => app.scopes.includes(scope))
    );
    const effective = useMemo(
        () => new Set(expandPermissions(selected).filter((scope) => offered.includes(scope))),
        [selected, offered]
    );
    const name = app.name || t("consent.unnamed");
    const unchanged = sameSet([...effective], app.scopes);
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
                    onToggle={(scope, checked) =>
                        setSelected((current) =>
                            checked
                                ? [...current, scope]
                                : current.filter((entry) => entry !== scope)
                        )
                    }
                />
                {empty ? <p className="text-xs text-danger">{t("connectedApps.pickOne")}</p> : null}
                <div className="mt-4 flex justify-end gap-2">
                    <Button variant="ghost" onClick={onCancel}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button disabled={unchanged || empty} onClick={() => onSave([...effective])}>
                        {t("connectedApps.save")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
