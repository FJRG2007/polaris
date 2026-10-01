"use client";

/**
 * Linked calendars: the Google and Microsoft accounts somebody linked, the
 * CalDAV servers and subscriptions they read, and the forms that add more.
 *
 * The screen draws at once; the list arrives from the server into skeleton
 * rows. A return from a provider's consent screen lands here with
 * `?provider=&connection=`, and its outcome is said once, above everything.
 */

import Link from "next/link";
import { useCalendarT } from "../i18n";
import { FieldRow, GroupHeading } from "../ui";
import { addressSchema } from "../../lib/schemas";
import { StatusNote, useIssueText } from "../public/kit";
import { useEffect, useState } from "react";
import type { SourceView } from "../../lib/wire";
import * as sources from "../../actions/sources";
import { hostUi } from "@polaris/app-host/client";
import { loadInstanceSettingsAction } from "../../actions/instance";
import type { InstanceSettings } from "../../lib/instance-settings";
import { cacheKey, dropCached, unwrap, useCachedRead } from "../cached-read";
import { CalDavForm, FeedForm, HolidayPicker, refreshOptions, REFRESH_CHOICES, SuggestedCalendars } from "./forms";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, KeyRound, Link2, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select, Skeleton } from "@polaris/ui";

type Accounts = Extract<Awaited<ReturnType<typeof sources.loadAccountsAction>>, { ok: true }>["accounts"];
type Instance = { settings: InstanceSettings; canManage: boolean };

const PROVIDER_NAMES = { google: "Google", microsoft: "Microsoft" } as const;

/** The outcome a return from the connection flow carries, as a sentence. */
function OutcomeBanner({ outcome, provider, onDismiss }: { outcome: string; provider: string; onDismiss: () => void }) {
    const t = useCalendarT();
    const name = provider === "microsoft" ? PROVIDER_NAMES.microsoft : PROVIDER_NAMES.google;
    const tone = outcome === "linked" ? "success" : outcome === "cancelled" ? "neutral" : outcome === "wrong_account" ? "warning" : "danger";
    const text =
        outcome === "linked"
            ? t("accounts.outcome.linked", { provider: name })
            : outcome === "cancelled"
              ? t("accounts.outcome.cancelled")
              : outcome === "wrong_account"
                ? t("accounts.outcome.wrongAccount", { provider: name })
                : outcome === "not_public"
                  ? t("accounts.outcome.notPublic", { provider: name })
                  : outcome === "taken"
                    ? t("accounts.outcome.taken", { provider: name })
                    : t("accounts.outcome.failed", { provider: name });
    return (
        <StatusNote tone={tone} className="flex items-start gap-2">
            <span className="min-w-0 flex-1">{text}</span>
            <button
                type="button"
                onClick={onDismiss}
                aria-label={t("accounts.outcome.dismiss")}
                title={t("accounts.outcome.dismiss")}
                className="shrink-0 opacity-70 hover:opacity-100"
            >
                <X className="size-4" aria-hidden />
            </button>
        </StatusNote>
    );
}

