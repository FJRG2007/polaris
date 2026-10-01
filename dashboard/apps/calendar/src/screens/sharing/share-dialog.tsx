"use client";

/**
 * Sharing a calendar with people and teams, and publishing it by link.
 *
 * Two dialogs over one calendar, as the calendar's menu offers them:
 * `ShareCalendarDialog` (who it is shared with, and how far) and
 * `PublishCalendarDialog` (the public link, the subscription link, the embed
 * code). Every change is drawn at once and taken back if the server refuses.
 */

import { useCalendarT } from "../i18n";
import { StatusNote } from "../public/kit";
import type { ShareView } from "../../lib/wire";
import { hostUi } from "@polaris/app-host/client";
import type { ShareLevel } from "../../lib/access";
import { linkBaseAction } from "../../actions/booking";
import type { CalendarDialogSlotProps } from "../slots";
import { emailSchema } from "../../lib/scheduling-schemas";
import { cacheKey, dropCached, unwrap, useCachedRead } from "../cached-read";
import { Loader2, RefreshCw, Send, Trash2, User, UsersRound } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
    Button,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Select,
    Skeleton
} from "@polaris/ui";
import * as sharing from "../../actions/sharing";

const LEVELS: readonly ShareLevel[] = ["freebusy", "read", "write", "manage"];

type Target =
    | { kind: "user"; id: string; name: string; detail: string }
    | { kind: "team"; id: string; name: string; detail: string };

// ---------------------------------------------------------------- sharing

