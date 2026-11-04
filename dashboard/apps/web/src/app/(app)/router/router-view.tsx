"use client";

/**
 * A machine as the network's router, laid out the way router consoles are: the
 * machine's state and its rollback, the ports with what rides each one, the internet
 * lines in the order they are tried, the networks behind it with their addresses,
 * the ports open from the internet and the devices holding a lease. The page paints
 * at once; only the regions that wait on the machine show a skeleton. Nothing changes
 * on the machine until Apply.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import * as actions from "./actions";
import { LanDialog } from "./lan-dialog";
import { LineDialog } from "./line-dialog";
import { formatBytes } from "@polaris/core";
import { dhcpRange } from "@/lib/vpn/networks";
import { ForwardDialog } from "./forward-dialog";
import { useVpnRead } from "../vpn/use-vpn-read";
import { HelpNote, whoIs } from "./router-field";
import { ServerPicker } from "@/components/server-picker";
import type { RouterView } from "@/lib/router/service";
import type { RouterReading } from "@/lib/router/read";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
    AlertTriangle,
    ArrowDown,
    ArrowUp,
    Loader2,
    Plus,
    Pencil,
    RefreshCw,
    Trash2
} from "lucide-react";
import {
    clashFix,
    hostCount,
    linksOf,
    networkOf,
    portClashes,
    singleWiredPort,
    withLanVlan,
    type PortClash,
    type PortLink
} from "@/lib/router/assist";
import {
    deviceOf,
    isPortName,
    lineDevice,
    modeOf,
    routerPlanSchema,
    MAX_CLIENTS,
    MAX_LANS,
    MAX_WANS,
    ROLLBACK_SECONDS,
    type RouterLan,
    type RouterPlan,
    type RouterWan
} from "@/lib/router/plan";

const EMPTY_PLAN: RouterPlan = { wans: [], lans: [], forwards: [] };

/** Why a line or network the machine is running does nothing, in what the screen can
 *  see. Only what was applied is judged: a draft has not reached the machine yet. */
function linkProblem(
    link: RouterWan,
    applied: readonly RouterWan[] | undefined,
    reading: RouterReading | null,
    isLine: boolean
): LinkProblem | null {
    if (!reading?.running) return null;
    const running = applied?.find((one) => deviceOf(one) === deviceOf(link));
    if (!running) return null;
    const port = reading.ports.find(({ name }) => name === deviceOf(running));
    if (!port) return "lineMissing";
    if (isLine && modeOf(running) === "pppoe") {
        return reading.sessions?.includes(lineDevice(running)) ? null : "sessionDown";
    }
    return isLine && !port.hasGateway ? "lineNoWay" : null;
}

/** What a running network was asked for and is not doing yet. */
function networkProblem(
    lan: RouterLan,
    applied: readonly RouterLan[] | undefined,
    reading: RouterReading | null
): LinkProblem | null {
    const missing = linkProblem(lan, applied, reading, false);
    if (missing || !reading?.running) return missing;
    const running = applied?.find((one) => one.id === lan.id);
    if (!running) return null;
    const device = deviceOf(running);
    if (running.wifi && !reading.airing?.includes(device)) return "notAiring";
    const port = reading.ports.find(({ name }) => name === device);
    if (!running.ipv6 || port?.publicAddresses?.length) return null;
    return reading.prefixClient === false ? "noPrefixClient" : "noPrefix";
}

type LinkProblem =
    "lineMissing" | "lineNoWay" | "sessionDown" | "notAiring" | "noPrefix" | "noPrefixClient";

function LinkWarning({ t, problem }: { t: Translate; problem: LinkProblem | null }) {
    if (problem === null) return null;
    return <p className="text-xs text-warning">{t(problem)}</p>;
}
/** How often a running router is read again while the page is open. */
const STATUS_POLL_MS = 15_000;

/** How many connected devices are drawn at once: a search narrows the rest. */
const CLIENTS_SHOWN = 200;
/** Every refusal the schema words, most useful first. */
const PROBLEMS = [
    "noLine",
    "noNetwork",
    "badReservation",
    "badPort",
    "badVlan",
    "badStaticLine",
    "lineSubnet",
    "badPppoe",
    "badWifi",
    "wifiVlan",
    "sharedPort",
    "overlap",
    "samePort",
    "outside"
] as const;

type Translate = ReturnType<typeof useTranslations>;

