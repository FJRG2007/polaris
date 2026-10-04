"use client";

/**
 * The keys an account holds, as a table.
 *
 * It was a stack of cards, which is the right shape for three keys and the wrong
 * one for fourteen: every row a different height, the dates in prose, and the
 * one question people actually open this page with - *is this key still being
 * used* - answerable only by reading each card in turn. A table puts the same
 * facts in columns that line up, so a key that expires next week or has not been
 * touched since April is found by scanning down rather than by reading.
 *
 * What each column is for is worth stating, because none of them is decoration:
 *
 * - **The key itself** is shown as its two visible halves. The prefix is what
 *   Polaris looks it up by; the last characters are what somebody matches
 *   against the value in their password manager. The secret is never shown
 *   again, so this is the only way to answer "which row is the key my deploy is
 *   using".
 * - **Environment** is a label its owner sorts by, and says so plainly rather
 *   than implying a separate Polaris behind it.
 * - **App** is where a key came from - a token minted in an app's settings is
 *   listed and revoked there, and this is so it can be recognised here.
 * - **Calls today** is the difference between a key that answered one request in
 *   April and one answering a thousand an hour. Both used to read "last used".
 * - **Compromised** is not implemented, and says so, because a column that
 *   silently reads "no" for everything is a promise nobody made.
 *
 * The filters run over the rows the page already has - see `api-keys-filter` -
 * so narrowing the list is instant and asks the server nothing.
 *
 * Making a key and changing one happen on pages of their own rather than in a
 * dialog over this one - see `key-form`. What a key may do is too large a
 * decision for a modal, and an address is something you can go back to.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { useDisplayFormat } from "@/components/display-format";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ApiKeyView } from "@polaris/auth";
import { deleteApiKeyAction, revokeApiKeyAction } from "./actions";
import { Ban, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import {
    API_KEY_ENVIRONMENTS,
    describeDevice,
    type ApiKeyEnvironment
} from "@polaris/core";
import * as list from "./api-keys-filter";
import {
    Badge,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    Select,
    cn
} from "@polaris/ui";

/** The one line that says a key is narrower than it looks, or nothing when it is
 *  not. A key restricted to an address or a client and showing no sign of it is a
 *  key somebody will spend an afternoon debugging. */
function describeLimits(key: ApiKeyView, t: Translate): string | null {
    const addresses =
        key.allowedCidrs.length + key.allowedCountries.length + key.allowedContinents.length;
    const parts: string[] = [];
    if (addresses > 0) parts.push(t("apiKeys.list.limits.addresses", { count: addresses }));
    if (key.allowedUserAgents.length > 0) {
        parts.push(t("apiKeys.list.limits.allowed", { count: key.allowedUserAgents.length }));
    }
    if (key.deniedUserAgents.length > 0) {
        parts.push(t("apiKeys.list.limits.blocked", { count: key.deniedUserAgents.length }));
    }
    // A list of counts, one per kind of rule, in the order they are set.
    return parts.length > 0 ? parts.join(", ") : null;
}

type Translate = NamespaceTranslator<"account">;

/** Each environment's name on screen. */
const ENVIRONMENT_KEYS: Readonly<Record<ApiKeyEnvironment, NamespaceKey<"account">>> = {
    production: "apiKeys.environments.production",
    development: "apiKeys.environments.development"
};

/** The list's sort and expiry choices, named. */
const SORT_KEYS: Readonly<Record<list.KeySort, NamespaceKey<"account">>> = {
    "created-desc": "apiKeys.list.sorts.createdDesc",
    "created-asc": "apiKeys.list.sorts.createdAsc",
    "used-desc": "apiKeys.list.sorts.usedDesc",
    "usage-desc": "apiKeys.list.sorts.usageDesc",
    "name-asc": "apiKeys.list.sorts.nameAsc"
};

