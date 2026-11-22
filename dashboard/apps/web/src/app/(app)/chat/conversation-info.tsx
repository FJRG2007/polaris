"use client";

/**
 * A conversation's info: what clicking its name at the top opens - WhatsApp's
 * "contact info" and Telegram's profile page.
 *
 * One page drawn in two places. On a phone it is the whole screen, because a
 * menu hanging off a 2rem button is a desktop's answer and a thumb misses it.
 * On a computer it is a panel beside the conversation, the way WhatsApp's
 * desktop app keeps the chat in view while its settings are changed.
 *
 * Every setting is one row that says its current value on the right. A row with
 * several answers - how long to mute, what may interrupt - opens a chooser that
 * takes this page's place, with a way back, and never a second window over it.
 * A switch is changed on the spot and drawn at once; a refusal puts it back and
 * says so.
 *
 * What opens a dialog of its own - renaming, leaving, deleting - is handed in by
 * the header, which keeps owning those dialogs. On a phone a row closes this
 * page before it opens anything, so there is never one modal over another.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import * as actions from "./actions";
import { Avatar } from "@/components/avatar";
import { useChat } from "./chat-context";
import { runAction } from "@/lib/run-action";
import { ChatAvatar } from "@/components/chat-avatar";
import { conversationFace } from "./conversation-face";
import { PersonName } from "@/components/person-name";
import { LEVEL_KEYS } from "./notify-menu";
import { MUTE_KEYS } from "./mute-menu";
import { durationName } from "./vanish-controls";
import { useDisplayFormat } from "@/components/display-format";
import { VANISH_DURATIONS, type VanishDuration } from "@/lib/chat/vanish-rules";
import type { DirectRulesView } from "@/lib/chat/vanish";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useState, type ReactNode } from "react";
import { blockPersonAction, unblockPersonAction } from "@/app/(app)/account/privacy/actions";
import { Dialog, DialogContent, DialogTitle, Switch, cn, useToast } from "@polaris/ui";
import {
    Archive,
    ArrowLeft,
    AtSign,
    Ban,
    Bell,
    BellOff,
    Check,
    ChevronRight,
    File,
    Flag,
    Hash,
    Image as ImageIcon,
    Languages,
    Link2,
    LogOut,
    Pencil,
    Phone,
    Pin,
    Search,
    Settings2,
    ShieldCheck,
    ShieldOff,
    Star,
    Timer,
    Trash2,
    UserPlus,
    UserRound,
    Users,
    Video,
    X
} from "lucide-react";

/** What the shared files are narrowed to - the search's own filters. */
export type SharedKind = "image" | "file" | "link";

/** How many people a group's section names before "see all". */
const MEMBERS_SHOWN = 5;

export interface ConversationInfoEntries {
    readonly onStartCall?: (withVideo: boolean) => void;
    readonly onSearch?: () => void;
    readonly onPins?: () => void;
    readonly onMembers?: () => void;
    readonly onShared?: (kind: SharedKind) => void;
    /** Refused with its reason rather than missing - see the header's `adder`. */
    readonly addPeople?: { readonly reason: string | null; readonly onSelect: () => void };
    readonly onCopyLink?: () => void;
    readonly onTranslation?: () => void;
    readonly onNickname?: () => void;
    readonly onEditGroup?: () => void;
    readonly onGroupSettings?: () => void;
    readonly channelSettingsHref?: string;
    /** Archiving a channel, for whoever runs it. */
    readonly archive?: { readonly archived: boolean; readonly onSelect: () => void };
    /** A direct conversation's disappearing timer, where this reader may set it. */
    readonly vanish?: {
        readonly rules: DirectRulesView;
        readonly onTimer: (seconds: VanishDuration) => void;
    };
    readonly onReport?: () => void;
    readonly onLeave?: () => void;
    readonly onDeleteChannel?: () => void;
    readonly onDeleteChat?: () => void;
}

/** Where the page is drawn: a phone's whole screen, or beside the chat. */
export type InfoLayout = "page" | "panel";

/** The chooser standing in for the page, or the page itself. */
type View = "main" | "mute" | "notify" | "vanish" | "privacy";

