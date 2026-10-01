"use client";

/**
 * A booking as the links in its emails open it: the confirmation link offers
 * the button that confirms (never on opening - a mail scanner opens links
 * too), the manage link cancels or moves a confirmed booking.
 */

import { useState } from "react";
import { browserZone } from "../time";
import { useCalendarT } from "../i18n";
import { BookingSummary } from "./booking-flow";
import { hostUi } from "@polaris/app-host/client";
import { SlotPicker } from "./booking-slot-picker";
import { Button, buttonVariants } from "@polaris/ui";
import { formatRange, PublicFrame, StatusNote } from "./kit";
import { CalendarCheck, CalendarX, Repeat } from "lucide-react";
import type { ManagedBooking, SlotView } from "../../lib/scheduling-wire";
import { cancelBookingAction, confirmBookingAction, rescheduleBookingAction } from "../../actions/booking";

type Outcome =
    | { kind: "none" }
    | { kind: "confirmed"; manageToken: string | null }
    | { kind: "taken" }
    | { kind: "expired" }
    | { kind: "cancelled" }
    | { kind: "moved" };

export function BookingManage({ token, booking }: { token: string; booking: ManagedBooking }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const [confirmDialog, confirmNode] = hostUi.confirmDialog.useConfirm();
    const [state, setState] = useState(booking.state);
    const [when, setWhen] = useState({ start: booking.start, end: booking.end });
    const [zone, setZone] = useState(() => booking.timezone || browserZone());
    const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [moving, setMoving] = useState(false);
    const [picked, setPicked] = useState<SlotView | null>(null);
    const [revision, setRevision] = useState(0);
    const page = booking.page;
    const bookAgain = `/cal/book/${page.slug}`;

    async function call<T extends { ok: boolean }>(work: () => Promise<T>): Promise<Extract<T, { ok: true }> | null> {
        setBusy(true);
        setProblem(null);
        const answer = await hostUi.runAction.runAction(work, setProblem);
        setBusy(false);
        if (!answer) return null;
        if (!answer.ok) {
            setProblem((answer as unknown as { error: string }).error);
            return null;
        }
        return answer as Extract<T, { ok: true }>;
    }

    async function confirm() {
        const answer = await call(() => confirmBookingAction(token));
        if (!answer) return;
        if (answer.status === "confirmed") {
            setState("confirmed");
            setOutcome({ kind: "confirmed", manageToken: answer.manageToken });
        } else {
            setState(answer.status === "taken" ? "cancelled" : answer.status);
            setOutcome({ kind: answer.status });
        }
    }

    /** From the confirmation link of a booking already confirmed: the manage
     *  address, asked for again rather than guessed. */
    async function openManage() {
        const answer = await call(() => confirmBookingAction(token));
        if (answer?.manageToken) window.location.assign(`/cal/booking/${answer.manageToken}`);
    }

    async function cancel() {
        const sure = await confirmDialog({
            title: t("booking.cancelYoursTitle"),
            description: formatRange(when.start, when.end, zone, locale),
            confirmLabel: t("booking.cancelBooking"),
            cancelLabel: t("booking.keepBooking"),
            danger: true
        });
        if (!sure) return;
        const answer = await call(() => cancelBookingAction(token));
        if (!answer) return;
        setState("cancelled");
        setOutcome({ kind: "cancelled" });
        setMoving(false);
    }

    async function move() {
        if (!picked) return;
        const answer = await call(() => rescheduleBookingAction({ token, start: picked.start }));
        if (!answer) {
            setRevision((value) => value + 1);
            setPicked(null);
            return;
        }
        setWhen({ start: answer.start, end: answer.end });
        setMoving(false);
        setPicked(null);
        setOutcome({ kind: "moved" });
    }

    const again = (
        <a href={bookAgain} className={buttonVariants({ size: "sm", variant: "outline" })}>
            {t("booking.pickAnother")}
        </a>
    );

    return (
        <PublicFrame title={page.title} subtitle={page.ownerName ? t("booking.with", { name: page.ownerName }) : undefined}>
            {confirmNode}
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                <span className="font-medium">{formatRange(when.start, when.end, zone, locale)}</span>
                <BookingSummary page={page} />
            </div>

            {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}

            {outcome.kind === "confirmed" ? (
                <StatusNote tone="success">
                    <span>{t("booking.confirmedNow")}</span>{" "}
                    {outcome.manageToken ? (
                        <a href={`/cal/booking/${outcome.manageToken}`} className="underline underline-offset-2">
                            {t("booking.manageLink")}
                        </a>
                    ) : null}
                </StatusNote>
            ) : null}
            {outcome.kind === "moved" ? <StatusNote tone="success">{t("booking.movedNow")}</StatusNote> : null}
            {outcome.kind === "taken" ? <StatusNote tone="warning">{t("booking.takenMeanwhile")}</StatusNote> : null}

            {state === "pending" && booking.via === "confirm" ? (
                <div className="flex flex-col gap-2">
                    <p className="text-muted-foreground">{t("booking.confirmPrompt", { name: booking.name })}</p>
                    <div>
                        <Button onClick={() => void confirm()} disabled={busy}>
                            <CalendarCheck />
                            {busy ? t("booking.confirming") : t("booking.confirm")}
                        </Button>
                    </div>
                </div>
            ) : null}

            {state === "pending" && booking.via === "manage" ? <StatusNote tone="warning">{t("booking.notConfirmed")}</StatusNote> : null}

            {state === "expired" ? (
                <div className="flex flex-col gap-2">
                    <StatusNote tone="warning">{t("booking.expired")}</StatusNote>
                    <div>{again}</div>
                </div>
            ) : null}

            {state === "cancelled" ? (
                <div className="flex flex-col gap-2">
                    {outcome.kind === "taken" ? null : <StatusNote tone="neutral">{t("booking.isCancelled")}</StatusNote>}
                    <div>{again}</div>
                </div>
            ) : null}

            {state === "past" ? <StatusNote tone="neutral">{t("booking.alreadyPast")}</StatusNote> : null}

            {state === "confirmed" && booking.via === "confirm" && outcome.kind !== "confirmed" ? (
                <div className="flex flex-col gap-2">
                    <StatusNote tone="success">{t("booking.alreadyConfirmed")}</StatusNote>
                    <div>
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => void openManage()}>
                            {t("booking.manageLink")}
                        </Button>
                    </div>
                </div>
            ) : null}

            {state === "confirmed" && booking.via === "manage" ? (
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => setMoving((open) => !open)} aria-expanded={moving}>
                            <Repeat />
                            {t("booking.reschedule")}
                        </Button>
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => void cancel()}>
                            <CalendarX />
                            {t("booking.cancelBooking")}
                        </Button>
                    </div>
                    {moving ? (
                        <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                            <SlotPicker
                                slug={page.slug}
                                zone={zone}
                                onZoneChange={setZone}
                                horizonDays={page.horizonDays}
                                selected={picked?.start ?? null}
                                onPick={setPicked}
                                revision={revision}
                            />
                            {picked ? (
                                <div className="flex flex-wrap items-center justify-end gap-2">
                                    <span className="mr-auto text-muted-foreground">{formatRange(picked.start, picked.end, zone, locale)}</span>
                                    <Button size="sm" disabled={busy} onClick={() => void move()}>
                                        {t("booking.moveHere")}
                                    </Button>
                                </div>
                            ) : null}
                        </section>
                    ) : null}
                </div>
            ) : null}
        </PublicFrame>
    );
}
