"use client";

/**
 * A channel's settings, as a page of their own - Discord's Edit Channel.
 *
 * A section list down the left and the section on the right, closed with the
 * cross or Esc back to the channel. On a phone the list is the first screen and
 * each section opens over it with a way back, the way a phone's own settings
 * work. Reached from the gear on the channel's row, its right-click menu and the
 * header's menu, all three only for somebody who may change it - the same
 * `mayAdminister` every save behind this page is checked against.
 *
 * Overview and Permissions are one draft: changes collect under a bar that says
 * they are not saved yet, with Reset and Save, and survive moving between
 * sections - the bar is Discord's. Invite links and webhooks act at once, since
 * each of them is a thing being made rather than a setting being changed.
 *
 * Lives in the settings route's layout, so the draft is not dropped when the
 * section in the address changes.
 */

import Link from "next/link";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { useChat } from "./chat-context";
import { runAction } from "@/lib/run-action";
import { Avatar } from "@/components/avatar";
import { spokenWait } from "@/lib/chat/durations";
import type { NamespaceKey } from "@/lib/i18n/types";
import { AddPeopleDialog } from "./add-people-dialog";
import { usePathname, useRouter } from "next/navigation";
import { ShareDialog } from "@/components/access/share-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { InvitesSection, WebhooksSection } from "./channel-settings-links";
import type { ChatChannelView, ChatMemberView } from "@/lib/chat/chat-service";
import {
    ArrowLeft,
    ChevronRight,
    Hash,
    Link2,
    Loader2,
    Lock,
    ShieldCheck,
    SlidersHorizontal,
    Trash2,
    Volume2,
    Webhook,
    X
} from "lucide-react";
import {
    Button,
    cn,
    ConfirmDeleteDialog,
    EmptyState,
    Input,
    Select,
    Skeleton,
    Switch,
    Textarea
} from "@polaris/ui";

