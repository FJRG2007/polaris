"use client";

/**
 * The Cloud servers page: connected accounts with this month's cost, and the
 * servers created through them.
 *
 * The frame paints at once. The list paints what it kept from the last visit
 * first, then swaps in what the server answers, so a return visit shows no
 * skeleton. Power changes show at once and are undone if the provider refuses.
 */

import Link from "next/link";
import { useCloudT } from "./i18n";
import { CONNECT_HREF } from "../lib/cloud-routes";
import * as actions from "../actions/cloud";
import type { Overview } from "../actions/cloud";
import type { AccountView, ServerView } from "../lib/service";
import { hostUi } from "@polaris/app-host/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cloud, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
    CREDENTIAL_FIELDS,
    machineNameSchema,
    PROVIDER_NAMES,
    PROVIDERS,
    type Choice,
    type ProviderId,
    type SizeChoice
} from "../lib/providers/types";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    EmptyState,
    Input,
    Select,
    Skeleton,
    Textarea
} from "@polaris/ui";

const CACHE_KEY = "polaris.cloud-servers.overview";
const POLL_MS = 5_000;

function readCache(): Overview | null {
    try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        return raw ? (JSON.parse(raw) as Overview) : null;
    } catch {
        return null;
    }
}

function writeCache(value: Overview) {
    try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
    } catch {
        // A private window: the page still works, it only loses the head start.
    }
}

function useMoney() {
    const locale = hostUi.i18nProvider.useLocale();
    return useCallback(
        (amount: number | null, currency: string | null) =>
            amount === null || !currency
                ? null
                : new Intl.NumberFormat(locale, {
                      style: "currency",
                      currency,
                      maximumFractionDigits: 4
                  }).format(amount),
        [locale]
    );
}

type StatusTone = "neutral" | "success" | "warning" | "danger" | "primary";
const TONE: Readonly<Record<string, StatusTone>> = {
    running: "success",
    creating: "primary",
    enrolling: "primary",
    transitioning: "warning",
    off: "neutral",
    failed: "danger",
    destroyed: "neutral"
};

