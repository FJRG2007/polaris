"use client";

/**
 * One booking page's settings: what it is, which calendar a booking lands in
 * and which ones count as busy, how long a meeting is and when it may start,
 * the weekly hours and the dates that differ, and what a visitor is asked.
 *
 * Checked against the same schema the server uses as it is typed; saving is
 * offered only when something differs from what was loaded.
 */

import Link from "next/link";
import { browserZone } from "../time";
import { useCalendarT } from "../i18n";
import { useRouter } from "next/navigation";
import { ZonePicker } from "../zone-picker";
import { FieldRow, GroupHeading } from "../ui";
import { BookingsList } from "./bookings-list";
import * as actions from "../../actions/booking";
import { hostUi } from "@polaris/app-host/client";
import { QuestionsEditor } from "./questions-editor";
import { StatusNote, useIssueText } from "../public/kit";
import { AvailabilityEditor } from "./availability-editor";
import type { BookingPageView } from "../../lib/scheduling-wire";
import { cacheKey, unwrap, useCachedRead } from "../cached-read";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { bookingPageInputSchema } from "../../lib/scheduling-schemas";
import { ArrowLeft, CopyPlus, ExternalLink, Trash2 } from "lucide-react";
import { BookingOffNote } from "./booking-off-note";
import {
    bookingUrl,
    forgetBookingPages,
    useBookingSwitch,
    useCalendarList,
    useLinkBase
} from "./reads";
import { draftOf, inputOf, newDraft, writableCalendars, type BookingDraft } from "./model";
import {
    Button,
    Checkbox,
    CopyButton,
    Input,
    SegmentedControl,
    Select,
    Skeleton,
    Switch,
    Textarea,
    buttonVariants
} from "@polaris/ui";

type Field = keyof BookingDraft;

/** The first problem each field has, by field. */
function problemsOf(draft: BookingDraft): Map<string, { message: string }[]> {
    const parsed = bookingPageInputSchema.safeParse(inputOf(draft));
    const found = new Map<string, { message: string }[]>();
    if (parsed.success) return found;
    for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "");
        if (!found.has(field)) found.set(field, [issue]);
    }
    return found;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
            <GroupHeading>{title}</GroupHeading>
            {children}
        </section>
    );
}

function NumberInput({
    id,
    value,
    onChange,
    onBlur,
    min,
    max
}: {
    id: string;
    value: number | null;
    onChange: (value: number | null) => void;
    onBlur: () => void;
    min: number;
    max: number;
}) {
    return (
        <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={value === null ? "" : String(value)}
            onChange={(event) =>
                onChange(event.target.value === "" ? null : Math.round(Number(event.target.value)))
            }
            onBlur={onBlur}
            className="w-full sm:w-32"
        />
    );
}

