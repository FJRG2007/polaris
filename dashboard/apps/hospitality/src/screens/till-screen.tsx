"use client";

/**
 * The till: open the shift with its float, put cash in or take it out, read
 * the X report at any time, and close with a blind count - the expected
 * figure appears only after the count is entered - which gives the Z report.
 * Orders still open stay open for the next shift (the handover).
 *
 * Also the payment and discount dialogs the order panel opens.
 */

import { useMoney } from "./menu-screen";
import { parsePrice } from "../model/catalog-csv";
import { useHospitalityLive } from "./live-client";
import { readMenuAction } from "../actions/catalog";
import type { closeShift, xReport } from "../lib/till";
import { useCallback, useEffect, useState } from "react";
import { changeDue, quickTenders } from "../model/pricing";
import { readCache, unwrap, useHospitalityT } from "./i18n";
import { Banknote, CreditCard, Percent } from "lucide-react";
import { closeShiftAction, moveCashAction, openShiftAction, payAction, readTillAction, setDiscountAction } from "../actions/till";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, EmptyState, Input, Select, Skeleton, cn, useToast } from "@polaris/ui";

type Till = Awaited<ReturnType<typeof xReport>>;
type Closed = Awaited<ReturnType<typeof closeShift>>;

export function TillScreen() {
    const t = useHospitalityT();
    const toast = useToast();
    const [venue, setVenue] = useState<{ id: string; currency: string } | null>(null);
    const [till, setTill] = useState<Till | undefined>(undefined);
    const [float, setFloat] = useState("");
    const [move, setMove] = useState({ kind: "out", amount: "", reason: "" });
    const [count, setCount] = useState("");
    const [closed, setClosed] = useState<Closed | null>(null);
    const money = useMoney(venue?.currency ?? "EUR");
    const fail = (caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message });

    const load = useCallback(() => {
        unwrap(() => readMenuAction({ venueId: readCache<string>("venue") }), t("errors.loadFailed"))
            .then((answer) => {
                const v = answer.menu.venues.find((x) => x.id === answer.menu.venueId);
                if (!v) return setTill(null);
                setVenue({ id: v.id, currency: v.currency });
                return unwrap(() => readTillAction({ venueId: v.id }), t("errors.loadFailed")).then((x) => setTill(x.till));
            })
            .catch((caught: Error) => toast.show({ title: t("errors.loadFailed"), body: caught.message }));
    }, [t, toast]);
    useEffect(load, [load]);
    useHospitalityLive(venue?.id ?? null, load);

    if (till === undefined) return <Skeleton className="m-4 h-48" />;
    if (!venue) return <EmptyState title={t("service.noFloor")} description={t("service.noFloorHint")} />;

    if (closed) {
        return (
            <div className="mx-auto flex w-full max-w-md flex-col gap-3 p-4">
                <h2 className="text-xl font-semibold">{t("till.zTitle", { number: closed.zNumber })}</h2>
                <Row label={t("till.counted")} value={money(closed.counted)} />
                <Row label={t("till.expected")} value={money(closed.expected)} />
                <Row label={closed.difference < 0 ? t("till.short") : t("till.over")} value={money(Math.abs(closed.difference))} strong />
                <Report report={closed.report} money={money} />
                <Button onClick={() => { setClosed(null); load(); }}>{t("till.next")}</Button>
            </div>
        );
    }

    if (!till) {
        const cents = parsePrice(float);
        return (
            <div className="mx-auto flex w-full max-w-md flex-col gap-3 p-4">
                <h2 className="text-xl font-semibold">{t("till.openTitle")}</h2>
                <Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} placeholder="0,00" aria-label={t("till.float")} />
                <Button size="lg" disabled={cents === null} onClick={() => cents !== null && unwrap(() => openShiftAction({ venueId: venue.id, float: cents }), t("errors.saveFailed")).then(load).catch(fail)}>
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
                    <Button
                        variant="outline"
                        disabled={!moveCents}
                        onClick={() =>
                            moveCents &&
                            unwrap(() => moveCashAction({ id: crypto.randomUUID(), venueId: venue.id, kind: move.kind, amount: moveCents, reason: move.reason }), t("errors.saveFailed"))
                                .then(() => { setMove({ kind: "out", amount: "", reason: "" }); load(); })
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
                    <Button
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

/** Taking payment: cash with one-tap amounts and the change, card, or both. */
export function PayDialog(props: { orderId: string; due: number; currency: string; onClose: () => void; onPaid: (ticketNo: string | null) => void }) {
    const t = useHospitalityT();
    const toast = useToast();
    const money = useMoney(props.currency);
    const [tendered, setTendered] = useState("");
    const [pending, setPending] = useState(false);
    const typed = parsePrice(tendered);
    const pay = (method: "cash" | "card", amount: number, handed: number) => {
        if (pending) return;
        setPending(true);
        unwrap(() => payAction({ orderId: props.orderId, payments: [{ id: crypto.randomUUID(), method, amount, tendered: handed }] }), t("errors.saveFailed"))
            .then((answer) => {
                if (method === "cash" && handed > amount) toast.show({ title: t("pay.change", { amount: money(changeDue(amount, handed)) }) });
                if (answer.closed) props.onPaid(answer.ticketNo);
                else props.onClose();
            })
            .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }))
            .finally(() => setPending(false));
    };
    return (
        <Dialog open onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("pay.title", { amount: money(props.due) })}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-2">
                        {quickTenders(props.due).map((amount) => (
                            <Button key={amount} size="lg" variant="outline" disabled={pending} onClick={() => pay("cash", props.due, amount)}>
                                <Banknote aria-hidden /> {money(amount)}
                            </Button>
                        ))}
                    </div>
                    <div className="flex gap-2">
                        <Input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder={t("pay.handed")} aria-label={t("pay.handed")} />
                        <Button disabled={pending || typed === null || typed <= 0} onClick={() => typed !== null && pay("cash", Math.min(typed, props.due), typed)}>
                            {t("pay.methods.cash")}
                        </Button>
                    </div>
                    {typed !== null && typed > props.due ? <p className="text-lg font-semibold">{t("pay.change", { amount: money(changeDue(props.due, typed)) })}</p> : null}
                    {typed !== null && typed < props.due && typed > 0 ? <p className="text-sm text-muted-foreground">{t("pay.partial", { amount: money(props.due - typed) })}</p> : null}
                    <Button size="lg" disabled={pending} onClick={() => pay("card", props.due, 0)}>
                        <CreditCard aria-hidden /> {t("pay.card", { amount: money(props.due) })}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** A discount on the whole order, with a reason; Remove takes it off. */