export function ConversationInfo({
    channel,
    open,
    onOpenChange,
    entries,
    privacy,
    layout = "page"
}: {
    channel: ChatChannelView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    entries: ConversationInfoEntries;
    /** A one-to-one conversation's privacy rules. A group's are in its settings. */
    privacy?: ReactNode;
    layout?: InfoLayout;
}) {
    if (layout === "panel") {
        if (!open) return null;
        return (
            <InfoBody
                channel={channel}
                layout="panel"
                onClose={() => onOpenChange(false)}
                entries={entries}
                privacy={privacy}
            />
        );
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                phone="full"
                className="flex flex-col gap-0 overflow-hidden p-0 max-sm:p-0 max-sm:pt-[var(--safe-top)]"
            >
                <DialogTitle className="sr-only">{channel.name}</DialogTitle>
                <InfoBody
                    channel={channel}
                    layout="page"
                    onClose={() => onOpenChange(false)}
                    entries={entries}
                    privacy={privacy}
                />
            </DialogContent>
        </Dialog>
    );
}

/**
 * Change one of this reader's settings on the conversation: drawn at once, put
 * back with a note when the server refuses. Returns whether it held.
 */
function useChannelWrite(channel: ChatChannelView) {
    const t = useTranslations("chat");
    const toast = useToast();
    const { patchChannel, refresh } = useChat();
    return async (
        patch: Partial<ChatChannelView>,
        call: () => Promise<{ error?: string }>
    ): Promise<boolean> => {
        const before = Object.fromEntries(
            Object.keys(patch).map((key) => [key, channel[key as keyof ChatChannelView]])
        ) as Partial<ChatChannelView>;
        patchChannel(channel.id, patch);
        let failure = "";
        const result = await runAction(call, (message) => {
            failure = message;
        });
        if (!result || result.error) {
            patchChannel(channel.id, before);
            toast.show({
                key: `chat-info-${channel.id}`,
                title: t("info.notSaved"),
                body: result?.error || failure || undefined
            });
            return false;
        }
        refresh();
        return true;
    };
}

