"use client";

/**
 * A booking page as a visitor uses it: pick a time, say who you are and answer
 * the page's questions, then confirm from the email. Nothing is booked until
 * the address is confirmed; until then the time is only held.
 */

import { useState } from "react";
import { browserZone } from "../time";
import { useCalendarT } from "../i18n";
import { FieldRow, Linkified } from "../ui";
import { hostUi } from "@polaris/app-host/client";
import { SlotPicker } from "./booking-slot-picker";
import { requestBookingAction } from "../../actions/booking";
import { Button, Input, Select, Textarea } from "@polaris/ui";
import { ArrowLeft, Clock, MapPin, Mail } from "lucide-react";
import { formatRange, PublicFrame, StatusNote, useIssueText } from "./kit";
import type { PublicBookingPage, SlotView } from "../../lib/scheduling-wire";
import { answersSchemaFor, bookingRequestSchema, normalizeAddress, normalizePersonName } from "../../lib/scheduling-schemas";

/** What the page says about itself above the picker. */
export function BookingSummary({ page }: { page: PublicBookingPage }) {
    const t = useCalendarT();
    return (
        <div className="flex flex-col gap-1.5 text-muted-foreground">
            <span className="flex items-center gap-1.5">
                <Clock className="size-4" />
                {t("bookingPage.minutes", { n: page.durationMinutes })}
            </span>
            {page.location ? (
                <span className="flex min-w-0 items-center gap-1.5">
                    <MapPin className="size-4" />
                    <span className="break-words">{page.location}</span>
                </span>
            ) : null}
            {page.description ? <Linkified text={page.description} className="text-muted-foreground" /> : null}
        </div>
    );
}

export function BookingFlow({ page }: { page: PublicBookingPage }) {
    const t = useCalendarT();
    const issueText = useIssueText();
    const locale = hostUi.i18nProvider.useLocale();
    const [zone, setZone] = useState(browserZone);
    const [slot, setSlot] = useState<SlotView | null>(null);
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [note, setNote] = useState("");
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
    const [attempted, setAttempted] = useState(false);
    const [sending, setSending] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [sentTo, setSentTo] = useState<string | null>(null);
    const [revision, setRevision] = useState(0);

    const request = bookingRequestSchema.safeParse({ slug: page.slug, start: slot?.start ?? "", name, email, note, answers, timezone: zone });
    const answered = answersSchemaFor(page.questions).safeParse(answers);
    const valid = request.success && answered.success;

    const errorOf = (field: string, value: string): string | null => {
        if (!touched.has(field) && !attempted) return null;
        if (!attempted && value.trim() === "") return null;
        const source = field.startsWith("q:") ? (answered.success ? [] : answered.error.issues) : request.success ? [] : request.error.issues;
        const key = field.startsWith("q:") ? field.slice(2) : field;
        const found = source.filter((issue) => issue.path[0] === key);
        return found.length > 0 ? issueText(found) : null;
    };
    const touch = (field: string) => setTouched((current) => new Set(current).add(field));

    async function submit() {
        if (!slot || sending) return;
        if (!valid) {
            setAttempted(true);
            return;
        }
        setSending(true);
        setProblem(null);
        const answer = await hostUi.runAction.runAction(
            () => requestBookingAction({ slug: page.slug, start: slot.start, name, email, note, answers, timezone: zone }),
            setProblem
        );
        setSending(false);
        if (!answer) return;
        if (!answer.ok) {
            setProblem(answer.error);
            // Whatever the reason, the times on offer may have moved.
            setRevision((value) => value + 1);
            return;
        }
        setSentTo(answer.email);
    }

    if (sentTo && slot) {
        return (
            <PublicFrame title={page.title} subtitle={page.ownerName ? t("booking.with", { name: page.ownerName }) : undefined}>
                <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                    <span className="flex items-center gap-2 font-medium">
                        <Mail className="size-4" />
                        {t("booking.checkEmailTitle")}
                    </span>
                    <p className="text-muted-foreground">{t("booking.checkEmailBody", { email: sentTo })}</p>
                    <p>{formatRange(slot.start, slot.end, zone, locale)}</p>
                    <p className="text-xs text-foreground-subtle">{t("booking.checkEmailHint")}</p>
                </div>
            </PublicFrame>
        );
    }

    return (
        <PublicFrame title={page.title} subtitle={page.ownerName ? t("booking.with", { name: page.ownerName }) : undefined} wide>
            <BookingSummary page={page} />
            {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
            {!slot ? (
                <section className="rounded-lg border border-border bg-card p-4">
                    <SlotPicker slug={page.slug} zone={zone} onZoneChange={setZone} horizonDays={page.horizonDays} selected={null} onPick={setSlot} revision={revision} />
                </section>
            ) : (
                <form
                    className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                    noValidate
                >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{formatRange(slot.start, slot.end, zone, locale)}</span>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setSlot(null)}>
                            <ArrowLeft />
                            {t("booking.otherTime")}
                        </Button>
                    </div>
                    <FieldRow label={`${t("booking.name")} *`} htmlFor="bk-name" error={errorOf("name", name)}>
                        <Input
                            id="bk-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            onBlur={() => {
                                setName(normalizePersonName(name));
                                touch("name");
                            }}
                            autoComplete="name"
                            autoCapitalize="words"
                            maxLength={120}
                            aria-required
                        />
                    </FieldRow>
                    <FieldRow label={`${t("booking.email")} *`} htmlFor="bk-email" error={errorOf("email", email)}>
                        <Input
                            id="bk-email"
                            type="email"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            onBlur={() => {
                                setEmail(normalizeAddress(email));
                                touch("email");
                            }}
                            autoComplete="email"
                            maxLength={320}
                            aria-required
                        />
                    </FieldRow>
                    {page.questions.map((question) => {
                        const value = answers[question.id] ?? "";
                        const field = `q:${question.id}`;
                        const set = (next: string) => {
                            setAnswers((current) => ({ ...current, [question.id]: next }));
                            touch(field);
                        };
                        const label = question.required ? `${question.label} *` : question.label;
                        return (
                            <FieldRow key={question.id} label={label} htmlFor={`bk-${question.id}`} error={errorOf(field, value)}>
                                {question.kind === "long" ? (
                                    <Textarea id={`bk-${question.id}`} value={value} onChange={(event) => set(event.target.value)} rows={3} maxLength={4000} />
                                ) : question.kind === "choice" ? (
                                    <Select
                                        id={`bk-${question.id}`}
                                        value={value}
                                        onValueChange={set}
                                        options={question.options.map((option) => ({ value: option, label: option }))}
                                        placeholder={t("booking.pickOne")}
                                        aria-label={question.label}
                                        className="w-full"
                                    />
                                ) : (
                                    <Input id={`bk-${question.id}`} value={value} onChange={(event) => set(event.target.value)} onBlur={() => touch(field)} maxLength={500} />
                                )}
                            </FieldRow>
                        );
                    })}
                    <FieldRow label={t("booking.noteLabel")} htmlFor="bk-note" error={errorOf("note", note)}>
                        <Textarea id="bk-note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={2000} />
                    </FieldRow>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        {attempted && !valid ? <span className="mr-auto text-xs text-danger">{t("booking.fixFirst")}</span> : null}
                        <Button type="submit" disabled={sending} aria-disabled={!valid || undefined}>
                            {sending ? t("booking.sending") : t("booking.book")}
                        </Button>
                    </div>
                    <p className="text-xs text-foreground-subtle">{t("booking.confirmHint")}</p>
                </form>
            )}
        </PublicFrame>
    );
}
