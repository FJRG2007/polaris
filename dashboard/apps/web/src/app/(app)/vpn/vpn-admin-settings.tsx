"use client";

/** The VPN's settings: the machines people connect through, and who may use them. */

import Link from "next/link";
import * as ui from "@polaris/ui";
import { NodePlaceDialog } from "./node-place-dialog";
import { NodeReachStatus } from "./node-reach-status";
import { countryName } from "@/components/map/country-name";
import { dropServerOptions, ServerPicker } from "@/components/server-picker";
import { useVpnRead } from "./use-vpn-read";
import * as actions from "./connect-actions";
import { setVpnMeshAction } from "./actions";
import { VpnOverviewSection } from "./overview";
import { useState, useTransition } from "react";
import { MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { DEFAULT_DEVICE_LIMIT, DEFAULT_PORT, isPublicEndpoint } from "@/lib/vpn/wireguard";

type NodeRow = actions.NodesAnswer["nodes"][number];
type AccessRow = actions.NodesAnswer["access"][number];

const GIB = 1024 ** 3;

function gib(bytes: string): string {
    return (Number(bytes) / GIB).toFixed(1);
}

export function VpnAdminSettings() {
    const t = useTranslations("vpn");
    const read = useVpnRead<actions.NodesAnswer>(
        "vpn-admin",
        actions.vpnAdminAction,
        t("errors.generic")
    );
    const locale = useLocale();
    const [nodeDialog, setNodeDialog] = useState<NodeRow | "new" | null>(null);
    const [placing, setPlacing] = useState<NodeRow | null>(null);
    const [accessDialog, setAccessDialog] = useState<AccessRow | "new" | null>(null);
    const [removing, setRemoving] = useState<NodeRow | null>(null);
    const [unreachable, setUnreachable] = useState(false);
    const [removeError, setRemoveError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const data = read.data;

    function run(work: () => Promise<{ error?: string }>): void {
        setError(null);
        startTransition(async () => {
            const result = await work();
            if (result.error !== undefined) setError(result.error);
            read.reload();
        });
    }

    function closeRemoval(): void {
        setRemoving(null);
        setUnreachable(false);
        setRemoveError(null);
    }

    function remove(node: NodeRow): void {
        setRemoveError(null);
        startTransition(async () => {
            const result = await actions.removeVpnNodeAction({ id: node.id, anyway: unreachable });
            if (result.error === undefined) {
                dropServerOptions();
                closeRemoval();
                read.reload();
                return;
            }
            setRemoveError(result.error);
            if ("unreachable" in result) setUnreachable(true);
        });
    }

    function done(close: () => void): () => void {
        return () => {
            close();
            read.reload();
        };
    }

    const mine = new Set(data?.mine);
    const canAdd = data?.canAdd ?? false;

    return (
        <div className="flex min-w-0 flex-col gap-6">
            {read.error ? <p className="text-sm text-danger">{read.error}</p> : null}
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            <section className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">{t("nodes.title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("nodes.hint")}</p>
                    </div>
                    <ui.Button
                        size="sm"
                        variant="secondary"
                        disabled={!canAdd}
                        title={!canAdd ? t("nodes.noMachines") : undefined}
                        onClick={() => setNodeDialog("new")}
                    >
                        <Plus />
                        {t("nodes.add")}
                    </ui.Button>
                </div>
                {data === null ? (
                    <ui.Skeleton className="h-12 w-full" />
                ) : data.nodes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("nodes.empty")}</p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {data.nodes.map((node) => (
                            <li
                                key={node.id}
                                className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
                            >
                                <span className="min-w-0 truncate font-medium" title={node.name}>
                                    {node.name}
                                </span>
                                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                                    {node.endpoint}:{node.port}
                                </span>
                                <ui.Badge variant="neutral">
                                    {node.exit === "tor"
                                        ? t("nodes.exits.tor")
                                        : t("nodes.exits.direct")}
                                </ui.Badge>
                                <span className="text-xs text-muted-foreground">
                                    {t("nodes.devices", { count: node._count.peers })}
                                </span>
                                {node.exit === "tor" ? null : (
                                    <ui.Button
                                        size="sm"
                                        variant="ghost"
                                        className="min-w-0"
                                        title={
                                            mine.has(node.hostId)
                                                ? t("place.set")
                                                : t("nodes.notYours")
                                        }
                                        disabled={!mine.has(node.hostId)}
                                        onClick={() => setPlacing(node)}
                                    >
                                        <MapPin />
                                        <span className="min-w-0 truncate">
                                            {node.country
                                                ? [node.city, countryName(node.country, locale)]
                                                      .filter(Boolean)
                                                      .join(", ")
                                                : t("place.unknown")}
                                        </span>
                                    </ui.Button>
                                )}
                                <ui.Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("nodes.edit")}
                                    title={
                                        mine.has(node.hostId)
                                            ? t("nodes.edit")
                                            : t("nodes.notYours")
                                    }
                                    disabled={!mine.has(node.hostId)}
                                    onClick={() => setNodeDialog(node)}
                                >
                                    <Pencil />
                                </ui.Button>
                                <ui.Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("nodes.remove")}
                                    title={
                                        mine.has(node.hostId)
                                            ? t("nodes.remove")
                                            : t("nodes.notYours")
                                    }
                                    disabled={!mine.has(node.hostId)}
                                    onClick={() => setRemoving(node)}
                                >
                                    <Trash2 />
                                </ui.Button>
                                {node.publicKey && !node.proxyHost ? (
                                    <BrowserRouteIssue
                                        node={node}
                                        owned={mine.has(node.hostId)}
                                        pending={pending}
                                        onEdit={() => setNodeDialog(node)}
                                        onRetry={() =>
                                            run(() =>
                                                actions.retryVpnBrowserAction({ id: node.id })
                                            )
                                        }
                                    />
                                ) : null}
                                <NodeReachStatus node={node} />
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            <section className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">{t("people.title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("people.hint")}</p>
                    </div>
                    <ui.Button size="sm" variant="secondary" onClick={() => setAccessDialog("new")}>
                        <Plus />
                        {t("people.add")}
                    </ui.Button>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("people.open")}</p>
                        <p className="text-xs text-muted-foreground">
                            {t("people.openHint", { count: DEFAULT_DEVICE_LIMIT })}
                        </p>
                    </div>
                    <ui.Switch
                        aria-label={t("people.open")}
                        checked={data?.open ?? false}
                        disabled={data === null || pending}
                        onChange={(open) => run(() => actions.setVpnOpenAccessAction(open))}
                    />
                </div>
                {data?.access.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("people.empty")}</p>
                ) : null}
                <ul className="flex flex-col gap-2">
                    {data?.access.map((row) => (
                        <li
                            key={row.userId}
                            className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
                        >
                            <span className="min-w-0 truncate font-medium" title={row.user.email}>
                                {row.user.name}
                            </span>
                            <span className="min-w-0 truncate text-xs text-muted-foreground">
                                {row.user.email}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {t("nodes.devices", { count: row.deviceLimit })}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {row.dataLimitGb !== null
                                    ? t("people.gb", {
                                          used: gib(row.usedBytes),
                                          count: row.dataLimitGb
                                      })
                                    : t("people.used", { used: gib(row.usedBytes) })}
                            </span>
                            {row.suspended ? (
                                <ui.Badge variant="warning">{t("people.suspended")}</ui.Badge>
                            ) : null}
                            <ui.Button
                                size="icon"
                                variant="ghost"
                                aria-label={t("people.edit")}
                                title={t("people.edit")}
                                onClick={() => setAccessDialog(row)}
                            >
                                <Pencil />
                            </ui.Button>
                            <ui.Button
                                size="icon"
                                variant="ghost"
                                aria-label={t("people.remove")}
                                title={t("people.remove")}
                                disabled={pending}
                                onClick={() => run(() => actions.revokeVpnAccessAction(row.userId))}
                            >
                                <Trash2 />
                            </ui.Button>
                        </li>
                    ))}
                </ul>
            </section>
            <section className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">{t("mesh.title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("mesh.hint")}</p>
                    </div>
                    <ui.Switch
                        aria-label={t("mesh.title")}
                        checked={data?.mesh ?? false}
                        disabled={data === null || pending}
                        onChange={(on) => run(() => setVpnMeshAction(on))}
                    />
                </div>
                {data?.mesh ? <VpnOverviewSection isAdmin /> : null}
            </section>
            {nodeDialog ? (
                <NodeDialog
                    node={nodeDialog === "new" ? null : nodeDialog}
                    onClose={() => setNodeDialog(null)}
                    onDone={done(() => setNodeDialog(null))}
                />
            ) : null}
            {placing ? (
                <NodePlaceDialog
                    node={placing}
                    onClose={() => setPlacing(null)}
                    onDone={done(() => setPlacing(null))}
                />
            ) : null}
            {accessDialog ? (
                <AccessDialog
                    nodes={data?.nodes ?? []}
                    row={accessDialog === "new" ? null : accessDialog}
                    onClose={() => setAccessDialog(null)}
                    onDone={done(() => setAccessDialog(null))}
                />
            ) : null}
            {removing ? (
                <ui.ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && closeRemoval()}
                    name={removing.name}
                    kind={t("nodes.removeKind")}
                    requireTyping={removing._count.peers > 0}
                    description={unreachable ? t("nodes.unreachableBody") : t("nodes.removeBody")}
                    confirmLabel={unreachable ? t("nodes.removeAnyway") : t("nodes.remove")}
                    error={removeError}
                    pending={pending}
                    onConfirm={() => remove(removing)}
                />
            ) : null}
        </div>
    );
}