function expiryLabel(value: list.ExpiryFilter, t: Translate): string {
    if (value === "soon") return t("apiKeys.list.expiry.soon", { days: list.EXPIRING_SOON_DAYS });
    return t(`apiKeys.list.expiry.${value}` as const);
}

/** An environment's name, or the stored value when it is one this version does not know. */
function environmentLabel(environment: string, t: Translate): string {
    const key = ENVIRONMENT_KEYS[environment as ApiKeyEnvironment];
    return key ? t(key) : environment;
}

export function ApiKeysView({ keys }: { keys: ApiKeyView[] }) {
    const router = useRouter();
    const format = useDisplayFormat();
    const t = useTranslations("account");
    const [confirm, confirmElement] = useConfirm();
    const [filters, setFilters] = useState<list.KeyFilters>(list.NO_FILTERS);
    const [error, setError] = useState<string | null>(null);

    const apps = useMemo(() => list.appsInKeys(keys), [keys]);
    const shown = useMemo(() => list.filterKeys(keys, filters), [keys, filters]);
    const narrowed = shown.length !== keys.length;

    function change<K extends keyof list.KeyFilters>(field: K, value: list.KeyFilters[K]) {
        setFilters((current) => ({ ...current, [field]: value }));
    }

    async function revoke(key: ApiKeyView) {
        const ok = await confirm({
            title: t("apiKeys.list.revokeTitle", { name: key.name }),
            description: t("apiKeys.list.revokeDescription"),
            confirmLabel: t("apiKeys.list.revoke"),
            danger: true
        });
        if (!ok) return;
        const result = await revokeApiKeyAction(key.id);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    async function remove(key: ApiKeyView) {
        const ok = await confirm({
            title: t("apiKeys.list.deleteTitle", { name: key.name }),
            description: t("apiKeys.list.deleteDescription"),
            confirmLabel: t("apiKeys.list.delete"),
            danger: true
        });
        if (!ok) return;
        const result = await deleteApiKeyAction(key.id);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    return (
        <div className="flex flex-col gap-4">
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
                    <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("apiKeys.list.search")}</span>
                        <Input
                            value={filters.search}
                            placeholder={t("apiKeys.list.searchPlaceholder")}
                            autoComplete="off"
                            onChange={(event) => change("search", event.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("apiKeys.list.environment")}</span>
                        <Select
                            value={filters.environment}
                            onValueChange={(value) => change("environment", value)}
                            className="w-40"
                            options={[
                                { value: "all", label: t("apiKeys.list.allEnvironments") },
                                ...API_KEY_ENVIRONMENTS.map((value) => ({
                                    value,
                                    label: environmentLabel(value, t)
                                }))
                            ]}
                        />
                    </label>
                    {/* Offered only where there is something to choose
                        between: an account with no app-minted keys does
                        not need a picker whose every option is "all". */}
                    {apps.length > 0 && (
                        <label className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">{t("apiKeys.list.app")}</span>
                            <Select
                                value={filters.app}
                                onValueChange={(value) => change("app", value)}
                                className="w-40"
                                options={[
                                    { value: "all", label: t("apiKeys.list.allApps") },
                                    { value: "none", label: t("apiKeys.list.noApp") },
                                    ...apps.map((app) => ({
                                        value: app.id,
                                        label: app.name
                                    }))
                                ]}
                            />
                        </label>
                    )}
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("apiKeys.list.expiryLabel")}</span>
                        <Select
                            value={filters.expiry}
                            onValueChange={(value) => change("expiry", value as list.ExpiryFilter)}
                            className="w-44"
                            options={list.EXPIRY_FILTERS.map((value) => ({
                                value,
                                label: expiryLabel(value, t)
                            }))}
                        />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("apiKeys.list.sortBy")}</span>
                        <Select
                            value={filters.sort}
                            onValueChange={(value) => change("sort", value as list.KeySort)}
                            className="w-44"
                            options={list.KEY_SORTS.map((value) => ({
                                value,
                                label: t(SORT_KEYS[value])
                            }))}
                        />
                    </label>
                </div>
                <Button size="sm" asChild>
                    <Link href="/account/api-keys/new" className="no-underline">
                        <Plus className="size-4" />
                        {t("apiKeys.list.newKey")}
                    </Link>
                </Button>
            </div>

            <p className="text-xs text-muted-foreground">
                {keys.length === 0
                    ? t("apiKeys.list.none")
                    : narrowed
                      ? t("apiKeys.list.showing", { shown: shown.length, total: keys.length })
                      : t("apiKeys.list.count", { count: keys.length })}
            </p>

            {keys.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("apiKeys.list.emptyHint")}</p>
            ) : (
                // Scrolls sideways rather than shrinking: nine columns on a phone
                // would be nine unreadable ones. The same table every list in
                // Polaris is drawn as - servers, containers, game servers.
                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full min-w-[62rem] text-sm">
                        <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                            <tr>
                                <th scope="col" className="w-full max-w-0 px-3 py-2 font-medium">
                                    {t("apiKeys.list.columns.name")}
                                </th>
                                <th scope="col" className="px-3 py-2 font-medium">
                                    {t("apiKeys.list.columns.key")}
                                </th>
                                <th scope="col" className="px-3 py-2 font-medium">
                                    {t("apiKeys.list.environment")}
                                </th>
                                <th scope="col" className="px-3 py-2 font-medium">
                                    {t("apiKeys.list.app")}
                                </th>
                                <th scope="col" className="px-3 py-2 font-medium">
                                    {t("apiKeys.list.columns.expires")}
                                </th>
                                <th scope="col" className="px-3 py-2 font-medium">
                                    {t("apiKeys.list.columns.created")}
                                </th>
                                <th scope="col" className="px-3 py-2 font-medium">
                                    {t("apiKeys.list.columns.lastUsed")}
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    {t("apiKeys.list.columns.callsToday")}
                                </th>
                                <th scope="col" className="px-3 py-2 font-medium">
                                    {t("apiKeys.list.columns.compromised")}
                                </th>
                                <th scope="col" className="px-3 py-2">
                                    <span className="sr-only">{t("apiKeys.list.columns.actions")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((key) => (
                                <KeyRow
                                    key={key.id}
                                    entry={key}
                                    date={(iso) => format.date(iso)}
                                    onRevoke={() => void revoke(key)}
                                    onDelete={() => void remove(key)}
                                />
                            ))}
                            {shown.length === 0 ? (
                                <tr>
                                    <td
                                        colSpan={10}
                                        className="px-3 py-10 text-center text-sm text-muted-foreground"
                                    >
                                        <span className="flex flex-col items-center gap-2">
                                            {t("apiKeys.list.noMatch")}
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => setFilters(list.NO_FILTERS)}
                                            >
                                                {t("apiKeys.list.clearFilters")}
                                            </Button>
                                        </span>
                                    </td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                </div>
            )}

            {confirmElement}
        </div>
    );
}

