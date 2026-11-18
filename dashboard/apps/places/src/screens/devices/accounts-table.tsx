"use client";

/**
 * The accounts devices are read through, as a table: one row per connected
 * account with its make, its name, whether it is answering and why not, how many
 * devices it brings and when it was last read, and a menu with everything that
 * can be done to it.
 *
 * A house with one hub and a building with forty accounts read the same screen,
 * so the table is searched, filtered by make and by state, and sorted by any
 * column. A row opens what the account holds: the device list below narrows to
 * its devices, and pressing it again shows them all.
 */

import { useMemo, useState } from "react";
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import type { PlacesKey } from "../../../messages";
import type { PlacesTranslator } from "../../lib/i18n";
import * as registry from "../../lib/device-connections";
import { placesRefusalText } from "../../lib/refusal-text";
import type { DeviceAccountView } from "../../lib/device-accounts";
import { ExternalLink, MoreHorizontal, Plus, Radio, Settings2, Unplug } from "lucide-react";
import {
    Badge,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    EmptyState,
    Select,
    Skeleton,
    SearchField,
    SortHeader,
    cn,
    nextSort,
    rowClickIntent,
    type TableSortDirection
} from "@polaris/ui";

const { useDisplayFormat } = hostUi.displayFormat;
const { IntegrationLogo } = hostUi.logos;

/** The states an account is shown in. Anything the server reports that is not
 *  one of the first three is shown as not answering, as the cards did. */
export const ACCOUNT_STATES = ["unauthorized", "lapsed", "unreachable", "ok"] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

export function accountState(account: DeviceAccountView): AccountState {
    return account.status === "ok" ||
        account.status === "unauthorized" ||
        account.status === "lapsed"
        ? account.status
        : "unreachable";
}

const STATE_WORDS: Record<AccountState, PlacesKey> = {
    ok: "devicesView.statusOk",
    unauthorized: "devicesView.statusUnauthorized",
    lapsed: "devicesView.statusLapsed",
    unreachable: "devicesView.statusUnreachable"
};

const STATE_TONE: Record<AccountState, "success" | "warning" | "danger"> = {
    ok: "success",
    unauthorized: "danger",
    lapsed: "warning",
    unreachable: "danger"
};

export type AccountSortKey = "name" | "integration" | "status" | "devices" | "lastSync";

export interface AccountSort {
    readonly order: AccountSortKey;
    readonly direction: TableSortDirection;
}

/** What a make is called on screen, in the reader's language where the
 *  registry has words for it. */
function integrationName(t: PlacesTranslator, account: DeviceAccountView): string {
    const connection = registry.deviceConnection(account.connection);
    return connection ? registry.connectionWords(t, connection).label : account.connectionLabel;
}

/** The accounts shown: searched, filtered and sorted. Pure, so it can be
 *  asserted without drawing the table. */
export function arrangeAccounts(
    accounts: readonly DeviceAccountView[],
    input: {
        query: string;
        integration: string;
        state: AccountState | "all";
        sort: AccountSort;
        nameOf: (account: DeviceAccountView) => string;
    }
): DeviceAccountView[] {
    const query = input.query.trim().toLocaleLowerCase();
    const shown = accounts.filter(
        (account) =>
            (input.integration === "all" || account.connection === input.integration) &&
            (input.state === "all" || accountState(account) === input.state) &&
            (query === "" ||
                [account.label, input.nameOf(account), account.brand].some((value) =>
                    value.toLocaleLowerCase().includes(query)
                ))
    );
    const synced = (account: DeviceAccountView) =>
        account.lastSyncedAt ? Date.parse(account.lastSyncedAt) : 0;
    const compare: Record<AccountSortKey, (a: DeviceAccountView, b: DeviceAccountView) => number> =
        {
            name: (a, b) => a.label.localeCompare(b.label),
            integration: (a, b) => input.nameOf(a).localeCompare(input.nameOf(b)),
            // Ascending puts what needs somebody first.
            status: (a, b) =>
                ACCOUNT_STATES.indexOf(accountState(a)) - ACCOUNT_STATES.indexOf(accountState(b)),
            devices: (a, b) => a.deviceCount - b.deviceCount,
            lastSync: (a, b) => synced(a) - synced(b)
        };
    const sign = input.sort.direction === "asc" ? 1 : -1;
    return shown.sort(
        (a, b) => sign * compare[input.sort.order](a, b) || a.label.localeCompare(b.label)
    );
}

