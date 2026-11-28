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
import { useMoney } from "./menu-screen";
import { DiscountDialog, PayDialog } from "./till-screen";
import { LineDialog, MoveDialog } from "./order-dialogs";
import { chooseModifiers } from "../model/modifiers";
import { mostSoldFirst, repeatRound } from "../model/rounds";
import { markBilledAction } from "../actions/till";
import { lineTotal, orderTotals } from "../model/pricing";
import { TABLE_SHAPES } from "../model/order-schemas";
import { readMenuAction } from "../actions/catalog";
import type { MenuView, ProductView } from "../lib/catalog";
import { useHospitalityLive, useHospitalityMode } from "./live-client";
import { readCache, unwrap, useHospitalityT, writeCache } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRightLeft, Euro, Minus, Move, Percent, Plus, Receipt, Repeat, Save, Send, Trash2 } from "lucide-react";
import type { LineView, OrderView, RoomView, ServiceView, TableView } from "../lib/orders";
import { Button, Input, Select, Skeleton, cn, useToast } from "@polaris/ui";
import { readServiceAction, removeLineAction, restoreLineAction, saveFloorAction } from "../actions/orders";
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

/** Grid units to pixels on the plan. */
const UNIT = 28;

type TableState = "free" | "open" | "pending" | "billed";

function tableState(order: OrderView | undefined): TableState {
    if (!order) return "free";
    if (order.status === "billed") return "billed";
    return order.lines.some((l) => l.status === "pending") ? "pending" : "open";
}

const STATE_CLASS: Record<TableState, string> = {
    free: "border-border bg-background",
    open: "border-sky-600 bg-sky-500/15",
    pending: "border-amber-600 bg-amber-500/20",
    billed: "border-violet-600 bg-violet-500/20"
};

