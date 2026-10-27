"use client";

/**
 * Compose an announcement and see what was sent.
 *
 * The form validates against the same schema the action parses with, counts
 * who it reaches as the audience changes, and previews the text with the
 * placeholders filled in the way a reader in this browser's language and time
 * zone will see them. The history below lists what went out with its reach and
 * reads, and carries edit (while it has not started), duplicate, end and retract.
 */

import type { Locale } from "@polaris/core";
import { Copy, Pencil, Square, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Checkbox,
    ConfirmDeleteDialog,
    EmptyState,
    Input,
    Select,
    Textarea,
    useToast
} from "@polaris/ui";
import { useLiveRead } from "@/components/use-live-resource";
import type { HistoryRow } from "@/lib/announcements/service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import { fillPlaceholders, formatDuration } from "@/lib/announcements/placeholders";
import { AnnouncementMarkdown } from "@/components/announcements/announcement-markdown";
import {
    composeSchema,
    DEFAULT_LEAD_MINUTES,
    HISTORY_PAGE,
    NOBODY,
    normalizeCompose,
    SEVERITIES,
    TEMPLATES,
    type ComposeInput,
    type TemplateId
} from "@/lib/announcements/schema";
import {
    composeOfAction,
    countAudienceAction,
    endAnnouncementAction,
    findRecipientsAction,
    historyAction,
    retractAnnouncementAction,
    saveAnnouncementAction
} from "./actions";

type Named = { id: string; name: string };
type Texts = Record<string, { title: string; body: string }>;

const LEAD_CHOICES = [0, 1, 2, 6, 12, 24, 48, 72, 168];

function blank(templates: Texts): ComposeInput {
    return {
        kind: "announcement",
        template: "generic",
        // The generic template's body is a prompt, not a message: it is shown as
        // the field's placeholder, so an untouched form never sends it.
        localized: false,
        severity: "info",
        title: templates.generic?.title ?? "",
        body: "",
        linkUrl: null,
        linkLabel: null,
        audience: { ...NOBODY, everyone: true },
        sendNotice: true,
        showBanner: true,
        startsAt: null,
        endsAt: null,
        windowStart: null,
        windowEnd: null,
        leadMinutes: DEFAULT_LEAD_MINUTES,
        affected: [],
        notifySteps: true
    };
}