export function CloudServersScreen() {
    const t = useCloudT();
    const [data, setData] = useState<Overview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [createOpen, setCreateOpen] = useState(false);
    const [resizing, setResizing] = useState<ServerView | null>(null);
    const [destroying, setDestroying] = useState<ServerView | null>(null);
    const [removing, setRemoving] = useState<Overview["accounts"][number] | null>(null);

    const load = useCallback(async () => {
        const answer = await actions.overviewAction();
        if (!answer.ok) return setError(answer.error);
        const { ok: _ok, ...overview } = answer;
        setData(overview);
        setError(null);
        writeCache(overview);
    }, []);

    useEffect(() => {
        const cached = readCache();
        if (cached) setData(cached);
        void load();
    }, [load]);

    const setServer = useCallback((server: ServerView) => {
        setData((current) =>
            current
                ? {
                      ...current,
                      servers: current.servers.some((s) => s.id === server.id)
                          ? current.servers.map((s) => (s.id === server.id ? server : s))
                          : [server, ...current.servers]
                  }
                : current
        );
    }, []);

    async function power(server: ServerView, action: "power_on" | "power_off" | "reboot") {
        setServer({ ...server, status: "transitioning" });
        const answer = await actions.powerAction({ serverId: server.id, action });
        if (!answer.ok) {
            setServer(server);
            setError(answer.error);
        } else {
            void load();
        }
    }

    async function refresh(server: ServerView) {
        const answer = await actions.progressAction(server.id);
        if (answer.ok) setServer(answer.server);
        else setError(answer.error);
    }

    const accounts = data?.accounts ?? [];
    const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-xl font-semibold">{t("title")}</h1>
                    <p className="text-sm text-muted-foreground">{t("intro")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {/* Accounts are connected in Profile > Connections, or an
                        organization's, which bring the reader back here. */}
                    <Button asChild variant="outline">
                        <Link href={CONNECT_HREF}>
                            <Plus className="size-4" />
                            {t("accounts.connect")}
                        </Link>
                    </Button>
                    <Button
                        onClick={() => setCreateOpen(true)}
                        disabled={accounts.length === 0}
                        title={accounts.length === 0 ? t("servers.needAccount") : undefined}
                    >
                        <Cloud className="size-4" />
                        {t("servers.create")}
                    </Button>
                </div>
            </header>

            {error && (
                <p
                    role="alert"
                    className="rounded-md border border-danger-edge bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                >
                    {error}
                </p>
            )}

            <section aria-labelledby="cloud-accounts" className="flex flex-col gap-2">
                <h2 id="cloud-accounts" className="text-sm font-medium text-muted-foreground">
                    {t("accounts.title")}
                </h2>
                {!data ? (
                    <Skeleton className="h-16 w-full" />
                ) : accounts.length === 0 ? (
                    <EmptyState
                        icon={<Cloud className="size-5" />}
                        title={t("accounts.empty")}
                        description={t("accounts.emptyHint")}
                    />
                ) : (
                    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {accounts.map((account) => (
                            <AccountCard
                                key={account.id}
                                account={account}
                                totals={data.monthTotals[account.id]}
                                onRemove={() => setRemoving(account)}
                            />
                        ))}
                    </ul>
                )}
            </section>

            <section aria-labelledby="cloud-servers" className="flex flex-col gap-2">
                <h2 id="cloud-servers" className="text-sm font-medium text-muted-foreground">
                    {t("servers.title")}
                </h2>
                {!data ? (
                    <Skeleton className="h-40 w-full" />
                ) : data.servers.length === 0 ? (
                    <EmptyState
                        icon={<Cloud className="size-5" />}
                        title={t("servers.empty")}
                        description={
                            accounts.length === 0
                                ? t("servers.needAccount")
                                : t("servers.emptyHint")
                        }
                    />
                ) : (
                    <ServerTable
                        servers={data.servers}
                        accountName={accountName}
                        onPower={power}
                        onRefresh={refresh}
                        onResize={setResizing}
                        onDestroy={setDestroying}
                    />
                )}
            </section>

            {createOpen && (
                <CreateDialog
                    accounts={accounts}
                    onClose={() => {
                        setCreateOpen(false);
                        void load();
                    }}
                    onServer={setServer}
                />
            )}
            {resizing && (
                <ResizeDialog
                    server={resizing}
                    onClose={() => setResizing(null)}
                    onDone={() => {
                        setResizing(null);
                        void load();
                    }}
                />
            )}
            {destroying && (
                <DestroyDialog
                    server={destroying}
                    onClose={() => setDestroying(null)}
                    onDone={() => {
                        setDestroying(null);
                        void load();
                    }}
                />
            )}
            {removing && (
                <RemoveAccountDialog
                    account={removing}
                    onClose={() => setRemoving(null)}
                    onDone={() => {
                        setRemoving(null);
                        void load();
                    }}
                />
            )}
        </div>
    );
}