/**
 * Why browsers cannot use a server yet, and the one thing that fixes it: setting up
 * the machine's edge on its own page, a public address in the server's settings, or
 * simply trying again. Every case also offers to try again, since that is what
 * picks up a fix made somewhere else.
 */
function BrowserRouteIssue({
    node,
    owned,
    pending,
    onEdit,
    onRetry
}: {
    node: NodeRow;
    owned: boolean;
    pending: boolean;
    onEdit: () => void;
    onRetry: () => void;
}) {
    const t = useTranslations("vpn");
    const issue =
        node.proxyIssue === "edge" || node.proxyIssue === "address" ? node.proxyIssue : "failed";
    return (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 text-xs">
            <ui.Badge variant="warning">{t("nodes.browser.title")}</ui.Badge>
            <span className="min-w-0 text-muted-foreground">{t(`nodes.browser.${issue}`)}</span>
            {owned && issue === "edge" ? (
                <Link
                    href={`/apps/servers/${encodeURIComponent(node.hostId)}`}
                    className={ui.buttonVariants({ size: "sm", variant: "secondary" })}
                >
                    {t("nodes.browser.setUpEdge")}
                </Link>
            ) : null}
            {owned && issue === "address" ? (
                <ui.Button size="sm" variant="secondary" onClick={onEdit}>
                    {t("nodes.browser.editAddress")}
                </ui.Button>
            ) : null}
            {owned ? (
                <ui.Button size="sm" variant="ghost" disabled={pending} onClick={onRetry}>
                    {pending ? t("nodes.browser.retrying") : t("nodes.browser.retry")}
                </ui.Button>
            ) : null}
        </div>
    );
}

