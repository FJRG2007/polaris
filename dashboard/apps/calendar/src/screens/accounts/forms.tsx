"use client";

/**
 * The forms that bring an outside calendar in: a CalDAV server, one address
 * to subscribe to, a public holiday calendar, a calendar the operator
 * suggests. Shared by the accounts screen and the "add calendars" dialog.
 *
 * Each is checked as it is typed with the same schema the action checks; a
 * field nobody has touched yet is incomplete rather than wrong.
 */

import { useCalendarT } from "../i18n";
import { unwrap } from "../cached-read";
import { FieldRow, GroupHeading } from "../ui";
import * as sources from "../../actions/sources";
import { hostUi } from "@polaris/app-host/client";
import { StatusNote, useIssueText } from "../public/kit";
import { HOLIDAY_CALENDARS } from "../../lib/sync/holidays";
import { useId, useMemo, useState, type FormEvent } from "react";
import { Check, ExternalLink, Loader2, Plus, Search } from "lucide-react";
import { Button, cn, Input, Select, type SelectOption } from "@polaris/ui";
import { CALDAV_PRESETS, presetUrl, type CalDavPresetId } from "../../lib/sync/presets";
import { caldavSourceSchema, CALENDAR_COLORS, icsSourceSchema } from "../../lib/schemas";

/** How often a subscription may be refreshed, in minutes. */
export const REFRESH_CHOICES = [
    { minutes: 15, key: "m15" },
    { minutes: 30, key: "m30" },
    { minutes: 60, key: "h1" },
    { minutes: 180, key: "h3" },
    { minutes: 360, key: "h6" },
    { minutes: 720, key: "h12" },
    { minutes: 1440, key: "d1" },
    { minutes: 10080, key: "w1" }
] as const;

type Translator = ReturnType<typeof useCalendarT>;

export function refreshOptions(t: Translator): SelectOption[] {
    return REFRESH_CHOICES.map((choice) => ({
        value: String(choice.minutes),
        label: t(`accounts.intervals.${choice.key}`)
    }));
}

/** The issues of one field in a zod result. */
function issuesAt(
    result: {
        success: boolean;
        error?: { issues: { path: (string | number)[]; message: string }[] };
    },
    field: string
) {
    if (result.success || !result.error) return [];
    return result.error.issues.filter((issue) => issue.path[0] === field);
}

async function run<T extends { ok: boolean }>(
    call: () => Promise<T>,
    fallback: string
): Promise<{ error: string | null }> {
    try {
        await unwrap(call, fallback);
        return { error: null };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : fallback };
    }
}

// ---------------------------------------------------------------- subscription