export function DiscountDialog(props: { orderId: string; onClose: () => void; onSaved: () => void }) {
    const t = useHospitalityT();
    const toast = useToast();
    const [kind, setKind] = useState<"percent" | "amount">("percent");
    const [value, setValue] = useState("");
    const [reason, setReason] = useState("");
    const n = kind === "percent" ? Math.round(Number(value.replace(",", ".")) * 100) : parsePrice(value);
    const ok = n !== null && Number.isFinite(n) && n > 0 && (kind === "amount" || n <= 10_000);
    const save = (discount: { kind: "percent" | "amount"; value: number; reason: string } | null) =>
        unwrap(() => setDiscountAction({ orderId: props.orderId, discount }), t("errors.saveFailed"))
            .then(() => { props.onSaved(); props.onClose(); })
            .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }));
    return (
        <Dialog open onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("discount.title")}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="flex gap-2">
                        <Select value={kind} onValueChange={(k) => setKind(k as "percent" | "amount")} options={[{ value: "percent", label: "%" }, { value: "amount", label: t("prices.amount") }]} />
                        <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === "percent" ? "10" : "0,00"} aria-label={t("prices.value")} />
                    </div>
                    <Input value={reason} maxLength={80} onChange={(e) => setReason(e.target.value)} placeholder={t("discount.reason")} />
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={() => save(null)}>{t("discount.remove")}</Button>
                        <Button className="flex-1" disabled={!ok} onClick={() => ok && n !== null && save({ kind, value: n, reason })}>
                            <Percent aria-hidden /> {t("discount.apply")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