function InfoBody({
    channel,
    layout,
    onClose,
    entries,
    privacy
}: {
    channel: ChatChannelView;
    layout: InfoLayout;
    onClose: () => void;
    entries: ConversationInfoEntries;
    privacy?: ReactNode;
}) {
    const t = useTranslations("chat");
    const format = useDisplayFormat();
    const write = useChannelWrite(channel);
    const [view, setView] = useState<View>("main");
    const direct = channel.kind === "dm" && channel.others.length === 1;
    const person = direct ? (channel.others[0] ?? null) : null;
    const { viewerId, viewerName } = useChat();
    // A group with one other person in it is still drawn as the group here.
    const face = direct ? person : channel.self ? conversationFace(channel, { id: viewerId, name: viewerName }) : null;
    // Somebody else on the other end: the one person a block can be about.
    const blockable = person !== null && person.id !== viewerId && !channel.self;

    /**
     * Close, then act, on a phone - the next dialog never opens over this page.
     * Beside the chat this is a panel rather than a modal and stays, unless what
     * the row opens is another panel in the same place.
     */
    const then =
        (run: () => void, replacesPanel = false): (() => void) =>
        () => {
            if (layout === "page" || replacesPanel) onClose();
            run();
        };

    const mute = (minutes: number | null) => {
        setView("main");
        const until = minutes === null ? null : core.muteEndsAt(minutes);
        void write({ muted: minutes !== null, mutedUntil: until?.toISOString() ?? null }, () =>
            actions.setMutedAction(channel.id, minutes)
        );
    };
    const muteValue = !channel.muted
        ? t("info.muteOff")
        : channel.mutedUntil
          ? t("info.muteUntil", { time: format.time(channel.mutedUntil) })
          : t("info.muteAlways");

    const inheritable = channel.spaceId !== null;
    const notifyLevel = inheritable
        ? channel.notifyLevel
        : core.resolveChatNotify(channel.notifyLevel, null);
    const notifyOffered: core.ChatChannelNotifyLevel[] = inheritable
        ? [...core.CHAT_CHANNEL_NOTIFY_LEVELS]
        : [...core.CHAT_NOTIFY_LEVELS];

    const vanishRules = entries.vanish?.rules ?? null;
    const shell = (title: string, body: ReactNode) => (
        <InfoFrame
            layout={layout}
            title={title}
            onBack={view === "main" ? undefined : () => setView("main")}
            onClose={onClose}
        >
            {body}
        </InfoFrame>
    );

    if (view === "mute") {
        const current = !channel.muted ? null : channel.mutedUntil ? undefined : core.MUTE_FOREVER;
        return shell(
            t("info.mute"),
            <>
                {channel.muted && channel.mutedUntil ? (
                    <p className="px-4 pt-3 text-xs text-muted-foreground">{muteValue}</p>
                ) : null}
                <div role="radiogroup" aria-label={t("info.mute")} className="flex flex-col py-1">
                    <Choice checked={current === null} onSelect={() => mute(null)}>
                        {t("info.muteOff")}
                    </Choice>
                    {core.MUTE_DURATIONS.map((minutes) => (
                        <Choice key={minutes} checked={false} onSelect={() => mute(minutes)}>
                            {t(MUTE_KEYS[minutes] ?? "muteMenu.durations.forever")}
                        </Choice>
                    ))}
                    <Choice
                        checked={current === core.MUTE_FOREVER}
                        onSelect={() => mute(core.MUTE_FOREVER)}
                    >
                        {t("muteMenu.durations.forever")}
                    </Choice>
                </div>
                <div className="border-t border-border py-1">
                    <SwitchRow
                        icon={<AtSign />}
                        label={t("muteMenu.muteMentions")}
                        checked={channel.muteMentions}
                        onChange={(on) =>
                            void write({ muteMentions: on }, () =>
                                actions.setMuteMentionsAction(channel.id, on)
                            )
                        }
                    />
                </div>
            </>
        );
    }

    if (view === "notify") {
        return shell(
            t("notifyMenu.notifications"),
            <div
                role="radiogroup"
                aria-label={t("notifyMenu.notifications")}
                className="flex flex-col py-1"
            >
                {notifyOffered.map((level) => (
                    <Choice
                        key={level}
                        checked={level === notifyLevel}
                        onSelect={() => {
                            setView("main");
                            if (level === channel.notifyLevel) return;
                            void write({ notifyLevel: level }, () =>
                                actions.setChannelNotifyAction(channel.id, level)
                            );
                        }}
                    >
                        {t(LEVEL_KEYS[level])}
                    </Choice>
                ))}
            </div>
        );
    }

    if (view === "vanish" && entries.vanish && vanishRules) {
        const onTimer = entries.vanish.onTimer;
        return shell(
            t("vanish.timer"),
            <>
                {vanishRules.proposes ? (
                    <p className="px-4 pt-3 text-xs text-muted-foreground">{t("vanish.proposeHint")}</p>
                ) : null}
                <div role="radiogroup" aria-label={t("vanish.timer")} className="flex flex-col py-1">
                    {VANISH_DURATIONS.map((seconds) => (
                        <Choice
                            key={seconds}
                            checked={vanishRules.vanishAfter === seconds}
                            onSelect={() => {
                                setView("main");
                                if (seconds !== vanishRules.vanishAfter) onTimer(seconds);
                            }}
                        >
                            {t(`vanish.duration.${durationName(seconds)}`)}
                        </Choice>
                    ))}
                </div>
            </>
        );
    }

    if (view === "privacy" && privacy) {
        return shell(t("info.privacy"), <div className="px-4 py-3">{privacy}</div>);
    }

    const members = channel.kind === "group" ? channel.others : [];

    return shell(
        t("info.title"),
        <>
            <div className="flex flex-col items-center gap-2 px-4 pt-6 pb-4 text-center">
                {channel.spaceId !== null ? (
                    <span className="flex size-20 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <Hash className="size-8 shrink-0" />
                    </span>
                ) : face ? (
                    <Avatar person={face} size={80} />
                ) : (
                    <ChatAvatar
                        kind="channel"
                        id={channel.id}
                        name={channel.name}
                        members={channel.others}
                        size={80}
                    />
                )}
                <h2 className="w-full min-w-0 truncate text-lg font-semibold" title={channel.name}>
                    <PersonName id={person?.id ?? null} name={channel.name} />
                </h2>
                {channel.topic ? (
                    <p className="line-clamp-3 w-full break-words text-sm text-muted-foreground">
                        {channel.topic}
                    </p>
                ) : !direct && channel.spaceId === null ? (
                    <p className="text-sm text-muted-foreground">
                        {t("info.people", { count: channel.others.length + 1 })}
                    </p>
                ) : null}
            </div>

            <div className="flex flex-wrap justify-center gap-2 px-4 pb-4">
                {entries.onStartCall && (
                    <QuickAction
                        label={t("channelHeader.startACall")}
                        onClick={then(() => entries.onStartCall?.(false))}
                    >
                        <Phone />
                    </QuickAction>
                )}
                {entries.onStartCall && (
                    <QuickAction label={t("info.video")} onClick={then(() => entries.onStartCall?.(true))}>
                        <Video />
                    </QuickAction>
                )}
                {entries.onSearch && (
                    <QuickAction label={t("info.search")} onClick={then(entries.onSearch, true)}>
                        <Search />
                    </QuickAction>
                )}
            </div>

            {entries.onShared && (
                <Group label={t("info.shared")}>
                    <InfoRow onClick={then(() => entries.onShared?.("image"), true)}>
                        <ImageIcon />
                        {t("search.attachments.image")}
                    </InfoRow>
                    <InfoRow onClick={then(() => entries.onShared?.("file"), true)}>
                        <File />
                        {t("search.attachments.file")}
                    </InfoRow>
                    <InfoRow onClick={then(() => entries.onShared?.("link"), true)}>
                        <Link2 />
                        {t("search.attachments.link")}
                    </InfoRow>
                </Group>
            )}

            <Group label={members.length > 0 ? t("info.people", { count: members.length + 1 }) : undefined}>
                {entries.addPeople && (
                    <InfoRow
                        disabled={entries.addPeople.reason !== null}
                        hint={entries.addPeople.reason}
                        onClick={then(entries.addPeople.onSelect)}
                    >
                        <UserPlus />
                        {t("channelHeader.addPeople")}
                    </InfoRow>
                )}
                {members.slice(0, MEMBERS_SHOWN).map((member) => (
                    <div key={member.id} className={cn(ROW, "hover:bg-transparent")}>
                        <Avatar person={member} size={28} />
                        <span className="min-w-0 flex-1 truncate" title={member.name}>
                            <PersonName id={member.id} name={member.name} />
                        </span>
                    </div>
                ))}
                {entries.onMembers && (
                    <InfoRow onClick={then(entries.onMembers, true)}>
                        {direct ? <UserRound /> : <Users />}
                        <span className="min-w-0 flex-1 truncate">
                            {direct
                                ? t("channelHeader.profile")
                                : members.length > MEMBERS_SHOWN
                                  ? t("info.seeAll", { count: members.length + 1 })
                                  : t("channelHeader.whoIsInHere")}
                        </span>
                    </InfoRow>
                )}
            </Group>

            <Group>
                <SettingRow
                    icon={channel.muted ? <BellOff /> : <Bell />}
                    label={t("info.mute")}
                    value={muteValue}
                    onClick={() => setView("mute")}
                />
                {/* Not in a one-to-one conversation, where the mute is the
                    whole of the question: every message in one is addressed
                    to you. */}
                {channel.kind !== "dm" && (
                    <SettingRow
                        icon={<Bell />}
                        label={t("notifyMenu.notifications")}
                        value={t(LEVEL_KEYS[notifyLevel])}
                        onClick={() => setView("notify")}
                    />
                )}
                <SwitchRow
                    icon={<Pin />}
                    label={t("info.pinChat")}
                    checked={channel.pinned}
                    onChange={(on) =>
                        void write({ pinned: on }, () => actions.setPinnedAction(channel.id, on))
                    }
                />
                {vanishRules?.mayChange && (
                    <SettingRow
                        icon={<Timer />}
                        label={t("vanish.timer")}
                        value={t(`vanish.duration.${durationName(vanishRules.vanishAfter)}`)}
                        onClick={() => setView("vanish")}
                    />
                )}
                {privacy ? (
                    <SettingRow
                        icon={<ShieldCheck />}
                        label={t("info.privacy")}
                        value=""
                        onClick={() => setView("privacy")}
                    />
                ) : null}
                {entries.onTranslation && (
                    <InfoRow onClick={then(entries.onTranslation)}>
                        <Languages />
                        {t("translation.settings")}
                    </InfoRow>
                )}
            </Group>

            <Group>
                {entries.onPins && (
                    <InfoRow onClick={then(entries.onPins)}>
                        <Pin />
                        {t("channelHeader.pinnedMessages")}
                    </InfoRow>
                )}
                <InfoLink href={`/chat/saved?c=${channel.id}`} onClick={onClose}>
                    <Star />
                    {t("channelHeader.starredMessages")}
                </InfoLink>
                {entries.onCopyLink && (
                    <InfoRow onClick={entries.onCopyLink}>
                        <Link2 />
                        {t("channelHeader.copyLink")}
                    </InfoRow>
                )}
            </Group>

            <Group>
                {entries.onNickname && (
                    <InfoRow onClick={then(entries.onNickname)}>
                        <Pencil />
                        {t("channelHeader.nickname")}
                    </InfoRow>
                )}
                {entries.onEditGroup && (
                    <InfoRow onClick={then(entries.onEditGroup)}>
                        <Pencil />
                        {t("editGroup.menu")}
                    </InfoRow>
                )}
                {entries.onGroupSettings && (
                    <InfoRow onClick={then(entries.onGroupSettings)}>
                        <Settings2 />
                        {t("channelHeader.groupSettings")}
                    </InfoRow>
                )}
                {entries.channelSettingsHref && (
                    <InfoLink href={entries.channelSettingsHref} onClick={onClose}>
                        <Settings2 />
                        {t("channelHeader.channelSettings")}
                    </InfoLink>
                )}
                {entries.archive && (
                    <InfoRow onClick={entries.archive.onSelect}>
                        <Archive />
                        {entries.archive.archived
                            ? t("channelHeader.reopenChannel")
                            : t("channelHeader.archiveChannel")}
                    </InfoRow>
                )}
            </Group>

            {/* Last, and in red: what cannot be taken back in a click. */}
            <Group danger>
                {blockable && person && (
                    <InfoRow
                        danger={!channel.blocked}
                        onClick={() => {
                            const on = !channel.blocked;
                            void write({ blocked: on }, () =>
                                on
                                    ? blockPersonAction({ userId: person.id })
                                    : unblockPersonAction({ userId: person.id })
                            );
                        }}
                    >
                        {channel.blocked ? <ShieldOff /> : <Ban />}
                        <span className="min-w-0 flex-1 truncate">
                            {channel.blocked
                                ? t("info.unblock", { name: person.name })
                                : t("info.block", { name: person.name })}
                        </span>
                    </InfoRow>
                )}
                {entries.onReport && (
                    <InfoRow danger onClick={then(entries.onReport)}>
                        <Flag />
                        {t("channelHeader.reportConversation")}
                    </InfoRow>
                )}
                {entries.onLeave && (
                    <InfoRow danger onClick={then(entries.onLeave)}>
                        <LogOut />
                        {t("channelHeader.leaveThisGroup")}
                    </InfoRow>
                )}
                {entries.onDeleteChat && (
                    <InfoRow danger onClick={then(entries.onDeleteChat)}>
                        <Trash2 />
                        {t("vanish.deleteChat")}
                    </InfoRow>
                )}
                {entries.onDeleteChannel && (
                    <InfoRow danger onClick={then(entries.onDeleteChannel)}>
                        <Trash2 />
                        {t("channelHeader.deleteChannel")}
                    </InfoRow>
                )}
            </Group>
        </>
    );
}

