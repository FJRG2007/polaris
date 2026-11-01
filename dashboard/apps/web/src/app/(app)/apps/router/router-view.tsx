"use client";

/**
 * A machine as the network's router: its ports, its lines in the order they are
 * tried, the networks behind it, the ports open from the internet and who is
 * connected. The page paints at once; only the regions that wait on the machine show
 * a skeleton. Nothing changes on the machine until Apply.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import * as actions from "./actions";
import { LanDialog } from "./lan-dialog";
import { ForwardDialog } from "./forward-dialog";
import { useVpnRead } from "../vpn/use-vpn-read";
import type { RouterView } from "@/lib/router/service";
import type { RouterReading } from "@/lib/router/read";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import {
    deviceOf,
    isPortName,
    routerPlanSchema,
    MAX_CLIENTS,
    MAX_LANS,
    MAX_WANS,
    type RouterLan,
    type RouterPlan
} from "@/lib/router/plan";

const EMPTY_PLAN: RouterPlan = { wans: [], lans: [], forwards: [] };

/** Why a line of a running router carries nothing, in what the screen can see. */
function lineProblem(
    wan: RouterPlan["wans"][number],
    reading: { running: boolean; ports: readonly { name: string; hasGateway: boolean }[] } | null
): "lineMissing" | "lineNoWay" | null {
    if (!reading?.running) return null;
    const port = reading.ports.find(({ name }) => name === deviceOf(wan));
    if (!port) return "lineMissing";
    return port.hasGateway ? null : "lineNoWay";
}
/** How often a running router is read again while the page is open. */
const STATUS_POLL_MS = 15_000;

/** How many connected devices are drawn at once: a search narrows the rest. */
const CLIENTS_SHOWN = 200;
/** Every refusal the schema words, most useful first. */
const PROBLEMS = [
    "noLine",
    "noNetwork",
    "badPort",
    "badVlan",
    "sharedPort",
    "overlap",
    "samePort",
    "outside"
] as const;

type Translate = ReturnType<typeof useTranslations>;

export function RouterSection() {
    const t = useTranslations("router");
    const list = useVpnRead("router:machines", actions.listMachinesAction, t("errors.generic"));
    const machines = list.data?.machines ?? null;
    const [hostId, setHostId] = useState("");
    const usable = machines?.filter(({ root }) => root) ?? [];
    const chosen = hostId || usable[0]?.id || "";

    return (
        <div className="flex flex-col gap-4">
            <p className="min-w-0 text-sm text-muted-foreground">{t("intro")}</p>
            {list.error ? <p className="text-sm text-danger">{list.error}</p> : null}
            {machines === null ? (
                <ui.Skeleton className="h-8 w-64 max-w-full" />
            ) : machines.length === 0 ? (
                <ui.EmptyState
                    title={t("noMachines")}
                    description={t("noMachinesBody")}
                    action={
                        <ui.Button asChild size="sm">
                            <Link href="/apps/servers">{t("addMachine")}</Link>
                        </ui.Button>
                    }
                />
            ) : (
                <>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{t("machine")}</span>
                        <ui.Select
                            className="w-64 max-w-full"
                            aria-label={t("machine")}
                            value={chosen}
                            placeholder={t("pickMachine")}
                            onValueChange={setHostId}
                            options={machines.map(({ id, name, root }) => ({
                                value: id,
                                label: name,
                                disabled: !root
                            }))}
                        />
                    </div>
                    {usable.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("noRoot")}</p>
                    ) : null}
                    {chosen ? (
                        <RouterEditor
                            key={chosen}
                            hostId={chosen}
                            privateNetworks={list.data?.privateNetworks ?? []}
                        />
                    ) : null}
                </>
            )}
        </div>
    );
}