/** Who a calendar is shared with, and how far. */
export function ShareCalendarDialog({
    calendar,
    open,
    onOpenChange,
    onChanged
}: CalendarDialogSlotProps) {
    const t = useCalendarT();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("shareDialog.title", { name: calendar.name })}</DialogTitle>
                    <DialogDescription>{t("shareDialog.lead")}</DialogDescription>
                </DialogHeader>
                {calendar.kind === "resource" ? (
                    <StatusNote tone="neutral">{t("shareDialog.notForRooms")}</StatusNote>
                ) : open ? (
                    <SharePanel
                        calendarId={calendar.id}
                        isOwner={calendar.reach === "owner"}
                        onChanged={onChanged}
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

function levelOptions(t: ReturnType<typeof useCalendarT>, isOwner: boolean) {
    return LEVELS.filter((level) => level !== "manage" || isOwner).map((level) => ({
        value: level,
        label: t(`shareDialog.levels.${level}`)
    }));
}

function SharePanel({
    calendarId,
    isOwner,
    onChanged
}: {
    calendarId: string;
    isOwner: boolean;
    onChanged: () => void;
}) {
    const t = useCalendarT();
    const generic = t("errors.generic");
    const key = cacheKey("shares", calendarId);
    const shares = useCachedRead<ShareView[]>(key, () =>
        unwrap(() => sharing.listSharesAction(calendarId), generic).then((answer) => answer.shares)
    );
    const [error, setError] = useState<string | null>(null);
    const [target, setTarget] = useState<Target | null>(null);
    const [level, setLevel] = useState<ShareLevel>("read");
    const [busy, setBusy] = useState(false);

    const list = shares.data ?? [];

    async function add(event: FormEvent): Promise<void> {
        event.preventDefault();
        if (!target || busy) return;
        const before = list;
        const optimistic: ShareView = {
            id: `pending-${target.kind}-${target.id}`,
            target: { kind: target.kind, id: target.id, name: target.name },
            access: level
        };
        shares.replace([...before.filter((share) => share.target.id !== target.id), optimistic]);
        setBusy(true);
        setError(null);
        try {
            const answer = await unwrap(
                () =>
                    sharing.shareCalendarAction({
                        calendarId,
                        target: { kind: target.kind, id: target.id },
                        access: level
                    }),
                generic
            );
            shares.replace(answer.shares);
            setTarget(null);
            onChanged();
        } catch (caught) {
            shares.replace(before);
            setError(caught instanceof Error ? caught.message : generic);
        } finally {
            setBusy(false);
        }
    }

    async function change(share: ShareView, access: ShareLevel): Promise<void> {
        if (access === share.access) return;
        const before = list;
        shares.replace(
            before.map((entry) => (entry.id === share.id ? { ...entry, access } : entry))
        );
        setError(null);
        try {
            const answer = await unwrap(
                () =>
                    sharing.shareCalendarAction({
                        calendarId,
                        target: { kind: share.target.kind, id: share.target.id },
                        access
                    }),
                generic
            );
            shares.replace(answer.shares);
            onChanged();
        } catch (caught) {
            shares.replace(before);
            setError(caught instanceof Error ? caught.message : generic);
        }
    }

    async function remove(share: ShareView): Promise<void> {
        const before = list;
        shares.replace(before.filter((entry) => entry.id !== share.id));
        setError(null);
        try {
            await unwrap(() => sharing.unshareCalendarAction(share.id), generic);
            dropCached("shares", calendarId);
            onChanged();
        } catch (caught) {
            shares.replace(before);
            setError(caught instanceof Error ? caught.message : generic);
        }
    }

    const options = levelOptions(t, isOwner);

    return (
        <div className="flex flex-col gap-4">
            <form onSubmit={(event) => void add(event)} className="flex flex-col gap-2">
                <TargetSearch value={target} onChange={setTarget} />
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Select
                        value={level}
                        onValueChange={(value) => setLevel(value as ShareLevel)}
                        options={options}
                        aria-label={t("shareDialog.levelLabel")}
                        className="sm:w-52"
                    />
                    <Button type="submit" disabled={!target || busy} className="sm:ml-auto">
                        {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                        {t("shareDialog.add")}
                    </Button>
                </div>
                {!isOwner ? (
                    <p className="text-xs text-foreground-subtle">{t("shareDialog.manageHint")}</p>
                ) : null}
            </form>

            {error ? <StatusNote tone="danger">{error}</StatusNote> : null}

            <section className="flex flex-col gap-2">
                <h3 className="text-[11px] font-medium uppercase tracking-wider text-foreground-subtle">
                    {t("shareDialog.sharedWith")}
                </h3>
                {shares.loading ? (
                    <div className="flex flex-col gap-2" aria-hidden>
                        {[0, 1].map((row) => (
                            <div key={row} className="flex items-center gap-2">
                                <Skeleton className="size-5 rounded-full" />
                                <Skeleton className="h-4 flex-1" />
                                <Skeleton className="h-7 w-36" />
                            </div>
                        ))}
                    </div>
                ) : shares.error ? (
                    <div className="flex items-center gap-2">
                        <StatusNote tone="danger" className="flex-1">
                            {t("shareDialog.loadFailed")}
                        </StatusNote>
                        <Button size="sm" variant="outline" onClick={shares.refresh}>
                            {t("shareDialog.retry")}
                        </Button>
                    </div>
                ) : list.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">{t("shareDialog.empty")}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                        {list.map((share) => {
                            // A manager cannot change or remove another manager: only the owner can.
                            const locked = share.access === "manage" && !isOwner;
                            const pending = share.id.startsWith("pending-");
                            return (
                                <li key={share.id} className="flex items-center gap-2 px-2.5 py-2">
                                    {share.target.kind === "team" ? (
                                        <UsersRound
                                            className="size-4 text-foreground-subtle"
                                            aria-hidden
                                        />
                                    ) : (
                                        <User
                                            className="size-4 text-foreground-subtle"
                                            aria-hidden
                                        />
                                    )}
                                    <span
                                        className="min-w-0 flex-1 truncate"
                                        title={share.target.name}
                                    >
                                        {share.target.name}
                                    </span>
                                    <Select
                                        value={share.access}
                                        onValueChange={(value) =>
                                            void change(share, value as ShareLevel)
                                        }
                                        options={locked ? levelOptions(t, true) : options}
                                        disabled={locked || pending}
                                        aria-label={t("shareDialog.levelFor", {
                                            name: share.target.name
                                        })}
                                        className="w-36 shrink-0 sm:w-44"
                                    />
                                    <Button
                                        type="button"
                                        size="icon-sm"
                                        variant="ghost"
                                        disabled={locked || pending}
                                        aria-label={t("shareDialog.remove", {
                                            name: share.target.name
                                        })}
                                        title={t("shareDialog.remove", { name: share.target.name })}
                                        onClick={() => void remove(share)}
                                    >
                                        <Trash2 aria-hidden />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
        </div>
    );
}

/** A field that finds people and teams, with the matches as a listbox under it. */
function TargetSearch({
    value,
    onChange
}: {
    value: Target | null;
    onChange: (target: Target | null) => void;
}) {
    const t = useCalendarT();
    const listId = useId();
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<Target[]>([]);
    const [searching, setSearching] = useState(false);
    const [active, setActive] = useState(0);
    const [open, setOpen] = useState(false);
    const turn = useRef(0);

    useEffect(() => {
        const term = query.trim();
        if (!open || value) return;
        const mine = ++turn.current;
        setSearching(true);
        const timer = setTimeout(() => {
            void hostUi.runAction
                .runAction(
                    () => sharing.shareTargetsAction(term),
                    () => undefined
                )
                .then((answer) => {
                    if (mine !== turn.current) return;
                    setSearching(false);
                    if (!answer || !answer.ok) {
                        setResults([]);
                        return;
                    }
                    setResults([
                        ...answer.people.map(
                            (person): Target => ({
                                kind: "user",
                                id: person.id,
                                name: person.name,
                                detail: person.username ? `@${person.username}` : ""
                            })
                        ),
                        ...answer.teams.map(
                            (team): Target => ({
                                kind: "team",
                                id: team.id,
                                name: team.name,
                                detail: t("shareDialog.teamOf", { org: team.orgName })
                            })
                        )
                    ]);
                    setActive(0);
                });
        }, 250);
        return () => clearTimeout(timer);
    }, [query, open, value, t]);

    function pick(target: Target): void {
        onChange(target);
        setQuery(target.name);
        setOpen(false);
    }

    return (
        <div className="relative flex flex-col gap-1">
            <label
                htmlFor={`${listId}-input`}
                className="text-xs font-medium text-muted-foreground"
            >
                {t("shareDialog.searchLabel")}
            </label>
            <Input
                id={`${listId}-input`}
                role="combobox"
                aria-expanded={open && !value}
                aria-controls={listId}
                aria-autocomplete="list"
                autoComplete="off"
                placeholder={t("shareDialog.searchPlaceholder")}
                value={query}
                onFocus={() => setOpen(true)}
                onChange={(event) => {
                    setQuery(event.target.value);
                    if (value) onChange(null);
                    setOpen(true);
                }}
                onKeyDown={(event) => {
                    if (!open || value) return;
                    if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setActive((index) => Math.min(index + 1, results.length - 1));
                    } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setActive((index) => Math.max(index - 1, 0));
                    } else if (event.key === "Enter" && results[active]) {
                        event.preventDefault();
                        pick(results[active]!);
                    } else if (event.key === "Escape") {
                        setOpen(false);
                    }
                }}
            />
            {open && !value ? (
                <ul
                    id={listId}
                    role="listbox"
                    aria-label={t("shareDialog.searchLabel")}
                    className="max-h-56 overflow-y-auto rounded-md border border-border bg-card py-1"
                >
                    {searching && results.length === 0 ? (
                        <li className="flex items-center gap-2 px-2.5 py-1.5 text-muted-foreground">
                            <Loader2 className="size-3.5 animate-spin" aria-hidden />
                            {t("shareDialog.searching")}
                        </li>
                    ) : results.length === 0 ? (
                        <li className="px-2.5 py-1.5 text-muted-foreground">
                            {t("shareDialog.noMatches")}
                        </li>
                    ) : (
                        results.map((result, index) => (
                            <li
                                key={`${result.kind}:${result.id}`}
                                role="option"
                                aria-selected={index === active}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => pick(result)}
                                onMouseEnter={() => setActive(index)}
                                className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 ${index === active ? "bg-card-hover" : ""}`}
                            >
                                {result.kind === "team" ? (
                                    <UsersRound
                                        className="size-4 text-foreground-subtle"
                                        aria-hidden
                                    />
                                ) : (
                                    <User className="size-4 text-foreground-subtle" aria-hidden />
                                )}
                                <span className="min-w-0 flex-1 truncate" title={result.name}>
                                    {result.name}
                                </span>
                                {result.detail ? (
                                    <span
                                        className="max-w-[45%] shrink truncate text-xs text-foreground-subtle"
                                        title={result.detail}
                                    >
                                        {result.detail}
                                    </span>
                                ) : null}
                            </li>
                        ))
                    )}
                </ul>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------- publishing

type Mode = "" | "busy" | "full";

/** The webcal address a subscription reads, on the configured domain. */
export function subscriptionLink(base: string, token: string): string {
    return `${base.replace(/^https?:\/\//i, "webcal://").replace(/\/+$/, "")}/api/calendar/public/${token}/feed.ics`;
}

/** The public link, the subscription link and the embed code of a calendar. */
export function publicLinks(base: string, token: string, title: string) {
    const root = base.replace(/\/+$/, "");
    const page = `${root}/cal/p/${token}`;
    const embedSrc = `${root}/cal/embed/${token}`;
    const safeTitle = title.replace(
        /[&"<>]/g,
        (ch) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[ch] ?? ch
    );
    return {
        page,
        subscribe: subscriptionLink(base, token),
        embed: `<iframe src="${embedSrc}" title="${safeTitle}" style="border:0" width="800" height="600" loading="lazy"></iframe>`
    };
}

/** Publishing a calendar by link: off, busy times only, or full details. */
export function PublishCalendarDialog({
    calendar,
    open,
    onOpenChange,
    onChanged
}: CalendarDialogSlotProps) {
    const t = useCalendarT();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {t("shareDialog.publishTitle", { name: calendar.name })}
                    </DialogTitle>
                    <DialogDescription>{t("shareDialog.publishLead")}</DialogDescription>
                </DialogHeader>
                {open ? (
                    <PublishPanel
                        calendarId={calendar.id}
                        name={calendar.name}
                        initialMode={calendar.publicMode}
                        initialToken={calendar.publicToken}
                        onChanged={onChanged}
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

function PublishPanel({
    calendarId,
    name,
    initialMode,
    initialToken,
    onChanged
}: {
    calendarId: string;
    name: string;
    initialMode: Mode;
    initialToken: string | null;
    onChanged: () => void;
}) {
    const t = useCalendarT();
    const generic = t("errors.generic");
    const [confirm, confirmNode] = hostUi.confirmDialog.useConfirm();
    const [mode, setMode] = useState<Mode>(initialMode);
    const [token, setToken] = useState<string | null>(initialMode ? initialToken : null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const base = useCachedRead<string>(
        cacheKey("link-base"),
        () => unwrap(() => linkBaseAction(), generic).then((answer) => answer.base),
        {
            freshMs: 10 * 60_000
        }
    );

    async function choose(next: Mode): Promise<void> {
        if (next === mode || busy) return;
        if (next === "" && mode !== "") {
            const sure = await confirm({
                title: t("shareDialog.offTitle"),
                description: t("shareDialog.offBody"),
                confirmLabel: t("shareDialog.offConfirm"),
                danger: true
            });
            if (!sure) return;
        }
        const before = { mode, token };
        setMode(next);
        if (next === "") setToken(null);
        setBusy(true);
        setError(null);
        try {
            const answer = await unwrap(
                () => sharing.publishCalendarAction({ calendarId, mode: next }),
                generic
            );
            setToken(answer.token);
            onChanged();
        } catch (caught) {
            setMode(before.mode);
            setToken(before.token);
            setError(caught instanceof Error ? caught.message : generic);
        } finally {
            setBusy(false);
        }
    }

    async function rotate(): Promise<void> {
        const sure = await confirm({
            title: t("shareDialog.rotateTitle"),
            description: t("shareDialog.rotateBody"),
            confirmLabel: t("shareDialog.rotateConfirm")
        });
        if (!sure) return;
        setBusy(true);
        setError(null);
        try {
            const answer = await unwrap(() => sharing.rotatePublicLinkAction(calendarId), generic);
            setToken(answer.token);
            onChanged();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : generic);
        } finally {
            setBusy(false);
        }
    }

    const links = useMemo(
        () =>
            token && base.data
                ? publicLinks(base.data, token, t("shareDialog.embedTitle", { name }))
                : null,
        [token, base.data, name, t]
    );

    return (
        <div className="flex flex-col gap-4">
            {confirmNode}
            <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                    {t("shareDialog.modeLabel")}
                </span>
                <SegmentedControl<Mode>
                    value={mode}
                    onValueChange={(value) => void choose(value)}
                    aria-label={t("shareDialog.modeLabel")}
                    options={[
                        { value: "", label: t("shareDialog.modes.off") },
                        { value: "busy", label: t("shareDialog.modes.busy") },
                        { value: "full", label: t("shareDialog.modes.full") }
                    ]}
                />
                <p className="text-xs text-foreground-subtle">
                    {mode === ""
                        ? t("shareDialog.modeHints.off")
                        : mode === "busy"
                          ? t("shareDialog.modeHints.busy")
                          : t("shareDialog.modeHints.full")}
                </p>
            </div>

            {error ? <StatusNote tone="danger">{error}</StatusNote> : null}

            {mode !== "" ? (
                links ? (
                    <div className="flex flex-col gap-3">
                        <LinkRow label={t("shareDialog.publicLink")} value={links.page} />
                        <LinkRow
                            label={t("shareDialog.subscribeLink")}
                            value={links.subscribe}
                            hint={t("shareDialog.subscribeHint")}
                        />
                        <LinkRow
                            label={t("shareDialog.embedCode")}
                            value={links.embed}
                            hint={t("shareDialog.embedHint")}
                        />
                        <MailLink calendarId={calendarId} />
                        <div>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void rotate()}
                                disabled={busy}
                            >
                                <RefreshCw aria-hidden />
                                {t("shareDialog.rotate")}
                            </Button>
                        </div>
                    </div>
                ) : base.error ? (
                    <StatusNote tone="danger">{base.error}</StatusNote>
                ) : (
                    <div className="flex flex-col gap-3" aria-hidden>
                        {[0, 1, 2].map((row) => (
                            <div key={row} className="flex flex-col gap-1">
                                <Skeleton className="h-3 w-24" />
                                <Skeleton className="h-8 w-full" />
                            </div>
                        ))}
                    </div>
                )
            ) : null}
        </div>
    );
}

function LinkRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
    const id = useId();
    return (
        <div className="flex flex-col gap-1">
            <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
                {label}
            </label>
            <div className="flex items-center gap-2">
                <Input
                    id={id}
                    readOnly
                    value={value}
                    onFocus={(event) => event.currentTarget.select()}
                    className="font-mono text-xs"
                />
                <CopyButton
                    value={value}
                    label={label}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-card-hover"
                />
            </div>
            {hint ? <p className="text-xs text-foreground-subtle">{hint}</p> : null}
        </div>
    );
}

function MailLink({ calendarId }: { calendarId: string }) {
    const t = useCalendarT();
    const id = useId();
    const [email, setEmail] = useState("");
    const [touched, setTouched] = useState(false);
    const [state, setState] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const parsed = emailSchema.safeParse(email);
    const problem =
        touched && email.trim() !== "" && !parsed.success ? t("booking.validation.email") : null;

    async function send(event: FormEvent): Promise<void> {
        event.preventDefault();
        setTouched(true);
        if (!parsed.success || busy) return;
        setBusy(true);
        setState(null);
        const generic = t("errors.generic");
        try {
            await unwrap(
                () => sharing.mailPublicLinkAction({ calendarId, email: parsed.data }),
                generic
            );
            setState({ tone: "success", text: t("shareDialog.sent", { email: parsed.data }) });
            setEmail("");
            setTouched(false);
        } catch (caught) {
            setState({ tone: "danger", text: caught instanceof Error ? caught.message : generic });
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={(event) => void send(event)} className="flex flex-col gap-1">
            <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
                {t("shareDialog.emailLabel")}
            </label>
            <div className="flex items-center gap-2">
                <Input
                    id={id}
                    type="email"
                    value={email}
                    placeholder={t("shareDialog.emailPlaceholder")}
                    onChange={(event) => setEmail(event.target.value)}
                    onBlur={() => setTouched(true)}
                    aria-invalid={problem ? true : undefined}
                />
                <Button
                    type="submit"
                    size="md"
                    variant="outline"
                    disabled={busy}
                    aria-disabled={!parsed.success}
                >
                    {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                    {t("shareDialog.send")}
                </Button>
            </div>
            {problem ? (
                <p role="alert" className="text-xs text-danger">
                    {problem}
                </p>
            ) : null}
            {state ? <StatusNote tone={state.tone}>{state.text}</StatusNote> : null}
        </form>
    );
}