export function AccountsView({ linked, provider = "" }: { linked: string | null; provider?: string }) {
    const t = useCalendarT();
    const generic = t("errors.generic");
    const [outcome, setOutcome] = useState<string | null>(linked);
    const accounts = useCachedRead<Accounts>(cacheKey("accounts"), () =>
        unwrap(() => sources.loadAccountsAction(), generic).then((answer) => answer.accounts)
    );
    const instance = useCachedRead<Instance>(cacheKey("instance"), () =>
        unwrap(() => loadInstanceSettingsAction(), generic).then((answer) => ({ settings: answer.settings, canManage: answer.canManage }))
    );

    function dismiss(): void {
        setOutcome(null);
        // The flags would say it again on the next reload.
        try {
            window.history.replaceState(null, "", window.location.pathname);
        } catch {
            // Nothing to tidy.
        }
    }

    function changed(): void {
        dropCached("accounts");
        accounts.refresh();
    }

    const data = accounts.data;
    const allow = instance.data?.settings.allowSubscriptions ?? true;
    const subscribed = data?.subscribed ?? [];

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <div className="flex flex-col gap-1">
                <Link href="/calendar" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="size-3.5" aria-hidden />
                    {t("accounts.back")}
                </Link>
                <h1 className="text-[17px] font-semibold tracking-tight">{t("accounts.title")}</h1>
                <p className="text-muted-foreground">{t("accounts.lead")}</p>
            </div>

            {outcome ? <OutcomeBanner outcome={outcome} provider={provider} onDismiss={dismiss} /> : null}

            <section className="flex flex-col gap-2">
                <GroupHeading>{t("accounts.sourcesTitle")}</GroupHeading>
                {accounts.loading ? (
                    <SourceSkeleton />
                ) : accounts.error || !data ? (
                    <div className="flex items-center gap-2">
                        <StatusNote tone="danger" className="flex-1">
                            {t("accounts.loadFailed")}
                        </StatusNote>
                        <Button variant="outline" size="sm" onClick={accounts.refresh}>
                            {t("accounts.retry")}
                        </Button>
                    </div>
                ) : data.sources.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">{t("accounts.sourcesEmpty")}</p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {data.sources.map((source) => (
                            <SourceRow
                                key={source.id}
                                source={source}
                                reconnectUrl={source.kind === "google" || source.kind === "microsoft" ? data.linkUrls[source.kind] : null}
                                onReplace={(next) => accounts.replace({ ...data, sources: data.sources.map((entry) => (entry.id === next.id ? next : entry)) })}
                                onRemoved={(gone) => {
                                    if (gone) accounts.replace({ ...data, sources: data.sources.filter((entry) => entry.id !== source.id) });
                                    else changed();
                                }}
                            />
                        ))}
                    </ul>
                )}
            </section>

            <section className="flex flex-col gap-2">
                <GroupHeading>{t("accounts.linkedTitle")}</GroupHeading>
                {data ? <LinkedAccounts accounts={data} onChanged={changed} /> : <SourceSkeleton rows={1} />}
            </section>

            <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
                <h2 className="text-sm font-semibold">{t("accounts.caldav.title")}</h2>
                <p className="text-xs text-foreground-subtle">{t("accounts.caldav.lead")}</p>
                <CalDavForm onAdded={changed} />
            </section>

            <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
                <h2 className="text-sm font-semibold">{t("accounts.feed.title")}</h2>
                {allow ? (
                    <>
                        <p className="text-xs text-foreground-subtle">{t("accounts.feed.lead")}</p>
                        <FeedForm onAdded={changed} />
                    </>
                ) : (
                    <SubscriptionsOff canManage={instance.data?.canManage ?? false} />
                )}
            </section>

            {allow ? (
                <>
                    {instance.data ? <SuggestedCalendars suggested={instance.data.settings.suggested} onAdded={changed} subscribed={subscribed} /> : null}
                    <section className="flex flex-col gap-2">
                        <GroupHeading>{t("accounts.holidays.title")}</GroupHeading>
                        <p className="text-xs text-foreground-subtle">{t("accounts.holidays.lead")}</p>
                        <HolidayPicker onAdded={changed} subscribed={subscribed} />
                    </section>
                </>
            ) : null}
        </div>
    );
}

/** Subscribing by address is switched off by the operator. */
export function SubscriptionsOff({ canManage }: { canManage: boolean }) {
    const t = useCalendarT();
    return (
        <p className="text-[13px] text-muted-foreground">
            {t("accounts.subscriptionsOff")}{" "}
            {canManage ? (
                <Link href="/calendar/admin" className="text-foreground underline underline-offset-2">
                    {t("accounts.subscriptionsOn")}
                </Link>
            ) : null}
        </p>
    );
}

function SourceSkeleton({ rows = 2 }: { rows?: number }) {
    return (
        <div className="flex flex-col gap-2" aria-hidden>
            {Array.from({ length: rows }, (_, index) => (
                <div key={index} className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5">
                    <div className="flex flex-1 flex-col gap-1.5">
                        <Skeleton className="h-4 w-48 max-w-full" />
                        <Skeleton className="h-3 w-32" />
                    </div>
                    <Skeleton className="h-7 w-40" />
                </div>
            ))}
        </div>
    );
}

