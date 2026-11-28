"use client";

/**
 * The till: open the shift with its float, put cash in or take it out, read
 * the X report at any time, and close with a blind count - the expected
 * figure appears only after the count is entered - which gives the Z report.
 * Orders still open stay open for the next shift (the handover).
 *
 * Also the payment and discount dialogs the order panel opens.
 */

import { TOUCH } from "./touch";
import { useMoney } from "./menu-screen";
import { parsePrice } from "../model/catalog-csv";
import { useHospitalityLive } from "./live-client";
import { readMenuAction } from "../actions/catalog";
import type { closeShift, xReport } from "../lib/till";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OrderView } from "../lib/orders";
import { useOfflineQueue, type OfflineQueue } from "./offline";
import { changeDue, itemsDue, lineTotal, quickTenders, splitEvenly } from "../model/pricing";
import { readCache, unwrap, useHospitalityT } from "./i18n";
import { LoadFailed, NoVenue } from "./states";
import { Banknote, CreditCard, Minus, Percent, Plus } from "lucide-react";
import { closeShiftAction, openShiftAction, payAction, readTillAction, setDiscountAction } from "../actions/till";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Select, Skeleton, cn, useToast } from "@polaris/ui";

type Till = Awaited<ReturnType<typeof xReport>>;
type Closed = Awaited<ReturnType<typeof closeShift>>;

export function TillScreen({ manager }: { manager: boolean }) {
    const t = useHospitalityT();
    const toast = useToast();
    const [venue, setVenue] = useState<{ id: string; currency: string } | null>(null);
    const [till, setTill] = useState<Till | undefined>(undefined);
    const [float, setFloat] = useState("");
    const [move, setMove] = useState({ kind: "out", amount: "", reason: "" });
    const [count, setCount] = useState("");
    const [closed, setClosed] = useState<Closed | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const money = useMoney(venue?.currency ?? "EUR");
    const fail = (caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message });
    // One id per cash movement being typed, so a retry is the same movement.
    const moveId = useRef(crypto.randomUUID());

    const load = useCallback(() => {
        unwrap(() => readMenuAction({ venueId: readCache<string>("venue") }), t("errors.loadFailed"))
            .then((answer) => {
                setFailed(null);
                const v = answer.menu.venues.find((x) => x.id === answer.menu.venueId);
                if (!v) return setTill(null);
                setVenue({ id: v.id, currency: v.currency });
                return unwrap(() => readTillAction({ venueId: v.id }), t("errors.loadFailed")).then((x) => setTill(x.till));
            })
            .catch((caught: Error) => setFailed(caught.message));
    }, [t]);
    useEffect(load, [load]);
    const queue = useOfflineQueue(load, (error) => toast.show({ title: t("errors.saveFailed"), body: error }));
    useHospitalityLive(venue?.id ?? null, load);

    if (failed && till === undefined) return <LoadFailed message={failed} onRetry={load} />;
    if (till === undefined) return <Skeleton className="m-4 h-48" />;
    if (!venue) return <NoVenue manager={manager} />;

    if (closed) {
        return (
            <div className="mx-auto flex w-full max-w-md flex-col gap-3 p-4">
                <h2 className="text-xl font-semibold">{t("till.zTitle", { number: closed.zNumber })}</h2>
                <Row label={t("till.counted")} value={money(closed.counted)} />
                <Row label={t("till.expected")} value={money(closed.expected)} />
                <Row label={closed.difference < 0 ? t("till.short") : t("till.over")} value={money(Math.abs(closed.difference))} strong />
                <Report report={closed.report} money={money} />
                <Button className={TOUCH} onClick={() => { setClosed(null); load(); }}>{t("till.next")}</Button>
            </div>
        );
    }

    if (!till) {
        const cents = parsePrice(float);
        return (
            <div className="mx-auto flex w-full max-w-md flex-col gap-3 p-4">
                <h2 className="text-xl font-semibold">{t("till.openTitle")}</h2>
                <Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} placeholder="0,00" aria-label={t("till.float")} />
                <Button className={TOUCH} size="lg" disabled={cents === null} onClick={() => cents !== null && unwrap(() => openShiftAction({ venueId: venue.id, float: cents }), t("errors.saveFailed")).then(load).catch(fail)}>
                    {t("till.open")}
                </Button>
            </div>
        );
    }

    const moveCents = parsePrice(move.amount);
    const countCents = parsePrice(count);
    return (
        <div className="mx-auto grid w-full max-w-4xl gap-6 p-4 md:grid-cols-2">
            <section className="flex min-w-0 flex-col gap-2">
                <h2 className="truncate text-lg font-semibold">{t("till.openSince", { name: till.shift.openedByName })}</h2>
                <Report report={till.report} money={money} hideExpected />
            </section>
            <section className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-col gap-2 rounded-lg border p-3">
                    <h3 className="font-medium">{t("till.moveTitle")}</h3>
                    <div className="flex gap-2">
                        <Select
                            value={move.kind}
                            onValueChange={(kind) => setMove({ ...move, kind })}
                            options={[
                                { value: "in", label: t("till.in") },
                                { value: "out", label: t("till.out") }
                            ]}
                        />
                        <Input inputMode="decimal" value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} placeholder="0,00" aria-label={t("till.amount")} />
                    </div>
                    <Input value={move.reason} maxLength={120} onChange={(e) => setMove({ ...move, reason: e.target.value })} placeholder={t("till.reason")} />
                    <Button className={TOUCH}
                        variant="outline"
                        disabled={!moveCents}
                        onClick={() =>
                            moveCents &&
                            // Recorded on this till even with the server away: the id it carries is stored once on replay.
                            queue
                                .submit([{ id: `cash:${moveId.current}`, kind: "cash", payload: { id: moveId.current, venueId: venue.id, kind: move.kind, amount: moveCents, reason: move.reason } }])
                                .then((result) => {
                                    if (result.refused.length > 0) return fail(new Error(result.refused[0]));
                                    moveId.current = crypto.randomUUID();
                                    setMove({ kind: "out", amount: "", reason: "" });
                                    if (result.left > 0) toast.show({ title: t("offline.queued") });
                                    else load();
                                })
                                .catch(fail)
                        }
                    >
                        {t("till.record")}
                    </Button>
                </div>
                <div className="flex flex-col gap-2 rounded-lg border p-3">
                    <h3 className="font-medium">{t("till.closeTitle")}</h3>
                    <p className="text-sm text-muted-foreground">{t("till.closeHint")}</p>
                    <Input inputMode="decimal" value={count} onChange={(e) => setCount(e.target.value)} placeholder="0,00" aria-label={t("till.counted")} />
                    <Button className={TOUCH}
                        disabled={countCents === null}
                        onClick={() =>
                            countCents !== null &&
                            unwrap(() => closeShiftAction({ venueId: venue.id, counted: countCents }), t("errors.saveFailed"))
                                .then((x) => { setClosed(x.closed); setCount(""); })
                                .catch(fail)
                        }
                    >
                        {t("till.close")}
                    </Button>
                </div>
            </section>
        </div>
    );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
    return (
        <div className={cn("flex min-w-0 justify-between gap-3", strong && "font-semibold")}>
            <span className="min-w-0 truncate" title={label}>{label}</span>
            <span className="shrink-0 tabular-nums">{value}</span>
        </div>
    );
}