/** The bar over the page or a chooser, and the scrolling column under it. */
function InfoFrame({
    layout,
    title,
    onBack,
    onClose,
    children
}: {
    layout: InfoLayout;
    title: string;
    onBack?: () => void;
    onClose: () => void;
    children: ReactNode;
}) {
    const t = useTranslations("chat");
    const panel = layout === "panel";
    // The phone page's own close sits in the dialog's corner; its bar only
    // carries the way back from a chooser.
    const bar = panel || onBack;
    const Root = panel ? "section" : "div";
    return (
        <Root
            aria-label={panel ? title : undefined}
            data-info-layout={layout}
            className={cn("flex min-h-0 min-w-0 flex-1 flex-col", panel && "border-s border-border bg-background")}
        >
            {bar ? (
                <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-2">
                    {onBack ? (
                        <BarButton label={t("info.back")} onClick={onBack}>
                            <ArrowLeft />
                        </BarButton>
                    ) : null}
                    <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold" title={title}>
                        {title}
                    </h2>
                    {panel ? (
                        <BarButton label={t("info.close")} onClick={onClose}>
                            <X />
                        </BarButton>
                    ) : (
                        // Room for the dialog's corner close.
                        <span aria-hidden className="w-10 shrink-0" />
                    )}
                </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-[var(--safe-bottom)]">
                {children}
            </div>
        </Root>
    );
}

function BarButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className="flex size-9 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0"
        >
            {children}
        </button>
    );
}

