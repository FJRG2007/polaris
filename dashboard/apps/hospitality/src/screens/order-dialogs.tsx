"use client";

/**
 * The dialogs the order panel opens: a product's options and the kitchen note
 * of a line, and moving a table - all of it, which joins the order already on
 * the table it goes to, or only some items (splitting the table).
 */

import { TOUCH } from "./touch";
import { useRef, useState } from "react";
import { useHospitalityT, unwrap } from "./i18n";
import type { ProductView } from "../lib/catalog";
import type { OrderView, RoomView } from "../lib/orders";
import { ArrowRightLeft, Check, Minus, Plus } from "lucide-react";
import { chooseModifiers, toggleModifier } from "../model/modifiers";
import { moveOrderAction, splitOrderAction } from "../actions/orders";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, cn, useToast } from "@polaris/ui";

/** A product's options and the note: Add stays off until every required group is chosen. */
export function LineDialog(props: {
    product: ProductView;
    modifierIds: string[];
    note: string;
    money: (cents: number) => string;
    onClose: () => void;
    onConfirm: (modifierIds: string[], note: string) => void;
}) {
    const t = useHospitalityT();
    const [ids, setIds] = useState(props.modifierIds);
    const [note, setNote] = useState(props.note);
    const groups = props.product.modifiers;
    const choice = chooseModifiers(groups, ids);
    return (
        <Dialog open onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle className="truncate">{props.product.name}</DialogTitle>
                </DialogHeader>
                <div className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto">
                    {groups.map((group) => {
                        const count = ids.filter((id) => group.options.some((o) => o.id === id)).length;
                        return (
                            <fieldset key={group.id} className="flex min-w-0 flex-col gap-2">
                                <legend className="flex w-full min-w-0 items-baseline gap-2">
                                    <span className="min-w-0 truncate font-medium" title={group.name}>{group.name}</span>
                                    <span className={cn("shrink-0 text-xs", count < group.min ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                                        {group.min > 0 ? t("order.pick", { count: group.min }) : t("order.upTo", { count: group.max })}
                                    </span>
                                </legend>
                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                    {group.options.map((option) => {
                                        const on = ids.includes(option.id);
                                        return (
                                            <Button
                                                key={option.id}
                                                variant={on ? "primary" : "outline"}
                                                aria-pressed={on}
                                                className={`h-auto min-h-11 min-w-0 flex-col items-start py-1.5 ${TOUCH}`}
                                                onClick={() => setIds(toggleModifier(groups, ids, option.id))}
                                            >
                                                <span className="w-full truncate text-start" title={option.name}>{option.name}</span>
                                                {option.price !== 0 ? (
                                                    <span className="text-xs tabular-nums opacity-80">{option.price > 0 ? "+" : ""}{props.money(option.price)}</span>
                                                ) : null}
                                            </Button>
                                        );
                                    })}
                                </div>
                            </fieldset>
                        );
                    })}
                    <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={t("order.note")} aria-label={t("order.note")} />
                </div>
                <Button className={TOUCH} size="lg" disabled={!choice.ok} onClick={() => choice.ok && props.onConfirm(ids, note.trim())}>
                    <Check aria-hidden /> {t("order.add")}
                </Button>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Moving a table. "All" moves the order (onto the order already open there, if
 * any); otherwise the quantities chosen go across and the rest stays.
 */
export function MoveDialog(props: {
    order: OrderView;
    fromTableId: string;
    rooms: RoomView[];
    busy: ReadonlySet<string>;
    onClose: () => void;
    onMoved: (tableId: string) => void;
}) {
    const t = useHospitalityT();
    const toast = useToast();
    const lines = props.order.lines.filter((l) => l.status !== "void" && !props.order.paidLineIds.includes(l.id));
    const [target, setTarget] = useState<string | null>(null);
    const [whole, setWhole] = useState(true);
    const [take, setTake] = useState<Record<string, number>>({});
    const [pending, setPending] = useState(false);
    // Ids made once per dialog: a retried split finds its lines stored and moves nothing twice.
    const ids = useRef({ order: crypto.randomUUID(), lines: new Map<string, string>() });
    const lineId = (id: string) => {
        const known = ids.current.lines.get(id);
        if (known) return known;
        const made = crypto.randomUUID();
        ids.current.lines.set(id, made);
        return made;
    };
    const chosen = lines.flatMap((l) => ((take[l.id] ?? 0) > 0 ? [{ lineId: l.id, quantity: take[l.id] ?? 0, newLineId: lineId(l.id) }] : []));
    const ready = target !== null && (whole || chosen.length > 0) && !pending;
    const targetName = props.rooms.flatMap((r) => r.tables).find((x) => x.id === target)?.name ?? "";

    const move = () => {
        if (!ready || !target) return;
        setPending(true);
        const work = whole
            ? unwrap(() => moveOrderAction({ orderId: props.order.id, tableId: target, version: props.order.version }), t("errors.saveFailed"))
            : unwrap(() => splitOrderAction({ orderId: props.order.id, version: props.order.version, tableId: target, targetOrderId: ids.current.order, lines: chosen }), t("errors.saveFailed"));
        work.then(() => { toast.show({ title: t("move.done", { table: targetName }) }); props.onMoved(target); })
            .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }))
            .finally(() => setPending(false));
    };

    return (
        <Dialog open onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("move.title")}</DialogTitle>
                </DialogHeader>
                <div className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto">
                    <div className="grid grid-cols-2 gap-2">
                        <Button className={TOUCH} variant={whole ? "primary" : "outline"} aria-pressed={whole} onClick={() => setWhole(true)}>{t("move.whole")}</Button>
                        <Button className={TOUCH} variant={whole ? "outline" : "primary"} aria-pressed={!whole} onClick={() => setWhole(false)}>{t("move.some")}</Button>
                    </div>
                    {whole ? null : (
                        <ul className="flex flex-col gap-1">
                            {lines.map((l) => {
                                const n = take[l.id] ?? 0;
                                const set = (q: number) => setTake({ ...take, [l.id]: Math.min(Math.max(q, 0), l.quantity) });
                                return (
                                    <li key={l.id} className="flex min-w-0 items-center gap-2 text-sm">
                                        <Button className={TOUCH} variant="ghost" size="icon" aria-label={t("order.less")} disabled={n === 0} onClick={() => set(n - 1)}>
                                            <Minus aria-hidden />
                                        </Button>
                                        <span className="w-12 shrink-0 text-center tabular-nums">{n}/{l.quantity}</span>
                                        <Button className={TOUCH} variant="ghost" size="icon" aria-label={t("order.more")} disabled={n === l.quantity} onClick={() => set(n + 1)}>
                                            <Plus aria-hidden />
                                        </Button>
                                        <span className="min-w-0 flex-1 truncate" title={l.name}>{l.name}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {props.rooms.map((room) => (
                        <section key={room.id} className="flex min-w-0 flex-col gap-2">
                            <h3 className="truncate text-sm font-medium text-muted-foreground" title={room.name}>{room.name}</h3>
                            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                                {room.tables.filter((x) => x.id !== props.fromTableId).map((x) => (
                                    <Button
                                        key={x.id}
                                        variant={x.id === target ? "primary" : "outline"}
                                        aria-pressed={x.id === target}
                                        className={cn("min-w-0", TOUCH, props.busy.has(x.id) && x.id !== target && "border-sky-600")}
                                        onClick={() => setTarget(x.id)}
                                    >
                                        <span className="truncate" title={x.name}>{x.name}</span>
                                    </Button>
                                ))}
                            </div>
                        </section>
                    ))}
                    {target && props.busy.has(target) ? <p className="text-sm text-muted-foreground">{t("move.joins", { table: targetName })}</p> : null}
                </div>
                <Button className={TOUCH} size="lg" disabled={!ready} onClick={move}>
                    <ArrowRightLeft aria-hidden /> {t("move.confirm")}
                </Button>
            </DialogContent>
        </Dialog>
    );
}
