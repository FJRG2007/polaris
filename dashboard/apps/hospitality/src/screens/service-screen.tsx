"use client";

/**
 * Service: the floor of a venue with each table's state, and the order of the
 * table tapped. On a phone or handheld the floor fills the screen and a table
 * opens its order over it (one hand, thumb at the bottom); on a tablet or a
 * desktop the floor and the order sit side by side.
 *
 * What a waiter taps goes on the order at once and is sent in the background;
 * if the server refuses, the line comes back off with the reason. The server
 * prices every line and computes every total.
 */

import { TOUCH } from "./touch";
import { FloorEditor, FloorPlan } from "./floor-plan";
import { useMoney } from "./menu-screen";
import { DiscountDialog, PayDialog } from "./till-screen";
import { LineDialog, MoveDialog } from "./order-dialogs";
import { chooseModifiers } from "../model/modifiers";
import { mostSoldFirst, repeatRound } from "../model/rounds";
import { markBilledAction } from "../actions/till";
import { lineTotal, orderTotals } from "../model/pricing";
import type { MenuView, ProductView } from "../lib/catalog";
import { useHospitalityLive, useHospitalityMode } from "./live-client";
import { readCache, unwrap, useHospitalityT, writeCache } from "./i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRightLeft, Euro, Minus, Move, Plus, Users, Percent, Receipt, Repeat, Send, Trash2 } from "lucide-react";
import type { LineView, OrderView, RoomView, ServiceView, TableView } from "../lib/orders";
import { Button, Select, Skeleton, cn, useToast } from "@polaris/ui";
import { readServiceScreenAction, removeLineAction, setCoversAction, restoreLineAction, saveFloorAction } from "../actions/orders";
import { useOfflineQueue } from "./offline";
import { LoadFailed, NoVenue } from "./states";

const COURSES = ["0", "1", "2", "3"] as const;
const LINE_STATUSES = ["pending", "sent", "ready", "served", "void"] as const;

function courseKey(course: number): (typeof COURSES)[number] {
    return COURSES[Math.min(Math.max(course, 0), 3)] ?? "0";
}

function lineStatus(status: string): (typeof LINE_STATUSES)[number] {
    return (LINE_STATUSES as readonly string[]).includes(status) ? (status as (typeof LINE_STATUSES)[number]) : "sent";
}

export function ServiceScreen({ manager }: { manager: boolean }) {
    const t = useHospitalityT();
    const toast = useToast();
    const [mode] = useHospitalityMode();
    const basic = mode === "basic";
    const [menu, setMenu] = useState<MenuView | null>(() => readCache<MenuView>("menu"));
    const [service, setService] = useState<ServiceView | null>(() => readCache<ServiceView>("service"));
    const [roomId, setRoomId] = useState<string | null>(null);
    const [tableId, setTableId] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const venueId = menu?.venueId ?? null;

    // One request for everything this screen draws; the cached copy shows meanwhile.
    const load = useCallback(() => {
        unwrap(() => readServiceScreenAction({ venueId: readCache<string>("venue") }), t("errors.loadFailed"))
            .then((answer) => {
                setMenu(answer.menu);
                setFailed(null);
                writeCache("menu", answer.menu);
                if (!answer.service) return;
                setService(answer.service);
                writeCache("service", answer.service);
            })
            .catch((caught: Error) => setFailed(caught.message));
    }, [t]);
    useEffect(load, [load]);
    useHospitalityLive(venueId, load);

    const room = service?.rooms.find((r) => r.id === roomId) ?? service?.rooms[0] ?? null;
    const byTable = useMemo(() => new Map((service?.orders ?? []).map((o) => [o.tableId, o])), [service]);
    const table = service?.rooms.flatMap((r) => r.tables).find((x) => x.id === tableId) ?? null;
    const busy = useMemo(() => new Set((service?.orders ?? []).flatMap((o) => (o.tableId ? [o.tableId] : []))), [service]);

    // A venue that is not set up yet has no floor to wait for: say so, and point a manager at where it is set up.
    if (menu && !venueId) return <NoVenue manager={manager} />;
    if (failed && (!menu || !service)) return <LoadFailed message={failed} onRetry={load} />;
    if (!menu || !service) {
        return (
            <div className="grid gap-3 p-4 sm:grid-cols-4" aria-busy>
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} className="h-24" />)}
            </div>
        );
    }
    if (!venueId || !room) return <NoVenue manager={manager} />;

    return (
        <div className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col md:flex-row">
            <section className={cn("min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden p-3", table ? "hidden md:flex" : "flex")}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {service.rooms.map((r) => (
                        <Button className={TOUCH} key={r.id} variant={r.id === room.id ? "primary" : "outline"} size={basic ? "lg" : "md"} onClick={() => setRoomId(r.id)}>
                            <span className="max-w-40 truncate" title={r.name}>{r.name}</span>
                        </Button>
                    ))}
                    {manager ? (
                        <Button className={TOUCH} variant="ghost" onClick={() => setEditing(!editing)}>
                            <Move aria-hidden /> {editing ? t("floor.done") : t("floor.edit")}
                        </Button>
                    ) : null}
                </div>
                {editing ? (
                    <FloorEditor
                        key={room.id}
                        room={room}
                        onSave={(name, tables) =>
                            unwrap(() => saveFloorAction({ venueId, roomId: room.id, name, tables }), t("errors.saveFailed"))
                                .then(() => { setEditing(false); load(); })
                                .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }))
                        }
                    />
                ) : (
                    <FloorPlan currency={menu.venues.find((v) => v.id === venueId)?.currency ?? "EUR"} room={room} byTable={byTable} basic={basic} selected={tableId} onPick={setTableId} />
                )}
            </section>
            {table ? (
                <OrderPanel
                    key={table.id}
                    venueId={venueId}
                    table={table}
                    order={byTable.get(table.id)}
                    menu={menu}
                    basic={basic}
                    manager={manager}
                    rooms={service.rooms}
                    busy={busy}
                    onMoved={(id) => { setTableId(id); load(); }}
                    onClose={() => setTableId(null)}
                    onChanged={load}
                />
            ) : null}
        </div>
    );
}