/** A run of rows under a line, drawn only when something is in it. */
function Group({ label, danger = false, children }: { label?: string; danger?: boolean; children: ReactNode }) {
    const rows = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean);
    if (rows.length === 0) return null;
    return (
        <section data-info-group={danger ? "danger" : undefined} className="flex flex-col border-t border-border py-1">
            {label ? (
                <h3 className="px-4 pt-2 pb-1 text-xs font-medium text-muted-foreground">{label}</h3>
            ) : null}
            {children}
        </section>
    );
}

const ROW =
    "flex min-h-12 w-full min-w-0 items-center gap-3 px-4 text-start text-sm transition-colors hover:bg-card-hover [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";

function InfoRow({
    onClick,
    danger = false,
    disabled = false,
    hint = null,
    children
}: {
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
    danger?: boolean;
    disabled?: boolean;
    /** Why it is refused, said under it rather than on a hover a phone has not got. */
    hint?: string | null;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            data-danger={danger || undefined}
            className={cn(
                ROW,
                danger && "text-danger [&>svg]:text-danger",
                disabled && "cursor-not-allowed text-foreground-subtle"
            )}
        >
            {hint ? (
                <span className="flex min-w-0 flex-1 items-center gap-3 [&>svg]:size-5 [&>svg]:shrink-0">
                    {children}
                    <span className="min-w-0 flex-1 truncate text-end text-xs" title={hint}>
                        {hint}
                    </span>
                </span>
            ) : (
                children
            )}
        </button>
    );
}