function Report({ report, money, hideExpected }: { report: NonNullable<Till>["report"]; money: (c: number) => string; hideExpected?: boolean }) {
    const t = useHospitalityT();
    return (
        <div className="flex flex-col gap-1 text-sm">
            <Row label={t("till.orders")} value={String(report.orders)} />
            <Row label={t("till.sales")} value={money(report.sales)} strong />
            {report.byMethod.map((m) => (
                <Row key={m.method} label={t(`pay.methods.${m.method === "card" ? "card" : m.method === "cash" ? "cash" : "other"}`)} value={money(m.amount)} />
            ))}
            <Row label={t("till.discounts")} value={money(report.discounts)} />
            <Row label={t("till.tips")} value={money(report.tips)} />
            <Row label={t("till.in")} value={money(report.cashIn)} />
            <Row label={t("till.out")} value={money(report.cashOut)} />
            {report.taxes.map((x) => (
                <Row key={x.rateBp} label={t("till.tax", { rate: x.rateBp / 100 })} value={money(x.amount)} />
            ))}
            {hideExpected ? null : <Row label={t("till.expected")} value={money(report.expected)} />}
        </div>
    );
}

/** Suggested tips, as percentages of what is being paid. */
const TIP_PERCENTS = [5, 10] as const;

type PayMode = "whole" | "items" | "even";

/**
 * Taking payment: the whole bill, some items (split by item) or one equal
 * part; a tip on top; then cash with one-tap amounts and the change, or card.
 */