function AccountCard({
    account,
    totals,
    onRemove
}: {
    account: Overview["accounts"][number];
    totals: Overview["monthTotals"][string] | undefined;
    onRemove: () => void;
}) {
    const t = useCloudT();
    const money = useMoney();
    const sums = Object.entries(totals?.totals ?? {});
    return (
        <li className="flex min-w-0 items-start justify-between gap-2 rounded-lg border border-border p-3">
            <div className="min-w-0">
                <p className="truncate font-medium" title={account.name}>
                    {account.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                    {account.organization
                        ? t("accounts.forOrg", {
                              provider: PROVIDER_NAMES[account.provider],
                              org: account.organization.name
                          })
                        : PROVIDER_NAMES[account.provider]}
                </p>
                <p className="mt-1 text-sm">
                    {t("accounts.monthTotal")}:{" "}
                    {sums.length === 0
                        ? "-"
                        : sums.map(([currency, amount]) => money(amount, currency)).join(" + ")}
                </p>
                {(totals?.unpriced ?? 0) > 0 && (
                    <p className="text-xs text-muted-foreground">
                        {t("accounts.unpriced", { count: String(totals?.unpriced ?? 0) })}
                    </p>
                )}
                {account.lastError && (
                    <p className="mt-1 break-words text-xs text-danger-ink">
                        {t("accounts.refreshError", { error: account.lastError })}
                    </p>
                )}
            </div>
            <Button
                variant="ghost"
                size="icon"
                aria-label={t("accounts.remove")}
                title={t("accounts.remove")}
                onClick={onRemove}
            >
                <Trash2 className="size-4" />
            </Button>
        </li>
    );
}

function ServerTable({
    servers,
    accountName,
    onPower,
    onRefresh,
    onResize,
    onDestroy
}: {
    servers: readonly ServerView[];
    accountName: ReadonlyMap<string, string>;
    onPower: (server: ServerView, action: "power_on" | "power_off" | "reboot") => void;
    onRefresh: (server: ServerView) => void;
    onResize: (server: ServerView) => void;
    onDestroy: (server: ServerView) => void;
}) {
    const t = useCloudT();
    const money = useMoney();
    const priceCell = (amount: number | null, currency: string | null) =>
        money(amount, currency) ?? (
            <span className="text-muted-foreground">{t("servers.noPrice")}</span>
        );
    const menu = (server: ServerView) =>
        server.status === "destroyed" ? null : (
            <ServerMenu
                server={server}
                onPower={onPower}
                onRefresh={onRefresh}
                onResize={onResize}
                onDestroy={onDestroy}
            />
        );
    const status = (server: ServerView) => (
        <Badge variant={TONE[server.status] ?? "neutral"}>
            {t(`status.${server.status}` as "status.unknown")}
        </Badge>
    );
    return (
        <>
            {/* Below 640px each server is a stacked card: nothing scrolls sideways. */}
            <ul className="flex flex-col gap-2 sm:hidden">
                {servers.map((server) => (
                    <li
                        key={server.id}
                        className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
                    >
                        <div className="flex min-w-0 items-start justify-between gap-2">
                            <div className="min-w-0">
                                <ServerName server={server} />
                                <p className="truncate text-xs text-muted-foreground">
                                    {PROVIDER_NAMES[server.provider]} -{" "}
                                    {accountName.get(server.accountId)}
                                </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                {status(server)}
                                {menu(server)}
                            </div>
                        </div>
                        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                            <dt className="text-muted-foreground">{t("servers.region")}</dt>
                            <dd className="min-w-0 truncate">{server.region}</dd>
                            <dt className="text-muted-foreground">{t("servers.size")}</dt>
                            <dd className="min-w-0 truncate">{server.size}</dd>
                            <dt className="text-muted-foreground">{t("servers.address")}</dt>
                            <dd className="min-w-0 truncate font-mono text-xs">
                                {server.ipv4 ?? "-"}
                            </dd>
                            <dt className="text-muted-foreground">{t("servers.hourly")}</dt>
                            <dd className="min-w-0">
                                {priceCell(server.priceHourly, server.currency)}
                            </dd>
                            <dt className="text-muted-foreground">{t("servers.monthly")}</dt>
                            <dd className="min-w-0">
                                {priceCell(server.priceMonthly, server.currency)}
                            </dd>
                            <dt className="text-muted-foreground">{t("servers.thisMonth")}</dt>
                            <dd className="min-w-0">
                                {money(server.thisMonth, server.currency) ?? "-"}
                            </dd>
                            <dt className="text-muted-foreground">{t("servers.sinceCreation")}</dt>
                            <dd className="min-w-0">
                                {money(server.sinceCreation, server.currency) ?? "-"}
                            </dd>
                        </dl>
                    </li>
                ))}
            </ul>
            <div className="hidden overflow-x-auto rounded-lg border border-border sm:block">
                <table className="w-full min-w-[56rem] text-sm">
                    <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">{t("servers.name")}</th>
                            <th className="px-3 py-2 font-medium">{t("servers.provider")}</th>
                            <th className="px-3 py-2 font-medium">{t("servers.region")}</th>
                            <th className="px-3 py-2 font-medium">{t("servers.size")}</th>
                            <th className="px-3 py-2 font-medium">{t("servers.status")}</th>
                            <th className="px-3 py-2 font-medium">{t("servers.address")}</th>
                            <th className="px-3 py-2 font-medium">{t("servers.hourly")}</th>
                            <th className="px-3 py-2 font-medium">{t("servers.monthly")}</th>
                            <th className="px-3 py-2 font-medium">{t("servers.thisMonth")}</th>
                            <th className="px-3 py-2 font-medium">{t("servers.sinceCreation")}</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {servers.map((server) => (
                            <tr key={server.id} className="border-t border-border align-top">
                                <td className="max-w-[14rem] px-3 py-2">
                                    <ServerName server={server} />
                                </td>
                                <td className="px-3 py-2">
                                    <span className="block">{PROVIDER_NAMES[server.provider]}</span>
                                    <span className="block text-xs text-muted-foreground">
                                        {accountName.get(server.accountId)}
                                    </span>
                                </td>
                                <td className="px-3 py-2">{server.region}</td>
                                <td className="px-3 py-2">{server.size}</td>
                                <td className="px-3 py-2">{status(server)}</td>
                                <td className="px-3 py-2 font-mono text-xs">
                                    {server.ipv4 ?? "-"}
                                </td>
                                <td className="px-3 py-2">
                                    {priceCell(server.priceHourly, server.currency)}
                                </td>
                                <td className="px-3 py-2">
                                    {priceCell(server.priceMonthly, server.currency)}
                                </td>
                                <td className="px-3 py-2">
                                    {money(server.thisMonth, server.currency) ?? "-"}
                                </td>
                                <td className="px-3 py-2">
                                    {money(server.sinceCreation, server.currency) ?? "-"}
                                </td>
                                <td className="px-3 py-2 text-right">{menu(server)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}

/** The server's name, opening it in Servers once it has joined Polaris. */
function ServerName({ server }: { server: ServerView }) {
    const t = useCloudT();
    return (
        <>
            {server.hostId ? (
                <Link
                    href={`/apps/servers/${server.hostId}`}
                    className="block truncate font-medium hover:underline"
                    title={t("servers.openInServers")}
                >
                    {server.name}
                </Link>
            ) : (
                <span className="block truncate font-medium" title={server.name}>
                    {server.name}
                </span>
            )}
            {server.error && (
                <span className="block break-words text-xs text-danger-ink">{server.error}</span>
            )}
        </>
    );
}

function ServerMenu({
    server,
    onPower,
    onRefresh,
    onResize,
    onDestroy
}: {
    server: ServerView;
    onPower: (server: ServerView, action: "power_on" | "power_off" | "reboot") => void;
    onRefresh: (server: ServerView) => void;
    onResize: (server: ServerView) => void;
    onDestroy: (server: ServerView) => void;
}) {
    const t = useCloudT();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("servers.actions", { name: server.name })}
                    title={t("servers.actions", { name: server.name })}
                >
                    <MoreHorizontal className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onRefresh(server)}>
                    <RefreshCw className="size-4" />
                    {t("servers.refresh")}
                </DropdownMenuItem>
                {server.status === "off" ? (
                    <DropdownMenuItem onSelect={() => onPower(server, "power_on")}>
                        {t("servers.powerOn")}
                    </DropdownMenuItem>
                ) : (
                    <DropdownMenuItem onSelect={() => onPower(server, "power_off")}>
                        {t("servers.powerOff")}
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem
                    disabled={server.status === "off"}
                    onSelect={() => onPower(server, "reboot")}
                >
                    {t("servers.reboot")}
                </DropdownMenuItem>
                {server.resize !== "none" && (
                    <DropdownMenuItem onSelect={() => onResize(server)}>
                        {t("servers.resize")}
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem className="text-danger-ink" onSelect={() => onDestroy(server)}>
                    {t("servers.destroy")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function Field({
    label,
    children,
    hint
}: {
    label: string;
    children: React.ReactNode;
    hint?: string;
}) {
    return (
        <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">{label}</span>
            {children}
            {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </label>
    );
}

export function ConnectDialog({
    open,
    orgId = null,
    onOpenChange,
    onConnected
}: {
    open: boolean;
    /** The organization it is connected for; null for the reader's own. */
    orgId?: string | null;
    onOpenChange: (open: boolean) => void;
    onConnected: (account: AccountView) => void;
}) {
    const t = useCloudT();
    const [provider, setProvider] = useState<ProviderId>("hetzner");
    const [name, setName] = useState("");
    const [values, setValues] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fields = CREDENTIAL_FIELDS[provider];
    const complete =
        name.trim().length > 0 && fields.every((f) => (values[f.key] ?? "").trim().length > 0);

    async function submit() {
        setBusy(true);
        setError(null);
        const credentials = Object.fromEntries(
            fields.map((f) => [f.key, (values[f.key] ?? "").trim()])
        );
        const answer = await actions.connectAccountAction({
            provider,
            name: name.trim(),
            credentials,
            orgId
        });
        setBusy(false);
        if (!answer.ok) return setError(answer.error);
        setValues({});
        setName("");
        onConnected(answer.account);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("accounts.connect")}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <Field label={t("accounts.provider")}>
                        <Select
                            value={provider}
                            aria-label={t("accounts.provider")}
                            options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_NAMES[p] }))}
                            onValueChange={(value) => {
                                setProvider(value as ProviderId);
                                setValues({});
                            }}
                        />
                    </Field>
                    <Field label={`${t("accounts.name")} *`}>
                        <Input
                            value={name}
                            maxLength={60}
                            placeholder={t("accounts.namePlaceholder")}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </Field>
                    {fields.map((field) => {
                        const label = `${t(`accounts.fields.${field.key}` as "accounts.fields.token")} *`;
                        const set = (value: string) =>
                            setValues((v) => ({ ...v, [field.key]: value }));
                        return (
                            <Field key={field.key} label={label}>
                                {field.multiline ? (
                                    <Textarea
                                        rows={5}
                                        spellCheck={false}
                                        autoComplete="off"
                                        value={values[field.key] ?? ""}
                                        onChange={(e) => set(e.target.value)}
                                    />
                                ) : (
                                    <Input
                                        type={field.secret ? "password" : "text"}
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={values[field.key] ?? ""}
                                        onChange={(e) => set(e.target.value)}
                                    />
                                )}
                            </Field>
                        );
                    })}
                    {error && (
                        <p role="alert" className="text-sm text-danger-ink">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {t("cancel")}
                    </Button>
                    <Button
                        onClick={submit}
                        disabled={busy || !complete}
                        aria-disabled={busy || !complete}
                    >
                        {busy ? t("accounts.checking") : t("accounts.connect")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function useOptions(accountId: string, region: string | null) {
    const [state, setState] = useState<{
        regions: Choice[];
        sizes: SizeChoice[];
        images: Choice[];
        error: string | null;
        loading: boolean;
    }>({
        regions: [],
        sizes: [],
        images: [],
        error: null,
        loading: false
    });
    useEffect(() => {
        if (!accountId) return;
        let live = true;
        setState((s) => ({
            ...s,
            loading: true,
            error: null,
            ...(region ? { sizes: [], images: [] } : { regions: [] })
        }));
        void actions.optionsAction({ accountId, region }).then((answer) => {
            if (!live) return;
            if (!answer.ok) return setState((s) => ({ ...s, loading: false, error: answer.error }));
            setState((s) => ({
                ...s,
                loading: false,
                ...(region
                    ? { sizes: [...answer.sizes], images: [...answer.images] }
                    : { regions: [...answer.regions] })
            }));
        });
        return () => {
            live = false;
        };
    }, [accountId, region]);
    return state;
}

function CreateDialog({
    accounts,
    onClose,
    onServer
}: {
    accounts: Overview["accounts"];
    onClose: () => void;
    onServer: (server: ServerView) => void;
}) {
    const t = useCloudT();
    const money = useMoney();
    const [accountId, setAccountId] = useState(accounts.length === 1 ? accounts[0]!.id : "");
    const [name, setName] = useState("");
    const [region, setRegion] = useState("");
    const [size, setSize] = useState("");
    const [image, setImage] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [created, setCreated] = useState<ServerView | null>(null);
    const regions = useOptions(accountId, null);
    const regional = useOptions(accountId, region || null);
    const nameValid = name.length === 0 || machineNameSchema.safeParse(name).success;
    const complete = !!accountId && !!region && !!size && !!image && name.length > 0 && nameValid;
    const chosenSize = regional.sizes.find((s) => s.id === size);

    async function submit() {
        setBusy(true);
        setError(null);
        const answer = await actions.createServerAction({ accountId, name, region, size, image });
        setBusy(false);
        if (!answer.ok) return setError(answer.error);
        setCreated(answer.server);
        onServer(answer.server);
    }

    // Follow the new server until it has joined Polaris or failed.
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (!created || created.hostId || created.error || created.status === "failed") return;
        timer.current = setTimeout(async () => {
            const answer = await actions.progressAction(created.id);
            if (answer.ok) {
                setCreated(answer.server);
                onServer(answer.server);
            } else {
                setError(answer.error);
            }
        }, POLL_MS);
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [created, onServer]);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {created
                            ? t("create.progressTitle", { name: created.name })
                            : t("create.title")}
                    </DialogTitle>
                </DialogHeader>
                {created ? (
                    <Progress server={created} />
                ) : (
                    <div className="flex flex-col gap-3">
                        <Field label={`${t("create.account")} *`}>
                            <Select
                                value={accountId}
                                placeholder={t("create.chooseAccount")}
                                aria-label={t("create.account")}
                                onValueChange={(value) => {
                                    setAccountId(value);
                                    setRegion("");
                                    setSize("");
                                    setImage("");
                                }}
                                options={accounts.map((a) => ({
                                    value: a.id,
                                    label: `${a.name} (${PROVIDER_NAMES[a.provider]})`
                                }))}
                            />
                        </Field>
                        <Field label={`${t("servers.name")} *`} hint={t("create.nameHint")}>
                            <Input
                                value={name}
                                maxLength={50}
                                aria-invalid={!nameValid}
                                onChange={(e) => setName(e.target.value.trim().toLowerCase())}
                            />
                        </Field>
                        <Field label={`${t("servers.region")} *`}>
                            <Select
                                value={region}
                                disabled={!accountId || regions.loading}
                                placeholder={
                                    regions.loading ? t("create.loading") : t("create.chooseRegion")
                                }
                                aria-label={t("servers.region")}
                                onValueChange={(value) => {
                                    setRegion(value);
                                    setSize("");
                                    setImage("");
                                }}
                                options={regions.regions.map((r) => ({ value: r.id, label: r.label }))}
                            />
                        </Field>
                        <Field label={`${t("servers.size")} *`}>
                            <Select
                                value={size}
                                disabled={!region || regional.loading}
                                placeholder={
                                    regional.loading ? t("create.loading") : t("create.chooseSize")
                                }
                                aria-label={t("servers.size")}
                                onValueChange={setSize}
                                options={regional.sizes.map((s) => {
                                    const price = money(s.priceMonthly, s.currency);
                                    return { value: s.id, label: price ? `${s.label} - ${price}` : s.label };
                                })}
                            />
                        </Field>
                        <Field label={`${t("servers.image")} *`}>
                            <Select
                                value={image}
                                disabled={!region || regional.loading}
                                placeholder={
                                    regional.loading ? t("create.loading") : t("create.chooseImage")
                                }
                                aria-label={t("servers.image")}
                                onValueChange={setImage}
                                options={regional.images.map((i) => ({ value: i.id, label: i.label }))}
                            />
                        </Field>
                        {chosenSize && (
                            <p className="text-xs text-muted-foreground">
                                {money(chosenSize.priceMonthly, chosenSize.currency)
                                    ? t("create.priceNote", {
                                          price: money(
                                              chosenSize.priceMonthly,
                                              chosenSize.currency
                                          )!
                                      })
                                    : t("create.noPriceNote")}
                            </p>
                        )}
                        {(error || regions.error || regional.error) && (
                            <p role="alert" className="text-sm text-danger-ink">
                                {error ?? regions.error ?? regional.error}
                            </p>
                        )}
                    </div>
                )}
                <DialogFooter>
                    {created ? (
                        <Button onClick={onClose}>{t("create.close")}</Button>
                    ) : (
                        <>
                            <Button variant="outline" onClick={onClose}>
                                {t("cancel")}
                            </Button>
                            <Button
                                onClick={submit}
                                disabled={busy || !complete}
                                aria-disabled={busy || !complete}
                            >
                                {busy ? t("create.creating") : t("create.submit")}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Progress({ server }: { server: ServerView }) {
    const t = useCloudT();
    const booted = server.status === "enrolling" || server.status === "running" || !!server.hostId;
    const steps = [
        { label: t("create.stepCreate"), done: true },
        { label: t("create.stepBoot"), done: booted },
        { label: t("create.stepEnroll"), done: !!server.hostId }
    ];
    return (
        <div className="flex flex-col gap-2" aria-live="polite">
            <ol className="flex flex-col gap-1 text-sm">
                {steps.map((step) => (
                    <li key={step.label} className={step.done ? "" : "text-muted-foreground"}>
                        {step.done ? "[x] " : "[ ] "}
                        {step.label}
                    </li>
                ))}
            </ol>
            {server.error ? (
                <p role="alert" className="text-sm text-danger-ink">
                    {server.error}
                </p>
            ) : server.hostId ? (
                <p className="text-sm">
                    {t("create.done")}{" "}
                    <Link href={`/apps/servers/${server.hostId}`} className="underline">
                        {t("servers.openInServers")}
                    </Link>
                </p>
            ) : null}
        </div>
    );
}

function ResizeDialog({
    server,
    onClose,
    onDone
}: {
    server: ServerView;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useCloudT();
    const money = useMoney();
    const options = useOptions(server.accountId, server.region);
    const [size, setSize] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const mustStop = server.resize === "stopped" && server.status !== "off";

    async function submit() {
        setBusy(true);
        const answer = await actions.resizeAction({ serverId: server.id, size });
        setBusy(false);
        if (!answer.ok) return setError(answer.error);
        onDone();
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("resize.title", { name: server.name })}</DialogTitle>
                    {mustStop && <DialogDescription>{t("resize.stoppedFirst")}</DialogDescription>}
                </DialogHeader>
                <Field label={`${t("servers.size")} *`}>
                    <Select
                        value={size}
                        disabled={options.loading || mustStop}
                        placeholder={options.loading ? t("create.loading") : t("create.chooseSize")}
                        aria-label={t("servers.size")}
                        onValueChange={setSize}
                        options={options.sizes
                            .filter((s) => s.id !== server.size)
                            .map((s) => {
                                const price = money(s.priceMonthly, s.currency);
                                return { value: s.id, label: price ? `${s.label} - ${price}` : s.label };
                            })}
                    />
                </Field>
                {(error || options.error) && (
                    <p role="alert" className="text-sm text-danger-ink">
                        {error ?? options.error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        {t("cancel")}
                    </Button>
                    <Button
                        onClick={submit}
                        disabled={busy || !size || mustStop}
                        aria-disabled={busy || !size || mustStop}
                    >
                        {t("resize.submit")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function DestroyDialog({
    server,
    onClose,
    onDone
}: {
    server: ServerView;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useCloudT();
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const matches = typed.trim() === server.name;

    async function submit() {
        setBusy(true);
        const answer = await actions.destroyAction({ serverId: server.id, typedName: typed });
        setBusy(false);
        if (!answer.ok) return setError(answer.error);
        onDone();
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("destroy.title", { name: server.name })}</DialogTitle>
                    <DialogDescription>{t("destroy.body")}</DialogDescription>
                </DialogHeader>
                <Field label={t("destroy.typeName", { name: server.name })}>
                    <Input
                        value={typed}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => setTyped(e.target.value)}
                    />
                </Field>
                {error && (
                    <p role="alert" className="text-sm text-danger-ink">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        {t("cancel")}
                    </Button>
                    <Button
                        variant="danger"
                        onClick={submit}
                        disabled={busy || !matches}
                        aria-disabled={busy || !matches}
                    >
                        {t("destroy.submit")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function RemoveAccountDialog({
    account,
    onClose,
    onDone
}: {
    account: Overview["accounts"][number];
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useCloudT();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        setBusy(true);
        const answer = await actions.removeAccountAction(account.id);
        setBusy(false);
        if (!answer.ok) return setError(answer.error);
        onDone();
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("accounts.removeTitle", { name: account.name })}</DialogTitle>
                    <DialogDescription>{t("accounts.removeBody")}</DialogDescription>
                </DialogHeader>
                {error && (
                    <p role="alert" className="text-sm text-danger-ink">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        {t("cancel")}
                    </Button>
                    <Button variant="danger" onClick={submit} disabled={busy}>
                        {t("accounts.remove")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