/** A setting with several answers: its name, what it is set to, and the way in. */
function SettingRow({
    icon,
    label,
    value,
    onClick
}: {
    icon: ReactNode;
    label: string;
    value: string;
    onClick: () => void;
}) {
    return (
        <button type="button" onClick={onClick} className={ROW}>
            {icon}
            <span className="min-w-0 flex-1 truncate" title={label}>
                {label}
            </span>
            {value ? (
                <span className="min-w-0 max-w-[45%] truncate text-xs text-muted-foreground" title={value}>
                    {value}
                </span>
            ) : null}
            <ChevronRight className="size-4 shrink-0 text-foreground-subtle rtl:rotate-180" />
        </button>
    );
}

/** A setting that is on or off, changed where it is. */
function SwitchRow({
    icon,
    label,
    checked,
    onChange
}: {
    icon: ReactNode;
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <label className={cn(ROW, "cursor-pointer")}>
            {icon}
            <span className="min-w-0 flex-1 truncate" title={label}>
                {label}
            </span>
            <Switch checked={checked} onChange={onChange} aria-label={label} />
        </label>
    );
}

/** One answer in a chooser. */
function Choice({
    checked,
    onSelect,
    children
}: {
    checked: boolean;
    onSelect: () => void;
    children: ReactNode;
}) {
    return (
        <button type="button" role="radio" aria-checked={checked} onClick={onSelect} className={ROW}>
            <span
                aria-hidden
                className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border",
                    checked ? "border-primary bg-primary text-primary-foreground" : "border-border"
                )}
            >
                {checked ? <Check className="size-3 shrink-0" /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{children}</span>
        </button>
    );
}

function InfoLink({
    href,
    onClick,
    children
}: {
    href: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Link href={href} onClick={onClick} className={ROW}>
            {children}
        </Link>
    );
}

function QuickAction({
    label,
    onClick,
    children
}: {
    label: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex min-h-16 w-20 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border border-border text-xs text-foreground transition-colors hover:bg-card-hover [&_svg]:size-5 [&_svg]:shrink-0"
        >
            {children}
            <span className="max-w-full truncate px-1" title={label}>
                {label}
            </span>
        </button>
    );
}