export const SETTINGS_SECTIONS = ["overview", "permissions", "invites", "integrations"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const SECTION_ICONS: Record<SettingsSection, typeof Hash> = {
    overview: SlidersHorizontal,
    permissions: ShieldCheck,
    invites: Link2,
    integrations: Webhook
};

const MODE_KEYS: Readonly<Record<core.ChatContentMode, NamespaceKey<"chat">>> = {
    default: "channelSettings.modes.default",
    spoiler: "channelSettings.modes.spoiler",
    age: "channelSettings.modes.age"
};

const MODE_HINT_KEYS: Readonly<Record<core.ChatContentMode, NamespaceKey<"chat">>> = {
    default: "channelSettings.modeHints.default",
    spoiler: "channelSettings.modeHints.spoiler",
    age: "channelSettings.modeHints.age"
};

/** The part of the address after `/settings`, or null for the bare page. */
function sectionOf(pathname: string): SettingsSection | null {
    const match = /\/settings\/([^/]+)/.exec(pathname);
    const found = match?.[1] ?? null;
    return (SETTINGS_SECTIONS as readonly string[]).includes(found ?? "")
        ? (found as SettingsSection)
        : null;
}

/** What Overview and Permissions edit, as the channel has it now. */
interface Draft {
    readonly name: string;
    readonly topic: string;
    readonly slowmode: number;
    readonly contentMode: core.ChatContentMode;
    /** The voice room's limit as typed, so an emptied box reads as no limit. */
    readonly limitText: string;
    readonly private: boolean;
}

function draftOf(channel: ChatChannelView): Draft {
    return {
        name: channel.name,
        topic: channel.topic ?? "",
        slowmode: channel.slowmode,
        contentMode: channel.contentMode,
        limitText: channel.userLimit > 0 ? String(channel.userLimit) : "",
        private: channel.private
    };
}

export function ChannelSettings({ channelId }: { channelId: string }) {
    const t = useTranslations("chat");
    const router = useRouter();
    const pathname = usePathname();
    const { channels, loaded, refresh } = useChat();
    const channel = channels.find((entry) => entry.id === channelId) ?? null;
    const section = sectionOf(pathname);
    const base = `/chat/c/${channelId}/settings`;
    const back = `/chat/c/${channelId}`;

    /** Edits not saved yet, or null when there are none - so a channel that
     *  changes under the page (another tab, another person) is shown as it is
     *  now until somebody starts typing. */
    const [draft, setDraft] = useState<Draft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [confirmDelete, setConfirmDelete] = useState(false);
    /** The bar, flashed when somebody tries to leave with changes unsaved. */
    const [nudge, setNudge] = useState(false);

    const shown = draft ?? (channel ? draftOf(channel) : null);
    const stored = useMemo(() => core.normalizeChannelName(shown?.name ?? ""), [shown?.name]);
    const voice = channel?.kind === "voice";
    const limit = useMemo(() => {
        const typed = (shown?.limitText ?? "").trim();
        return core.chatVoiceUserLimitSchema.safeParse(typed === "" ? 0 : Number(typed));
    }, [shown?.limitText]);
    const limitError = voice && !limit.success ? (limit.error.issues[0]?.message ?? "") : "";
    const userLimit = limit.success ? limit.data : null;
    const topicTooLong = (shown?.topic.length ?? 0) > core.MAX_CHANNEL_TOPIC;

    const dirty = useMemo(() => {
        if (!draft || !channel) return false;
        const now = draftOf(channel);
        return (
            stored !== channel.name ||
            draft.topic !== now.topic ||
            draft.slowmode !== now.slowmode ||
            draft.contentMode !== now.contentMode ||
            draft.private !== now.private ||
            (voice && userLimit !== null && userLimit !== channel.userLimit)
        );
    }, [draft, channel, stored, voice, userLimit]);

    const edit = useCallback(
        (change: Partial<Draft>) => {
            if (!channel) return;
            setDraft((current) => ({ ...(current ?? draftOf(channel)), ...change }));
        },
        [channel]
    );

    const save = async () => {
        if (!channel || !draft) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () =>
                actions.updateChannelAction({
                    channelId: channel.id,
                    name: draft.name,
                    topic: draft.topic,
                    slowmode: draft.slowmode,
                    contentMode: draft.contentMode,
                    private: draft.private,
                    ...(voice && userLimit !== null ? { userLimit } : {})
                }),
            setError
        );
        setBusy(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setDraft(null);
        refresh();
    };

    const leave = useCallback(() => {
        if (dirty) {
            setNudge(true);
            return;
        }
        router.push(back);
    }, [dirty, router, back]);

    useEffect(() => {
        if (!nudge) return;
        const timer = setTimeout(() => setNudge(false), 700);
        return () => clearTimeout(timer);
    }, [nudge]);

    // Esc closes, as Discord's does - unless a dialog on top is what Esc is for.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (document.querySelector("[role='dialog'], [role='alertdialog'], [role='menu']")) return;
            leave();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [leave]);

    // Somebody who may not change it never gets the page: the same rule the
    // gear and every save are held to.
    if (loaded && (!channel || !channel.spaceId || !channel.mayAdminister)) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <EmptyState
                    icon={<Lock />}
                    title={t("channelSettings.notAllowedTitle")}
                    description={t("channelSettings.notAllowedHint")}
                    action={
                        <Button asChild size="sm" variant="secondary">
                            <Link href={back}>{t("channelSettings.backToChannel")}</Link>
                        </Button>
                    }
                />
            </div>
        );
    }

    const active: SettingsSection = section ?? "overview";
    const KindIcon = voice ? Volume2 : Hash;

    const nav = (
        <nav
            aria-label={t("channelSettings.sections.label")}
            className={cn(
                "min-h-0 w-full flex-col gap-0.5 overflow-y-auto border-border bg-card/40 p-3 md:flex md:w-56 md:shrink-0 md:border-r",
                section ? "hidden" : "flex"
            )}
        >
            <div className="flex items-center gap-2 px-2 pb-2 pt-1">
                <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-1 text-sm font-semibold text-foreground">
                        <KindIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {channel ? (
                            <span className="min-w-0 truncate" title={channel.name}>
                                {channel.name}
                            </span>
                        ) : (
                            <Skeleton className="h-3.5 w-24" />
                        )}
                    </p>
                    <p className="text-[0.6875rem] uppercase tracking-wide text-foreground-subtle">
                        {voice ? t("channelSettings.voiceChannel") : t("channelSettings.textChannel")}
                    </p>
                </div>
                {/* On a phone the list is the first screen, so it carries the way
                    out; from `md` the cross beside the section does. */}
                <button
                    type="button"
                    onClick={leave}
                    aria-label={t("channelSettings.close")}
                    title={t("channelSettings.close")}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-card-hover hover:text-foreground md:hidden"
                >
                    <X className="size-4 shrink-0" />
                </button>
            </div>
            {SETTINGS_SECTIONS.map((entry) => {
                const Icon = SECTION_ICONS[entry];
                const current = entry === active;
                return (
                    <Link
                        key={entry}
                        href={`${base}/${entry}`}
                        aria-current={current ? "page" : undefined}
                        className={cn(
                            "flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-card-hover md:py-1.5",
                            current
                                ? "text-foreground md:bg-card-hover"
                                : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <Icon className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                            {t(`channelSettings.sections.${entry}`)}
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-foreground-subtle md:hidden" />
                    </Link>
                );
            })}
            <div className="my-2 border-t border-border" />
            <button
                type="button"
                disabled={!channel}
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-danger transition-colors hover:bg-danger-soft md:py-1.5"
            >
                <Trash2 className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t("channelSettings.deleteChannel")}</span>
            </button>
        </nav>
    );

    return (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {nav}

            <section
                className={cn(
                    "relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex",
                    section ? "flex" : "hidden"
                )}
            >
                <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5 md:border-b-0 md:px-8 md:pt-6">
                    <Link
                        href={base}
                        aria-label={t("channelSettings.back")}
                        title={t("channelSettings.back")}
                        className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-card-hover hover:text-foreground md:hidden"
                    >
                        <ArrowLeft className="size-4 shrink-0" />
                    </Link>
                    <h1 className="min-w-0 flex-1 truncate text-[1.0625rem] font-semibold tracking-tight">
                        {t(`channelSettings.sections.${active}`)}
                    </h1>
                    <button
                        type="button"
                        onClick={leave}
                        aria-label={t("channelSettings.close")}
                        title={t("channelSettings.close")}
                        className="hidden shrink-0 flex-col items-center gap-0.5 text-muted-foreground hover:text-foreground md:flex"
                    >
                        <span className="flex size-8 items-center justify-center rounded-full border border-border">
                            <X className="size-4 shrink-0" />
                        </span>
                        <span className="text-[0.625rem] font-semibold uppercase">{t("channelSettings.esc")}</span>
                    </button>
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4 md:px-8">
                    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
                        {!channel || !shown ? (
                            <div className="flex flex-col gap-3" aria-hidden="true">
                                <Skeleton className="h-9 w-full" />
                                <Skeleton className="h-20 w-full" />
                                <Skeleton className="h-9 w-1/2" />
                            </div>
                        ) : active === "overview" ? (
                            <Overview
                                channel={channel}
                                draft={shown}
                                stored={stored}
                                limitError={limitError}
                                topicTooLong={topicTooLong}
                                onEdit={edit}
                                onError={setError}
                                onSaved={refresh}
                            />
                        ) : active === "permissions" ? (
                            <Permissions channel={channel} draft={shown} onEdit={edit} />
                        ) : active === "invites" ? (
                            <InvitesSection channel={channel} />
                        ) : (
                            <WebhooksSection channel={channel} />
                        )}
                        {error && !dirty && (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        )}
                    </div>
                </div>

                {/* Discord's bar: what is not saved yet, wherever in the page
                    somebody is, until it is saved or reset. */}
                {dirty && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-3 pb-3 md:px-8 md:pb-5">
                        <div
                            role="status"
                            className={cn(
                                "pointer-events-auto flex w-full max-w-2xl flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 shadow-lg transition-colors",
                                nudge && "border-danger bg-danger-soft"
                            )}
                        >
                            <span className="min-w-0 flex-1 text-sm font-medium">
                                {error || t("channelSettings.unsaved")}
                            </span>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => {
                                    setDraft(null);
                                    setError("");
                                }}
                            >
                                {t("channelSettings.reset")}
                            </Button>
                            <Button
                                size="sm"
                                disabled={busy || !stored || Boolean(limitError) || topicTooLong}
                                onClick={() => void save()}
                            >
                                {busy && <Loader2 className="size-4 animate-spin" />}
                                {t("channelSettings.saveChanges")}
                            </Button>
                        </div>
                    </div>
                )}
            </section>

            <ConfirmDeleteDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                name={channel?.name ?? ""}
                kind="channel"
                description={t("channelSettings.everyMessageInItGoes")}
                confirmLabel={t("channelSettings.deleteChannel")}
                onConfirm={async () => {
                    if (!channel) return;
                    const result = await runAction(
                        () => actions.deleteChannelAction(channel.id),
                        setError
                    );
                    setConfirmDelete(false);
                    if (!result || result.error) {
                        if (result?.error) setError(result.error);
                        return;
                    }
                    refresh();
                    router.push("/chat");
                }}
            />
        </div>
    );
}

