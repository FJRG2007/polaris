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
import type { ApiKeyView } from "@polaris/auth";
import { deleteApiKeyAction, revokeApiKeyAction } from "./actions";
import { Ban, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import {
    API_KEY_ENVIRONMENTS,
    API_KEY_ENVIRONMENT_LABELS,
    describeDevice,
    type ApiKeyEnvironment
} from "@polaris/core";
import * as list from "./api-keys-filter";
import {
    Badge,
    Button,
    Card,
    CardBody,
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
function describeLimits(key: ApiKeyView): string | null {
    const parts: string[] = [];
    const addresses =
        key.allowedCidrs.length + key.allowedCountries.length + key.allowedContinents.length;
    if (addresses > 0) parts.push(`${addresses} address rule${addresses === 1 ? "" : "s"}`);
    if (key.allowedUserAgents.length > 0) {
        parts.push(
            `${key.allowedUserAgents.length} allowed client${key.allowedUserAgents.length === 1 ? "" : "s"}`
        );
    }
    if (key.deniedUserAgents.length > 0) {
        parts.push(
            `${key.deniedUserAgents.length} blocked client${key.deniedUserAgents.length === 1 ? "" : "s"}`
        );
    }
    return parts.length > 0 ? `Limited to ${parts.join(", ")}` : null;
}

export function ApiKeysView({ keys }: { keys: ApiKeyView[] }) {
    const router = useRouter();
    const format = useDisplayFormat();
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
            title: `Revoke "${key.name}"?`,
            description: "Anything using this key stops working immediately.",
            confirmLabel: "Revoke",
            danger: true
        });
        if (!ok) return;
        const result = await revokeApiKeyAction(key.id);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    async function remove(key: ApiKeyView) {
        const ok = await confirm({
            title: `Delete "${key.name}"?`,
            description: "The key disappears from this list. It cannot be undone.",
            confirmLabel: "Delete",
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

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
                            <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
                                <span className="text-xs text-muted-foreground">Search</span>
                                <Input
                                    value={filters.search}
                                    placeholder="Name or key"
                                    autoComplete="off"
                                    onChange={(event) => change("search", event.target.value)}
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">Environment</span>
                                <Select
                                    value={filters.environment}
                                    onValueChange={(value) => change("environment", value)}
                                    className="w-40"
                                    options={[
                                        { value: "all", label: "All environments" },
                                        ...API_KEY_ENVIRONMENTS.map((value) => ({
                                            value,
                                            label: API_KEY_ENVIRONMENT_LABELS[value]
                                        }))
                                    ]}
                                />
                            </label>
                            {/* Offered only where there is something to choose
                                between: an account with no app-minted keys does
                                not need a picker whose every option is "all". */}
                            {apps.length > 0 && (
                                <label className="flex flex-col gap-1">
                                    <span className="text-xs text-muted-foreground">App</span>
                                    <Select
                                        value={filters.app}
                                        onValueChange={(value) => change("app", value)}
                                        className="w-40"
                                        options={[
                                            { value: "all", label: "All apps" },
                                            { value: "none", label: "No app" },
                                            ...apps.map((app) => ({
                                                value: app.id,
                                                label: app.name
                                            }))
                                        ]}
                                    />
                                </label>
                            )}
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">Expiry</span>
                                <Select
                                    value={filters.expiry}
                                    onValueChange={(value) =>
                                        change("expiry", value as list.ExpiryFilter)
                                    }
                                    className="w-44"
                                    options={list.EXPIRY_FILTERS.map((value) => ({
                                        value,
                                        label: list.EXPIRY_FILTER_LABELS[value]
                                    }))}
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">Sort by</span>
                                <Select
                                    value={filters.sort}
                                    onValueChange={(value) => change("sort", value as list.KeySort)}
                                    className="w-44"
                                    options={list.KEY_SORTS.map((value) => ({
                                        value,
                                        label: list.KEY_SORT_LABELS[value]
                                    }))}
                                />
                            </label>
                        </div>
                        <Button size="sm" asChild>
                            <Link href="/account/api-keys/new" className="no-underline">
                                <Plus className="size-4" />
                                New key
                            </Link>
                        </Button>
                    </div>

                    <p className="text-xs text-muted-foreground">
                        {keys.length === 0
                            ? "No keys yet."
                            : narrowed
                              ? `Showing ${shown.length} of ${keys.length} keys`
                              : `${keys.length} key${keys.length === 1 ? "" : "s"}`}
                    </p>

                    {keys.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            A key lets a script act as you, with a subset of your own permissions
                            and only from where you allow.
                        </p>
                    ) : shown.length === 0 ? (
                        <div className="flex flex-col items-start gap-2 py-4">
                            <p className="text-sm text-muted-foreground">
                                No key matches those filters.
                            </p>
                            <Button size="sm" variant="ghost" onClick={() => setFilters(list.NO_FILTERS)}>
                                Clear filters
                            </Button>
                        </div>
                    ) : (
                        // Scrolls sideways rather than shrinking: nine columns on
                        // a phone would be nine unreadable ones.
                        <div className="-mx-1 overflow-x-auto px-1">
                            <table className="w-full min-w-[62rem] border-collapse text-sm">
                                <thead>
                                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                                        <th scope="col" className="w-full max-w-0 py-2 pr-3 font-medium">
                                            Name
                                        </th>
                                        <th scope="col" className="py-2 pr-3 font-medium">Key</th>
                                        <th scope="col" className="py-2 pr-3 font-medium">Environment</th>
                                        <th scope="col" className="py-2 pr-3 font-medium">App</th>
                                        <th scope="col" className="py-2 pr-3 font-medium">Expires</th>
                                        <th scope="col" className="py-2 pr-3 font-medium">Created</th>
                                        <th scope="col" className="py-2 pr-3 font-medium">Last used</th>
                                        <th scope="col" className="py-2 pr-3 text-right font-medium">
                                            Calls today
                                        </th>
                                        <th scope="col" className="py-2 pr-3 font-medium">Compromised</th>
                                        <th scope="col" className="py-2 font-medium">
                                            <span className="sr-only">Actions</span>
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
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardBody>
            </Card>

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
    const href = `/account/api-keys/${entry.id}`;
    const state = list.lifecycleOf(entry);
    const soon = list.expiringSoon(entry);
    const limits = describeLimits(entry);

    return (
        <tr className="border-b border-border/60 last:border-b-0 hover:bg-muted/30">
            <td className="max-w-0 py-2 pr-3 align-top">
                <span className="flex min-w-0 items-center gap-2">
                    <Link
                        href={href}
                        className="min-w-0 truncate text-left font-medium no-underline hover:underline"
                        title={`Edit ${entry.name}`}
                    >
                        {entry.name}
                    </Link>
                    {/* Only when it is not what a key normally is. A row that
                        says "Active" on every line says nothing on any of
                        them. */}
                    {state === "revoked" ? (
                        <Badge variant="danger">Revoked</Badge>
                    ) : state === "expired" ? (
                        <Badge variant="neutral">Expired</Badge>
                    ) : null}
                </span>
                {entry.description ? (
                    <p className="truncate text-xs" title={entry.description}>
                        {entry.description}
                    </p>
                ) : null}
                <p className="truncate text-xs text-muted-foreground">
                    {entry.scopes.length} scope{entry.scopes.length === 1 ? "" : "s"}
                    {limits ? ` - ${limits.toLowerCase()}` : null}
                </p>
                {entry.lastUsedUserAgent ? (
                    <p
                        className="truncate text-xs text-muted-foreground"
                        title={entry.lastUsedUserAgent}
                    >
                        {describeDevice(entry.lastUsedUserAgent)}
                        {entry.lastUsedIp ? ` from ${entry.lastUsedIp}` : null}
                    </p>
                ) : null}
            </td>
            <td className="whitespace-nowrap py-2 pr-3 align-top font-mono text-xs text-muted-foreground">
                {list.maskedKey(entry)}
            </td>
            <td className="whitespace-nowrap py-2 pr-3 align-top">
                <Badge variant={entry.environment === "production" ? "primary" : "neutral"}>
                    {API_KEY_ENVIRONMENT_LABELS[entry.environment as ApiKeyEnvironment] ??
                        entry.environment}
                </Badge>
            </td>
            <td className="whitespace-nowrap py-2 pr-3 align-top text-muted-foreground">
                {entry.projectName ?? "None"}
            </td>
            <td
                className={cn(
                    "whitespace-nowrap py-2 pr-3 align-top",
                    state === "expired" ? "text-danger" : soon ? "text-warning" : undefined
                )}
            >
                {entry.expiresAt ? (
                    <span title={date(entry.expiresAt)}>{date(entry.expiresAt)}</span>
                ) : (
                    "Never"
                )}
            </td>
            <td className="whitespace-nowrap py-2 pr-3 align-top text-muted-foreground">
                {date(entry.createdAt)}
            </td>
            <td className="whitespace-nowrap py-2 pr-3 align-top text-muted-foreground">
                {entry.lastUsedAt ? <RelativeTime iso={entry.lastUsedAt} /> : "Never"}
            </td>
            <td
                className="whitespace-nowrap py-2 pr-3 text-right align-top tabular-nums"
                title={`${entry.usedRecently} calls in the last 30 days`}
            >
                {entry.usedToday === 0 ? (
                    <span className="text-muted-foreground">0</span>
                ) : (
                    entry.usedToday
                )}
            </td>
            <td className="whitespace-nowrap py-2 pr-3 align-top text-xs text-muted-foreground">
                Coming soon
            </td>
            <td className="py-2 align-top">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`What to do with ${entry.name}`}
                            title="More"
                        >
                            <MoreHorizontal className="size-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem asChild>
                            <Link href={href} className="no-underline">
                                <Pencil className="size-3.5" />
                                Edit
                            </Link>
                        </DropdownMenuItem>
                        {state === "revoked" ? null : (
                            <DropdownMenuItem onSelect={onRevoke}>
                                <Ban className="size-3.5" />
                                Revoke
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={onDelete} variant="danger">
                            <Trash2 className="size-3.5" />
                            Delete
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </td>
        </tr>
    );
}
