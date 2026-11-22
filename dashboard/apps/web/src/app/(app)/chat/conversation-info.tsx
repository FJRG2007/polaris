"use client";

/**
 * A conversation's info page on a phone: what tapping its name at the top opens,
 * WhatsApp's "contact info" and Telegram's profile page. The whole screen,
 * because a menu hanging off a 2rem button is a desktop's answer and a thumb
 * misses it.
 *
 * Nothing here decides anything: every row is something the header already
 * offers - its call buttons, its three dots, the roster, the settings - handed
 * in by the header, which keeps owning the dialogs they open. A row closes this
 * page before it opens anything, so there is never one modal over another.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { ChatAvatar } from "@/components/chat-avatar";
import { useChat } from "./chat-context";
import { conversationFace } from "./conversation-face";
import { PersonName } from "@/components/person-name";
import { MuteOptions, type MenuParts } from "./mute-menu";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Dialog, DialogContent, DialogTitle, cn } from "@polaris/ui";
import {
    File,
    Hash,
    Image as ImageIcon,
    Link2,
    LogOut,
    Pencil,
    Phone,
    Pin,
    Search,
    Settings2,
    Star,
    Trash2,
    UserPlus,
    UserRound,
    Users,
    Video
} from "lucide-react";

/** What the shared files are narrowed to - the search's own filters. */
export type SharedKind = "image" | "file" | "link";

export interface ConversationInfoEntries {
    readonly onStartCall?: (withVideo: boolean) => void;
    readonly onSearch?: () => void;
    readonly onPins?: () => void;
    readonly onMembers?: () => void;
    readonly onShared?: (kind: SharedKind) => void;
    readonly onMute: (minutes: number | null) => void;
    /** Whether the mute holds back mentions too; settles once saved. */
    readonly onMuteMentions: (on: boolean) => Promise<unknown>;
    /** Refused with its reason rather than missing - see the header's `adder`. */
    readonly addPeople?: { readonly reason: string | null; readonly onSelect: () => void };
    readonly onNickname?: () => void;
    readonly onEditGroup?: () => void;
    readonly onGroupSettings?: () => void;
    readonly channelSettingsHref?: string;
    readonly onLeave?: () => void;
    readonly onDeleteChannel?: () => void;
    readonly onDeleteChat?: () => void;
}

/** The mute choices as rows of this page rather than a submenu - see `MenuParts`. */
const FLAT: MenuParts = {
    Item: ({ children, onSelect }) => (
        <InfoRow onClick={(event) => onSelect?.(event.nativeEvent)}>{children}</InfoRow>
    ),
    Sub: ({ children }) => <div className="flex flex-col">{children}</div>,
    SubTrigger: ({ children }) => (
        <p className="flex items-center gap-3 px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0">
            {children}
        </p>
    ),
    SubContent: ({ children }) => <div className="flex flex-col">{children}</div>
};

export function ConversationInfo({
    channel,
    open,
    onOpenChange,
    entries,
    privacy
}: {
    channel: ChatChannelView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    entries: ConversationInfoEntries;
    /** A one-to-one conversation's privacy rules. A group's are in its settings. */
    privacy?: ReactNode;
}) {
    const t = useTranslations("chat");
    const direct = channel.kind === "dm" && channel.others.length === 1;
    const person = direct ? (channel.others[0] ?? null) : null;
    const { viewerId, viewerName } = useChat();
    // A group with one other person in it is still drawn as the group here.
    const face = direct ? person : channel.self ? conversationFace(channel, { id: viewerId, name: viewerName }) : null;
    /** Close first, then act: the next dialog never opens over this one. */
    const then =
        (run: () => void): (() => void) =>
        () => {
            onOpenChange(false);
            run();
        };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent phone="full" className="flex flex-col gap-0 overflow-y-auto overscroll-contain p-0">
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
                    <DialogTitle className="w-full min-w-0 truncate text-lg" title={channel.name}>
                        <PersonName id={person?.id ?? null} name={channel.name} />
                    </DialogTitle>
                    {channel.topic ? (
                        <p className="line-clamp-3 w-full text-sm text-muted-foreground">
                            {channel.topic}
                        </p>
                    ) : !direct && channel.spaceId === null ? (
                        <p className="text-sm text-muted-foreground">
                            {t("info.people", { count: channel.others.length + 1 })}
                        </p>
                    ) : null}
                </div>

                <div className="flex justify-center gap-2 px-4 pb-4">
                    {entries.onStartCall && (
                        <QuickAction
                            label={t("channelHeader.startACall")}
                            onClick={then(() => entries.onStartCall?.(false))}
                        >
                            <Phone />
                        </QuickAction>
                    )}
                    {entries.onStartCall && (
                        <QuickAction
                            label={t("info.video")}
                            onClick={then(() => entries.onStartCall?.(true))}
                        >
                            <Video />
                        </QuickAction>
                    )}
                    {entries.onSearch && (
                        <QuickAction label={t("info.search")} onClick={then(entries.onSearch)}>
                            <Search />
                        </QuickAction>
                    )}
                </div>

                <Group>
                    {entries.onMembers && (
                        <InfoRow onClick={then(entries.onMembers)}>
                            {direct ? <UserRound /> : <Users />}
                            {direct ? t("channelHeader.profile") : t("channelHeader.whoIsInHere")}
                        </InfoRow>
                    )}
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
                </Group>

                {entries.onShared && (
                    <Group label={t("info.shared")}>
                        <InfoRow onClick={then(() => entries.onShared?.("image"))}>
                            <ImageIcon />
                            {t("search.attachments.image")}
                        </InfoRow>
                        <InfoRow onClick={then(() => entries.onShared?.("file"))}>
                            <File />
                            {t("search.attachments.file")}
                        </InfoRow>
                        <InfoRow onClick={then(() => entries.onShared?.("link"))}>
                            <Link2 />
                            {t("search.attachments.link")}
                        </InfoRow>
                    </Group>
                )}

                <Group>
                    {entries.onPins && (
                        <InfoRow onClick={then(entries.onPins)}>
                            <Pin />
                            {t("channelHeader.pinnedMessages")}
                        </InfoRow>
                    )}
                    <InfoLink href={`/chat/saved?c=${channel.id}`} onClick={() => onOpenChange(false)}>
                        <Star />
                        {t("channelHeader.starredMessages")}
                    </InfoLink>
                    <MuteOptions
                        channel={channel}
                        parts={FLAT}
                        onChoose={(minutes) => {
                            onOpenChange(false);
                            entries.onMute(minutes);
                        }}
                        onMentions={entries.onMuteMentions}
                    />
                </Group>

                {privacy ? <div className="border-t border-border px-4 py-3">{privacy}</div> : null}

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
                        <InfoLink
                            href={entries.channelSettingsHref}
                            onClick={() => onOpenChange(false)}
                        >
                            <Settings2 />
                            {t("channelHeader.channelSettings")}
                        </InfoLink>
                    )}
                </Group>

                <Group>
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
            </DialogContent>
        </Dialog>
    );
}

/** A run of rows under a line, drawn only when something is in it. */
function Group({ label, children }: { label?: string; children: ReactNode }) {
    const rows = (Array.isArray(children) ? children : [children]).filter(Boolean);
    if (rows.length === 0) return null;
    return (
        <section className="flex flex-col border-t border-border py-1">
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