/** A node runs on a server Polaris is root on, and only one node per server. */
const NODE_SERVERS = { root: true, withoutVpnNode: true } as const;

function NodeDialog({
    node,
    onClose,
    onDone
}: {
    node: NodeRow | null;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useTranslations("vpn");
    const [hostId, setHostId] = useState<string | null>(null);
    const [name, setName] = useState(node?.name ?? "");
    const [endpoint, setEndpoint] = useState(node?.endpoint ?? "");
    const [port, setPort] = useState(String(node?.port ?? DEFAULT_PORT));
    const [exit, setExit] = useState(node?.exit === "tor" ? "tor" : "direct");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const ready =
        (node !== null || hostId !== null) &&
        name.trim() !== "" &&
        endpoint.trim() !== "" &&
        port !== "";

    function save(): void {
        if (!ready || pending) return;
        setError(null);
        const fields = { name, endpoint, port: Number(port), exit };
        startTransition(async () => {
            const result = node
                ? await actions.updateVpnNodeAction({ ...fields, id: node.id })
                : await actions.addVpnNodeAction({ ...fields, hostId: hostId ?? "" });
            if (result.error !== undefined) setError(result.error);
            else {
                dropServerOptions();
                onDone();
            }
        });
    }

    const busy = node ? t("nodes.saving") : t("nodes.adding");
    const idle = node ? t("nodes.save") : t("nodes.add");

    return (
        <ui.Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{node ? t("nodes.edit") : t("nodes.add")}</ui.DialogTitle>
                    <ui.DialogDescription>
                        {node ? t("nodes.editBody") : t("nodes.addBody")}
                    </ui.DialogDescription>
                </ui.DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    {node ? null : (
                        <ServerPicker
                            aria-label={t("nodes.machine")}
                            value={hostId}
                            filter={NODE_SERVERS}
                            onValueChange={(id, machine) => {
                                setHostId(id);
                                if (machine) {
                                    setName(machine.name.slice(0, 40));
                                    setEndpoint(machine.address);
                                }
                            }}
                        />
                    )}
                    <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                        {`${t("nodes.name")} *`}
                        <ui.Input
                            value={name}
                            maxLength={40}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
                        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                            {`${t("nodes.endpoint")} *`}
                            <ui.Input
                                className="font-mono"
                                value={endpoint}
                                onChange={(event) => setEndpoint(event.target.value)}
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                            {`${t("nodes.port")} *`}
                            <ui.Input
                                className="font-mono"
                                inputMode="numeric"
                                value={port}
                                onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))}
                            />
                        </label>
                    </div>
                    {endpoint.trim() !== "" && !isPublicEndpoint(endpoint.trim()) ? (
                        <p className="text-xs text-warning">
                            {t("nodes.privateEndpoint", { port })}
                        </p>
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            {t("nodes.portHint", { port })}
                        </p>
                    )}
                    <ui.Select
                        aria-label={t("nodes.exit")}
                        value={exit}
                        onValueChange={setExit}
                        options={[
                            { value: "direct", label: t("nodes.exits.direct") },
                            { value: "tor", label: t("nodes.exits.tor") }
                        ]}
                    />
                    {exit === "tor" ? (
                        <p className="text-xs text-muted-foreground">{t("nodes.torHint")}</p>
                    ) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
                <ui.DialogFooter>
                    <ui.Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
                        {t("connect.cancel")}
                    </ui.Button>
                    <ui.Button size="sm" aria-disabled={!ready || pending} onClick={save}>
                        {pending ? busy : idle}
                    </ui.Button>
                </ui.DialogFooter>
            </ui.DialogContent>
        </ui.Dialog>
    );
}