export function ServiceScreen({ manager }: { manager: boolean }) {
    const t = useHospitalityT();
    const [mode] = useHospitalityMode();
    const basic = mode === "basic";
    const [menu, setMenu] = useState<MenuView | null>(() => readCache<MenuView>("menu"));
    const [service, setService] = useState<ServiceView | null>(() => readCache<ServiceView>("service"));
    const [roomId, setRoomId] = useState<string | null>(null);
    const [tableId, setTableId] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const venueId = menu?.venueId ?? null;

    const load = useCallback(() => {
        unwrap(() => readMenuAction({ venueId: readCache<string>("venue") }), t("errors.loadFailed"))
            .then((answer) => {
                setMenu(answer.menu);
                setFailed(null);
                writeCache("menu", answer.menu);
                if (!answer.menu.venueId) return;
                return unwrap(() => readServiceAction({ venueId: answer.menu.venueId }), t("errors.loadFailed")).then((s) => {
                    setService(s.service);
                    writeCache("service", s.service);
                });
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
            <section className={cn("min-h-0 min-w-0 flex-1 flex-col overflow-auto p-3", table ? "hidden md:flex" : "flex")}>
                <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
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
                    <FloorEditor key={room.id} venueId={venueId} room={room} onSaved={() => { setEditing(false); load(); }} />
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

function FloorPlan(props: {
    currency: string;
    room: RoomView;
    byTable: Map<string | null, OrderView>;
    basic: boolean;
    selected: string | null;
    onPick: (id: string) => void;
}) {
    const t = useHospitalityT();
    const money = useMoney(props.currency);
    const width = Math.max(...props.room.tables.map((x) => x.x + x.width), 8) * UNIT;
    const height = Math.max(...props.room.tables.map((x) => x.y + x.height), 6) * UNIT;
    return (
        <div className="relative shrink-0" style={{ width, height }}>
            {props.room.tables.map((x) => {
                const order = props.byTable.get(x.id);
                const state = tableState(order);
                return (
                    <button
                        key={x.id}
                        type="button"
                        onClick={() => props.onPick(x.id)}
                        aria-label={`${t("floor.table")} ${x.name}: ${t(`floor.state.${state}`)}`}
                        className={cn(
                            "absolute flex flex-col items-center justify-center gap-0.5 border-2 text-center",
                            x.shape === "round" ? "rounded-full" : "rounded-lg",
                            STATE_CLASS[state],
                            props.selected === x.id && "ring-2 ring-primary ring-offset-2"
                        )}
                        style={{ left: x.x * UNIT, top: x.y * UNIT, width: x.width * UNIT, height: x.height * UNIT }}
                    >
                        <span className={cn("font-semibold", props.basic ? "text-xl" : "text-base")}>{x.name}</span>
                        {order ? <span className="text-xs tabular-nums">{money(order.totals.total)}</span> : null}
                    </button>
                );
            })}
        </div>
    );
}

/** Drag tables into place, add, reshape, rename; Save writes the whole room. */
function FloorEditor(props: { venueId: string; room: RoomView; onSaved: () => void }) {
    const t = useHospitalityT();
    const toast = useToast();
    const [name, setName] = useState(props.room.name);
    const [tables, setTables] = useState<Array<Omit<TableView, "id" | "roomId"> & { id: string | null; key: string }>>(() =>
        props.room.tables.map((x) => ({ ...x, key: x.id }))
    );
    const [picked, setPicked] = useState<string | null>(null);
    const drag = useRef<{ key: string; dx: number; dy: number } | null>(null);
    const plan = useRef<HTMLDivElement>(null);
    const update = (key: string, patch: Partial<(typeof tables)[number]>) =>
        setTables((all) => all.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    const current = tables.find((x) => x.key === picked) ?? null;

    const save = () =>
        unwrap(
            () =>
                saveFloorAction({
                    venueId: props.venueId,
                    roomId: props.room.id,
                    name,
                    tables: tables.map(({ key: _key, ...x }) => x)
                }),
            t("errors.saveFailed")
        )
            .then(props.onSaved)
            .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }));

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Input className="w-48" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label={t("floor.roomName")} />
                <Button className={TOUCH}
                    variant="outline"
                    onClick={() => {
                        const key = crypto.randomUUID();
                        setTables((all) => [...all, { id: null, key, name: String(all.length + 1), x: 0, y: 0, width: 2, height: 2, shape: "square", seats: 4 }]);
                        setPicked(key);
                    }}
                >
                    <Plus aria-hidden /> {t("floor.addTable")}
                </Button>
                <Button className={TOUCH} onClick={save}>
                    <Save aria-hidden /> {t("actions.save")}
                </Button>
            </div>
            {current ? (
                <div className="flex min-w-0 flex-wrap items-end gap-2 rounded-lg border p-2">
                    <Input className="w-20" value={current.name} maxLength={12} onChange={(e) => update(current.key, { name: e.target.value })} aria-label={t("floor.tableName")} />
                    <Select
                        value={current.shape}
                        onValueChange={(shape) => update(current.key, { shape })}
                        options={TABLE_SHAPES.map((s) => ({ value: s, label: t(`floor.shape.${s}`) }))}
                    />
                    <Button className={TOUCH} variant="outline" size="icon" aria-label={t("floor.fewerSeats")} onClick={() => update(current.key, { seats: Math.max(1, current.seats - 1) })}>
                        <Minus aria-hidden />
                    </Button>
                    <span className="tabular-nums">{t("floor.seats", { count: current.seats })}</span>
                    <Button className={TOUCH} variant="outline" size="icon" aria-label={t("floor.moreSeats")} onClick={() => update(current.key, { seats: Math.min(60, current.seats + 1) })}>
                        <Plus aria-hidden />
                    </Button>
                    <Button className={TOUCH} variant="ghost" aria-label={t("floor.removeTable")} onClick={() => { setTables((all) => all.filter((x) => x.key !== current.key)); setPicked(null); }}>
                        <Trash2 aria-hidden />
                    </Button>
                </div>
            ) : null}
            <div
                ref={plan}
                className="relative touch-none rounded-lg border border-dashed bg-[length:28px_28px] bg-[linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border))_1px,transparent_1px)]"
                style={{ width: 24 * UNIT, height: 16 * UNIT, maxWidth: "100%" }}
                onPointerMove={(e) => {
                    const d = drag.current;
                    const box = plan.current?.getBoundingClientRect();
                    if (!d || !box) return;
                    update(d.key, {
                        x: Math.max(0, Math.round((e.clientX - box.left - d.dx) / UNIT)),
                        y: Math.max(0, Math.round((e.clientY - box.top - d.dy) / UNIT))
                    });
                }}
                onPointerUp={() => (drag.current = null)}
                onPointerLeave={() => (drag.current = null)}
            >
                {tables.map((x) => (
                    <div
                        key={x.key}
                        role="button"
                        tabIndex={0}
                        onPointerDown={(e) => {
                            const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            drag.current = { key: x.key, dx: e.clientX - box.left, dy: e.clientY - box.top };
                            setPicked(x.key);
                        }}
                        className={cn(
                            "absolute flex cursor-grab items-center justify-center border-2 bg-background font-semibold",
                            x.shape === "round" ? "rounded-full" : "rounded-lg",
                            picked === x.key ? "border-primary" : "border-border"
                        )}
                        style={{ left: x.x * UNIT, top: x.y * UNIT, width: (x.shape === "long" ? Math.max(x.width, 4) : x.width) * UNIT, height: x.height * UNIT }}
                    >
                        {x.name}
                    </div>
                ))}
            </div>
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
                    : [{ id: `open:${orderId}`, kind: "open", payload: { id: orderId, venueId: props.venueId, tableId: props.table.id, covers: props.table.seats } }]),
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