export function FeedForm({
    onAdded,
    withProton = true
}: {
    onAdded: () => void;
    withProton?: boolean;
}) {
    const t = useCalendarT();
    const issueText = useIssueText();
    const id = useId();
    const [url, setUrl] = useState("");
    const [name, setName] = useState("");
    const [color, setColor] = useState<string>(CALENDAR_COLORS[0]);
    const [refresh, setRefresh] = useState("360");
    const [touched, setTouched] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

    const input = { url, name, color, refreshMinutes: Number(refresh) };
    const result = icsSourceSchema.safeParse(input);
    const shown = (field: string, value: string) => {
        if (!touched[field] || value.trim() === "") return null;
        const issues = issuesAt(result, field);
        return issues.length > 0 ? issueText(issues) : null;
    };

    async function submit(event: FormEvent): Promise<void> {
        event.preventDefault();
        setTouched({ url: true, name: true });
        if (!result.success || busy) return;
        setBusy(true);
        setNote(null);
        const outcome = await run(() => sources.addFeedAction(result.data), t("errors.generic"));
        setBusy(false);
        if (outcome.error) {
            setNote({ tone: "danger", text: outcome.error });
            return;
        }
        setNote({ tone: "success", text: t("accounts.feed.added") });
        setUrl("");
        setName("");
        setTouched({});
        onAdded();
    }

    return (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3" noValidate>
            <FieldRow
                label={`${t("accounts.feed.url")} *`}
                htmlFor={`${id}-url`}
                error={shown("url", url)}
            >
                <Input
                    id={`${id}-url`}
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    placeholder="https://"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    onBlur={() => setTouched((held) => ({ ...held, url: true }))}
                />
            </FieldRow>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <FieldRow
                    label={`${t("accounts.feed.name")} *`}
                    htmlFor={`${id}-name`}
                    error={shown("name", name)}
                >
                    <Input
                        id={`${id}-name`}
                        value={name}
                        maxLength={120}
                        onChange={(event) => setName(event.target.value)}
                        onBlur={() => setTouched((held) => ({ ...held, name: true }))}
                    />
                </FieldRow>
                <FieldRow label={t("accounts.feed.interval")}>
                    <Select
                        value={refresh}
                        onValueChange={setRefresh}
                        options={refreshOptions(t)}
                        aria-label={t("accounts.feed.interval")}
                        className="sm:w-44"
                    />
                </FieldRow>
            </div>
            <ColorChoice value={color} onChange={setColor} />
            {note ? <StatusNote tone={note.tone}>{note.text}</StatusNote> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
                {withProton ? (
                    <p className="min-w-0 flex-1 text-xs text-foreground-subtle">
                        {t("accounts.feed.proton")}
                    </p>
                ) : (
                    <span />
                )}
                <Button type="submit" disabled={busy} aria-disabled={!result.success}>
                    {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    {t("accounts.feed.add")}
                </Button>
            </div>
        </form>
    );
}

function ColorChoice({ value, onChange }: { value: string; onChange: (color: string) => void }) {
    const t = useCalendarT();
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
                {t("accounts.feed.color")}
            </span>
            <div
                role="radiogroup"
                aria-label={t("accounts.feed.color")}
                className="flex flex-wrap gap-1.5"
            >
                {CALENDAR_COLORS.map((color) => (
                    <button
                        key={color}
                        type="button"
                        role="radio"
                        aria-checked={value === color}
                        aria-label={t("accounts.feed.colorOption", { color })}
                        title={t("accounts.feed.colorOption", { color })}
                        onClick={() => onChange(color)}
                        className={cn(
                            "inline-flex size-6 items-center justify-center rounded-full border-2 transition-colors duration-fast",
                            value === color ? "border-foreground" : "border-transparent"
                        )}
                        style={{ backgroundColor: color }}
                    >
                        {value === color ? (
                            <Check className="size-3.5 text-white" aria-hidden />
                        ) : null}
                    </button>
                ))}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- CalDAV

type PresetChoice = CalDavPresetId | "custom";

export function CalDavForm({ onAdded }: { onAdded: () => void }) {
    const t = useCalendarT();
    const issueText = useIssueText();
    const id = useId();
    const [preset, setPreset] = useState<PresetChoice>("icloud");
    const [customUrl, setCustomUrl] = useState("");
    const [host, setHost] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [touched, setTouched] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

    const chosen = CALDAV_PRESETS.find((entry) => entry.id === preset) ?? null;
    const ownHost = preset === "custom" || (chosen !== null && chosen.url === null);
    const urlSource = preset === "custom" ? customUrl : chosen && chosen.url === null ? host : "";
    const url =
        preset === "custom"
            ? customUrl
            : chosen
              ? chosen.url === null
                  ? host.trim()
                      ? presetUrl(chosen, host)
                      : ""
                  : presetUrl(chosen)
              : "";
    const result = caldavSourceSchema.safeParse({ url, username, password });
    const shown = (field: string, value: string) => {
        if (!touched[field] || value.trim() === "") return null;
        const issues = issuesAt(result, field);
        return issues.length > 0 ? issueText(issues) : null;
    };

    const options: SelectOption[] = [
        ...CALDAV_PRESETS.map((entry) => ({
            value: entry.id,
            label: t(`accounts.caldav.presets.${entry.id}`)
        })),
        { value: "custom", label: t("accounts.caldav.custom") }
    ];

    async function submit(event: FormEvent): Promise<void> {
        event.preventDefault();
        setTouched({ url: true, username: true, password: true });
        if (!result.success || busy) return;
        setBusy(true);
        setNote(null);
        const outcome = await run(() => sources.addCalDavAction(result.data), t("errors.generic"));
        setBusy(false);
        if (outcome.error) {
            setNote({ tone: "danger", text: outcome.error });
            return;
        }
        setNote({ tone: "success", text: t("accounts.caldav.added") });
        setPassword("");
        setTouched({});
        onAdded();
    }

    return (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-2">
                <FieldRow label={t("accounts.caldav.service")}>
                    <Select
                        value={preset}
                        onValueChange={(value) => setPreset(value as PresetChoice)}
                        options={options}
                        aria-label={t("accounts.caldav.service")}
                    />
                </FieldRow>
                {ownHost ? (
                    <FieldRow
                        label={`${preset === "custom" ? t("accounts.caldav.url") : t("accounts.caldav.nextcloudHost")} *`}
                        htmlFor={`${id}-url`}
                        error={shown("url", urlSource)}
                    >
                        <Input
                            id={`${id}-url`}
                            type="url"
                            inputMode="url"
                            autoComplete="off"
                            placeholder="https://"
                            value={preset === "custom" ? customUrl : host}
                            onChange={(event) =>
                                preset === "custom"
                                    ? setCustomUrl(event.target.value)
                                    : setHost(event.target.value)
                            }
                            onBlur={() => setTouched((held) => ({ ...held, url: true }))}
                        />
                    </FieldRow>
                ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                <FieldRow
                    label={`${t("accounts.caldav.username")} *`}
                    htmlFor={`${id}-user`}
                    error={shown("username", username)}
                >
                    <Input
                        id={`${id}-user`}
                        autoComplete="username"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        onBlur={() => setTouched((held) => ({ ...held, username: true }))}
                    />
                </FieldRow>
                <FieldRow
                    label={`${t("accounts.caldav.password")} *`}
                    htmlFor={`${id}-password`}
                    error={shown("password", password)}
                >
                    {/* A third-party service's app password, not a Polaris one: the identity and breach checks do not apply. */}
                    <Input
                        id={`${id}-password`}
                        type="password"
                        autoComplete="off"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        onBlur={() => setTouched((held) => ({ ...held, password: true }))}
                    />
                </FieldRow>
            </div>
            {note ? <StatusNote tone={note.tone}>{note.text}</StatusNote> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
                {chosen?.appPasswordHelp ? (
                    <a
                        href={chosen.appPasswordHelp}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                        {t("accounts.caldav.help")}
                        <ExternalLink className="size-3" aria-hidden />
                    </a>
                ) : (
                    <span />
                )}
                <Button type="submit" disabled={busy} aria-disabled={!result.success}>
                    {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    {busy ? t("accounts.caldav.checking") : t("accounts.caldav.add")}
                </Button>
            </div>
        </form>
    );
}

// ---------------------------------------------------------------- holidays and suggestions

/** One-click subscriptions: the button that adds a feed and says it did. */
function useFeedAdder(onAdded: () => void) {
    const t = useCalendarT();
    const [adding, setAdding] = useState<string | null>(null);
    const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
    const [error, setError] = useState<string | null>(null);
    async function add(
        url: string,
        name: string,
        color: string,
        refreshMinutes: number
    ): Promise<void> {
        if (adding) return;
        setAdding(url);
        setError(null);
        // Drawn as added at once; taken back when refused.
        setAdded((held) => new Set([...held, url]));
        const outcome = await run(
            () => sources.addFeedAction({ url, name: name.slice(0, 120), color, refreshMinutes }),
            t("errors.generic")
        );
        setAdding(null);
        if (outcome.error) {
            setAdded((held) => new Set([...held].filter((entry) => entry !== url)));
            setError(outcome.error);
            return;
        }
        onAdded();
    }
    return { adding, added, error, add };
}

export function HolidayPicker({
    onAdded,
    subscribed = []
}: {
    onAdded: () => void;
    subscribed?: readonly string[];
}) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const [query, setQuery] = useState("");
    const adder = useFeedAdder(onAdded);

    const groups = useMemo(() => {
        let regions: Intl.DisplayNames | null = null;
        let languages: Intl.DisplayNames | null = null;
        try {
            regions = new Intl.DisplayNames([locale], { type: "region" });
            languages = new Intl.DisplayNames([locale], { type: "language" });
        } catch {
            regions = null;
        }
        const byRegion = new Map<
            string,
            {
                region: string;
                name: string;
                feeds: { url: string; label: string; language: string }[];
            }
        >();
        for (const feed of HOLIDAY_CALENDARS) {
            const name = regions?.of(feed.region) ?? feed.name;
            const entry = byRegion.get(feed.region) ?? { region: feed.region, name, feeds: [] };
            entry.feeds.push({
                url: feed.url,
                label: name,
                language: languages?.of(feed.language) ?? feed.language
            });
            byRegion.set(feed.region, entry);
        }
        return [...byRegion.values()].sort((a, b) => a.name.localeCompare(b.name, locale));
    }, [locale]);

    const term = query.trim().toLocaleLowerCase(locale);
    const shown = term
        ? groups.filter(
              (group) =>
                  group.name.toLocaleLowerCase(locale).includes(term) ||
                  group.region.toLowerCase() === term
          )
        : groups;
    const taken = new Set([...subscribed, ...adder.added]);

    return (
        <div className="flex flex-col gap-2">
            <div className="relative">
                <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle"
                    aria-hidden
                />
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("accounts.holidays.search")}
                    aria-label={t("accounts.holidays.search")}
                    className="pl-8"
                />
            </div>
            {adder.error ? <StatusNote tone="danger">{adder.error}</StatusNote> : null}
            {shown.length === 0 ? (
                <p className="py-2 text-[13px] text-muted-foreground">
                    {t("accounts.holidays.noMatch")}
                </p>
            ) : (
                <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
                    {shown.flatMap((group) =>
                        group.feeds.map((feed) => {
                            const label =
                                group.feeds.length > 1
                                    ? `${group.name} (${feed.language})`
                                    : group.name;
                            const done = taken.has(feed.url);
                            return (
                                <li
                                    key={feed.url}
                                    className="flex items-center gap-2 px-2.5 py-1.5 text-[13px]"
                                >
                                    <span className="min-w-0 flex-1 truncate" title={label}>
                                        {label}
                                    </span>
                                    {done ? (
                                        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success-ink">
                                            <Check className="size-3.5" aria-hidden />
                                            {t("accounts.holidays.added")}
                                        </span>
                                    ) : (
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            disabled={adder.adding !== null}
                                            aria-label={t("accounts.holidays.add", { name: label })}
                                            title={t("accounts.holidays.add", { name: label })}
                                            onClick={() =>
                                                void adder.add(feed.url, label, "#2ca02c", 10080)
                                            }
                                        >
                                            {adder.adding === feed.url ? (
                                                <Loader2 className="animate-spin" aria-hidden />
                                            ) : (
                                                <Plus aria-hidden />
                                            )}
                                        </Button>
                                    )}
                                </li>
                            );
                        })
                    )}
                </ul>
            )}
        </div>
    );
}

export function SuggestedCalendars({
    suggested,
    onAdded,
    subscribed = []
}: {
    suggested: readonly { name: string; url: string }[];
    onAdded: () => void;
    subscribed?: readonly string[];
}) {
    const t = useCalendarT();
    const adder = useFeedAdder(onAdded);
    if (suggested.length === 0) return null;
    const taken = new Set([...subscribed, ...adder.added]);
    return (
        <div className="flex flex-col gap-2">
            <GroupHeading>{t("accounts.suggested.title")}</GroupHeading>
            <p className="text-xs text-foreground-subtle">{t("accounts.suggested.lead")}</p>
            {adder.error ? <StatusNote tone="danger">{adder.error}</StatusNote> : null}
            <ul className="divide-y divide-border rounded-md border border-border">
                {suggested.map((entry) => (
                    <li
                        key={entry.url}
                        className="flex items-center gap-2 px-2.5 py-1.5 text-[13px]"
                    >
                        <span className="min-w-0 flex-1 truncate" title={entry.url}>
                            {entry.name}
                        </span>
                        {taken.has(entry.url) ? (
                            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success-ink">
                                <Check className="size-3.5" aria-hidden />
                                {t("accounts.holidays.added")}
                            </span>
                        ) : (
                            <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                disabled={adder.adding !== null}
                                aria-label={t("accounts.suggested.add", { name: entry.name })}
                                title={t("accounts.suggested.add", { name: entry.name })}
                                onClick={() =>
                                    void adder.add(entry.url, entry.name, CALENDAR_COLORS[1], 1440)
                                }
                            >
                                {adder.adding === entry.url ? (
                                    <Loader2 className="animate-spin" aria-hidden />
                                ) : (
                                    <Plus aria-hidden />
                                )}
                            </Button>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}