function LinkedAccounts({ accounts, onChanged }: { accounts: Accounts; onChanged: () => void }) {
    const t = useCalendarT();
    const Logo = hostUi.logos.IntegrationLogo;
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const unused = accounts.links.filter((link) => !link.used);
    const hasGoogle = accounts.links.some((link) => link.provider === "google");
    const hasMicrosoft = accounts.links.some((link) => link.provider === "microsoft");

    async function use(id: string): Promise<void> {
        setBusy(id);
        setError(null);
        try {
            await unwrap(() => sources.addLinkedAccountAction(id), t("errors.generic"));
            onChanged();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : t("errors.generic"));
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="flex flex-col gap-2">
            {error ? <StatusNote tone="danger">{error}</StatusNote> : null}
            {unused.length === 0 && accounts.links.length === 0 ? <p className="text-[13px] text-muted-foreground">{t("accounts.linkedEmpty")}</p> : null}
            {unused.length > 0 ? (
                <ul className="flex flex-col gap-2">
                    {unused.map((link) => (
                        <li key={link.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5">
                            <Logo slug={link.provider} className="size-5" />
                            <div className="min-w-0 flex-1">
                                <p className="truncate font-medium" title={link.label}>
                                    {link.label}
                                </p>
                                {!link.grantsCalendar ? <p className="text-xs text-foreground-subtle">{t("accounts.reconnectHint")}</p> : null}
                            </div>
                            {link.grantsCalendar ? (
                                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void use(link.id)}>
                                    {busy === link.id ? <Loader2 className="animate-spin" aria-hidden /> : null}
                                    {t("accounts.useForCalendars")}
                                </Button>
                            ) : (
                                <Button size="sm" variant="outline" asChild>
                                    <a href={accounts.linkUrls[link.provider]}>{t("accounts.reconnect")}</a>
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            ) : null}
            <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" asChild>
                    <a href={accounts.linkUrls.google}>
                        <Logo slug="google" className="size-4" />
                        {hasGoogle ? t("accounts.linkAnotherGoogle") : t("accounts.linkGoogle")}
                    </a>
                </Button>
                <Button size="sm" variant="secondary" asChild>
                    <a href={accounts.linkUrls.microsoft}>
                        <Logo slug="microsoft" className="size-4" />
                        {hasMicrosoft ? t("accounts.linkAnotherMicrosoft") : t("accounts.linkMicrosoft")}
                    </a>
                </Button>
            </div>
        </div>
    );
}

function statusTone(status: SourceView["status"]): "success" | "warning" | "danger" {
    return status === "ok" ? "success" : status === "auth" ? "warning" : "danger";
}

function SourceRow({
    source,
    reconnectUrl,
    onReplace,
    onRemoved
}: {
    source: SourceView;
    reconnectUrl: string | null;
    onReplace: (next: SourceView) => void;
    /** true: take it off the list now; false: the removal was refused, read the list again. */
    onRemoved: (gone: boolean) => void;
}) {
    const t = useCalendarT();
    const generic = t("errors.generic");
    const RelativeTime = hostUi.relativeTime.RelativeTime;
    const [confirm, confirmNode] = hostUi.confirmDialog.useConfirm();
    const [syncing, setSyncing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [passwordOpen, setPasswordOpen] = useState(false);
    const [addressOpen, setAddressOpen] = useState(false);
    const name = source.label || t(`accounts.kinds.${source.kind}`);
    const tone = statusTone(source.status);
    const chip = {
        success: "border-success-edge bg-success-soft text-success-ink",
        warning: "border-warning-edge bg-warning-soft text-warning-ink",
        danger: "border-danger-edge bg-danger-soft text-danger-ink"
    }[tone];

    async function syncNow(): Promise<void> {
        setSyncing(true);
        setError(null);
        try {
            const answer = await unwrap(() => sources.refreshSourceAction(source.id), generic);
            onReplace(answer.source);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : generic);
        } finally {
            setSyncing(false);
        }
    }

    async function interval(value: string): Promise<void> {
        const minutes = Number(value);
        if (minutes === source.refreshMinutes) return;
        const before = source;
        onReplace({ ...source, refreshMinutes: minutes });
        setError(null);
        try {
            await unwrap(() => sources.updateSourceAction({ id: source.id, refreshMinutes: minutes }), generic);
        } catch (caught) {
            onReplace(before);
            setError(caught instanceof Error ? caught.message : generic);
        }
    }

    async function remove(): Promise<void> {
        const sure = await confirm({
            title: t("accounts.removeTitle", { name }),
            description: t("accounts.removeBody"),
            confirmLabel: t("accounts.removeConfirm"),
            danger: true
        });
        if (!sure) return;
        onRemoved(true);
        try {
            await unwrap(() => sources.removeSourceAction(source.id), generic);
            dropCached("accounts");
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : generic);
            onRemoved(false);
        }
    }

    const intervalValue = REFRESH_CHOICES.some((choice) => choice.minutes === source.refreshMinutes) ? String(source.refreshMinutes) : "";

    return (
        <li className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2.5">
            {confirmNode}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-medium" title={name}>
                            {name}
                        </span>
                        <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted-foreground">{t(`accounts.kinds.${source.kind}`)}</span>
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-subtle">
                        <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]", chip)}>
                            {tone === "success" ? <CheckCircle2 className="size-3" aria-hidden /> : <AlertTriangle className="size-3" aria-hidden />}
                            {t(`accounts.status.${source.status}`)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <Clock className="size-3" aria-hidden />
                            {source.lastSyncAt ? <RelativeTime iso={source.lastSyncAt} /> : t("accounts.neverSynced")}
                        </span>
                        <span>{t("accounts.calendarCount", { count: source.calendarCount })}</span>
                    </p>
                    {source.kind === "ics" && source.url ? (
                        <p className="mt-0.5 truncate text-xs text-foreground-subtle" title={source.url}>
                            {source.url}
                        </p>
                    ) : null}
                    {source.status === "error" && source.lastError ? <p className="mt-0.5 text-xs text-foreground-subtle">{source.lastError}</p> : null}
                </div>
                <div className="flex items-center gap-1">
                    {source.status === "auth" && reconnectUrl ? (
                        <Button size="sm" variant="outline" asChild>
                            <a href={reconnectUrl}>{t("accounts.reconnect")}</a>
                        </Button>
                    ) : null}
                    {source.status === "auth" && source.kind === "ics" ? (
                        <Button size="sm" variant="outline" onClick={() => setAddressOpen(true)}>
                            {t("accounts.newAddress")}
                        </Button>
                    ) : null}
                    <Select
                        value={intervalValue}
                        onValueChange={(value) => void interval(value)}
                        options={refreshOptions(t)}
                        placeholder={t("accounts.feed.interval")}
                        aria-label={t("accounts.intervalFor", { name })}
                        className="w-40"
                    />
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={syncing}
                        onClick={() => void syncNow()}
                        aria-label={t("accounts.syncNow", { name })}
                        title={t("accounts.syncNow", { name })}
                    >
                        <RefreshCw className={syncing ? "animate-spin" : undefined} aria-hidden />
                    </Button>
                    {source.kind === "caldav" ? (
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => setPasswordOpen(true)}
                            aria-label={t("accounts.newPassword", { name })}
                            title={t("accounts.newPassword", { name })}
                        >
                            <KeyRound aria-hidden />
                        </Button>
                    ) : null}
                    {source.kind === "ics" ? (
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => setAddressOpen(true)}
                            aria-label={t("accounts.replaceAddress", { name })}
                            title={t("accounts.replaceAddress", { name })}
                        >
                            <Link2 aria-hidden />
                        </Button>
                    ) : null}
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => void remove()}
                        aria-label={t("accounts.remove", { name })}
                        title={t("accounts.remove", { name })}
                    >
                        <Trash2 aria-hidden />
                    </Button>
                </div>
            </div>
            {error ? <StatusNote tone="danger">{error}</StatusNote> : null}
            {source.kind === "caldav" ? (
                <PasswordDialog
                    open={passwordOpen}
                    onOpenChange={setPasswordOpen}
                    name={name}
                    onSaved={() => onReplace({ ...source, status: "ok", lastError: null })}
                    sourceId={source.id}
                />
            ) : null}
            {source.kind === "ics" ? (
                <AddressDialog open={addressOpen} onOpenChange={setAddressOpen} name={name} sourceId={source.id} onSaved={onReplace} />
            ) : null}
        </li>
    );
}

function PasswordDialog({
    open,
    onOpenChange,
    name,
    sourceId,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    name: string;
    sourceId: string;
    onSaved: () => void;
}) {
    const t = useCalendarT();
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            setPassword("");
            setError(null);
        }
    }, [open]);

    async function save(): Promise<void> {
        if (!password || busy) return;
        setBusy(true);
        setError(null);
        try {
            await unwrap(() => sources.updateSourceAction({ id: sourceId, password }), t("errors.generic"));
            onSaved();
            onOpenChange(false);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : t("errors.generic"));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("accounts.passwordTitle")}</DialogTitle>
                    <DialogDescription>{name}</DialogDescription>
                </DialogHeader>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                    className="flex flex-col gap-3"
                >
                    {/* A third-party service's app password, not a Polaris one: the identity and breach checks do not apply. */}
                    <Input
                        type="password"
                        autoComplete="off"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        aria-label={t("accounts.caldav.password")}
                        placeholder={t("accounts.caldav.password")}
                    />
                    <p className="text-xs text-foreground-subtle">{t("accounts.passwordHint")}</p>
                    {error ? <StatusNote tone="danger">{error}</StatusNote> : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("accounts.cancel")}
                        </Button>
                        <Button type="submit" disabled={busy} aria-disabled={!password}>
                            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                            {t("accounts.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** A feed's address is never read back: a new one replaces it, checked as it is
 *  typed with the schema the action checks. */
function AddressDialog({
    open,
    onOpenChange,
    name,
    sourceId,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    name: string;
    sourceId: string;
    onSaved: (next: SourceView) => void;
}) {
    const t = useCalendarT();
    const issueText = useIssueText();
    const [url, setUrl] = useState("");
    const [touched, setTouched] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            setUrl("");
            setTouched(false);
            setError(null);
        }
    }, [open]);

    const result = addressSchema.safeParse(url);
    const issue = touched && url.trim() !== "" && !result.success ? issueText(result.error.issues) : null;

    async function save(): Promise<void> {
        setTouched(true);
        if (!result.success || busy) return;
        const address = result.data;
        setBusy(true);
        setError(null);
        try {
            const answer = await unwrap(() => sources.updateSourceAction({ id: sourceId, url: address }), t("errors.generic"));
            onSaved(answer.source);
            onOpenChange(false);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : t("errors.generic"));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("accounts.addressTitle")}</DialogTitle>
                    <DialogDescription>{name}</DialogDescription>
                </DialogHeader>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                    className="flex flex-col gap-3"
                    noValidate
                >
                    <FieldRow label={`${t("accounts.feed.url")} *`} htmlFor={`${sourceId}-address`} error={issue} hint={t("accounts.addressHint")}>
                        <Input
                            id={`${sourceId}-address`}
                            type="url"
                            inputMode="url"
                            autoComplete="off"
                            placeholder="https://"
                            value={url}
                            onChange={(event) => setUrl(event.target.value)}
                            onBlur={() => setTouched(true)}
                        />
                    </FieldRow>
                    {error ? <StatusNote tone="danger">{error}</StatusNote> : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("accounts.cancel")}
                        </Button>
                        <Button type="submit" disabled={busy} aria-disabled={!result.success}>
                            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                            {t("accounts.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