/** `datetime-local` speaks the browser's own zone without one; the form keeps ISO. */
function toLocalInput(iso: string | null): string {
    if (!iso) return "";
    const date = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function Chips({
    items,
    picked,
    onToggle,
    label
}: {
    items: Named[];
    picked: readonly string[];
    onToggle: (id: string) => void;
    label: string;
}) {
    if (items.length === 0) return null;
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <div className="flex flex-wrap gap-1.5">
                {items.map((item) => {
                    const on = picked.includes(item.id);
                    return (
                        <button
                            key={item.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() => onToggle(item.id)}
                            title={item.name}
                            className={
                                on
                                    ? "max-w-56 truncate rounded-full border border-primary bg-primary/10 px-2.5 py-0.5 text-xs font-medium"
                                    : "max-w-56 truncate rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                            }
                        >
                            {item.name}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export function AnnouncementsView({
    locale,
    templates,
    roles,
    groups,
    orgs
}: {
    locale: Locale;
    templates: Texts;
    roles: Named[];
    groups: Named[];
    orgs: Named[];
}) {
    const t = useTranslations("announcements");
    const toast = useToast();
    const [form, setForm] = useState<ComposeInput>(() => blank(templates));
    const [editing, setEditing] = useState<string | null>(null);
    const [people, setPeople] = useState<readonly PickedPerson[]>([]);
    const [affectedText, setAffectedText] = useState("");
    const [tried, setTried] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const [reach, setReach] = useState<number | null>(null);
    const [pending, startTransition] = useTransition();
    const [retracting, setRetracting] = useState<HistoryRow | null>(null);

    const loadHistory = useCallback(() => historyAction(), []);
    const { data: latest, refresh: refreshLatest } = useLiveRead<HistoryRow[]>({
        load: loadHistory,
        cacheKey: "admin-announcements",
        intervalMs: 60_000
    });
    // Older pages, read on request after the newest one the live read keeps fresh.
    const [older, setOlder] = useState<readonly HistoryRow[]>([]);
    const [olderDone, setOlderDone] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const history = useMemo(() => {
        if (latest == null) return null;
        const seen = new Set(latest.map((row) => row.id));
        return [...latest, ...older.filter((row) => !seen.has(row.id))];
    }, [latest, older]);
    const hasOlder =
        latest != null && (older.length === 0 ? latest.length >= HISTORY_PAGE : !olderDone);

    const showOlder = () => {
        const last = history?.[history.length - 1];
        if (!last) return;
        setLoadingOlder(true);
        void historyAction({ after: last.id, take: HISTORY_PAGE })
            .then((rows) => {
                setOlder((current) => [...current, ...rows]);
                setOlderDone(rows.length < HISTORY_PAGE);
            })
            .catch(() => toast.show({ title: t("admin.errors.failed") }))
            .finally(() => setLoadingOlder(false));
    };

    // Re-read what is listed, the older pages included, after something changed.
    const refresh = () => {
        refreshLatest();
        if (older.length === 0 || !history) return;
        void historyAction({ take: Math.min(history.length + 1, 1000) })
            .then((rows) => setOlder(rows))
            .catch(() => null);
    };

    const input = useMemo<ComposeInput>(
        () =>
            normalizeCompose({
                ...form,
                audience: { ...form.audience, userIds: people.map((person) => person.id) },
                affected: affectedText.split(",")
            }),
        [form, people, affectedText]
    );
    const check = composeSchema.safeParse(input);
    const issue = check.success ? null : check.error.issues[0];
    const issueKey = issue
        ? ((["audience", "delivery", "window", "order", "link"] as const).find(
              (one) => one === issue.message
          ) ?? (issue.path[0] === "title" ? "title" : "invalid"))
        : null;

    // The live count: asked a moment after the audience stops changing.
    const audienceKey = JSON.stringify(input.audience);
    useEffect(() => {
        setReach(null);
        const timer = window.setTimeout(() => {
            void countAudienceAction(JSON.parse(audienceKey)).then((answer) =>
                setReach(answer.count)
            );
        }, 300);
        return () => window.clearTimeout(timer);
    }, [audienceKey]);

    const set = <K extends keyof ComposeInput>(key: K, value: ComposeInput[K]) =>
        setForm((current) => {
            const next = { ...current, [key]: value };
            if (key === "title" || key === "body") {
                const own = templates[next.template];
                next.localized =
                    own !== undefined && next.title === own.title && next.body === own.body;
            }
            return next;
        });

    const pickTemplate = (id: TemplateId) =>
        setForm((current) => ({
            ...current,
            template: id,
            localized: id !== "generic",
            title: templates[id]?.title ?? "",
            body: id === "generic" ? "" : (templates[id]?.body ?? "")
        }));

    const pickKind = (kind: ComposeInput["kind"]) => {
        setForm((current) => ({
            ...current,
            kind,
            severity: kind === "maintenance" ? "warning" : current.severity
        }));
        pickTemplate(kind === "maintenance" ? "maintenanceScheduled" : "generic");
    };

    const toggle = (field: "roleIds" | "groupIds" | "orgIds", id: string) =>
        setForm((current) => {
            const list = current.audience[field];
            const next = list.includes(id) ? list.filter((one) => one !== id) : [...list, id];
            return { ...current, audience: { ...current.audience, [field]: next } };
        });

    const reset = () => {
        setForm(blank(templates));
        setPeople([]);
        setAffectedText("");
        setEditing(null);
        setTried(false);
        setServerError(null);
    };

    const load = (id: string, asEdit: boolean) =>
        startTransition(async () => {
            const result = await composeOfAction(id);
            if (!result.ok) {
                toast.show({ title: result.error });
                return;
            }
            setForm(asEdit ? result.input : { ...result.input, startsAt: null, endsAt: null });
            setAffectedText(result.input.affected.join(", "));
            setPeople(result.people);
            setEditing(asEdit ? id : null);
            setTried(false);
            setServerError(null);
            window.scrollTo({ top: 0, behavior: "smooth" });
        });

    const submit = () => {
        setTried(true);
        if (!check.success) return;
        startTransition(async () => {
            const result = await saveAnnouncementAction(editing, check.data);
            if (!result.ok) {
                setServerError(result.error);
                return;
            }
            toast.show({ title: editing ? t("admin.history.saved") : t("admin.history.sent") });
            reset();
            refresh();
        });
    };

    const end = (row: HistoryRow) =>
        startTransition(async () => {
            const result = await endAnnouncementAction(row.id);
            toast.show({
                title: result.ok
                    ? result.outcome === "cancelled"
                        ? t("admin.history.cancelled")
                        : t("admin.history.ended")
                    : result.error
            });
            refresh();
        });

    const retract = (row: HistoryRow) =>
        startTransition(async () => {
            const result = await retractAnnouncementAction(row.id);
            toast.show({ title: result.ok ? t("admin.history.retracted") : result.error });
            setRetracting(null);
            refresh();
        });

    // Preview: this browser's language and zone, which is what one reader sees.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const when = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: zone
    });
    const start = input.kind === "maintenance" ? input.windowStart : input.startsAt;
    const stop = input.kind === "maintenance" ? input.windowEnd : input.endsAt;
    const values = {
        start: when.format(start ? new Date(start) : new Date()),
        end: stop ? when.format(new Date(stop)) : t("vars.noEnd"),
        duration:
            start && stop
                ? formatDuration(Date.parse(stop) - Date.parse(start), locale)
                : t("vars.noEnd"),
        affected:
            input.affected.length > 0
                ? new Intl.ListFormat(locale, { type: "conjunction" }).format(input.affected)
                : t("vars.everything")
    };
    const scheduled =
        (input.kind === "announcement" &&
            input.startsAt !== null &&
            Date.parse(input.startsAt) > Date.now()) ||
        input.kind === "maintenance";
    const fieldError = (field: string) =>
        tried && issue && issue.path[0] === field ? t(`admin.errors.${issueKey!}`) : null;

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardBody className="flex flex-col gap-4">
                    {editing ? (
                        <p className="text-sm font-medium">{t("admin.compose.editTitle")}</p>
                    ) : null}
                    <div className="grid gap-3 sm:grid-cols-3">
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("admin.compose.kind")}
                            </span>
                            <Select
                                value={form.kind}
                                onValueChange={(value) => pickKind(value as ComposeInput["kind"])}
                                aria-label={t("admin.compose.kind")}
                                options={[
                                    {
                                        value: "announcement",
                                        label: t("admin.compose.kindAnnouncement")
                                    },
                                    {
                                        value: "maintenance",
                                        label: t("admin.compose.kindMaintenance")
                                    }
                                ]}
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("admin.compose.template")}
                            </span>
                            <Select
                                value={form.template}
                                onValueChange={(value) => pickTemplate(value as TemplateId)}
                                aria-label={t("admin.compose.template")}
                                options={TEMPLATES.map((id) => ({
                                    value: id,
                                    label: t(`admin.template.${id}`)
                                }))}
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("admin.compose.severity")}
                            </span>
                            <Select
                                value={form.severity}
                                onValueChange={(value) =>
                                    set("severity", value as ComposeInput["severity"])
                                }
                                aria-label={t("admin.compose.severity")}
                                options={SEVERITIES.map((id) => ({
                                    value: id,
                                    label: t(`admin.severity.${id}`)
                                }))}
                            />
                        </label>
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="text-xs font-medium text-muted-foreground">
                            {t("admin.compose.titleLabel")} *
                        </span>
                        <Input
                            value={form.title}
                            maxLength={120}
                            onChange={(event) => set("title", event.target.value)}
                            aria-invalid={fieldError("title") ? true : undefined}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="text-xs font-medium text-muted-foreground">
                            {t("admin.compose.bodyLabel")}
                        </span>
                        <Textarea
                            value={form.body}
                            placeholder={
                                form.template === "generic" ? templates.generic?.body : undefined
                            }
                            rows={4}
                            maxLength={2000}
                            onChange={(event) => set("body", event.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("admin.compose.bodyHint")}
                        </span>
                        <span className="text-xs text-muted-foreground">
                            {form.localized
                                ? t("admin.compose.translated")
                                : t("admin.compose.edited")}
                        </span>
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("admin.compose.linkUrl")}
                            </span>
                            <Input
                                value={form.linkUrl ?? ""}
                                placeholder="/drive"
                                onChange={(event) => set("linkUrl", event.target.value)}
                                aria-invalid={fieldError("linkUrl") ? true : undefined}
                            />
                            <span className="text-xs text-muted-foreground">
                                {fieldError("linkUrl") ?? t("admin.compose.linkHint")}
                            </span>
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("admin.compose.linkLabel")}
                            </span>
                            <Input
                                value={form.linkLabel ?? ""}
                                maxLength={40}
                                onChange={(event) => set("linkLabel", event.target.value)}
                            />
                        </label>
                    </div>

                    {form.kind === "maintenance" ? (
                        <div className="grid gap-3 sm:grid-cols-3">
                            <label className="flex min-w-0 flex-col gap-1 text-sm">
                                <span className="text-xs font-medium text-muted-foreground">
                                    {t("admin.compose.windowStart")} *
                                </span>
                                <Input
                                    type="datetime-local"
                                    value={toLocalInput(form.windowStart)}
                                    onChange={(event) =>
                                        set("windowStart", fromLocalInput(event.target.value))
                                    }
                                    aria-invalid={fieldError("windowStart") ? true : undefined}
                                />
                            </label>
                            <label className="flex min-w-0 flex-col gap-1 text-sm">
                                <span className="text-xs font-medium text-muted-foreground">
                                    {t("admin.compose.windowEnd")} *
                                </span>
                                <Input
                                    type="datetime-local"
                                    value={toLocalInput(form.windowEnd)}
                                    onChange={(event) =>
                                        set("windowEnd", fromLocalInput(event.target.value))
                                    }
                                    aria-invalid={fieldError("windowEnd") ? true : undefined}
                                />
                            </label>
                            <label className="flex min-w-0 flex-col gap-1 text-sm">
                                <span className="text-xs font-medium text-muted-foreground">
                                    {t("admin.compose.lead")}
                                </span>
                                <Select
                                    value={String((form.leadMinutes ?? DEFAULT_LEAD_MINUTES) / 60)}
                                    onValueChange={(value) =>
                                        set("leadMinutes", Number(value) * 60)
                                    }
                                    aria-label={t("admin.compose.lead")}
                                    options={LEAD_CHOICES.map((hours) => ({
                                        value: String(hours),
                                        label: t("admin.compose.leadHours", { count: hours })
                                    }))}
                                />
                            </label>
                            <label className="flex min-w-0 flex-col gap-1 text-sm sm:col-span-2">
                                <span className="text-xs font-medium text-muted-foreground">
                                    {t("admin.compose.affected")}
                                </span>
                                <Input
                                    value={affectedText}
                                    onChange={(event) => setAffectedText(event.target.value)}
                                />
                                <span className="text-xs text-muted-foreground">
                                    {t("admin.compose.affectedHint")}
                                </span>
                            </label>
                            <label className="flex items-center gap-2 self-center text-sm">
                                <Checkbox
                                    checked={form.notifySteps}
                                    onChange={(event) => set("notifySteps", event.target.checked)}
                                />
                                {t("admin.compose.notifySteps")}
                            </label>
                        </div>
                    ) : (
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="flex min-w-0 flex-col gap-1 text-sm">
                                <span className="text-xs font-medium text-muted-foreground">
                                    {t("admin.compose.startsAt")}
                                </span>
                                <Input
                                    type="datetime-local"
                                    value={toLocalInput(form.startsAt)}
                                    onChange={(event) =>
                                        set("startsAt", fromLocalInput(event.target.value))
                                    }
                                />
                                <span className="text-xs text-muted-foreground">
                                    {t("admin.compose.startsNow")}
                                </span>
                            </label>
                            <label className="flex min-w-0 flex-col gap-1 text-sm">
                                <span className="text-xs font-medium text-muted-foreground">
                                    {t("admin.compose.endsAt")}
                                </span>
                                <Input
                                    type="datetime-local"
                                    value={toLocalInput(form.endsAt)}
                                    onChange={(event) =>
                                        set("endsAt", fromLocalInput(event.target.value))
                                    }
                                    aria-invalid={fieldError("endsAt") ? true : undefined}
                                />
                                <span className="text-xs text-muted-foreground">
                                    {fieldError("endsAt") ?? t("admin.compose.noEnd")}
                                </span>
                            </label>
                        </div>
                    )}

                    <fieldset className="flex flex-col gap-3">
                        <legend className="mb-1 text-sm font-medium">
                            {t("admin.compose.audience")}
                        </legend>
                        <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                                checked={form.audience.everyone}
                                onChange={(event) =>
                                    setForm((current) => ({
                                        ...current,
                                        audience: {
                                            ...current.audience,
                                            everyone: event.target.checked
                                        }
                                    }))
                                }
                            />
                            {t("admin.compose.everyone")}
                        </label>
                        {form.audience.everyone ? null : (
                            <>
                                <Chips
                                    items={roles}
                                    picked={form.audience.roleIds}
                                    onToggle={(id) => toggle("roleIds", id)}
                                    label={t("admin.compose.roles")}
                                />
                                <Chips
                                    items={groups}
                                    picked={form.audience.groupIds}
                                    onToggle={(id) => toggle("groupIds", id)}
                                    label={t("admin.compose.groups")}
                                />
                                <Chips
                                    items={orgs}
                                    picked={form.audience.orgIds}
                                    onToggle={(id) => toggle("orgIds", id)}
                                    label={t("admin.compose.orgs")}
                                />
                                <PeoplePicker
                                    picked={people}
                                    onChange={setPeople}
                                    label={t("admin.compose.peopleLabel")}
                                    search={(query) => findRecipientsAction(query)}
                                />
                            </>
                        )}
                        <p className="text-sm font-medium" aria-live="polite">
                            {reach === null
                                ? t("admin.compose.counting")
                                : t("admin.compose.reaches", { count: reach })}
                        </p>
                        {fieldError("audience") ? (
                            <p className="text-xs text-destructive">{fieldError("audience")}</p>
                        ) : null}
                    </fieldset>

                    <fieldset className="flex flex-col gap-2">
                        <legend className="mb-1 text-sm font-medium">
                            {t("admin.compose.delivery")}
                        </legend>
                        <label className="flex items-start gap-2 text-sm">
                            <Checkbox
                                checked={form.sendNotice}
                                onChange={(event) => set("sendNotice", event.target.checked)}
                            />
                            <span className="min-w-0">
                                {t("admin.compose.sendNotice")}
                                <span className="block text-xs text-muted-foreground">
                                    {t("admin.compose.sendNoticeHint")}
                                </span>
                            </span>
                        </label>
                        <label className="flex items-start gap-2 text-sm">
                            <Checkbox
                                checked={form.showBanner}
                                onChange={(event) => set("showBanner", event.target.checked)}
                            />
                            <span className="min-w-0">
                                {t("admin.compose.showBanner")}
                                <span className="block text-xs text-muted-foreground">
                                    {t("admin.compose.showBannerHint")}
                                </span>
                            </span>
                        </label>
                        {fieldError("showBanner") ? (
                            <p className="text-xs text-destructive">{fieldError("showBanner")}</p>
                        ) : null}
                    </fieldset>

                    <div className="flex flex-col gap-1 rounded-lg border border-dashed p-3">
                        <span className="text-xs font-medium text-muted-foreground">
                            {t("admin.compose.preview")}
                        </span>
                        <p className="break-words text-sm font-medium">
                            {fillPlaceholders(input.title, values) || "-"}
                        </p>
                        <AnnouncementMarkdown
                            source={fillPlaceholders(input.body, values)}
                            className="text-xs"
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("admin.compose.previewHint")}
                        </span>
                    </div>

                    {tried &&
                    issueKey &&
                    !["audience", "showBanner", "linkUrl", "endsAt"].includes(
                        String(issue?.path[0])
                    ) ? (
                        <p className="text-sm text-destructive">{t(`admin.errors.${issueKey}`)}</p>
                    ) : null}
                    {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                        {editing ? (
                            <Button variant="ghost" onClick={reset} disabled={pending}>
                                {t("admin.compose.cancel")}
                            </Button>
                        ) : null}
                        <Button onClick={submit} disabled={pending} aria-disabled={!check.success}>
                            {editing
                                ? t("admin.compose.save")
                                : scheduled
                                  ? t("admin.compose.schedule")
                                  : t("admin.compose.send")}
                        </Button>
                    </div>
                </CardBody>
            </Card>

            <section className="flex flex-col gap-2">
                <h2 className="text-base font-semibold">{t("admin.history.title")}</h2>
                {history == null ? (
                    <div className="flex flex-col gap-2" aria-hidden>
                        {[0, 1, 2].map((one) => (
                            <div key={one} className="h-16 animate-pulse rounded-lg bg-muted" />
                        ))}
                    </div>
                ) : history.length === 0 ? (
                    <EmptyState
                        title={t("admin.history.empty")}
                        description={t("admin.history.emptyHint")}
                    />
                ) : (
                    <ul className="flex flex-col divide-y rounded-lg border">
                        {history.map((row) => {
                            const picks =
                                row.audience.roleIds.length +
                                row.audience.groupIds.length +
                                row.audience.orgIds.length +
                                row.audience.userIds.length;
                            const active = !["ended", "retracted"].includes(row.phase);
                            const start = row.windowStart ?? row.startsAt;
                            return (
                                <li
                                    key={row.id}
                                    className="flex flex-wrap items-start gap-3 px-3 py-2.5"
                                >
                                    <div className="min-w-0 grow basis-64">
                                        <p
                                            className="truncate text-sm font-medium"
                                            title={row.title}
                                        >
                                            {row.title}
                                        </p>
                                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                            <Badge variant="neutral">
                                                {t(`admin.phase.${row.phase}`)}
                                            </Badge>
                                            <Badge variant="neutral">
                                                {t(`admin.severity.${row.severity as "info"}`)}
                                            </Badge>
                                            <span>
                                                {new Date(start).toLocaleString(locale, {
                                                    dateStyle: "medium",
                                                    timeStyle: "short"
                                                })}
                                            </span>
                                            <span>
                                                {row.audience.everyone
                                                    ? t("admin.history.audienceEveryone")
                                                    : t("admin.history.audiencePicked", {
                                                          count: picks
                                                      })}
                                            </span>
                                            <span>
                                                {t("admin.history.reach", { count: row.reach })}
                                            </span>
                                            {row.sendNotice ? (
                                                <span>
                                                    {t("admin.history.read", { count: row.read })}
                                                </span>
                                            ) : null}
                                            {row.showBanner ? (
                                                <span>
                                                    {t("admin.history.dismissed", {
                                                        count: row.dismissed
                                                    })}
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {row.editable ? (
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                onClick={() => load(row.id, true)}
                                                aria-label={t("admin.history.edit")}
                                                title={t("admin.history.edit")}
                                            >
                                                <Pencil className="size-4" aria-hidden />
                                            </Button>
                                        ) : null}
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => load(row.id, false)}
                                            aria-label={t("admin.history.duplicate")}
                                            title={t("admin.history.duplicate")}
                                        >
                                            <Copy className="size-4" aria-hidden />
                                        </Button>
                                        {active ? (
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                onClick={() => end(row)}
                                                disabled={pending}
                                                aria-label={
                                                    row.kind === "maintenance" && row.editable
                                                        ? t("admin.history.cancelMaintenance")
                                                        : t("admin.history.end")
                                                }
                                                title={
                                                    row.kind === "maintenance" && row.editable
                                                        ? t("admin.history.cancelMaintenance")
                                                        : t("admin.history.end")
                                                }
                                            >
                                                <Square className="size-4" aria-hidden />
                                            </Button>
                                        ) : null}
                                        {row.phase !== "retracted" ? (
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                onClick={() => setRetracting(row)}
                                                aria-label={t("admin.history.retract")}
                                                title={t("admin.history.retract")}
                                            >
                                                <Undo2 className="size-4" aria-hidden />
                                            </Button>
                                        ) : null}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {hasOlder ? (
                    <Button
                        variant="ghost"
                        className="self-center"
                        onClick={showOlder}
                        disabled={loadingOlder}
                    >
                        {t("admin.history.older")}
                    </Button>
                ) : null}
            </section>
            <ConfirmDeleteDialog
                open={retracting !== null}
                onOpenChange={(open) => (open ? null : setRetracting(null))}
                name={retracting?.title ?? ""}
                kind={t("admin.title")}
                title={t("admin.history.retractTitle")}
                description={t("admin.history.retractBody")}
                confirmLabel={t("admin.history.retractConfirm")}
                onConfirm={() => (retracting ? retract(retracting) : undefined)}
            />
        </div>
    );
}