export function BookingPageEditor({ pageId }: { pageId: string | null }) {
    const t = useCalendarT();
    const router = useRouter();
    const issueText = useIssueText();
    const base = useLinkBase();
    const calendars = useCalendarList();
    const switched = useBookingSwitch();
    const off = switched !== null && !switched.allowed;
    const [confirm, confirmNode] = hostUi.confirmDialog.useConfirm();
    const page = useCachedRead<BookingPageView>(
        pageId ? cacheKey("booking-page", pageId) : null,
        async () =>
            (await unwrap(() => actions.bookingPageAction(pageId), t("errors.generic"))).page
    );

    const [baseline, setBaseline] = useState<BookingDraft | null>(null);
    const [draft, setDraft] = useState<BookingDraft | null>(null);
    const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
    const [attempted, setAttempted] = useState(false);
    const [saving, setSaving] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    // The form starts from the stored page, or - for a new one - from the
    // first calendar a booking can go into.
    useEffect(() => {
        if (draft) return;
        if (pageId && page.data) {
            const loaded = draftOf(page.data);
            setBaseline(loaded);
            setDraft(loaded);
        } else if (!pageId && calendars.data) {
            const first = writableCalendars(calendars.data)[0];
            const fresh = newDraft(browserZone(), first?.id ?? "");
            setBaseline(fresh);
            setDraft(fresh);
        }
    }, [draft, pageId, page.data, calendars.data]);

    const problems = useMemo(
        () => (draft ? problemsOf(draft) : new Map<string, { message: string }[]>()),
        [draft]
    );
    const dirty =
        draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
    const valid = problems.size === 0;

    const set = <K extends Field>(field: K, value: BookingDraft[K]) => {
        setSaved(false);
        setDraft((current) => (current ? { ...current, [field]: value } : current));
        setTouched((current) => new Set(current).add(field));
    };
    const touch = (field: Field) => setTouched((current) => new Set(current).add(field));
    const errorOf = (field: Field): string | null => {
        const found = problems.get(field);
        if (!found || (!touched.has(field) && !attempted)) return null;
        // An empty required field is not filled in yet rather than wrong: the
        // asterisk and the disabled button say so until the person tries.
        if (
            !attempted &&
            draft &&
            typeof draft[field] === "string" &&
            (draft[field] as string).trim() === ""
        )
            return null;
        return issueText(found);
    };

    async function save() {
        if (!draft || saving) return;
        if (!valid) {
            setAttempted(true);
            return;
        }
        setSaving(true);
        setProblem(null);
        const answer = await hostUi.runAction.runAction(
            () =>
                pageId
                    ? actions.updateBookingPageAction(pageId, inputOf(draft))
                    : actions.createBookingPageAction(inputOf(draft)),
            setProblem
        );
        setSaving(false);
        if (!answer) return;
        if (!answer.ok) {
            setProblem(answer.error);
            return;
        }
        forgetBookingPages();
        if (!pageId) {
            router.push(`/calendar/booking/${answer.page.id}`);
            return;
        }
        const next = draftOf(answer.page);
        page.replace(answer.page);
        setBaseline(next);
        setDraft(next);
        setTouched(new Set());
        setAttempted(false);
        setSaved(true);
    }

    async function duplicate() {
        if (!pageId) return;
        const answer = await hostUi.runAction.runAction(
            () => actions.duplicateBookingPageAction(pageId),
            setProblem
        );
        if (!answer) return;
        if (!answer.ok) return setProblem(answer.error);
        forgetBookingPages();
        router.push(`/calendar/booking/${answer.page.id}`);
    }

    async function remove() {
        if (!pageId || !baseline) return;
        const sure = await confirm({
            title: t("bookingPage.deleteTitle", { title: baseline.title }),
            description: t("bookingPage.deleteBody"),
            confirmLabel: t("bookingPage.delete"),
            danger: true
        });
        if (!sure) return;
        const answer = await hostUi.runAction.runAction(
            () => actions.deleteBookingPageAction(pageId),
            setProblem
        );
        if (!answer) return;
        if (!answer.ok) return setProblem(answer.error);
        forgetBookingPages();
        router.push("/calendar/booking");
    }

    const loadError =
        (pageId ? page.error && !page.data : false) || (calendars.error && !calendars.data);
    const bookable = writableCalendars(calendars.data ?? []);
    const others = (calendars.data ?? []).filter(
        (calendar) => calendar.kind !== "resource" && calendar.id !== draft?.calendarId
    );
    const slug = baseline?.slug ?? "";

    return (
        <div className="flex flex-col gap-4">
            {confirmNode}
            <div className="flex flex-wrap items-center gap-2">
                <Link
                    href="/calendar/booking"
                    className={buttonVariants({ size: "sm", variant: "ghost" })}
                >
                    <ArrowLeft />
                    {t("bookingPage.allPages")}
                </Link>
                {pageId && slug ? (
                    <span className="ml-auto flex items-center gap-1">
                        {base ? (
                            <CopyButton
                                value={bookingUrl(base, slug)}
                                label={t("bookingPage.copyLink")}
                            />
                        ) : null}
                        <a
                            href={`/cal/book/${slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={t("bookingPage.preview")}
                            title={t("bookingPage.preview")}
                            className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
                        >
                            <ExternalLink />
                        </a>
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => void duplicate()}
                            aria-label={t("bookingPage.duplicate")}
                            title={t("bookingPage.duplicate")}
                        >
                            <CopyPlus />
                        </Button>
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => void remove()}
                            aria-label={t("bookingPage.delete")}
                            title={t("bookingPage.delete")}
                        >
                            <Trash2 />
                        </Button>
                    </span>
                ) : null}
            </div>

            {off ? <BookingOffNote canManage={switched?.canManage ?? false} /> : null}
            {loadError ? (
                <StatusNote tone="danger">
                    {(pageId ? page.error : null) ?? calendars.error}
                </StatusNote>
            ) : null}
            {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
            {saved && !dirty ? (
                <StatusNote tone="success">{t("bookingPage.saved")}</StatusNote>
            ) : null}
            {!pageId && calendars.data && bookable.length === 0 ? (
                <StatusNote tone="warning">{t("bookingPage.noWritable")}</StatusNote>
            ) : null}

            {!draft ? (
                <div className="flex flex-col gap-3" aria-busy>
                    {[0, 1, 2].map((block) => (
                        <div
                            key={block}
                            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
                        >
                            <Skeleton className="h-3 w-24" />
                            <Skeleton className="h-8 w-full" />
                            <Skeleton className="h-8 w-2/3" />
                        </div>
                    ))}
                </div>
            ) : (
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <Section title={t("bookingPage.sectionAbout")}>
                        <FieldRow
                            label={`${t("bookingPage.title")} *`}
                            htmlFor="bp-title"
                            error={errorOf("title")}
                        >
                            <Input
                                id="bp-title"
                                value={draft.title}
                                onChange={(event) => set("title", event.target.value)}
                                onBlur={() => touch("title")}
                                maxLength={120}
                                aria-required
                            />
                        </FieldRow>
                        {pageId ? (
                            <FieldRow
                                label={t("bookingPage.slug")}
                                htmlFor="bp-slug"
                                hint={base ? bookingUrl(base, draft.slug || "...") : undefined}
                                error={errorOf("slug")}
                            >
                                <Input
                                    id="bp-slug"
                                    value={draft.slug}
                                    onChange={(event) => set("slug", event.target.value)}
                                    onBlur={() => touch("slug")}
                                    maxLength={60}
                                />
                            </FieldRow>
                        ) : null}
                        <FieldRow
                            label={t("bookingPage.description")}
                            htmlFor="bp-description"
                            error={errorOf("description")}
                        >
                            <Textarea
                                id="bp-description"
                                value={draft.description}
                                onChange={(event) => set("description", event.target.value)}
                                rows={3}
                                maxLength={4000}
                            />
                        </FieldRow>
                        <FieldRow
                            label={t("bookingPage.location")}
                            htmlFor="bp-location"
                            error={errorOf("location")}
                        >
                            <Input
                                id="bp-location"
                                value={draft.location}
                                onChange={(event) => set("location", event.target.value)}
                                maxLength={500}
                            />
                        </FieldRow>
                        <FieldRow
                            label={t("bookingPage.visibility")}
                            hint={
                                draft.visibility === "public"
                                    ? t("bookingPage.visibilityPublicHint")
                                    : t("bookingPage.visibilityLinkHint")
                            }
                        >
                            <SegmentedControl
                                value={draft.visibility}
                                onValueChange={(value) => set("visibility", value)}
                                aria-label={t("bookingPage.visibility")}
                                options={[
                                    { value: "link", label: t("bookingPage.visibilityLink") },
                                    { value: "public", label: t("bookingPage.visibilityPublic") }
                                ]}
                            />
                        </FieldRow>
                        <label className="flex items-center justify-between gap-3">
                            <span className="flex flex-col">
                                <span>{t("bookingPage.enabled")}</span>
                                <span className="text-xs text-foreground-subtle">
                                    {t("bookingPage.enabledHint")}
                                </span>
                            </span>
                            <Switch
                                checked={draft.enabled}
                                onChange={(value) => set("enabled", value)}
                                disabled={off && !draft.enabled}
                                aria-label={t("bookingPage.enabled")}
                            />
                        </label>
                    </Section>

                    <Section title={t("bookingPage.sectionCalendars")}>
                        <FieldRow
                            label={`${t("bookingPage.calendar")} *`}
                            hint={t("bookingPage.calendarHint")}
                            error={errorOf("calendarId")}
                        >
                            <Select
                                value={draft.calendarId}
                                onValueChange={(value) => set("calendarId", value)}
                                options={bookable.map((calendar) => ({
                                    value: calendar.id,
                                    label: calendar.name
                                }))}
                                placeholder={t("bookingPage.pickCalendar")}
                                aria-label={t("bookingPage.calendar")}
                                className="w-full sm:w-72"
                            />
                        </FieldRow>
                        <div className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("bookingPage.conflicts")}
                            </span>
                            <p className="text-xs text-foreground-subtle">
                                {t("bookingPage.conflictsHint")}
                            </p>
                            {others.length === 0 ? (
                                <p className="text-foreground-subtle">
                                    {t("bookingPage.noOtherCalendars")}
                                </p>
                            ) : (
                                <ul className="flex flex-col gap-1.5">
                                    {others.map((calendar) => {
                                        const checked = draft.conflictIds.includes(calendar.id);
                                        return (
                                            <li key={calendar.id}>
                                                <label className="flex min-w-0 items-center gap-2">
                                                    <Checkbox
                                                        checked={checked}
                                                        onChange={(event) =>
                                                            set(
                                                                "conflictIds",
                                                                event.target.checked
                                                                    ? [
                                                                          ...draft.conflictIds,
                                                                          calendar.id
                                                                      ]
                                                                    : draft.conflictIds.filter(
                                                                          (id) => id !== calendar.id
                                                                      )
                                                            )
                                                        }
                                                    />
                                                    <span
                                                        aria-hidden
                                                        className="inline-block size-2.5 shrink-0 rounded-full"
                                                        style={{ backgroundColor: calendar.color }}
                                                    />
                                                    <span
                                                        className="truncate"
                                                        title={calendar.name}
                                                    >
                                                        {calendar.name}
                                                    </span>
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </Section>

                    <Section title={t("bookingPage.sectionTiming")}>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <FieldRow
                                label={t("bookingPage.duration")}
                                htmlFor="bp-duration"
                                error={errorOf("durationMinutes")}
                            >
                                <NumberInput
                                    id="bp-duration"
                                    value={draft.durationMinutes}
                                    min={5}
                                    max={720}
                                    onChange={(value) => set("durationMinutes", value ?? 0)}
                                    onBlur={() => touch("durationMinutes")}
                                />
                            </FieldRow>
                            <FieldRow
                                label={t("bookingPage.slotEvery")}
                                htmlFor="bp-slot"
                                error={errorOf("slotMinutes")}
                            >
                                <NumberInput
                                    id="bp-slot"
                                    value={draft.slotMinutes}
                                    min={5}
                                    max={720}
                                    onChange={(value) => set("slotMinutes", value ?? 0)}
                                    onBlur={() => touch("slotMinutes")}
                                />
                            </FieldRow>
                            <FieldRow
                                label={t("bookingPage.bufferBefore")}
                                htmlFor="bp-before"
                                error={errorOf("bufferBefore")}
                            >
                                <NumberInput
                                    id="bp-before"
                                    value={draft.bufferBefore}
                                    min={0}
                                    max={240}
                                    onChange={(value) => set("bufferBefore", value ?? 0)}
                                    onBlur={() => touch("bufferBefore")}
                                />
                            </FieldRow>
                            <FieldRow
                                label={t("bookingPage.bufferAfter")}
                                htmlFor="bp-after"
                                error={errorOf("bufferAfter")}
                            >
                                <NumberInput
                                    id="bp-after"
                                    value={draft.bufferAfter}
                                    min={0}
                                    max={240}
                                    onChange={(value) => set("bufferAfter", value ?? 0)}
                                    onBlur={() => touch("bufferAfter")}
                                />
                            </FieldRow>
                            <FieldRow
                                label={t("bookingPage.notice")}
                                htmlFor="bp-notice"
                                hint={t("bookingPage.noticeHint")}
                                error={errorOf("noticeMinutes")}
                            >
                                <NumberInput
                                    id="bp-notice"
                                    value={draft.noticeMinutes}
                                    min={0}
                                    max={86_400}
                                    onChange={(value) => set("noticeMinutes", value ?? 0)}
                                    onBlur={() => touch("noticeMinutes")}
                                />
                            </FieldRow>
                            <FieldRow
                                label={t("bookingPage.horizon")}
                                htmlFor="bp-horizon"
                                error={errorOf("horizonDays")}
                            >
                                <NumberInput
                                    id="bp-horizon"
                                    value={draft.horizonDays}
                                    min={1}
                                    max={365}
                                    onChange={(value) => set("horizonDays", value ?? 0)}
                                    onBlur={() => touch("horizonDays")}
                                />
                            </FieldRow>
                            <FieldRow
                                label={t("bookingPage.maxPerDay")}
                                htmlFor="bp-max"
                                hint={t("bookingPage.maxPerDayHint")}
                                error={errorOf("maxPerDay")}
                            >
                                <NumberInput
                                    id="bp-max"
                                    value={draft.maxPerDay}
                                    min={1}
                                    max={100}
                                    onChange={(value) => set("maxPerDay", value)}
                                    onBlur={() => touch("maxPerDay")}
                                />
                            </FieldRow>
                        </div>
                        <FieldRow
                            label={`${t("bookingPage.timezone")} *`}
                            htmlFor="bp-zone"
                            error={errorOf("timezone")}
                        >
                            <ZonePicker
                                id="bp-zone"
                                value={draft.timezone}
                                onChange={(zone) => set("timezone", zone)}
                                label={t("bookingPage.timezone")}
                            />
                        </FieldRow>
                    </Section>

                    <Section title={t("bookingPage.sectionHours")}>
                        <AvailabilityEditor
                            value={draft.availability}
                            onChange={(value) => set("availability", value)}
                            error={errorOf("availability")}
                        />
                    </Section>

                    <Section title={t("bookingPage.sectionQuestions")}>
                        <p className="text-xs text-foreground-subtle">
                            {t("bookingPage.questionsHint")}
                        </p>
                        <QuestionsEditor
                            value={draft.questions}
                            onChange={(value) => set("questions", value)}
                            error={errorOf("questions")}
                        />
                    </Section>

                    <Section title={t("bookingPage.sectionMeeting")}>
                        <label className="flex items-center justify-between gap-3">
                            <span className="flex flex-col">
                                <span>{t("bookingPage.meetingLink")}</span>
                                <span className="text-xs text-foreground-subtle">
                                    {t("bookingPage.meetingLinkHint")}
                                </span>
                            </span>
                            <Switch
                                checked={draft.meetingLink}
                                onChange={(value) => set("meetingLink", value)}
                                aria-label={t("bookingPage.meetingLink")}
                            />
                        </label>
                    </Section>

                    <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/95 py-3">
                        {attempted && !valid ? (
                            <span className="mr-auto text-xs text-danger">
                                {t("bookingPage.fixFirst")}
                            </span>
                        ) : null}
                        {dirty && baseline ? (
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => {
                                    setDraft(baseline);
                                    setTouched(new Set());
                                    setAttempted(false);
                                }}
                            >
                                {t("bookingPage.discard")}
                            </Button>
                        ) : null}
                        <Button
                            type="submit"
                            disabled={
                                saving || (!dirty && pageId !== null) || (off && pageId === null)
                            }
                            aria-disabled={!valid || undefined}
                        >
                            {saving
                                ? t("bookingPage.saving")
                                : pageId
                                  ? t("bookingPage.save")
                                  : t("bookingPage.create")}
                        </Button>
                    </div>
                </form>
            )}

            {pageId ? <BookingsList pageId={pageId} /> : null}
        </div>
    );
}