export interface AccountsTableProps {
    accounts: readonly DeviceAccountView[];
    canManage: boolean;
    /** The account whose devices the list below is narrowed to, if any. */
    shownAccountId: string | null;
    onShowDevices: (accountId: string | null) => void;
    onReconnect: (account: DeviceAccountView) => void;
    /** Open the connect dialog, for another way into a make whose plan ran out. */
    onConnect: () => void;
    onLink: (account: DeviceAccountView) => void;
    onAdjust: (accountId: string) => void;
    onDisconnect: (account: DeviceAccountView) => void;
}

export function AccountsTable({
    accounts,
    canManage,
    shownAccountId,
    onShowDevices,
    onReconnect,
    onConnect,
    onLink,
    onAdjust,
    onDisconnect
}: AccountsTableProps) {
    const t = usePlacesT();
    const format = useDisplayFormat();
    const [query, setQuery] = useState("");
    const [integration, setIntegration] = useState("all");
    const [state, setState] = useState<AccountState | "all">("all");
    const [sort, setSort] = useState<AccountSort>({ order: "name", direction: "asc" });

    const nameOf = (account: DeviceAccountView) => integrationName(t, account);
    const integrations = useMemo(() => {
        const seen = new Map<string, string>();
        for (const account of accounts)
            if (!seen.has(account.connection))
                seen.set(account.connection, integrationName(t, account));
        return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
    }, [accounts, t]);
    // A filter on something no longer listed would hide every row with no way
    // to see why, so it falls back to everything.
    const integrationShown = integrations.some(([id]) => id === integration) ? integration : "all";
    const rows = arrangeAccounts(accounts, {
        query,
        integration: integrationShown,
        state,
        sort,
        nameOf
    });

    const header = (key: AccountSortKey, label: string, className?: string) => (
        <SortHeader
            label={label}
            order={key}
            sort={sort}
            onSort={(order) => setSort((current) => nextSort(current, order))}
            className={className}
        />
    );
    const toggle = (accountId: string) =>
        onShowDevices(shownAccountId === accountId ? null : accountId);

    return (
        <div className="flex min-w-0 flex-col gap-2">
            {accounts.length > 1 && (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <SearchField
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("devicesView.searchAccounts")}
                        aria-label={t("devicesView.searchAccounts")}
                        maxLength={200}
                        wrapperClassName="flex-1 basis-48 sm:max-w-xs"
                    />
                    {integrations.length > 1 && (
                        <Select
                            value={integrationShown}
                            onValueChange={setIntegration}
                            aria-label={t("devicesView.integrationFilter")}
                            className="w-44"
                            options={[
                                { value: "all", label: t("devicesView.allIntegrations") },
                                ...integrations.map(([value, label]) => ({ value, label }))
                            ]}
                        />
                    )}
                    <Select
                        value={state}
                        onValueChange={(value) => setState(value as AccountState | "all")}
                        aria-label={t("devicesView.statusFilter")}
                        className="w-44"
                        options={[
                            { value: "all", label: t("devicesView.allStatuses") },
                            ...ACCOUNT_STATES.map((value) => ({
                                value,
                                label: t(STATE_WORDS[value])
                            }))
                        ]}
                    />
                </div>
            )}

            {rows.length === 0 ? (
                <EmptyState
                    title={t("devicesView.noAccountMatch")}
                    description={t("devicesView.noAccountMatchBody")}
                />
            ) : (
                <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-border">
                    <table className="w-full text-sm" aria-label={t("devicesView.accountsLabel")}>
                        <thead className="bg-surface/60 text-start text-xs text-muted-foreground">
                            <tr>
                                {header("name", t("devicesView.columnAccount"), "w-full max-w-0")}
                                {header(
                                    "integration",
                                    t("devicesView.columnIntegration"),
                                    "hidden xl:table-cell"
                                )}
                                {header("status", t("devicesView.columnStatus"))}
                                {header(
                                    "devices",
                                    t("devicesView.columnDevices"),
                                    "hidden lg:table-cell"
                                )}
                                {header(
                                    "lastSync",
                                    t("devicesView.columnLastSync"),
                                    "hidden lg:table-cell"
                                )}
                                <th scope="col" className="w-0 px-1 py-2">
                                    <span className="sr-only">{t("devicesView.open")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((account) => (
                                <AccountRow
                                    key={account.id}
                                    account={account}
                                    integration={nameOf(account)}
                                    synced={
                                        account.lastSyncedAt
                                            ? format.time(account.lastSyncedAt)
                                            : t("devicesView.notChecked")
                                    }
                                    shown={shownAccountId === account.id}
                                    canManage={canManage}
                                    onToggle={() => toggle(account.id)}
                                    onReconnect={onReconnect}
                                    onConnect={onConnect}
                                    onLink={onLink}
                                    onAdjust={onAdjust}
                                    onDisconnect={onDisconnect}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function AccountRow({
    account,
    integration,
    synced,
    shown,
    canManage,
    onToggle,
    onReconnect,
    onConnect,
    onLink,
    onAdjust,
    onDisconnect
}: {
    account: DeviceAccountView;
    integration: string;
    synced: string;
    shown: boolean;
    canManage: boolean;
    onToggle: () => void;
} & Pick<
    AccountsTableProps,
    "onReconnect" | "onConnect" | "onLink" | "onAdjust" | "onDisconnect"
>) {
    const t = usePlacesT();
    const state = accountState(account);
    const connection = registry.deviceConnection(account.connection);
    const reason = account.statusNote ? placesRefusalText(t, account.statusNote) : "";
    const stateWords = t(STATE_WORDS[state]);
    const devices = t("devicesView.deviceCount", { count: account.deviceCount });
    return (
        <tr
            className={cn(
                "cursor-pointer border-t border-border transition-colors hover:bg-surface/60",
                shown && "bg-surface"
            )}
            onClick={(event) => {
                const intent = rowClickIntent({
                    target: event.target as Element,
                    button: event.button,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    selection: window.getSelection()?.toString() ?? ""
                });
                if (intent === "open") onToggle();
            }}
        >
            <td className="w-full max-w-0 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                    <IntegrationLogo
                        slug={connection?.logo ?? ""}
                        className="size-5 w-6 shrink-0 object-contain"
                    />
                    <div className="flex min-w-0 flex-col">
                        <button
                            type="button"
                            className="min-w-0 truncate text-start font-medium hover:underline"
                            title={`${account.label} - ${t("devicesView.showDevices")}`}
                            aria-pressed={shown}
                            onClick={onToggle}
                        >
                            {account.label}
                        </button>
                        {/* What the narrower screens hide, kept on the first cell. */}
                        <span
                            className="min-w-0 truncate text-xs text-muted-foreground xl:hidden"
                            title={`${integration} - ${devices} - ${synced}`}
                        >
                            {integration}
                            <span className="lg:hidden">{` - ${devices} - ${synced}`}</span>
                        </span>
                    </div>
                </div>
            </td>
            <td className="hidden max-w-[14rem] px-3 py-2 xl:table-cell">
                <span className="block min-w-0 truncate text-muted-foreground" title={integration}>
                    {integration}
                </span>
            </td>
            <td className="max-w-[16rem] px-3 py-2">
                <div className="flex min-w-0 flex-col items-start gap-0.5">
                    <Badge variant={STATE_TONE[state]} className="shrink-0 whitespace-nowrap">
                        {stateWords}
                    </Badge>
                    {reason && (
                        <span
                            className="block w-full min-w-0 truncate text-xs text-muted-foreground"
                            title={reason}
                        >
                            {reason}
                        </span>
                    )}
                </div>
            </td>
            <td className="hidden px-3 py-2 tabular-nums lg:table-cell">{account.deviceCount}</td>
            <td className="hidden whitespace-nowrap px-3 py-2 text-muted-foreground lg:table-cell">
                {synced}
            </td>
            <td className="px-1 py-1 text-end">
                <AccountMenu
                    account={account}
                    shown={shown}
                    canManage={canManage}
                    onToggle={onToggle}
                    onReconnect={onReconnect}
                    onConnect={onConnect}
                    onLink={onLink}
                    onAdjust={onAdjust}
                    onDisconnect={onDisconnect}
                />
            </td>
        </tr>
    );
}

/** Everything the old account card offered, behind the row's three dots. */
function AccountMenu({
    account,
    shown,
    canManage,
    onToggle,
    onReconnect,
    onConnect,
    onLink,
    onAdjust,
    onDisconnect
}: {
    account: DeviceAccountView;
    shown: boolean;
    canManage: boolean;
    onToggle: () => void;
} & Pick<
    AccountsTableProps,
    "onReconnect" | "onConnect" | "onLink" | "onAdjust" | "onDisconnect"
>) {
    const t = usePlacesT();
    const label = t("devicesView.moreFor", { name: account.label });
    const connection = registry.deviceConnection(account.connection);
    const said = connection ? registry.connectionWords(t, connection) : null;
    const instead = registry.recommendedConnection(account.brand);
    const lapsed = account.status === "lapsed";
    const offerInstead =
        canManage && lapsed && instead !== null && instead.id !== account.connection;
    const hasOptions = canManage && (connection?.options?.length ?? 0) > 0;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    aria-label={label}
                    title={label}
                >
                    <MoreHorizontal className="size-4 shrink-0" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onToggle}>
                    {shown ? t("devicesView.showAllDevices") : t("devicesView.showDevices")}
                </DropdownMenuItem>
                {canManage && account.status === "unauthorized" && (
                    <DropdownMenuItem onSelect={() => onReconnect(account)}>
                        {t("devicesView.reconnect")}
                    </DropdownMenuItem>
                )}
                {lapsed && connection?.link && (
                    <DropdownMenuItem asChild>
                        <a href={connection.link.href} target="_blank" rel="noreferrer">
                            <ExternalLink className="size-4 shrink-0" />
                            {t("devicesView.openWhere", {
                                where: said?.link?.label ?? connection.link.label
                            })}
                        </a>
                    </DropdownMenuItem>
                )}
                {offerInstead && instead && (
                    <DropdownMenuItem onSelect={onConnect}>
                        <Plus className="size-4 shrink-0" />
                        {t("devicesView.connectInstead", {
                            label: registry.connectionWords(t, instead).label
                        })}
                    </DropdownMenuItem>
                )}
                {canManage && account.connection === "nuki-web" && (
                    <DropdownMenuItem onSelect={() => onLink(account)}>
                        <Radio className="size-4 shrink-0" />
                        {t("devicesView.connectLocallyItem")}
                    </DropdownMenuItem>
                )}
                {hasOptions && (
                    <DropdownMenuItem onSelect={() => onAdjust(account.id)}>
                        <Settings2 className="size-4 shrink-0" />
                        {t("devicesView.settingsItem")}
                    </DropdownMenuItem>
                )}
                {canManage && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            className="text-danger focus:text-danger"
                            onSelect={() => onDisconnect(account)}
                        >
                            <Unplug className="size-4 shrink-0" />
                            {t("devicesView.disconnect")}
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The table's frame while the accounts are read: a header and three rows. */
export function AccountsTableSkeleton() {
    return (
        <div className="overflow-hidden rounded-lg border border-border" aria-hidden="true">
            <div className="flex items-center gap-4 bg-surface/60 px-3 py-2.5">
                <Skeleton className="h-3 w-24" />
                <span className="flex-1" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="hidden h-3 w-16 lg:block" />
                <Skeleton className="hidden h-3 w-20 lg:block" />
            </div>
            {[0, 1, 2].map((row) => (
                <div
                    key={row}
                    className="flex items-center gap-3 border-t border-border px-3 py-2.5"
                >
                    <Skeleton className="size-5 shrink-0 rounded" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <Skeleton className="h-3.5 w-40 max-w-full" />
                        <Skeleton className="h-3 w-24 max-w-full xl:hidden" />
                    </div>
                    <Skeleton className="h-5 w-20 shrink-0 rounded-full" />
                    <Skeleton className="hidden h-3.5 w-6 shrink-0 lg:block" />
                    <Skeleton className="hidden h-3.5 w-20 shrink-0 lg:block" />
                    <Skeleton className="size-8 shrink-0 rounded-md" />
                </div>
            ))}
        </div>
    );
}