/** Making a machine a router needs root on it. */
const ROOT_ONLY = { root: true } as const;

export function RouterSection() {
    const t = useTranslations("router");
    const list = useVpnRead("router:machines", actions.listMachinesAction, t("errors.generic"));
    const start = list.data ?? null;
    const [hostId, setHostId] = useState("");
    const chosen = hostId || start?.first?.id || "";

    return (
        <div className="flex flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-1">
                <p className="min-w-0 text-sm text-muted-foreground">{t("intro")}</p>
                <HelpNote title={t("modelTitle")}>
                    <ul className="flex list-disc flex-col gap-1 pl-4">
                        <li>{t("modelLines")}</li>
                        <li>{t("modelNetworks")}</li>
                        <li>{t("modelVlans")}</li>
                        <li>{t("modelApply")}</li>
                    </ul>
                </HelpNote>
            </div>
            {list.error ? <p className="text-sm text-danger">{list.error}</p> : null}
            {start === null ? (
                <ui.Skeleton className="h-8 w-64 max-w-full" />
            ) : !start.hasMachines ? (
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
                        <ServerPicker
                            className="w-64 max-w-full"
                            aria-label={t("machine")}
                            value={chosen || null}
                            selectedLabel={
                                chosen === start.first?.id ? start.first.name : undefined
                            }
                            placeholder={t("pickMachine")}
                            filter={ROOT_ONLY}
                            onValueChange={setHostId}
                        />
                    </div>
                    {start.first === null ? (
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

/** A line being edited: its place in the order, or a new one to append. */
type LineEdit = { at: number; wan: RouterWan; isNew: boolean };

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
    const [editingLine, setEditingLine] = useState<LineEdit | null>(null);
    const [addingForward, setAddingForward] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const { poll } = read;

    useEffect(() => {
        return ui.pollWhileVisible(poll, STATUS_POLL_MS);
    }, [poll]);

    const saved = read.data?.plan ?? null;
    const reading = read.data?.reading ?? null;
    const plan = draft ?? saved ?? EMPTY_PLAN;
    const ports = useMemo(() => {
        if (!reading) return [];
        const held = saved ? [...saved.wans, ...saved.lans].map((link) => link.interface) : [];
        const present = reading.ports.map(({ name }) => name).filter(isPortName);
        return [...new Set([...present, ...held])];
    }, [reading, saved]);
    const radios = useMemo(
        () => reading?.ports.filter(({ wireless }) => wireless).map(({ name }) => name) ?? [],
        [reading]
    );
    const wired = useMemo(
        () =>
            reading?.ports
                .filter(({ wireless, name }) => !wireless && isPortName(name))
                .map(({ name }) => name) ?? [],
        [reading]
    );
    const links = linksOf(plan);
    const clashes = portClashes(plan);
    const onePort = singleWiredPort(wired);
    const changed = JSON.stringify(plan) !== JSON.stringify(saved ?? EMPTY_PLAN);
    const retryable = plan.lans.some(
        (lan) => networkProblem(lan, saved?.lans, reading) === "noPrefixClient"
    );
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

    function saveLine(edit: LineEdit, wan: RouterWan): void {
        change({
            wans: edit.isNew
                ? [...plan.wans, wan]
                : plan.wans.map((one, index) => (index === edit.at ? wan : one))
        });
        setEditingLine(null);
    }

    /** A new line starts on a port nothing rides untagged, else the first one. */
    function addLine(): void {
        const free = ports.find(
            (port) => !links.some((link) => link.port === port && link.vlan === null)
        );
        setEditingLine({
            at: plan.wans.length,
            wan: { interface: free ?? ports[0] ?? "", vlan: null },
            isNew: true
        });
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

    const lanLinks: PortLink[] =
        editingLan === "new"
            ? links
            : links.filter((link) => !(link.kind === "network" && link.key === editingLan?.id));
    const lineLinks: PortLink[] = editingLine
        ? links.filter((link) => !(link.kind === "line" && link.key === String(editingLine.at)))
        : links;

    return (
        <div className="flex min-w-0 flex-col gap-4">
            {read.error ? <p className="text-sm text-danger">{read.error}</p> : null}
            <Status t={t} view={read.data} unanswered={unanswered} onRefresh={read.reload} />

            <Part title={t("ports")} hint={t("portsHint")}>
                {reading === null ? (
                    <Unread t={t} unanswered={unanswered} height="h-16" />
                ) : (
                    <PortTable t={t} reading={reading} links={links} />
                )}
                {onePort ? <OnePortNote t={t} port={onePort} links={links} /> : null}
            </Part>

            {clashes.map((clash) => (
                <ClashNote
                    key={`${clash.port}-${clash.vlan ?? "untagged"}`}
                    t={t}
                    clash={clash}
                    fix={clashFix(plan, clash)}
                    plan={plan}
                    onFix={(lanId, vlan) => setDraft(withLanVlan(plan, lanId, vlan))}
                    onEditLine={(at) => {
                        const wan = plan.wans[at];
                        if (wan) setEditingLine({ at, wan, isNew: false });
                    }}
                />
            ))}

            <Part
                title={t("lines")}
                hint={t("linesHint")}
                action={
                    <ui.Button
                        size="sm"
                        variant="secondary"
                        disabled={plan.wans.length >= MAX_WANS || ports.length === 0}
                        onClick={addLine}
                    >
                        <Plus />
                        {t("addLine")}
                    </ui.Button>
                }
            >
                {plan.wans.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("noLines")}</p>
                ) : (
                    <Table head={[t("orderCol"), t("port"), t("vlanTag"), t("lineMode"), ""]}>
                        {plan.wans.map((wan, at) => (
                            <tr key={at} className="border-t border-border align-top">
                                <td className="py-2 pr-3 text-muted-foreground">{at + 1}</td>
                                <td className="py-2 pr-3">
                                    <span className="font-mono">{wan.interface}</span>
                                    {reading?.activeWan === lineDevice(wan) ? (
                                        <ui.Badge variant="success" className="ml-2">
                                            {t("inUse")}
                                        </ui.Badge>
                                    ) : null}
                                    <LinkWarning
                                        t={t}
                                        problem={linkProblem(wan, saved?.wans, reading, true)}
                                    />
                                </td>
                                <td className="py-2 pr-3">
                                    <VlanChip t={t} vlan={wan.vlan} />
                                </td>
                                <td className="py-2 pr-3">{t(`lineModes.${modeOf(wan)}`)}</td>
                                <td className="py-2 text-right whitespace-nowrap">
                                    <IconButton
                                        label={t("editLine")}
                                        onClick={() => setEditingLine({ at, wan, isNew: false })}
                                    >
                                        <Pencil />
                                    </IconButton>
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
                                            change({
                                                wans: plan.wans.filter((_, index) => index !== at)
                                            })
                                        }
                                    >
                                        <Trash2 />
                                    </IconButton>
                                </td>
                            </tr>
                        ))}
                    </Table>
                )}
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
                {plan.lans.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("noNetworks")}</p>
                ) : (
                    <Table
                        head={[
                            t("name"),
                            t("onCol"),
                            t("subnet"),
                            t("gatewayCol"),
                            t("dhcpCol"),
                            t("devicesCol"),
                            ""
                        ]}
                        minWidth="min-w-[52rem]"
                    >
                        {plan.lans.map((lan) => {
                            const pool = dhcpRange(lan.cidr);
                            const devices =
                                reading?.clients.filter(
                                    ({ address }) => networkOf([lan], address) !== null
                                ).length ?? null;
                            return (
                                <tr key={lan.id} className="border-t border-border align-top">
                                    <td className="max-w-0 py-2 pr-3">
                                        <button
                                            type="button"
                                            className="block max-w-full truncate text-left font-medium hover:underline"
                                            title={lan.name}
                                            onClick={() => setEditingLan(lan)}
                                        >
                                            {lan.name}
                                        </button>
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {lan.internet ? null : (
                                                <ui.Badge variant="neutral">
                                                    {t("noInternet")}
                                                </ui.Badge>
                                            )}
                                            {lan.isolated ? (
                                                <ui.Badge variant="neutral">
                                                    {t("isolated")}
                                                </ui.Badge>
                                            ) : null}
                                            {lan.wifi ? (
                                                <ui.Badge variant="neutral" title={t("wifiName")}>
                                                    {lan.wifi.ssid}
                                                </ui.Badge>
                                            ) : null}
                                            {lan.ipv6 ? (
                                                <ui.Badge variant="neutral">{t("ipv6")}</ui.Badge>
                                            ) : null}
                                        </div>
                                        <LinkWarning
                                            t={t}
                                            problem={networkProblem(lan, saved?.lans, reading)}
                                        />
                                    </td>
                                    <td className="py-2 pr-3 whitespace-nowrap">
                                        <span className="font-mono">{lan.interface}</span>{" "}
                                        <VlanChip t={t} vlan={lan.vlan} />
                                    </td>
                                    <td className="py-2 pr-3 font-mono whitespace-nowrap">
                                        {lan.cidr}
                                        <p className="font-sans text-xs text-muted-foreground">
                                            {t("subnetRoom", { count: hostCount(lan.cidr) ?? 0 })}
                                        </p>
                                    </td>
                                    <td className="py-2 pr-3 font-mono">{lan.address}</td>
                                    <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                                        {pool.first}
                                        <br />
                                        {pool.last}
                                    </td>
                                    <td className="py-2 pr-3">{devices ?? "-"}</td>
                                    <td className="py-2 text-right whitespace-nowrap">
                                        <IconButton
                                            label={t("edit")}
                                            onClick={() => setEditingLan(lan)}
                                        >
                                            <Pencil />
                                        </IconButton>
                                        <IconButton
                                            label={t("remove")}
                                            onClick={() =>
                                                change({
                                                    lans: plan.lans.filter(
                                                        ({ id }) => id !== lan.id
                                                    )
                                                })
                                            }
                                        >
                                            <Trash2 />
                                        </IconButton>
                                    </td>
                                </tr>
                            );
                        })}
                    </Table>
                )}
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
                {plan.forwards.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("noForwards")}</p>
                ) : (
                    <Table
                        head={[
                            t("protocol"),
                            t("openPort"),
                            t("toAddress"),
                            t("toPort"),
                            t("networkCol"),
                            ""
                        ]}
                    >
                        {plan.forwards.map((forward, at) => (
                            <tr key={at} className="border-t border-border">
                                <td className="py-2 pr-3 uppercase">{forward.protocol}</td>
                                <td className="py-2 pr-3 font-mono">{forward.port}</td>
                                <td className="py-2 pr-3 font-mono">{forward.address}</td>
                                <td className="py-2 pr-3 font-mono">{forward.toPort}</td>
                                <td
                                    className="max-w-0 truncate py-2 pr-3"
                                    title={networkOf(plan.lans, forward.address)?.name}
                                >
                                    {networkOf(plan.lans, forward.address)?.name ?? "-"}
                                </td>
                                <td className="py-2 text-right">
                                    <IconButton
                                        label={t("remove")}
                                        onClick={() =>
                                            change({
                                                forwards: plan.forwards.filter(
                                                    (_, index) => index !== at
                                                )
                                            })
                                        }
                                    >
                                        <Trash2 />
                                    </IconButton>
                                </td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Part>

            <Part title={t("clients")} hint={t("clientsHint")}>
                {reading === null ? (
                    <Unread t={t} unanswered={unanswered} height="h-10" />
                ) : (
                    <ClientList t={t} clients={reading.clients} lans={plan.lans} />
                )}
            </Part>

            <div className="sticky bottom-0 flex min-w-0 flex-col gap-2 border-t border-border bg-background py-3">
                {problem && changed && !(problem === "sharedPort" && clashes.length > 0) ? (
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
                    <p className="mr-auto min-w-0 text-xs text-muted-foreground">
                        {changed ? t("unsaved") : t("rollbackNote", { seconds: ROLLBACK_SECONDS })}
                    </p>
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
                        disabled={!check.success || !(changed || retryable) || pending}
                        onClick={() => setConfirming(true)}
                    >
                        {t("apply")}
                    </ui.Button>
                </div>
            </div>

            {editingLan ? (
                <LanDialog
                    lan={editingLan === "new" ? null : editingLan}
                    taken={plan.lans}
                    links={lanLinks}
                    ports={ports}
                    radios={radios}
                    wired={wired}
                    privateNetworks={privateNetworks}
                    onClose={() => setEditingLan(null)}
                    onSave={saveLan}
                />
            ) : null}
            {editingLine ? (
                <LineDialog
                    wan={editingLine.wan}
                    position={editingLine.at}
                    isNew={editingLine.isNew}
                    ports={ports}
                    links={lineLinks}
                    onClose={() => setEditingLine(null)}
                    onSave={(wan) => saveLine(editingLine, wan)}
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

/** A wide table that scrolls sideways on a phone instead of squeezing. */
function Table({
    head,
    minWidth = "min-w-[36rem]",
    children
}: {
    head: readonly string[];
    minWidth?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="min-w-0 overflow-x-auto">
            <table className={`w-full ${minWidth} text-left text-sm`}>
                <thead>
                    <tr>
                        {head.map((label, at) => (
                            <th key={at} className="pb-1 pr-3 font-normal">
                                {label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}

function VlanChip({ t, vlan }: { t: Translate; vlan: number | null }) {
    return vlan === null ? (
        <span className="text-xs text-muted-foreground">{t("untagged")}</span>
    ) : (
        <ui.Badge variant="neutral">{t("vlanChip", { vlan })}</ui.Badge>
    );
}

/** Every port the machine shows, its link, addresses, traffic and what rides it. */
function PortTable({
    t,
    reading,
    links
}: {
    t: Translate;
    reading: RouterReading;
    links: readonly PortLink[];
}) {
    return (
        <Table
            head={[t("port"), t("linkCol"), t("addressesCol"), t("carriesCol"), t("trafficCol")]}
            minWidth="min-w-[44rem]"
        >
            {reading.ports.map((port) => {
                const riding = links
                    .filter((link) => link.port === port.name)
                    .sort((a, b) => (a.vlan ?? 0) - (b.vlan ?? 0));
                return (
                    <tr key={port.name} className="border-t border-border align-top">
                        <td className="py-2 pr-3 font-mono">
                            {port.name}
                            {port.wireless ? (
                                <span className="ml-2 font-sans text-xs text-muted-foreground">
                                    {t("radio")}
                                </span>
                            ) : null}
                        </td>
                        <td className="py-2 pr-3">
                            <ui.Badge variant={port.up ? "success" : "neutral"}>
                                {port.up ? t("connected") : t("noCable")}
                            </ui.Badge>
                        </td>
                        <td className="max-w-0 py-2 pr-3 font-mono text-xs">
                            <span className="block truncate" title={port.addresses.join(", ")}>
                                {port.addresses.join(", ") || "-"}
                            </span>
                        </td>
                        <td className="py-2 pr-3">
                            {riding.length === 0 ? (
                                <span className="text-xs text-muted-foreground">
                                    {t("carriesNothing")}
                                </span>
                            ) : (
                                <ul className="flex flex-col gap-1">
                                    {riding.map((link) => (
                                        <li
                                            key={`${link.kind}-${link.key}`}
                                            className="flex min-w-0 items-center gap-2 text-xs"
                                        >
                                            <span
                                                className="min-w-0 truncate"
                                                title={whoIs(t, link)}
                                            >
                                                {link.kind === "line"
                                                    ? t("roleLine", { n: link.name })
                                                    : t("roleNetwork", { name: link.name })}
                                            </span>
                                            <VlanChip t={t} vlan={link.vlan} />
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </td>
                        <td className="py-2 pr-3 text-xs whitespace-nowrap text-muted-foreground">
                            {t("traffic", {
                                received: formatBytes(port.received),
                                sent: formatBytes(port.sent)
                            })}
                        </td>
                    </tr>
                );
            })}
        </Table>
    );
}

/** A machine with one wired port: a line and a network can only share it on a VLAN. */
function OnePortNote({
    t,
    port,
    links
}: {
    t: Translate;
    port: string;
    links: readonly PortLink[];
}) {
    const line = links.find((link) => link.kind === "line" && link.port === port);
    return (
        <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-surface p-3 text-sm">
            <p className="font-medium">{t("onePortTitle", { port })}</p>
            <p className="text-xs text-muted-foreground">
                {line ? t("onePortLine", { port }) : t("onePortBody", { port })}
            </p>
        </div>
    );
}

/** Two links on one device, named, with the change that ends it. */
function ClashNote({
    t,
    clash,
    fix,
    plan,
    onFix,
    onEditLine
}: {
    t: Translate;
    clash: PortClash;
    fix: { lanId: string; vlan: number } | null;
    plan: RouterPlan;
    onFix: (lanId: string, vlan: number) => void;
    onEditLine: (at: number) => void;
}) {
    const [first, second] = clash.links;
    if (!first || !second) return null;
    const names = { first: whoIs(t, first), second: whoIs(t, second), port: clash.port };
    const moved = fix ? plan.lans.find(({ id }) => id === fix.lanId) : undefined;
    const line = clash.links.find((link) => link.kind === "line");
    return (
        <div
            role="alert"
            className="flex min-w-0 flex-col gap-2 rounded-md border border-warning-edge bg-warning-soft p-3 text-sm text-warning-ink"
        >
            <p className="flex items-start gap-2 font-medium">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                {clash.vlan === null
                    ? t("clashUntagged", names)
                    : t("clashVlan", { ...names, vlan: clash.vlan })}
            </p>
            <p className="text-xs">{t("clashWhy")}</p>
            <div className="flex flex-wrap items-center gap-2">
                {fix && moved ? (
                    <ui.Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onFix(fix.lanId, fix.vlan)}
                    >
                        {t("clashFix", { name: moved.name, vlan: fix.vlan })}
                    </ui.Button>
                ) : null}
                {!fix && line ? (
                    <ui.Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onEditLine(Number(line.key))}
                    >
                        {t("editLine")}
                    </ui.Button>
                ) : null}
            </div>
            <p className="text-xs">
                {fix ? t("clashFixNote", { vlan: fix.vlan, port: clash.port }) : t("clashLines")}
            </p>
        </div>
    );
}

/** A region waiting on the machine: a skeleton while it may still answer, a sentence
 *  once it has not. */
function Unread({ t, unanswered, height }: { t: Translate; unanswered: boolean; height: string }) {
    if (!unanswered) return <ui.Skeleton className={`${height} w-full`} />;
    return <p className="text-sm text-muted-foreground">{t("cannotRead")}</p>;
}

function ClientList({
    t,
    clients,
    lans
}: {
    t: Translate;
    clients: RouterReading["clients"];
    lans: readonly RouterLan[];
}) {
    const [search, setSearch] = useState("");
    const format = useDisplayFormat();
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
            <Table
                head={[t("addressCol"), t("name"), t("mac"), t("networkCol"), t("leaseCol")]}
                minWidth="min-w-[40rem]"
            >
                {found.slice(0, CLIENTS_SHOWN).map((client) => (
                    <tr key={`${client.mac}-${client.address}`} className="border-t border-border">
                        <td className="py-1.5 pr-3 font-mono">{client.address}</td>
                        <td className="max-w-0 py-1.5 pr-3">
                            <span className="block truncate" title={client.name ?? undefined}>
                                {client.name ?? t("unnamed")}
                            </span>
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-xs">{client.mac}</td>
                        <td
                            className="max-w-0 truncate py-1.5 pr-3"
                            title={networkOf(lans, client.address)?.name}
                        >
                            {networkOf(lans, client.address)?.name ?? "-"}
                        </td>
                        <td className="py-1.5 pr-3 text-xs whitespace-nowrap text-muted-foreground">
                            {client.expires === 0
                                ? t("leaseFixed")
                                : format.dateTime(new Date(client.expires * 1000))}
                        </td>
                    </tr>
                ))}
            </Table>
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

/** A line by its port: a session's device name means nothing on screen. */
function lineName(plan: RouterPlan | null, device: string): string {
    return plan?.wans.find((wan) => lineDevice(wan) === device)?.interface ?? device;
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
    if (view === null) return unanswered ? null : <ui.Skeleton className="h-16 w-full" />;
    const { reading, plan } = view;
    const facts = plan
        ? [
              t("countLines", { count: plan.wans.length }),
              t("countNetworks", { count: plan.lans.length }),
              t("countForwards", { count: plan.forwards.length }),
              ...(reading ? [t("countClients", { count: reading.clients.length })] : [])
          ]
        : [];
    return (
        <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-card p-3 text-sm">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                        {t("usingLine", { line: lineName(plan, reading.activeWan) })}
                    </span>
                ) : null}
                {reading?.rolledBack ? (
                    <ui.Badge variant="warning">{t("wentBack")}</ui.Badge>
                ) : null}
                <span className="ml-auto">
                    <IconButton label={t("refresh")} onClick={onRefresh}>
                        <RefreshCw />
                    </IconButton>
                </span>
            </div>
            {facts.length > 0 ? (
                <p className="text-xs text-muted-foreground">{facts.join(" - ")}</p>
            ) : reading !== null ? (
                <p className="text-xs text-muted-foreground">{t("notRouterBody")}</p>
            ) : null}
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
