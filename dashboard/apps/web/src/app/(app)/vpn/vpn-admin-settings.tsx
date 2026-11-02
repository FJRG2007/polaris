"use client";

/** The VPN's settings: the machines people connect through, and who may use them. */

import * as ui from "@polaris/ui";
import { useVpnRead } from "./use-vpn-read";
import * as actions from "./connect-actions";
import { VpnOverviewSection } from "./overview";
import { useState, useTransition } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DEFAULT_DEVICE_LIMIT, DEFAULT_PORT, isPublicEndpoint } from "@/lib/vpn/wireguard";

type Machine = actions.NodesAnswer["machines"][number];
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
    const [nodeDialog, setNodeDialog] = useState<NodeRow | "new" | null>(null);
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

    const used = new Set(data?.nodes.map(({ hostId }) => hostId));
    const free = data?.machines.filter(({ id, root }) => root && !used.has(id)) ?? [];

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
                        disabled={free.length === 0}
                        title={free.length === 0 ? t("nodes.noMachines") : undefined}
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
                                <ui.Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("nodes.edit")}
                                    title={t("nodes.edit")}
                                    onClick={() => setNodeDialog(node)}
                                >
                                    <Pencil />
                                </ui.Button>
                                <ui.Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("nodes.remove")}
                                    title={t("nodes.remove")}
                                    onClick={() => setRemoving(node)}
                                >
                                    <Trash2 />
                                </ui.Button>
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
                <div className="min-w-0">
                    <h2 className="text-sm font-medium">{t("mesh.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("mesh.hint")}</p>
                </div>
                <VpnOverviewSection isAdmin />
            </section>
            {nodeDialog ? (
                <NodeDialog
                    machines={free}
                    node={nodeDialog === "new" ? null : nodeDialog}
                    onClose={() => setNodeDialog(null)}
                    onDone={done(() => setNodeDialog(null))}
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

function NodeDialog({
    machines,
    node,
    onClose,
    onDone
}: {
    machines: readonly Machine[];
    node: NodeRow | null;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useTranslations("vpn");
    const first = machines[0];
    const [hostId, setHostId] = useState(first?.id ?? "");
    const [name, setName] = useState(node?.name ?? first?.name ?? "");
    const [endpoint, setEndpoint] = useState(node?.endpoint ?? first?.address ?? "");
    const [port, setPort] = useState(String(node?.port ?? DEFAULT_PORT));
    const [exit, setExit] = useState(node?.exit === "tor" ? "tor" : "direct");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const ready = name.trim() !== "" && endpoint.trim() !== "" && port !== "";

    function save(): void {
        if (!ready || pending) return;
        setError(null);
        const fields = { name, endpoint, port: Number(port), exit };
        startTransition(async () => {
            const result = node
                ? await actions.updateVpnNodeAction({ ...fields, id: node.id })
                : await actions.addVpnNodeAction({ ...fields, hostId });
            if (result.error !== undefined) setError(result.error);
            else onDone();
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
                        <ui.Select
                            aria-label={t("nodes.machine")}
                            value={hostId}
                            onValueChange={(id) => {
                                const machine = machines.find((one) => one.id === id);
                                setHostId(id);
                                if (machine) {
                                    setName(machine.name);
                                    setEndpoint(machine.address);
                                }
                            }}
                            options={machines.map(({ id, name: label }) => ({ value: id, label }))}
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
                        <p className="text-xs text-warning">{t("nodes.privateEndpoint", { port })}</p>
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
                                onChange={(event) => setDevices(event.target.value.replace(/\D/g, ""))}
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
                                <label key={node.id} className="flex min-w-0 items-center gap-2 text-sm">
                                    <ui.Checkbox
                                        checked={chosen.includes(node.id)}
                                        onChange={(event) => toggle(node.id, event.target.checked)}
                                    />
                                    <span className="min-w-0 truncate" title={node.name}>{node.name}</span>
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
