"use client";

/**
 * The private networks: each with where its gateway stands, whether the router
 * answers, and what to enter on a router to build it. The heading paints first;
 * only the list waits on the control server, and it is asked again for a while
 * when a gateway is still coming up.
 */

import * as ui from "@polaris/ui";
import * as actions from "./actions";
import { useVpnRead } from "../use-vpn-read";
import type { NetworksAnswer } from "./actions";
import { CodeView } from "@/components/json-view";
import type { NetworkView } from "@/lib/vpn/network-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Loader2, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import {
    firstHost,
    isHostOf,
    isUsableCidr,
    networkInputSchema,
    normalizeCidr,
    suggestCidr
} from "@/lib/vpn/networks";

/** How often the list is asked again while a gateway has not arrived. */
const SETTLING_POLL_MS = 5_000;
/** How many times, so a server that stays off is not asked about for good. */
const SETTLING_POLLS = 24;

type Translate = ReturnType<typeof useTranslations>;

export function VpnNetworksSection({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations("vpn");
    const read = useVpnRead<NetworksAnswer>(
        "networks",
        actions.listNetworksAction,
        t("errors.generic")
    );
    const [creating, setCreating] = useState(false);
    const [editing, setEditing] = useState<NetworkView | null>(null);
    const [removing, setRemoving] = useState<NetworkView | null>(null);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [changes, setChanges] = useState(0);
    const networks = read.data?.networks ?? null;
    const limited = read.data?.limited ?? false;
    const settling =
        networks
            ?.filter(({ gateway }) => gateway !== "online")
            .map(({ id, gateway }) => `${id}:${gateway}`)
            .join() ?? "";

    useEffect(() => {
        if (settling === "") return;
        let left = SETTLING_POLLS;
        const timer = setInterval(() => {
            read.poll();
            left -= 1;
            if (left === 0) clearInterval(timer);
        }, SETTLING_POLL_MS);
        return () => clearInterval(timer);
    }, [settling, changes, read.poll]);

    function run(
        action: () => Promise<{ error?: string; notice?: string }>,
        done?: () => void
    ): void {
        setError(null);
        startTransition(async () => {
            const result = await action().catch((): { error?: string; notice?: string } => ({
                error: t("errors.generic")
            }));
            read.reload();
            setChanges((count) => count + 1);
            if (result.error !== undefined) {
                setError(result.error);
                return;
            }
            if (result.notice !== undefined) setError(result.notice);
            done?.();
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-sm text-muted-foreground">
                    {isAdmin ? t("networks.intro") : t("networks.memberIntro")}
                </p>
                {isAdmin && !limited ? (
                    <ui.Button
                        size="sm"
                        disabled={read.data === null}
                        onClick={() => setCreating(true)}
                    >
                        <Plus />
                        {t("networks.new")}
                    </ui.Button>
                ) : null}
            </div>
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            {networks === null ? (
                read.error ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <p role="alert" className="text-sm text-danger">
                            {read.error}
                        </p>
                        <ui.Button size="sm" variant="ghost" onClick={read.reload}>
                            {t("actions.retry")}
                        </ui.Button>
                    </div>
                ) : (
                    <ul className="flex flex-col gap-2" aria-busy="true">
                        {[0, 1].map((row) => (
                            <li key={row}>
                                <ui.Skeleton className="h-28 w-full" />
                            </li>
                        ))}
                    </ul>
                )
            ) : networks.length === 0 ? (
                <ui.EmptyState
                    title={t("networks.emptyTitle")}
                    description={
                        !isAdmin
                            ? t("networks.memberEmptyBody")
                            : limited
                              ? t("errors.limited")
                              : t("networks.emptyBody")
                    }
                    action={
                        isAdmin && !limited ? (
                            <ui.Button size="sm" onClick={() => setCreating(true)}>
                                {t("networks.new")}
                            </ui.Button>
                        ) : undefined
                    }
                />
            ) : (
                <ul className="flex flex-col gap-3">
                    {networks.map((network) => (
                        <li key={network.id}>
                            <NetworkCard
                                network={network}
                                t={t}
                                isAdmin={isAdmin}
                                busy={pending}
                                onRefresh={read.reload}
                                onRetry={() =>
                                    run(() => actions.retryGatewayAction({ id: network.id }))
                                }
                                onEdit={() => setEditing(network)}
                                onRemove={() => setRemoving(network)}
                            />
                        </li>
                    ))}
                </ul>
            )}
            {isAdmin && creating ? (
                <CreateDialog
                    t={t}
                    taken={networks?.map(({ cidr }) => cidr) ?? []}
                    servers={read.data?.servers ?? []}
                    busy={pending}
                    error={error}
                    onClose={() => setCreating(false)}
                    onCreate={(input) =>
                        run(
                            () => actions.createNetworkAction(input),
                            () => setCreating(false)
                        )
                    }
                />
            ) : null}
            {editing ? (
                <EditDialog
                    t={t}
                    network={editing}
                    busy={pending}
                    error={error}
                    onClose={() => setEditing(null)}
                    onSave={(change) =>
                        run(
                            () => actions.updateNetworkAction(change),
                            () => setEditing(null)
                        )
                    }
                />
            ) : null}
            <ui.ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => !open && setRemoving(null)}
                kind={t("networks.kind")}
                name={removing?.name ?? ""}
                title={t("networks.removeTitle")}
                description={t("networks.removeBody")}
                confirmLabel={t("networks.remove")}
                pending={pending}
                error={error}
                onConfirm={() => {
                    if (!removing) return;
                    run(
                        () => actions.removeNetworkAction({ id: removing.id }),
                        () => setRemoving(null)
                    );
                }}
            />
        </div>
    );
}

function NetworkCard({
    network,
    t,
    isAdmin,
    busy,
    onRefresh,
    onRetry,
    onEdit,
    onRemove
}: {
    network: NetworkView;
    t: Translate;
    isAdmin: boolean;
    busy: boolean;
    onRefresh: () => void;
    onRetry: () => void;
    onEdit: () => void;
    onRemove: () => void;
}) {
    const server = network.serverName ?? t("networks.server");
    const online = network.gateway === "online";
    return (
        <ui.Card>
            <ui.CardHeader>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <ui.CardTitle className="min-w-0 truncate" title={network.name}>
                        {network.name}
                    </ui.CardTitle>
                    <ui.Badge variant={online ? "success" : "warning"}>
                        {t(`networks.state.${network.gateway}`)}
                    </ui.Badge>
                    {network.routerReachable !== null ? (
                        <ui.Badge variant={network.routerReachable ? "success" : "warning"}>
                            {network.routerReachable
                                ? t("networks.routerSeen")
                                : t("networks.routerMissing")}
                        </ui.Badge>
                    ) : null}
                    {isAdmin ? (
                        <div className="ml-auto flex shrink-0 items-center gap-1">
                            <IconButton label={t("networks.refresh")} onClick={onRefresh}>
                                <RefreshCw />
                            </IconButton>
                            <IconButton label={t("networks.edit")} onClick={onEdit}>
                                <Pencil />
                            </IconButton>
                            <IconButton label={t("networks.remove")} onClick={onRemove}>
                                <Trash2 />
                            </IconButton>
                        </div>
                    ) : null}
                </div>
            </ui.CardHeader>
            <ui.CardBody className="flex flex-col gap-4">
                <dl className="grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                    <Fact term={t("networks.subnet")} value={network.cidr} />
                    <Fact term={t("networks.routerAddress")} value={network.routerAddress} />
                    <Fact term={t("networks.server")} value={server} />
                </dl>
                {network.gateway !== "online" && isAdmin ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 text-sm text-muted-foreground">
                            {t(`networks.stateHint.${network.gateway}`, { server })}
                        </p>
                        <ui.Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>
                            {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                            {t("networks.retry")}
                        </ui.Button>
                    </div>
                ) : null}
                {network.routerReachable === false ? (
                    <p className="text-sm text-muted-foreground">
                        {t("networks.routerMissingHint", {
                            address: network.routerAddress,
                            server
                        })}
                    </p>
                ) : null}
                {network.setup ? (
                    <RouterSetup t={t} network={network} setup={network.setup} server={server} />
                ) : null}
            </ui.CardBody>
        </ui.Card>
    );
}

function IconButton({
    label,
    onClick,
    children
}: {
    label: string;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <ui.Button size="icon" variant="ghost" aria-label={label} title={label} onClick={onClick}>
            {children}
        </ui.Button>
    );
}

function Fact({ term, value }: { term: string; value: string }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{term}</dt>
            <dd className="truncate font-mono text-sm" title={value}>
                {value}
            </dd>
        </div>
    );
}