export function PayDialog(props: { order: OrderView; currency: string; queue: OfflineQueue; onClose: () => void; onPaid: (ticketNo: string | null) => void; }) {
    const t = useHospitalityT();
    const toast = useToast();
    const money = useMoney(props.currency);
    const left = Math.max(0, props.order.totals.total - props.order.paid);
    const live = props.order.lines.filter((l) => l.status !== "void");
    const open = live.filter((l) => !props.order.paidLineIds.includes(l.id));
    const [mode, setMode] = useState<PayMode>("whole");
    const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
    const [parts, setParts] = useState(2);
    const [tipPercent, setTipPercent] = useState<number | null>(null);
    const [tipTyped, setTipTyped] = useState("");
    const [tendered, setTendered] = useState("");
    const [pending, setPending] = useState(false);
    // A ref, not state: two taps in one frame both see `pending` false.
    const busy = useRef(false);
    // One payment id per amount, method and tip while the dialog is open, so a
    // retry after a lost answer is the same payment, never a second one.
    const paymentIds = useRef(new Map<string, string>());
    const due = Math.min(
        left,
        mode === "items" ? itemsDue(live, props.order.totals.total, chosen) : mode === "even" ? (splitEvenly(left, parts)[0] ?? 0) : left
    );
    const tip = tipPercent !== null ? Math.round((due * tipPercent) / 100) : (parsePrice(tipTyped) ?? 0);
    const total = due + tip;
    const typed = parsePrice(tendered);
    const pay = (method: "cash" | "card", handed: number) => {
        if (busy.current || due <= 0) return;
        busy.current = true;
        setPending(true);
        const lineIds = mode === "items" ? [...chosen] : [];
        const id = paymentId(`${method}:${due}:${tip}:${lineIds.join(",")}`);
        const payload = { orderId: props.order.id, payments: [{ id, method, amount: due, tip, tendered: handed, lineIds }] };
        const change = () => method === "cash" && handed > total && toast.show({ title: t("pay.change", { amount: money(changeDue(total, handed)) }) });
        // A payment is shown as done only once the server took it, or once it is in this
        // device's queue that replays it (same id, so it is stored once) when the server is back.
        // Anything already queued goes first, so the payment never overtakes the lines it pays.
        const queued = async () => {
            const result = await props.queue.submit([{ id: `pay:${id}`, kind: "pay", payload }]);
            if (result.refused.length > 0) throw new Error(result.refused[0]);
            change();
            if (result.left > 0) {
                toast.show({ title: t("offline.paymentQueued") });
                return props.onClose();
            }
            // Sent from the queue: ask again (the same id changes nothing) for the ticket number.
            const answer = await unwrap(() => payAction(payload), t("errors.saveFailed"));
            if (answer.closed) props.onPaid(answer.ticketNo);
            else props.onClose();
        };
        const direct = async () => {
            let answer: Awaited<ReturnType<typeof payAction>>;
            try {
                answer = await payAction(payload);
            } catch {
                // No answer at all (no network, the server restarting): keep it on the device.
                return queued();
            }
            if (!answer.ok) throw new Error(answer.error);
            change();
            if (answer.closed) props.onPaid(answer.ticketNo);
            else props.onClose();
        };
        (props.queue.waiting > 0 ? queued() : direct())
            .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }))
            .finally(() => { busy.current = false; setPending(false); });
    };
    const paymentId = (key: string) => {
        const known = paymentIds.current.get(key);
        if (known) return known;
        const made = crypto.randomUUID();
        paymentIds.current.set(key, made);
        return made;
    };
    const toggle = (id: string) =>
        setChosen((all) => {
            const next = new Set(all);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    return (
        <Dialog open onOpenChange={(isOpen) => !isOpen && props.onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("pay.title", { amount: money(total) })}</DialogTitle>
                </DialogHeader>
                <div className="flex max-h-[75dvh] flex-col gap-3 overflow-y-auto">
                    <div className="grid grid-cols-3 gap-1.5">
                        {(["whole", "items", "even"] as const).map((m) => (
                            <Button className={TOUCH} key={m} size="sm" variant={mode === m ? "primary" : "outline"} aria-pressed={mode === m} onClick={() => setMode(m)}>
                                <span className="truncate">{t(`pay.modes.${m}`)}</span>
                            </Button>
                        ))}
                    </div>
                    {mode === "items" ? (
                        <ul className="flex flex-col gap-1">
                            {open.map((l) => (
                                <li key={l.id}>
                                    <button
                                        type="button"
                                        aria-pressed={chosen.has(l.id)}
                                        onClick={() => toggle(l.id)}
                                        className={cn("flex w-full min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-start text-sm", chosen.has(l.id) && "border-primary bg-primary/10")}
                                    >
                                        <span className="w-6 shrink-0 text-end tabular-nums">{l.quantity}</span>
                                        <span className="min-w-0 flex-1 truncate" title={l.name}>{l.name}</span>
                                        <span className="shrink-0 tabular-nums">{money(lineTotal(l))}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {mode === "even" ? (
                        <div className="flex items-center gap-2">
                            <Button className={TOUCH} variant="outline" size="icon" aria-label={t("pay.fewer")} disabled={parts <= 2} onClick={() => setParts(parts - 1)}>
                                <Minus aria-hidden />
                            </Button>
                            <span className="min-w-0 flex-1 truncate text-center">{t("pay.parts", { count: parts, amount: money(due) })}</span>
                            <Button className={TOUCH} variant="outline" size="icon" aria-label={t("pay.more")} disabled={parts >= 50} onClick={() => setParts(parts + 1)}>
                                <Plus aria-hidden />
                            </Button>
                        </div>
                    ) : null}
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="me-1 text-sm text-muted-foreground">{t("pay.tip")}</span>
                        <Button className={TOUCH} size="sm" variant={tipPercent === null && !tipTyped ? "primary" : "outline"} onClick={() => { setTipPercent(null); setTipTyped(""); }}>
                            {t("pay.noTip")}
                        </Button>
                        {TIP_PERCENTS.map((p) => (
                            <Button className={TOUCH} key={p} size="sm" variant={tipPercent === p ? "primary" : "outline"} onClick={() => { setTipPercent(p); setTipTyped(""); }}>
                                {p} %
                            </Button>
                        ))}
                        <Input
                            className="w-24"
                            inputMode="decimal"
                            value={tipTyped}
                            onChange={(e) => { setTipTyped(e.target.value); setTipPercent(null); }}
                            placeholder="0,00"
                            aria-label={t("pay.tip")}
                        />
                    </div>
                    {due > 0 ? (
                        <>
                            <div className="grid grid-cols-2 gap-2">
                                {quickTenders(total).map((amount) => (
                                    <Button className={TOUCH} key={amount} size="lg" variant="outline" disabled={pending} onClick={() => pay("cash", amount)}>
                                        <Banknote aria-hidden /> {money(amount)}
                                    </Button>
                                ))}
                            </div>
                            <div className="flex gap-2">
                                <Input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder={t("pay.handed")} aria-label={t("pay.handed")} />
                                <Button className={TOUCH} disabled={pending || typed === null || typed < total} onClick={() => typed !== null && pay("cash", typed)}>
                                    {t("pay.methods.cash")}
                                </Button>
                            </div>
                            {typed !== null && typed > total ? <p className="text-lg font-semibold">{t("pay.change", { amount: money(changeDue(total, typed)) })}</p> : null}
                            {typed !== null && typed < total && typed > 0 ? <p className="text-sm text-muted-foreground">{t("pay.short", { amount: money(total - typed) })}</p> : null}
                            <Button className={TOUCH} size="lg" disabled={pending} onClick={() => pay("card", 0)}>
                                <CreditCard aria-hidden /> {t("pay.card", { amount: money(total) })}
                            </Button>
                            {due < left ? <p className="text-sm text-muted-foreground">{t("pay.partial", { amount: money(left - due) })}</p> : null}
                        </>
                    ) : (
                        <p className="text-sm text-muted-foreground">{t("pay.pickItems")}</p>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
/** A discount on the whole order or on one line, with a reason; Remove takes it off. */
export function DiscountDialog(props: { orderId: string; version?: number; lineId?: string; lineName?: string; onClose: () => void; onSaved: () => void }) {
    const t = useHospitalityT();
    const toast = useToast();
    const [kind, setKind] = useState<"percent" | "amount">("percent");
    const [value, setValue] = useState("");
    const [reason, setReason] = useState("");
    const n = kind === "percent" ? Math.round(Number(value.replace(",", ".")) * 100) : parsePrice(value);
    const ok = n !== null && Number.isFinite(n) && n > 0 && (kind === "amount" || n <= 10_000);
    const save = (discount: { kind: "percent" | "amount"; value: number; reason: string } | null) =>
        unwrap(() => setDiscountAction({ orderId: props.orderId, version: props.version, lineId: props.lineId ?? null, discount }), t("errors.saveFailed"))
            .then(() => { props.onSaved(); props.onClose(); })
            .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }));
    return (
        <Dialog open onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="truncate">{props.lineName ? t("discount.line", { name: props.lineName }) : t("discount.title")}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="flex gap-2">
                        <Select value={kind} onValueChange={(k) => setKind(k as "percent" | "amount")} options={[{ value: "percent", label: "%" }, { value: "amount", label: t("prices.amount") }]} />
                        <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === "percent" ? "10" : "0,00"} aria-label={t("prices.value")} />
                    </div>
                    <Input value={reason} maxLength={80} onChange={(e) => setReason(e.target.value)} placeholder={t("discount.reason")} />
                    <div className="flex gap-2">
                        <Button className={TOUCH} variant="outline" onClick={() => save(null)}>{t("discount.remove")}</Button>
                        <Button className={`flex-1 ${TOUCH}`} disabled={!ok} onClick={() => ok && n !== null && save({ kind, value: n, reason })}>
                            <Percent aria-hidden /> {t("discount.apply")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