function AccessDialog({
    nodes,
    row,
    onClose,
    onDone
}: {
    nodes: readonly NodeRow[];
    row: AccessRow | null;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useTranslations("vpn");
    const [email, setEmail] = useState(row?.user.email ?? "");
    const [devices, setDevices] = useState(String(row?.deviceLimit ?? DEFAULT_DEVICE_LIMIT));
    const [gb, setGb] = useState(row?.dataLimitGb == null ? "" : String(row.dataLimitGb));
    const [until, setUntil] = useState(
        row?.expiresAt ? new Date(row.expiresAt).toISOString().slice(0, 10) : ""
    );
    const [chosen, setChosen] = useState<readonly string[]>(row?.nodes ?? []);
    const [suspended, setSuspended] = useState(row?.suspended ?? false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const ready = email.trim() !== "" && devices !== "";

    function toggle(id: string, on: boolean): void {
        setChosen((list) => (on ? [...list, id] : list.filter((one) => one !== id)));
    }

    function save(): void {
        if (!ready || pending) return;
        setError(null);
        startTransition(async () => {
            const result = await actions.grantVpnAccessAction({
                email,
                nodes: chosen,
                deviceLimit: Number(devices),
                dataLimitGb: gb === "" ? null : Number(gb),
                expiresAt: until === "" ? null : until,
                suspended
            });
            if (result.error !== undefined) setError(result.error);
            else onDone();
        });
    }

    return (
        <ui.Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{row ? t("people.edit") : t("people.add")}</ui.DialogTitle>
                    <ui.DialogDescription>
                        {row ? t("people.editBody") : t("people.addBody")}
                    </ui.DialogDescription>
                </ui.DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                        {`${t("people.email")} *`}
                        <ui.Input
                            type="email"
                            value={email}
                            readOnly={row !== null}
                            onChange={(event) => setEmail(event.target.value)}
                        />
                    </label>
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
                        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                            {`${t("people.deviceLimit")} *`}
                            <ui.Input
                                inputMode="numeric"
                                value={devices}
                                onChange={(event) =>
                                    setDevices(event.target.value.replace(/\D/g, ""))
                                }
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                            {t("people.dataLimit")}
                            <ui.Input
                                inputMode="numeric"
                                value={gb}
                                onChange={(event) => setGb(event.target.value.replace(/\D/g, ""))}
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                            {t("people.until")}
                            <ui.Input
                                type="date"
                                value={until}
                                onChange={(event) => setUntil(event.target.value)}
                            />
                        </label>
                    </div>
                    {nodes.length > 0 ? (
                        <fieldset className="flex min-w-0 flex-col gap-1">
                            <legend className="text-sm font-medium">{t("people.nodes")}</legend>
                            <p className="text-xs text-muted-foreground">
                                {chosen.length === 0 ? t("people.allNodes") : null}
                            </p>
                            {nodes.map((node) => (
                                <label
                                    key={node.id}
                                    className="flex min-w-0 items-center gap-2 text-sm"
                                >
                                    <ui.Checkbox
                                        checked={chosen.includes(node.id)}
                                        onChange={(event) => toggle(node.id, event.target.checked)}
                                    />
                                    <span className="min-w-0 truncate" title={node.name}>
                                        {node.name}
                                    </span>
                                </label>
                            ))}
                        </fieldset>
                    ) : null}
                    {row ? (
                        <div className="flex min-w-0 items-center justify-between gap-3">
                            <span className="text-sm font-medium">{t("people.suspend")}</span>
                            <ui.Switch
                                aria-label={t("people.suspend")}
                                checked={suspended}
                                onChange={setSuspended}
                            />
                        </div>
                    ) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
                <ui.DialogFooter>
                    <ui.Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
                        {t("connect.cancel")}
                    </ui.Button>
                    <ui.Button size="sm" aria-disabled={!ready || pending} onClick={save}>
                        {row ? t("nodes.save") : t("people.add")}
                    </ui.Button>
                </ui.DialogFooter>
            </ui.DialogContent>
        </ui.Dialog>
    );
}