function CopyRow({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
    return (
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
            <div className="min-w-0">
                <div className="text-xs text-muted-foreground">{label}</div>
                <code className="block truncate font-mono text-xs" title={value}>
                    {value}
                </code>
            </div>
            <ui.CopyButton value={value} label={copyLabel} />
        </div>
    );
}

function RouterSetup({
    t,
    network,
    setup,
    server
}: {
    t: Translate;
    network: NetworkView;
    setup: NonNullable<NetworkView["setup"]>;
    server: string;
}) {
    return (
        <details className="min-w-0 rounded-md border border-border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                {t("networks.setupTitle")}
            </summary>
            <div className="flex min-w-0 flex-col gap-4 border-t border-border p-3">
                <p className="text-sm text-muted-foreground">{t("networks.setupBody")}</p>
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                    <CopyRow
                        label={t("networks.ssid")}
                        value={setup.ssid}
                        copyLabel={t("networks.copySsid")}
                    />
                    {setup.wifiPassword ? (
                        <CopyRow
                            label={t("networks.password")}
                            value={setup.wifiPassword}
                            copyLabel={t("networks.copyPassword")}
                        />
                    ) : (
                        <p className="text-sm text-danger">{t("networks.passwordLost")}</p>
                    )}
                    <CopyRow
                        label={t("networks.subnet")}
                        value={network.cidr}
                        copyLabel={t("networks.copySubnet")}
                    />
                    <CopyRow
                        label={t("networks.routerAddress")}
                        value={network.routerAddress}
                        copyLabel={t("networks.copyRouter")}
                    />
                </div>
                <p className="text-sm">
                    {t("networks.dhcpRange")}:{" "}
                    <code className="font-mono text-xs">
                        {`${setup.dhcp.first} - ${setup.dhcp.last}`}
                    </code>
                </p>
                <div className="min-w-0">
                    <h4 className="text-sm font-medium">{t("networks.ruleTitle")}</h4>
                    <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                        <li>{t("networks.ruleLan", { server, cidr: network.cidr })}</li>
                        <li>{t("networks.ruleDevices", { cidr: network.cidr })}</li>
                        <li>
                            {network.internet
                                ? t("networks.ruleInternetOn", { cidr: network.cidr })
                                : t("networks.ruleInternetOff", { cidr: network.cidr })}
                        </li>
                    </ul>
                </div>
                {setup.openWrt ? (
                    <div className="flex min-w-0 flex-col gap-1">
                        <h4 className="text-sm font-medium">{t("networks.openWrtTitle")}</h4>
                        <p className="text-sm text-muted-foreground">{t("networks.openWrtBody")}</p>
                        <p className="text-sm text-muted-foreground">
                            {t("networks.openWrtNoRadio", { bridge: setup.bridge })}
                        </p>
                        <CodeView
                            value={setup.openWrt}
                            language="bash"
                            label={t("networks.scriptLabel")}
                            className="max-h-72 min-w-0"
                        />
                    </div>
                ) : null}
                <div className="min-w-0">
                    <h4 className="text-sm font-medium">{t("networks.linesTitle")}</h4>
                    <p className="text-sm text-muted-foreground">{t("networks.linesBody")}</p>
                </div>
            </div>
        </details>
    );
}

function Field({
    id,
    label,
    error,
    hint,
    children
}: {
    id: string;
    label: string;
    error?: string | null;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={id} className="text-sm font-medium">
                {label}
            </label>
            {children}
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}

function AccessField({
    t,
    value,
    onChange
}: {
    t: Translate;
    value: "admins" | "everyone";
    onChange: (value: "admins" | "everyone") => void;
}) {
    return (
        <Field id="network-access" label={t("networks.accessLabel")}>
            <ui.Select
                value={value}
                onValueChange={(next) => onChange(next as "admins" | "everyone")}
                options={[
                    { value: "admins", label: t("networks.accessAdmins") },
                    { value: "everyone", label: t("networks.accessEveryone") }
                ]}
            />
        </Field>
    );
}

function InternetField({
    t,
    value,
    onChange
}: {
    t: Translate;
    value: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
                <p className="text-sm font-medium">{t("networks.internet")}</p>
                <p className="text-xs text-muted-foreground">{t("networks.internetHint")}</p>
            </div>
            <ui.Switch checked={value} onChange={onChange} aria-label={t("networks.internet")} />
        </div>
    );
}

function CreateDialog({
    t,
    taken,
    servers,
    busy,
    error,
    onClose,
    onCreate
}: {
    t: Translate;
    taken: readonly string[];
    servers: NetworksAnswer["servers"];
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onCreate: (input: unknown) => void;
}) {
    const suggested = useMemo(() => suggestCidr(taken), [taken]);
    const [name, setName] = useState("");
    const [cidr, setCidr] = useState(suggested);
    const [routerAddress, setRouterAddress] = useState(firstHost(suggested));
    const [routerTouched, setRouterTouched] = useState(false);
    const [targetId, setTargetId] = useState(servers[0]?.id ?? "");
    const [ssid, setSsid] = useState("");
    const [access, setAccess] = useState<"admins" | "everyone">("admins");
    const [internet, setInternet] = useState(false);

    const normalized = normalizeCidr(cidr);
    const subnetBad = cidr.trim() !== "" && !isUsableCidr(normalized);
    const routerBad =
        routerAddress.trim() !== "" &&
        isUsableCidr(normalized) &&
        !isHostOf(normalized, routerAddress.trim());
    const input = { name, cidr, routerAddress, targetId, ssid, access, internet };
    const valid = networkInputSchema.safeParse(input).success;

    function changeCidr(next: string): void {
        setCidr(next);
        const clean = normalizeCidr(next);
        if (!routerTouched && isUsableCidr(clean)) setRouterAddress(firstHost(clean));
    }

    return (
        <ui.Dialog open onOpenChange={(open) => !open && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{t("networks.createTitle")}</ui.DialogTitle>
                    <ui.DialogDescription>{t("networks.createBody")}</ui.DialogDescription>
                </ui.DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <Field id="network-name" label={`${t("networks.name")} *`}>
                        <ui.Input
                            id="network-name"
                            value={name}
                            maxLength={40}
                            placeholder={t("networks.namePlaceholder")}
                            onChange={(event) => {
                                const next = event.target.value;
                                if (ssid === "" || ssid === name.slice(0, 32)) {
                                    setSsid(next.slice(0, 32));
                                }
                                setName(next);
                            }}
                        />
                    </Field>
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field
                            id="network-subnet"
                            label={`${t("networks.subnet")} *`}
                            error={subnetBad ? t("networks.badSubnet") : null}
                        >
                            <ui.Input
                                id="network-subnet"
                                value={cidr}
                                className="font-mono"
                                onChange={(event) => changeCidr(event.target.value)}
                            />
                        </Field>
                        <Field
                            id="network-router"
                            label={`${t("networks.routerAddress")} *`}
                            error={routerBad ? t("networks.badRouter") : null}
                        >
                            <ui.Input
                                id="network-router"
                                value={routerAddress}
                                className="font-mono"
                                onChange={(event) => {
                                    setRouterTouched(true);
                                    setRouterAddress(event.target.value);
                                }}
                            />
                        </Field>
                    </div>
                    {!subnetBad ? (
                        <p className="text-xs text-muted-foreground">{t("networks.subnetHint")}</p>
                    ) : null}
                    <Field
                        id="network-server"
                        label={`${t("networks.server")} *`}
                        error={servers.length === 0 ? t("networks.noServers") : null}
                    >
                        <ui.Select
                            value={targetId}
                            onValueChange={setTargetId}
                            placeholder={t("networks.pickServer")}
                            disabled={servers.length === 0}
                            options={servers.map((server) => ({
                                value: server.id,
                                label: server.name
                            }))}
                        />
                    </Field>
                    <Field id="network-ssid" label={`${t("networks.ssid")} *`}>
                        <ui.Input
                            id="network-ssid"
                            value={ssid}
                            maxLength={32}
                            onChange={(event) => setSsid(event.target.value)}
                        />
                    </Field>
                    <AccessField t={t} value={access} onChange={setAccess} />
                    <InternetField t={t} value={internet} onChange={setInternet} />
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
                <ui.DialogFooter>
                    <ui.Button variant="ghost" size="sm" onClick={onClose}>
                        {t("networks.cancel")}
                    </ui.Button>
                    <ui.Button
                        size="sm"
                        aria-disabled={!valid || busy}
                        onClick={() => valid && !busy && onCreate(input)}
                    >
                        {busy ? <Loader2 className="animate-spin" /> : null}
                        {t("networks.create")}
                    </ui.Button>
                </ui.DialogFooter>
            </ui.DialogContent>
        </ui.Dialog>
    );
}

function EditDialog({
    t,
    network,
    busy,
    error,
    onClose,
    onSave
}: {
    t: Translate;
    network: NetworkView;
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSave: (change: unknown) => void;
}) {
    const [name, setName] = useState(network.name);
    const [access, setAccess] = useState(network.access);
    const [internet, setInternet] = useState(network.internet);
    const clean = name.trim();
    const dirty =
        clean !== network.name || access !== network.access || internet !== network.internet;
    const valid = clean.length > 0 && dirty;

    return (
        <ui.Dialog open onOpenChange={(open) => !open && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{t("networks.editTitle")}</ui.DialogTitle>
                    <ui.DialogDescription>{t("networks.editBody")}</ui.DialogDescription>
                </ui.DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <Field id="network-edit-name" label={`${t("networks.name")} *`}>
                        <ui.Input
                            id="network-edit-name"
                            value={name}
                            maxLength={40}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </Field>
                    <AccessField t={t} value={access} onChange={setAccess} />
                    <InternetField t={t} value={internet} onChange={setInternet} />
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
                <ui.DialogFooter>
                    <ui.Button variant="ghost" size="sm" onClick={onClose}>
                        {t("networks.cancel")}
                    </ui.Button>
                    <ui.Button
                        size="sm"
                        aria-disabled={!valid || busy}
                        onClick={() =>
                            valid &&
                            !busy &&
                            onSave({ id: network.id, name: clean, access, internet })
                        }
                    >
                        {busy ? <Loader2 className="animate-spin" /> : null}
                        {t("networks.save")}
                    </ui.Button>
                </ui.DialogFooter>
            </ui.DialogContent>
        </ui.Dialog>
    );
}