function KeyRow({
    entry,
    date,
    onRevoke,
    onDelete
}: {
    entry: ApiKeyView;
    date: (iso: string) => string;
    onRevoke: () => void;
    onDelete: () => void;
}) {
    const t = useTranslations("account");
    const href = `/account/api-keys/${entry.id}`;
    const state = list.lifecycleOf(entry);
    const soon = list.expiringSoon(entry);
    const limits = describeLimits(entry, t);

    return (
        <tr className="border-t border-border hover:bg-card-hover">
            <td className="max-w-0 px-3 py-2 align-top">
                <span className="flex min-w-0 items-center gap-2">
                    <Link
                        href={href}
                        className="min-w-0 truncate text-left font-medium no-underline hover:underline"
                        title={t("apiKeys.list.editNamed", { name: entry.name })}
                    >
                        {entry.name}
                    </Link>
                    {/* Which keys a terminal is holding, so somebody cleaning up
                        the list can tell a laptop's sign-in from a pipeline's key. */}
                    {entry.kind === "cli" ? (
                        <Badge variant="neutral" title={t("apiKeys.list.cli.title")}>
                            {t("apiKeys.list.cli.badge")}
                        </Badge>
                    ) : null}
                    {/* Only when it is not what a key normally is. A row that
                        says "Active" on every line says nothing on any of
                        them. */}
                    {state === "revoked" ? (
                        <Badge variant="danger">{t("apiKeys.list.revoked")}</Badge>
                    ) : state === "expired" ? (
                        <Badge variant="neutral">{t("apiKeys.list.expiry.expired")}</Badge>
                    ) : null}
                </span>
                {entry.description ? (
                    <p className="truncate text-xs" title={entry.description}>
                        {entry.description}
                    </p>
                ) : null}
                <p className="truncate text-xs text-muted-foreground">
                    {limits
                        ? t("apiKeys.list.scopesLimited", { count: entry.scopes.length, limits })
                        : t("apiKeys.list.scopes", { count: entry.scopes.length })}
                </p>
                {entry.lastUsedUserAgent ? (
                    <p
                        className="truncate text-xs text-muted-foreground"
                        title={entry.lastUsedUserAgent}
                    >
                        {entry.lastUsedIp
                            ? t("apiKeys.list.deviceFrom", {
                                  device: describeDevice(entry.lastUsedUserAgent),
                                  ip: entry.lastUsedIp
                              })
                            : describeDevice(entry.lastUsedUserAgent)}
                    </p>
                ) : null}
            </td>
            <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs text-muted-foreground">
                {list.maskedKey(entry)}
            </td>
            <td className="whitespace-nowrap px-3 py-2 align-top">
                <Badge variant={entry.environment === "production" ? "primary" : "neutral"}>
                    {environmentLabel(entry.environment, t)}
                </Badge>
            </td>
            <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
                {entry.projectName ?? t("apiKeys.list.noneApp")}
            </td>
            {/* The same tone as the two date columns beside it. A date that is
                merely a date has nothing to say, and reading brighter than
                "Created" made it look like it did; the colour is kept for the
                two cases that do - it has run out, or it is about to. */}
            <td
                className={cn(
                    "whitespace-nowrap px-3 py-2 align-top",
                    state === "expired"
                        ? "text-danger"
                        : soon
                          ? "text-warning"
                          : "text-muted-foreground"
                )}
            >
                {entry.expiresAt ? (
                    <span title={date(entry.expiresAt)}>{date(entry.expiresAt)}</span>
                ) : (
                    t("apiKeys.list.never")
                )}
            </td>
            <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
                {date(entry.createdAt)}
            </td>
            <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
                {entry.lastUsedAt ? <RelativeTime iso={entry.lastUsedAt} /> : t("apiKeys.list.never")}
            </td>
            <td
                className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums"
                title={t("apiKeys.list.callsRecently", { count: entry.usedRecently })}
            >
                {entry.usedToday === 0 ? (
                    <span className="text-muted-foreground">0</span>
                ) : (
                    entry.usedToday
                )}
            </td>
            <td className="whitespace-nowrap px-3 py-2 align-top text-xs text-muted-foreground">
                {t("apiKeys.list.comingSoon")}
            </td>
            <td className="px-3 py-2 align-top">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t("apiKeys.list.menuFor", { name: entry.name })}
                            title={t("apiKeys.list.more")}
                        >
                            <MoreHorizontal className="size-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem asChild>
                            <Link href={href} className="no-underline">
                                <Pencil className="size-3.5" />
                                {t("apiKeys.list.edit")}
                            </Link>
                        </DropdownMenuItem>
                        {state === "revoked" ? null : (
                            <DropdownMenuItem onSelect={onRevoke}>
                                <Ban className="size-3.5" />
                                {t("apiKeys.list.revoke")}
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={onDelete} variant="danger">
                            <Trash2 className="size-3.5" />
                            {t("apiKeys.list.delete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </td>
        </tr>
    );
}