/** A labelled field with a hint under it. */
function Field({
    label,
    hint,
    htmlFor,
    children
}: {
    label: string;
    hint?: React.ReactNode;
    htmlFor?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <label
                htmlFor={htmlFor}
                className="text-[0.75rem] font-semibold uppercase tracking-wide text-muted-foreground"
            >
                {label}
            </label>
            {children}
            {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </div>
    );
}

function Overview({
    channel,
    draft,
    stored,
    limitError,
    topicTooLong,
    onEdit,
    onError,
    onSaved
}: {
    channel: ChatChannelView;
    draft: Draft;
    stored: string;
    limitError: string;
    topicTooLong: boolean;
    onEdit: (change: Partial<Draft>) => void;
    onError: (message: string) => void;
    onSaved: () => void;
}) {
    const t = useTranslations("chat");
    const [archiving, setArchiving] = useState(false);
    const voice = channel.kind === "voice";

    return (
        <>
            <Field
                label={t("channelSettings.channelName")}
                htmlFor="channel-name"
                hint={
                    stored && stored !== draft.name
                        ? t("channelSettings.storedAs", { name: stored })
                        : undefined
                }
            >
                <Input
                    id="channel-name"
                    value={draft.name}
                    maxLength={80}
                    aria-invalid={stored ? undefined : true}
                    onChange={(event) => onEdit({ name: event.target.value })}
                />
            </Field>

            <Field
                label={t("channelSettings.topic")}
                htmlFor="channel-topic"
                hint={
                    <span className={cn("tabular-nums", topicTooLong && "text-danger")}>
                        {t("channelSettings.count", {
                            count: draft.topic.length,
                            max: core.MAX_CHANNEL_TOPIC
                        })}
                    </span>
                }
            >
                <Textarea
                    id="channel-topic"
                    value={draft.topic}
                    rows={3}
                    placeholder={t("channelSettings.topicPlaceholder")}
                    aria-invalid={topicTooLong ? true : undefined}
                    onChange={(event) => onEdit({ topic: event.target.value })}
                />
            </Field>

            <Field label={t("channelSettings.slowmode")} hint={t("channelSettings.slowmodeHint")}>
                <Select
                    value={String(draft.slowmode)}
                    onValueChange={(value) => onEdit({ slowmode: Number(value) })}
                    aria-label={t("channelSettings.slowmode")}
                    options={core.CHAT_SLOWMODE_STEPS.map((seconds) => ({
                        value: String(seconds),
                        label:
                            seconds === 0
                                ? t("channelSettings.off")
                                : t(spokenWait(seconds).key, spokenWait(seconds).params)
                    }))}
                />
            </Field>

            <Field label={t("channelSettings.content")} hint={t(MODE_HINT_KEYS[draft.contentMode])}>
                <Select
                    value={draft.contentMode}
                    onValueChange={(value) =>
                        onEdit({ contentMode: value as core.ChatContentMode })
                    }
                    aria-label={t("channelSettings.content")}
                    options={core.CHAT_CONTENT_MODES.map((mode) => ({
                        value: mode,
                        label: t(MODE_KEYS[mode])
                    }))}
                />
            </Field>

            {voice && (
                <Field
                    label={t("channelSettings.userLimit")}
                    htmlFor="channel-limit"
                    hint={
                        <span className={cn(limitError && "text-danger")}>
                            {limitError ||
                                t("channelSettings.limitHint", { max: core.MAX_VOICE_USER_LIMIT })}
                        </span>
                    }
                >
                    <Input
                        id="channel-limit"
                        value={draft.limitText}
                        inputMode="numeric"
                        aria-invalid={limitError ? true : undefined}
                        placeholder={t("channelSettings.noLimit")}
                        maxLength={2}
                        onChange={(event) =>
                            onEdit({ limitText: event.target.value.replace(/[^0-9]/g, "") })
                        }
                    />
                </Field>
            )}

            {/* Archiving acts at once rather than joining the draft: it is a
                thing done to the room, and the bar is for how it is set up. */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-3">
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                        {channel.archived
                            ? t("channelSettings.reopenTitle")
                            : t("channelSettings.archiveTitle")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {channel.archived
                            ? t("channelSettings.thisChannelIsArchivedIt")
                            : t("channelSettings.archiveHint")}
                    </p>
                </div>
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={archiving}
                    onClick={async () => {
                        setArchiving(true);
                        const result = await runAction(
                            () =>
                                actions.updateChannelAction({
                                    channelId: channel.id,
                                    archived: !channel.archived
                                }),
                            onError
                        );
                        setArchiving(false);
                        if (result?.error) onError(result.error);
                        else if (result) onSaved();
                    }}
                >
                    {archiving && <Loader2 className="size-4 animate-spin" />}
                    {channel.archived ? t("channelSettings.reopen") : t("channelSettings.archive")}
                </Button>
            </div>
        </>
    );
}

function Permissions({
    channel,
    draft,
    onEdit
}: {
    channel: ChatChannelView;
    draft: Draft;
    onEdit: (change: Partial<Draft>) => void;
}) {
    const t = useTranslations("chat");
    const { viewerId } = useChat();
    const [members, setMembers] = useState<readonly ChatMemberView[] | null>(null);
    const [adding, setAdding] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        const result = await actions.listMembersAction(channel.id);
        setMembers(result.members ?? []);
        if (result.error) setError(result.error);
    }, [channel.id]);

    useEffect(() => {
        if (channel.private) void load();
    }, [channel.private, load]);

    const remove = async (member: ChatMemberView) => {
        const before = members;
        // Off the list at once, back on it if the server says no.
        setMembers((current) => (current ?? []).filter((entry) => entry.userId !== member.userId));
        const result = await runAction(
            () => actions.removeChannelMemberAction(channel.id, member.userId),
            setError
        );
        if (!result || result.error) {
            setMembers(before);
            if (result?.error) setError(result.error);
        }
    };

    return (
        <>
            <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-3">
                <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t("channelSettings.private")}</p>
                    <p className="text-xs text-muted-foreground">
                        {draft.private
                            ? t("channelSettings.privateHint")
                            : t("channelSettings.publicNote")}
                    </p>
                </div>
                <Switch
                    checked={draft.private}
                    onChange={(checked) => onEdit({ private: checked })}
                    aria-label={t("channelSettings.private")}
                />
            </div>

            {/* Who is in it, once it is private as saved - a list read off the
                channel, which only exists once the switch has been saved. */}
            {draft.private && (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="min-w-0 flex-1 text-[0.75rem] font-semibold uppercase tracking-wide text-muted-foreground">
                            {t("channelSettings.whoCanReach")}
                        </h2>
                        {channel.private && (
                            <>
                                <Button size="sm" variant="secondary" onClick={() => setSharing(true)}>
                                    {t("channelSettings.teamsAndRoles")}
                                </Button>
                                <Button size="sm" onClick={() => setAdding(true)}>
                                    {t("channelSettings.addPeople")}
                                </Button>
                            </>
                        )}
                    </div>
                    {!channel.private ? (
                        <p className="text-xs text-muted-foreground">
                            {t("channelSettings.whoCanReachHint")}
                        </p>
                    ) : members === null ? (
                        <div className="flex flex-col gap-2" aria-hidden="true">
                            <Skeleton className="h-9 w-full" />
                            <Skeleton className="h-9 w-full" />
                        </div>
                    ) : members.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("channelSettings.nobodyYet")}</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                            {members.map((member) => (
                                <li key={member.userId} className="flex items-center gap-2 px-3 py-2">
                                    <Avatar person={{ id: member.userId, name: member.name }} size={24} />
                                    <span className="min-w-0 flex-1 truncate text-sm" title={member.name}>
                                        {member.name}
                                        {member.userId === viewerId && (
                                            <span className="text-muted-foreground">
                                                {" "}
                                                {t("channelSettings.you")}
                                            </span>
                                        )}
                                    </span>
                                    {/* Not yourself: taking yourself out of a
                                        private room is leaving it, which the
                                        channel's own menu does. */}
                                    {member.userId !== viewerId && (
                                        <button
                                            type="button"
                                            onClick={() => void remove(member)}
                                            aria-label={t("channelSettings.removePerson", {
                                                name: member.name
                                            })}
                                            title={t("channelSettings.removePerson", {
                                                name: member.name
                                            })}
                                            className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-danger-soft hover:text-danger"
                                        >
                                            <X className="size-3.5 shrink-0" />
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>
            )}

            {adding && (
                <AddPeopleDialog
                    open
                    onOpenChange={setAdding}
                    channel={channel}
                    onAdded={() => void load()}
                />
            )}
            {sharing && (
                <ShareDialog
                    open
                    onOpenChange={setSharing}
                    subject="chat.channel"
                    subjectId={channel.id}
                    name={channel.name}
                />
            )}
        </>
    );
}
