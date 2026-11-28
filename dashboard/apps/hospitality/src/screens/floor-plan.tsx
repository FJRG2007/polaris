"use client";

/**
 * The floor of a room as a drawing: every table in its shape and size with
 * its chairs around it, coloured and marked by state (free, seated, not sent,
 * waiting on the kitchen, served, bill asked, paying), with the minutes since
 * the last thing happened, the covers, the waiter and the running total. One
 * SVG scaled to the space it has, so a handheld and a wall tablet draw the
 * same plan crisply; zoom in and out or fit it back.
 *
 * Fast with a hundred tables: each table is a memoised group redrawn only when
 * its own order changes, and one timer per plan moves the clocks.
 */

import { TOUCH } from "./touch";
import { useMoney } from "./menu-screen";
import { useHospitalityT } from "./i18n";
import { useHospitalityFormat } from "./format";
import { TABLE_SHAPES } from "../model/order-schemas";
import { Button, Input, Select, cn } from "@polaris/ui";
import type { OrderView, RoomView, TableView } from "../lib/orders";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chairsOf, lastActivity, minutesSince, planBounds, snap, tableState, type TableState } from "../model/floor";
import { Armchair, ChefHat, CreditCard, Hourglass, Maximize, Minus, Plus, Receipt, Save, Trash2, Users, UtensilsCrossed, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";

const STATE_STYLE: Record<TableState, { readonly table: string; readonly chair: string; readonly icon: LucideIcon }> = {
    // Light mode first (venues work in daylight): 600/700 strokes on a pale tint, and the
    // state is always paired with its own icon, so color is never the only cue.
    free: { table: "fill-background stroke-foreground/50", chair: "fill-muted stroke-foreground/50", icon: Armchair },
    seated: { table: "fill-sky-500/15 stroke-sky-600", chair: "fill-sky-600 stroke-sky-700", icon: Users },
    pending: { table: "fill-amber-500/25 stroke-amber-600", chair: "fill-amber-600 stroke-amber-700", icon: Hourglass },
    kitchen: { table: "fill-orange-500/20 stroke-orange-600", chair: "fill-orange-600 stroke-orange-700", icon: ChefHat },
    served: { table: "fill-emerald-500/20 stroke-emerald-600", chair: "fill-emerald-600 stroke-emerald-700", icon: UtensilsCrossed },
    billed: { table: "fill-violet-500/25 stroke-violet-600", chair: "fill-violet-600 stroke-violet-700", icon: Receipt },
    paying: { table: "fill-fuchsia-500/25 stroke-fuchsia-600", chair: "fill-fuchsia-600 stroke-fuchsia-700", icon: CreditCard }
};

type Box = Pick<TableView, "x" | "y" | "width" | "height" | "shape">;

/** Shape outline of a table in grid units. */
function TableShape({ table, className }: { table: Box; className: string }) {
    if (table.shape === "round") {
        return <ellipse className={className} cx={table.x + table.width / 2} cy={table.y + table.height / 2} rx={table.width / 2} ry={table.height / 2} strokeWidth={0.1} />;
    }
    return <rect className={className} x={table.x} y={table.y} width={table.width} height={table.height} rx={0.25} strokeWidth={0.1} />;
}

/** A name cut to what fits; the whole one is in the table's label. */
function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}...` : text;
}

const TableMark = memo(function TableMark(props: {
    table: TableView;
    order: OrderView | undefined;
    now: number;
    basic: boolean;
    selected: boolean;
    money: (cents: number) => string;
    onPick: (id: string) => void;
}) {
    const t = useHospitalityT();
    const { table, order } = props;
    const state = tableState(order);
    const style = STATE_STYLE[state];
    const Icon = style.icon;
    const covers = order?.covers ?? 0;
    const minutes = order ? minutesSince(lastActivity(order), props.now) : null;
    const chairs = chairsOf(table);
    const cx = table.x + table.width / 2;
    const middle = table.y + table.height / 2;
    const fits = Math.max(3, Math.floor(table.width * 2.4));
    const label = [
        `${t("floor.table")} ${table.name}`,
        t(`floor.state.${state}`),
        t("floor.seats", { count: table.seats }),
        order ? t("floor.covers", { count: covers }) : null,
        order?.waiterName || null,
        order ? props.money(order.totals.total) : null,
        minutes !== null ? t("floor.minutes", { count: minutes }) : null
    ].filter(Boolean).join(", ");
    return (
        <g
            role="button"
            tabIndex={0}
            aria-label={label}
            className="cursor-pointer outline-none"
            onClick={() => props.onPick(table.id)}
            onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                props.onPick(table.id);
            }}
        >
            <title>{label}</title>
            {chairs.map((c, i) => (
                // Chairs with someone on them (covers) are filled, the rest outlined.
                <circle key={i} cx={c.cx} cy={c.cy} r={0.28} strokeWidth={0.06} className={i < covers ? style.chair : "fill-background stroke-foreground/50"} />
            ))}
            {props.selected ? (
                <TableShape table={{ ...table, x: table.x - 0.18, y: table.y - 0.18, width: table.width + 0.36, height: table.height + 0.36 }} className="fill-none stroke-primary" />
            ) : null}
            <TableShape table={table} className={style.table} />
            <Icon x={table.x + 0.12} y={table.y + 0.12} width={0.6} height={0.6} strokeWidth={2.4} className="text-foreground" aria-hidden />
            <text x={cx} y={order ? middle - 0.1 : middle + 0.22} textAnchor="middle" className="fill-foreground font-semibold" fontSize={props.basic ? 0.75 : 0.6}>
                {clip(table.name, fits)}
            </text>
            {order ? (
                <text x={cx} y={middle + 0.5} textAnchor="middle" className="fill-foreground tabular-nums" fontSize={props.basic ? 0.5 : 0.42}>
                    {clip(props.money(order.totals.total), fits + 4)}
                </text>
            ) : null}
            {minutes !== null && table.height >= 1.8 ? (
                <text x={cx} y={middle + 0.95} textAnchor="middle" fontSize={0.36}
                    className={cn("tabular-nums", minutes >= 20 && state !== "served" ? "fill-red-700 font-semibold dark:fill-red-400" : "fill-foreground")}
                >
                    {t("floor.minutes", { count: minutes })}
                    {!props.basic && order?.waiterName ? ` - ${clip(order.waiterName, 10)}` : ""}
                </text>
            ) : null}
        </g>
    );
});

/** Zoom buttons beside a plan's tools; "fit" puts the whole room back on screen. */
function ZoomBar({ zoom, setZoom, children }: { zoom: number; setZoom: (z: number) => void; children?: ReactNode }) {
    const t = useHospitalityT();
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
            {children}
            <div className="ms-auto flex shrink-0 items-center gap-1">
                <Button className={TOUCH} variant="outline" size="icon" aria-label={t("floor.zoomOut")} title={t("floor.zoomOut")} disabled={zoom <= 1} onClick={() => setZoom(Math.max(1, zoom / 1.25))}>
                    <ZoomOut aria-hidden />
                </Button>
                <Button className={TOUCH} variant="outline" onClick={() => setZoom(1)}>
                    <Maximize aria-hidden /> {t("floor.fit")}
                </Button>
                <Button className={TOUCH} variant="outline" size="icon" aria-label={t("floor.zoomIn")} title={t("floor.zoomIn")} disabled={zoom >= 4} onClick={() => setZoom(Math.min(4, zoom * 1.25))}>
                    <ZoomIn aria-hidden />
                </Button>
            </div>
        </div>
    );
}

/** The live plan: fits the room to the screen, zooms, and opens a table on tap. */
export function FloorPlan(props: {
    currency: string;
    room: RoomView;
    byTable: Map<string | null, OrderView>;
    basic: boolean;
    selected: string | null;
    onPick: (id: string) => void;
}) {
    const t = useHospitalityT();
    const money = useMoney(props.currency);
    const [zoom, setZoom] = useState(1);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);
    const box = useMemo(() => planBounds(props.room.tables), [props.room.tables]);
    const counts = useMemo(() => {
        let free = 0;
        let covers = 0;
        for (const x of props.room.tables) {
            const order = props.byTable.get(x.id);
            if (order) covers += order.covers;
            else free++;
        }
        return { free, covers };
    }, [props.room.tables, props.byTable]);
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <ZoomBar zoom={zoom} setZoom={setZoom}>
                <span className="min-w-0 truncate text-sm text-muted-foreground">{t("floor.summary", { free: counts.free, covers: counts.covers })}</span>
            </ZoomBar>
            <div className="min-h-60 min-w-0 flex-1 overflow-auto rounded-lg border bg-background">
                <svg
                    viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
                    preserveAspectRatio="xMidYMid meet"
                    className="block h-full w-full touch-manipulation select-none"
                    style={zoom > 1 ? { width: `${zoom * 100}%`, height: `${zoom * 100}%` } : undefined}
                    role="group"
                    aria-label={props.room.name}
                >
                    {props.room.tables.map((x) => (
                        <TableMark key={x.id} table={x} order={props.byTable.get(x.id)} now={now} basic={props.basic} selected={props.selected === x.id} money={money} onPick={props.onPick} />
                    ))}
                </svg>
            </div>
            <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-foreground" aria-label={t("floor.legend")}>
                {(Object.keys(STATE_STYLE) as TableState[]).map((s) => {
                    const Icon = STATE_STYLE[s].icon;
                    return (
                        <li key={s} className="flex items-center gap-1">
                            <svg viewBox="0 0 1 1" className="size-3 shrink-0" aria-hidden>
                                <rect width={1} height={1} rx={0.2} className={STATE_STYLE[s].table} strokeWidth={0.15} />
                            </svg>
                            <Icon className="size-3.5 shrink-0" aria-hidden />
                            {t(`floor.state.${s}`)}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

export type FloorDraft = Omit<TableView, "id" | "roomId"> & { id: string | null };
type Draft = FloorDraft & { key: string };

/** The size a shape starts at, in grid units. */
const SIZES: Record<string, readonly [number, number]> = { square: [2, 2], round: [2, 2], long: [4, 2] };

/**
 * Drag tables into place with a finger or a mouse (snapped to half a unit),
 * add, reshape, resize, rename, set the chairs; Save writes the whole room.
 */
export function FloorEditor(props: { room: RoomView; onSave: (name: string, tables: FloorDraft[]) => void }) {
    const t = useHospitalityT();
    const format = useHospitalityFormat();
    const [name, setName] = useState(props.room.name);
    const [tables, setTables] = useState<Draft[]>(() => props.room.tables.map((x) => ({ ...x, key: x.id })));
    const [picked, setPicked] = useState<string | null>(null);
    const [zoom, setZoom] = useState(1);
    const drag = useRef<{ key: string; dx: number; dy: number } | null>(null);
    const svg = useRef<SVGSVGElement>(null);
    const update = (key: string, patch: Partial<Draft>) => setTables((all) => all.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    const current = tables.find((x) => x.key === picked) ?? null;
    const bounds = planBounds(tables, 2);
    // Room to drag into: never smaller than a 24 x 16 floor.
    const box = { width: Math.max(24, bounds.x + bounds.width), height: Math.max(16, bounds.y + bounds.height) };

    /** A pointer position in grid units. */
    const unitsAt = (clientX: number, clientY: number) => {
        const matrix = svg.current?.getScreenCTM();
        if (!matrix) return null;
        const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
        return { x: point.x, y: point.y };
    };

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <ZoomBar zoom={zoom} setZoom={setZoom}>
                <Input className="w-48 min-w-0" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label={t("floor.roomName")} />
                <Button
                    className={TOUCH}
                    variant="outline"
                    onClick={() => {
                        const key = crypto.randomUUID();
                        setTables((all) => [...all, { id: null, key, name: String(all.length + 1), x: 1, y: 1, width: 2, height: 2, shape: "square", seats: 4 }]);
                        setPicked(key);
                    }}
                >
                    <Plus aria-hidden /> {t("floor.addTable")}
                </Button>
                <Button className={TOUCH} onClick={() => props.onSave(name, tables.map(({ key: _key, ...x }) => x))}>
                    <Save aria-hidden /> {t("actions.save")}
                </Button>
            </ZoomBar>
            {current ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border p-2">
                    <Input className="w-24" value={current.name} maxLength={12} onChange={(e) => update(current.key, { name: e.target.value })} aria-label={t("floor.tableName")} />
                    <Select
                        aria-label={t("floor.shape.label")}
                        value={current.shape}
                        onValueChange={(shape) => {
                            const [width, height] = SIZES[shape] ?? [2, 2];
                            update(current.key, { shape, width, height });
                        }}
                        options={TABLE_SHAPES.map((s) => ({ value: s, label: t(`floor.shape.${s}`) }))}
                    />
                    <Stepper label={t("floor.width")} shown={format.number(current.width)} value={current.width} onChange={(width) => update(current.key, { width })} />
                    <Stepper label={t("floor.depth")} shown={format.number(current.height)} value={current.height} onChange={(height) => update(current.key, { height })} />
                    <Stepper label={t("floor.chairs")} shown={t("floor.seats", { count: current.seats })} value={current.seats} step={1} max={60} onChange={(seats) => update(current.key, { seats })} />
                    <Button className={TOUCH} variant="ghost" onClick={() => { setTables((all) => all.filter((x) => x.key !== current.key)); setPicked(null); }}>
                        <Trash2 aria-hidden /> {t("floor.removeTable")}
                    </Button>
                </div>
            ) : (
                <p className="text-sm text-muted-foreground">{t("floor.editHint")}</p>
            )}
            <div className="min-h-80 min-w-0 flex-1 overflow-auto rounded-lg border border-dashed">
                <svg
                    ref={svg}
                    viewBox={`0 0 ${box.width} ${box.height}`}
                    preserveAspectRatio="xMinYMin meet"
                    className="block h-full w-full touch-none select-none"
                    style={zoom > 1 ? { width: `${zoom * 100}%`, height: `${zoom * 100}%` } : undefined}
                    onPointerMove={(e) => {
                        const d = drag.current;
                        const at = d ? unitsAt(e.clientX, e.clientY) : null;
                        if (!d || !at) return;
                        update(d.key, { x: snap(at.x - d.dx), y: snap(at.y - d.dy) });
                    }}
                    onPointerUp={() => (drag.current = null)}
                    onPointerCancel={() => (drag.current = null)}
                >
                    <defs>
                        <pattern id="hospitality-grid" width={1} height={1} patternUnits="userSpaceOnUse">
                            <path d="M 1 0 L 0 0 0 1" className="fill-none stroke-border" strokeWidth={0.03} />
                        </pattern>
                    </defs>
                    <rect width={box.width} height={box.height} fill="url(#hospitality-grid)" onPointerDown={() => setPicked(null)} />
                    {tables.map((x) => (
                        <g
                            key={x.key}
                            className="cursor-grab active:cursor-grabbing"
                            onPointerDown={(e) => {
                                const at = unitsAt(e.clientX, e.clientY);
                                if (!at) return;
                                svg.current?.setPointerCapture(e.pointerId);
                                drag.current = { key: x.key, dx: at.x - x.x, dy: at.y - x.y };
                                setPicked(x.key);
                            }}
                        >
                            {chairsOf(x).map((c, i) => <circle key={i} cx={c.cx} cy={c.cy} r={0.28} strokeWidth={0.06} className="fill-muted stroke-border" />)}
                            <TableShape table={x} className={picked === x.key ? "fill-primary/15 stroke-primary" : "fill-background stroke-foreground/40"} />
                            <text x={x.x + x.width / 2} y={x.y + x.height / 2 + 0.2} textAnchor="middle" fontSize={0.6} className="pointer-events-none fill-foreground font-semibold">
                                {clip(x.name, Math.max(3, Math.floor(x.width * 2.4)))}
                            </text>
                        </g>
                    ))}
                </svg>
            </div>
        </div>
    );
}

/** Minus, the value, plus, with 56 px targets; sizes go in half units. */
function Stepper(props: { label: string; shown: string; value: number; step?: number; max?: number; onChange: (value: number) => void }) {
    const step = props.step ?? 0.5;
    const max = props.max ?? 12;
    return (
        <span className="flex shrink-0 items-center gap-1" role="group" aria-label={props.label}>
            <Button className={TOUCH} variant="outline" size="icon" aria-label={`${props.label}: -`} disabled={props.value <= step} onClick={() => props.onChange(Math.max(step, props.value - step))}>
                <Minus aria-hidden />
            </Button>
            <span className="flex min-w-16 flex-col text-center text-xs leading-tight">
                <span className="text-muted-foreground">{props.label}</span>
                <span className="text-sm tabular-nums">{props.shown}</span>
            </span>
            <Button className={TOUCH} variant="outline" size="icon" aria-label={`${props.label}: +`} disabled={props.value >= max} onClick={() => props.onChange(Math.min(max, props.value + step))}>
                <Plus aria-hidden />
            </Button>
        </span>
    );
}