function RouterEditor({
    hostId,
    privateNetworks
}: {
    hostId: string;
    privateNetworks: actions.MachinesAnswer["privateNetworks"];
}) {
    const t = useTranslations("router");
    const load = useCallback(() => actions.readRouterAction({ hostId }), [hostId]);
    const read = useVpnRead<RouterView>(`router:${hostId}`, load, t("errors.generic"));
    const [draft, setDraft] = useState<RouterPlan | null>(null);
    const [editingLan, setEditingLan] = useState<RouterLan | "new" | null>(null);
    const [addingForward, setAddingForward] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const { poll } = read;

    useEffect(() => {
        const timer = setInterval(poll, STATUS_POLL_MS);
        return () => clearInterval(timer);
    }, [poll]);

    const saved = read.data?.plan ?? null;
    const reading = read.data?.reading ?? null;
    const plan = draft ?? saved ?? EMPTY_PLAN;
    const ports = useMemo(
        () => reading?.ports.map(({ name }) => name).filter(isPortName) ?? [],
        [reading]
    );
    const portOptions = ports.map((name) => ({ value: name, label: name }));
    const changed = JSON.stringify(plan) !== JSON.stringify(saved ?? EMPTY_PLAN);
    const check = routerPlanSchema.safeParse(plan);
    const problem = check.success
        ? undefined
        : (PROBLEMS.find((one) => check.error.issues.some(({ message }) => message === one)) ??
          "invalid");
    const unanswered = read.data !== null || read.error !== null;

    const change = (next: Partial<RouterPlan>) => setDraft({ ...plan, ...next });

    function moveWan(at: number, by: number): void {
        const wans = [...plan.wans];
        const [wan] = wans.splice(at, 1);
        if (!wan) return;
        wans.splice(at + by, 0, wan);
        change({ wans });
    }

    function saveLan(lan: RouterLan): void {
        const known = plan.lans.some(({ id }) => id === lan.id);
        change({
            lans: known
                ? plan.lans.map((one) => (one.id === lan.id ? lan : one))
                : [...plan.lans, lan]
        });
        setEditingLan(null);
    }

    function run(action: () => Promise<{ error?: string }>, done: () => void): void {
        setError(null);
        startTransition(async () => {
            const result = await action().catch(() => ({ error: t("errors.generic") }));
            read.reload();
            if (result.error !== undefined) {
                setError(result.error);
                return;
            }
            done();
        });
    }

    return (
        <div className="flex min-w-0 flex-col gap-4">
            {read.error ? <p className="text-sm text-danger">{read.error}</p> : null}
            <Status t={t} view={read.data} unanswered={unanswered} onRefresh={read.reload} />

            <Part title={t("ports")} hint={t("portsHint")}>
                {reading === null ? (
                    <Unread t={t} unanswered={unanswered} height="h-16" />
                ) : (
                    <ul className="flex flex-col gap-1">
                        {reading.ports.map((port) => (
                            <li
                                key={port.name}
                                className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
                            >
                                <span className="font-mono">{port.name}</span>
                                <ui.Badge variant={port.up ? "success" : "neutral"}>
                                    {port.up ? t("connected") : t("noCable")}
                                </ui.Badge>
                                <span className="min-w-0 truncate text-muted-foreground">
                                    {port.addresses.join(", ")}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Part>

            <Part
                title={t("lines")}
                hint={t("linesHint")}
                action={
                    <ui.Button
                        size="sm"
                        variant="secondary"
                        disabled={plan.wans.length >= MAX_WANS || ports.length === 0}
                        onClick={() =>
                            change({
                                wans: [...plan.wans, { interface: ports[0] ?? "", vlan: null }]
                            })
                        }
                    >
                        <Plus />
                        {t("addLine")}
                    </ui.Button>
                }
            >
                <ul className="flex flex-col gap-2">
                    {plan.wans.map((wan, at) => (
                        <li key={at} className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="w-5 text-sm text-muted-foreground">{at + 1}</span>
                            <ui.Select
                                className="w-44"
                                aria-label={t("port")}
                                value={wan.interface}
                                options={portOptions}
                                onValueChange={(name) =>
                                    change({
                                        wans: plan.wans.map((one, index) =>
                                            index === at ? { ...one, interface: name } : one
                                        )
                                    })
                                }
                            />
                            <VlanInput
                                t={t}
                                value={wan.vlan}
                                onChange={(vlan) =>
                                    change({
                                        wans: plan.wans.map((one, index) =>
                                            index === at ? { ...one, vlan } : one
                                        )
                                    })
                                }
                            />
                            <IconButton
                                label={t("moveUp")}
                                disabled={at === 0}
                                onClick={() => moveWan(at, -1)}
                            >
                                <ArrowUp />
                            </IconButton>
                            <IconButton
                                label={t("moveDown")}
                                disabled={at === plan.wans.length - 1}
                                onClick={() => moveWan(at, 1)}
                            >
                                <ArrowDown />
                            </IconButton>
                            <IconButton
                                label={t("remove")}
                                onClick={() =>
                                    change({ wans: plan.wans.filter((_, index) => index !== at) })
                                }
                            >
                                <Trash2 />
                            </IconButton>
                            {lineProblem(wan, reading) ? (
                                <span className="w-full text-xs text-warning">
                                    {t(lineProblem(wan, reading) ?? "lineNoWay")}
                                </span>
                            ) : null}
                        </li>
                    ))}
                </ul>
            </Part>

            <Part
                title={t("networks")}
                hint={t("networksHint")}
                action={
                    <ui.Button
                        size="sm"
                        variant="secondary"
                        disabled={plan.lans.length >= MAX_LANS || ports.length === 0}
                        onClick={() => setEditingLan("new")}
                    >
                        <Plus />
                        {t("addNetwork")}
                    </ui.Button>
                }
            >
                <ul className="flex flex-col gap-2">
                    {plan.lans.map((lan) => (
                        <li key={lan.id} className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="min-w-0 truncate text-sm font-medium" title={lan.name}>
                                {lan.name}
                            </span>
                            <span className="font-mono text-xs text-muted-foreground">
                                {lan.cidr}
                            </span>
                            <span className="font-mono text-xs text-muted-foreground">
                                {lan.vlan === null
                                    ? lan.interface
                                    : t("onVlan", { port: lan.interface, vlan: lan.vlan })}
                            </span>
                            {lan.internet ? null : (
                                <ui.Badge variant="neutral">{t("noInternet")}</ui.Badge>
                            )}
                            {lan.isolated ? (
                                <ui.Badge variant="neutral">{t("isolated")}</ui.Badge>
                            ) : null}
                            <IconButton label={t("edit")} onClick={() => setEditingLan(lan)}>
                                <Pencil />
                            </IconButton>
                            <IconButton
                                label={t("remove")}
                                onClick={() =>
                                    change({ lans: plan.lans.filter(({ id }) => id !== lan.id) })
                                }
                            >
                                <Trash2 />
                            </IconButton>
                        </li>
                    ))}
                </ul>
            </Part>

            <Part
                title={t("forwards")}
                hint={t("forwardsHint")}
                action={
                    <ui.Button
                        size="sm"
                        variant="secondary"
                        disabled={plan.lans.length === 0}
                        onClick={() => setAddingForward(true)}
                    >
                        <Plus />
                        {t("addForward")}
                    </ui.Button>
                }
            >
                <ul className="flex flex-col gap-1">
                    {plan.forwards.map((forward, at) => (
                        <li key={at} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                            <span className="font-mono">
                                {forward.protocol} {forward.port} {"->"} {forward.address}:
                                {forward.toPort}
                            </span>
                            <IconButton
                                label={t("remove")}
                                onClick={() =>
                                    change({
                                        forwards: plan.forwards.filter((_, index) => index !== at)
                                    })
                                }
                            >
                                <Trash2 />
                            </IconButton>
                        </li>
                    ))}
                </ul>
            </Part>

            <Part title={t("clients")} hint={t("clientsHint")}>
                {reading === null ? (
                    <Unread t={t} unanswered={unanswered} height="h-10" />
                ) : (
                    <ClientList t={t} clients={reading.clients} />
                )}
            </Part>

            {problem && changed ? (
                <p className="text-sm text-danger">
                    {problem === "invalid" ? t("errors.invalid") : t(`problems.${problem}`)}
                </p>
            ) : null}
            {error && !confirming && !removing ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
                {saved ? (
                    <ui.Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
                        {t("stopRouter")}
                    </ui.Button>
                ) : null}
                {changed ? (
                    <ui.Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                        {t("discard")}
                    </ui.Button>
                ) : null}
                <ui.Button
                    size="sm"
                    disabled={!check.success || !changed || pending}
                    onClick={() => setConfirming(true)}
                >
                    {t("apply")}
                </ui.Button>
            </div>

            {editingLan ? (
                <LanDialog
                    lan={editingLan === "new" ? null : editingLan}
                    taken={plan.lans}
                    ports={ports}
                    privateNetworks={privateNetworks}
                    onClose={() => setEditingLan(null)}
                    onSave={saveLan}
                />
            ) : null}
            {addingForward ? (
                <ForwardDialog
                    lans={plan.lans}
                    onClose={() => setAddingForward(false)}
                    onSave={(forward) => {
                        change({ forwards: [...plan.forwards, forward] });
                        setAddingForward(false);
                    }}
                />
            ) : null}
            <ui.Dialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
                <ui.DialogContent>
                    <ui.DialogHeader>
                        <ui.DialogTitle>{t("applyTitle")}</ui.DialogTitle>
                        <ui.DialogDescription>{t("applyBody")}</ui.DialogDescription>
                    </ui.DialogHeader>
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <ui.DialogFooter>
                        <ui.Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => setConfirming(false)}
                        >
                            {t("cancel")}
                        </ui.Button>
                        <ui.Button
                            size="sm"
                            disabled={pending}
                            onClick={() =>
                                run(
                                    () => actions.applyRouterAction({ hostId, plan }),
                                    () => {
                                        setDraft(null);
                                        setConfirming(false);
                                    }
                                )
                            }
                        >
                            {pending ? <Loader2 className="animate-spin" /> : null}
                            {pending ? t("applying") : t("apply")}
                        </ui.Button>
                    </ui.DialogFooter>
                </ui.DialogContent>
            </ui.Dialog>
            <ui.ConfirmDeleteDialog
                open={removing}
                onOpenChange={setRemoving}
                kind={t("kind")}
                name={t("kind")}
                requireTyping={false}
                title={t("stopTitle")}
                description={t("stopBody")}
                confirmLabel={t("stopRouter")}
                pending={pending}
                error={error}
                onConfirm={() =>
                    run(
                        () => actions.removeRouterAction({ hostId }),
                        () => {
                            setDraft(null);
                            setRemoving(false);
                        }
                    )
                }
            />
        </div>
    );
}

/** A region waiting on the machine: a skeleton while it may still answer, a sentence
 *  once it has not. */
function Unread({ t, unanswered, height }: { t: Translate; unanswered: boolean; height: string }) {
    if (!unanswered) return <ui.Skeleton className={`${height} w-full`} />;
    return <p className="text-sm text-muted-foreground">{t("cannotRead")}</p>;
}

function ClientList({ t, clients }: { t: Translate; clients: RouterReading["clients"] }) {
    const [search, setSearch] = useState("");
    if (clients.length === 0) {
        return <p className="text-sm text-muted-foreground">{t("noClients")}</p>;
    }
    const wanted = search.trim().toLowerCase();
    const found = wanted
        ? clients.filter(({ address, mac, name }) =>
              [address, mac, name ?? ""].some((text) => text.toLowerCase().includes(wanted))
          )
        : clients;
    return (
        <div className="flex min-w-0 flex-col gap-2">
            {clients.length > CLIENTS_SHOWN ? (
                <ui.Input
                    className="max-w-64"
                    aria-label={t("searchClients")}
                    placeholder={t("searchClients")}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                />
            ) : null}
            <ul className="flex flex-col gap-1">
                {found.slice(0, CLIENTS_SHOWN).map((client) => (
                    <li
                        key={`${client.mac}-${client.address}`}
                        className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
                    >
                        <span className="font-mono">{client.address}</span>
                        <span className="min-w-0 truncate">{client.name ?? t("unnamed")}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                            {client.mac}
                        </span>
                    </li>
                ))}
            </ul>
            {found.length > CLIENTS_SHOWN ? (
                <p className="text-xs text-muted-foreground">
                    {t("clientsLimited", { shown: CLIENTS_SHOWN, total: found.length })}
                </p>
            ) : null}
            {clients.length >= MAX_CLIENTS ? (
                <p className="text-xs text-muted-foreground">
                    {t("clientsCapped", { max: MAX_CLIENTS })}
                </p>
            ) : null}
        </div>
    );
}

function Status({
    t,
    view,
    unanswered,
    onRefresh
}: {
    t: Translate;
    view: RouterView | null;
    unanswered: boolean;
    onRefresh: () => void;
}) {
    if (view === null) return unanswered ? null : <ui.Skeleton className="h-8 w-full" />;
    const { reading, plan } = view;
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            {reading === null ? (
                <ui.Badge variant="warning">{t("notAnswering")}</ui.Badge>
            ) : plan === null ? (
                <ui.Badge variant="neutral">{t("notRouter")}</ui.Badge>
            ) : reading.running ? (
                <ui.Badge variant="success">{t("running")}</ui.Badge>
            ) : (
                <ui.Badge variant="danger">{t("stopped")}</ui.Badge>
            )}
            {reading?.activeWan ? (
                <span className="text-muted-foreground">
                    {t("usingLine", { line: reading.activeWan })}
                </span>
            ) : null}
            {reading?.rolledBack ? <ui.Badge variant="warning">{t("wentBack")}</ui.Badge> : null}
            <IconButton label={t("refresh")} onClick={onRefresh}>
                <RefreshCw />
            </IconButton>
        </div>
    );
}

function Part({
    title,
    hint,
    action,
    children
}: {
    title: string;
    hint: string;
    action?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                    <h2 className="text-sm font-medium">{title}</h2>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

function IconButton({
    label,
    disabled,
    onClick,
    children
}: {
    label: string;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <ui.Button
            size="icon"
            variant="ghost"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
        >
            {children}
        </ui.Button>
    );
}

export function VlanInput({
    t,
    value,
    onChange
}: {
    t: Translate;
    value: number | null;
    onChange: (vlan: number | null) => void;
}) {
    return (
        <ui.Input
            className="w-24"
            inputMode="numeric"
            aria-label={t("vlan")}
            placeholder={t("vlan")}
            value={value ?? ""}
            onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, "");
                onChange(digits === "" ? null : Number(digits));
            }}
        />
    );
}