interface Draft {
    readonly id: string;
    readonly product: ProductView;
    quantity: number;
    course: number;
    modifierIds: string[];
    note: string;
}

/** A draft's options priced from its product, as the server will price them. */
function draftModifiers(d: Draft) {
    const choice = chooseModifiers(d.product.modifiers, d.modifierIds);
    return choice.ok ? choice.modifiers : [];
}

function OrderPanel(props: {
    venueId: string;
    table: TableView;
    order: OrderView | undefined;
    menu: MenuView;
    basic: boolean;
    manager: boolean;
    rooms: RoomView[];
    busy: ReadonlySet<string>;
    onMoved: (tableId: string) => void;
    onClose: () => void;
    onChanged: () => void;
}) {
    const t = useHospitalityT();
    const toast = useToast();
    const venue = props.menu.venues.find((v) => v.id === props.venueId);
    const money = useMoney(venue?.currency ?? "EUR");
    const [category, setCategory] = useState(props.menu.categories[0]?.id ?? null);
    const [drafts, setDrafts] = useState<Draft[]>([]);
    const [course, setCourse] = useState(0);
    const [sending, setSending] = useState(false);
    const [paying, setPaying] = useState(false);
    const [discounting, setDiscounting] = useState<LineView | "order" | null>(null);
    const [moving, setMoving] = useState(false);
    /** Guests at the table: the floor fills that many chairs. Kept here until the order exists. */
    const [covers, setCovers] = useState(props.order?.covers ?? props.table.seats);
    useEffect(() => setCovers(props.order?.covers ?? props.table.seats), [props.order?.covers, props.table.seats]);
    const changeCovers = (next: number) => {
        const value = Math.min(Math.max(next, 1), 500);
        setCovers(value);
        if (!props.order) return;
        unwrap(() => setCoversAction({ orderId: props.order!.id, covers: value }), t("errors.saveFailed"))
            .then(props.onChanged)
            .catch((caught: Error) => {
                setCovers(props.order?.covers ?? props.table.seats);
                toast.show({ title: t("errors.saveFailed"), body: caught.message });
            });
    };
    /** The product whose options are being picked, and the draft it edits (null: a new one). */
    const [picking, setPicking] = useState<{ product: ProductView; draft: Draft | null } | null>(null);
    const products = mostSoldFirst(props.menu.products.filter((p) => p.categoryId === category));
    const sent = props.order?.lines.filter((l) => l.status !== "void") ?? [];
    const preview = orderTotals([
        ...sent,
        ...drafts.map((d) => ({ unitPrice: d.product.price, quantity: d.quantity, taxRateBp: d.product.taxRateBp, modifiers: draftModifiers(d) }))
    ], props.order?.discount);

    const add = (product: ProductView) => {
        if (!product.available) return;
        if (product.modifiers.length > 0) return setPicking({ product, draft: null });
        setDrafts((all) => {
            const same = all.find((d) => d.product.id === product.id && d.course === course && d.modifierIds.length === 0 && !d.note);
            if (same) return all.map((d) => (d === same ? { ...d, quantity: d.quantity + 1 } : d));
            return [...all, { id: crypto.randomUUID(), product, quantity: 1, course, modifierIds: [], note: "" }];
        });
    };

    const queue = useOfflineQueue(props.onChanged, (error) => toast.show({ title: t("errors.saveFailed"), body: error }));

    /**
     * Opens the order if the table had none, adds the drafts and fires them, as
     * three queued operations with ids made here: with no network they wait on
     * this device and go out in order when it is back, and a replay adds nothing
     * twice. The drafts leave the screen only once they are safely queued.
     */
    const send = async () => {
        if (sending || (drafts.length === 0 && !sent.some((l) => l.status === "pending"))) return;
        setSending(true);
        try {
            const orderId = props.order?.id ?? crypto.randomUUID();
            const ops = [
                ...(props.order
                    ? []
                    : [{ id: `open:${orderId}`, kind: "open", payload: { id: orderId, venueId: props.venueId, tableId: props.table.id, covers } }]),
                ...(drafts.length
                    ? [{
                          id: `add:${drafts[0]?.id ?? orderId}`,
                          kind: "add",
                          payload: { orderId, lines: drafts.map((d) => ({ id: d.id, productId: d.product.id, quantity: d.quantity, course: d.course, modifierIds: d.modifierIds, note: d.note })) }
                      }]
                    : []),
                { id: `send:${crypto.randomUUID()}`, kind: "send", payload: { orderId, course: null } }
            ];
            const result = await queue.submit(ops);
            setDrafts([]);
            if (result.left > 0) toast.show({ title: t("offline.queued") });
            else if (result.refused.length === 0) toast.show({ title: t("order.sent") });
        } catch (caught) {
            // Not even queued (storage full): the drafts stay on screen.
            toast.show({ title: t("errors.saveFailed"), body: (caught as Error).message });
        } finally {
            setSending(false);
        }
    };

    /** "Otra ronda": the last round fired, back as drafts at today's menu, to be checked and sent. */
    const repeat = () => {
        const round = repeatRound(sent, props.menu.products);
        setDrafts((all) => [...all, ...round.lines.map((l) => ({ id: crypto.randomUUID(), ...l }))]);
        if (round.missing > 0) toast.show({ title: t("order.repeatMissing", { count: round.missing }) });
    };

    // No confirm on the hot path: the line goes at once and the note offers it back.
    // The version shown goes with it, so a line another device just changed is not removed blind.
    const remove = (line: { id: string; name: string }) =>
        unwrap(() => removeLineAction({ lineId: line.id, version: props.order?.version }), t("errors.saveFailed"))
            .then(() => {
                props.onChanged();
                toast.show({
                    key: `removed:${line.id}`,
                    title: t("orders.removed", { name: line.name }),
                    life: 10_000,
                    actions: [
                        {
                            label: t("orders.undo"),
                            run: async () => {
                                const answer = await restoreLineAction({ lineId: line.id });
                                props.onChanged();
                                return answer.ok ? null : answer.error;
                            }
                        }
                    ]
                });
            })
            .catch((caught: Error) => {
                props.onChanged();
                toast.show({ title: t("errors.saveFailed"), body: caught.message });
            });

    return (
        <section className="flex min-h-0 w-full min-w-0 flex-col border-s bg-background md:w-[28rem] lg:w-[34rem]">
            <header className="flex min-w-0 items-center gap-2 border-b p-2">
                <Button className={TOUCH} variant="ghost" size="icon" aria-label={t("order.back")} onClick={props.onClose}>
                    <ArrowLeft aria-hidden />
                </Button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <h2 className="truncate text-lg font-semibold">{t("floor.table")} {props.table.name}</h2>
                    {props.order?.updatedByName ? (
                        <span className="truncate text-xs text-muted-foreground" title={props.order.updatedByName}>
                            {t("orders.lastChange", { name: props.order.updatedByName })}
                        </span>
                    ) : null}
                </div>
                <span className="flex shrink-0 items-center gap-1" role="group" aria-label={t("floor.covers", { count: covers })}>
                    <Button className={TOUCH} variant="ghost" size="icon" aria-label={t("order.fewerGuests")} disabled={covers <= 1} onClick={() => changeCovers(covers - 1)}>
                        <Minus aria-hidden />
                    </Button>
                    <span className="flex items-center gap-1 tabular-nums" title={t("floor.covers", { count: covers })}>
                        <Users className="size-4" aria-hidden /> {covers}
                    </span>
                    <Button className={TOUCH} variant="ghost" size="icon" aria-label={t("order.moreGuests")} onClick={() => changeCovers(covers + 1)}>
                        <Plus aria-hidden />
                    </Button>
                </span>
                <Select
                    aria-label={t("order.course")}
                    value={String(course)}
                    onValueChange={(c) => setCourse(Number(c))}
                    options={COURSES.map((c) => ({ value: c, label: t(`order.courses.${c}`) }))}
                />
            </header>
            <div className="flex min-w-0 gap-1.5 overflow-x-auto border-b p-2">
                {props.menu.categories.map((c) => (
                    <Button className={TOUCH} key={c.id} size={props.basic ? "lg" : "sm"} variant={c.id === category ? "primary" : "outline"} onClick={() => setCategory(c.id)}>
                        <span className="max-w-32 truncate" title={c.name}>{c.name}</span>
                    </Button>
                ))}
            </div>
            <div className={cn("grid min-h-0 flex-1 auto-rows-min gap-2 overflow-y-auto p-2", props.basic ? "grid-cols-2" : "grid-cols-3")}>
                {products.map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        disabled={!p.available}
                        onClick={() => add(p)}
                        className={cn(
                            "flex min-w-0 flex-col items-start rounded-lg border p-2 text-start active:scale-[0.98]",
                            props.basic ? "min-h-20 text-base" : "min-h-14 text-sm",
                            !p.available && "opacity-40"
                        )}
                    >
                        <span className="w-full truncate font-medium" title={p.name}>{p.name}</span>
                        <span className="tabular-nums text-muted-foreground">{p.available ? money(p.price) : t("menu.soldOut")}</span>
                    </button>
                ))}
            </div>
            <div className="max-h-[40%] min-h-0 overflow-y-auto border-t p-2">
                {sent.map((l) => (
                    <div key={l.id} className="flex min-w-0 items-center gap-2 py-1 text-sm">
                        <span className="w-6 shrink-0 text-end tabular-nums">{l.quantity}</span>
                        <LineName name={l.name} extras={[...l.modifiers.map((m) => m.name), l.note]} />
                        <span className="shrink-0 text-xs text-muted-foreground">{t(`order.status.${lineStatus(l.status)}`)}</span>
                        <span className={cn("w-16 shrink-0 text-end tabular-nums", l.discount && "text-emerald-700 dark:text-emerald-400")}>{money(lineTotal(l))}</span>
                        {props.manager ? (
                            <Button className={TOUCH} variant="ghost" size="icon" aria-label={t("discount.line", { name: l.name })} onClick={() => setDiscounting(l)}>
                                <Percent aria-hidden />
                            </Button>
                        ) : null}
                        <Button className={TOUCH} variant="ghost" size="icon" aria-label={t("order.remove")} onClick={() => remove(l)}>
                            <Trash2 aria-hidden />
                        </Button>
                    </div>
                ))}
                {drafts.map((d) => (
                    <div key={d.id} className="flex min-w-0 items-center gap-2 py-1 text-sm font-medium text-amber-700 dark:text-amber-400">
                        <Button className={TOUCH} variant="ghost" size="icon" aria-label={t("order.less")} onClick={() => setDrafts((all) => all.flatMap((x) => (x.id !== d.id ? [x] : x.quantity > 1 ? [{ ...x, quantity: x.quantity - 1 }] : [])))}>
                            <Minus aria-hidden />
                        </Button>
                        <span className="w-6 shrink-0 text-end tabular-nums">{d.quantity}</span>
                        <Button className={TOUCH} variant="ghost" size="icon" aria-label={t("order.more")} onClick={() => setDrafts((all) => all.map((x) => (x.id === d.id ? { ...x, quantity: Math.min(x.quantity + 1, 99) } : x)))}>
                            <Plus aria-hidden />
                        </Button>
                        <button type="button" className="flex min-w-0 flex-1 text-start" aria-label={t("order.change", { name: d.product.name })} onClick={() => setPicking({ product: d.product, draft: d })}>
                            <LineName name={d.product.name} extras={[...draftModifiers(d).map((m) => m.name), d.note]} />
                        </button>
                        <span className="shrink-0 text-xs">{t(`order.courses.${courseKey(d.course)}`)}</span>
                        <span className="w-16 shrink-0 text-end tabular-nums">{money(lineTotal({ unitPrice: d.product.price, quantity: d.quantity, taxRateBp: d.product.taxRateBp, modifiers: draftModifiers(d) }))}</span>
                    </div>
                ))}
            </div>
            <footer className="flex min-w-0 flex-wrap items-center gap-2 border-t p-2">
                <span className="min-w-0 flex-1 truncate text-lg font-semibold tabular-nums">{money(preview.total)}</span>
                {queue.waiting > 0 ? (
                    <span className="shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs" title={t("offline.waitingHint")}>
                        {t("offline.waiting", { count: queue.waiting })}
                    </span>
                ) : null}
                {props.order ? (
                    <>
                        {props.manager ? (
                            <Button className={TOUCH} variant="outline" size="lg" onClick={() => setDiscounting("order")}>
                                <Percent aria-hidden /> {t("discount.title")}
                            </Button>
                        ) : null}
                        <Button className={TOUCH}
                            variant="outline"
                            size="lg"
                            onClick={() =>
                                props.order &&
                                unwrap(() => markBilledAction({ orderId: props.order!.id }), t("errors.saveFailed"))
                                    .then(props.onChanged)
                                    .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }))
                            }
                        >
                            <Receipt aria-hidden /> {t("order.bill")}
                        </Button>
                        <Button className={TOUCH} variant="outline" size="lg" disabled={!sent.some((l) => l.sentAt)} onClick={repeat}>
                            <Repeat aria-hidden /> {t("order.repeat")}
                        </Button>
                        <Button className={TOUCH} variant="outline" size="lg" disabled={drafts.length > 0} onClick={() => setMoving(true)}>
                            <ArrowRightLeft aria-hidden /> {t("order.move")}
                        </Button>
                        <Button className={TOUCH} variant="outline" size="lg" disabled={drafts.length > 0} onClick={() => setPaying(true)}>
                            <Euro aria-hidden /> {t("order.pay")}
                        </Button>
                    </>
                ) : null}
                <Button className={TOUCH} size="lg" onClick={send} disabled={sending || (drafts.length === 0 && !sent.some((l) => l.status === "pending"))}>
                    <Send aria-hidden /> {t("order.send")}
                </Button>
            </footer>
            {paying && props.order ? (
                <PayDialog
                    order={props.order}
                    queue={queue}
                    currency={venue?.currency ?? "EUR"}
                    onClose={() => { setPaying(false); props.onChanged(); }}
                    onPaid={(ticketNo) => {
                        setPaying(false);
                        toast.show({ title: t("pay.done", { ticket: ticketNo ?? "" }) });
                        props.onChanged();
                        props.onClose();
                    }}
                />
            ) : null}
            {discounting && props.order ? (
                <DiscountDialog
                    orderId={props.order.id}
                    version={props.order.version}
                    lineId={discounting === "order" ? undefined : discounting.id}
                    lineName={discounting === "order" ? undefined : discounting.name}
                    onClose={() => setDiscounting(null)}
                    onSaved={props.onChanged}
                />
            ) : null}
            {moving && props.order ? (
                <MoveDialog
                    order={props.order}
                    fromTableId={props.table.id}
                    rooms={props.rooms}
                    busy={props.busy}
                    onClose={() => setMoving(false)}
                    onMoved={(id) => { setMoving(false); props.onMoved(id); }}
                />
            ) : null}
            {picking ? (
                <LineDialog
                    product={picking.product}
                    modifierIds={picking.draft?.modifierIds ?? []}
                    note={picking.draft?.note ?? ""}
                    money={money}
                    onClose={() => setPicking(null)}
                    onConfirm={(modifierIds, note) => {
                        const editing = picking.draft;
                        setDrafts((all) =>
                            editing
                                ? all.map((d) => (d.id === editing.id ? { ...d, modifierIds, note } : d))
                                : [...all, { id: crypto.randomUUID(), product: picking.product, quantity: 1, course, modifierIds, note }]
                        );
                        setPicking(null);
                    }}
                />
            ) : null}
        </section>
    );
}

/** A line's name with its options and note in small print under it. */
function LineName({ name, extras }: { name: string; extras: string[] }) {
    const detail = extras.filter(Boolean).join(" · ");
    return (
        <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate" title={name}>{name}</span>
            {detail ? <span className="truncate text-xs text-muted-foreground" title={detail}>{detail}</span> : null}
        </span>
    );
}
