"use client";

/**
 * The Inbox UI: a channels bar, a conversation list, and the active thread with a
 * composer. Conversations and the open thread are short-polled (the app's
 * established realtime pattern); sends and channel connects go through the inbox
 * server actions. The composer can send plain text or an interactive prompt
 * (rendered as native buttons or a poll per the channel's capabilities).
 */

import type { Platform } from "@polaris/messaging";
import { DiscordPeerFields } from "./discord-peer-fields";
import { useFollowBottom } from "@/lib/use-follow-bottom";
import { ConnectChannelDialog } from "./connect-channel-dialog";
import { ChevronLeft, Loader2, MessagesSquare, Plus, Send, Trash2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { PLATFORM_LOGO, editablePeer, humanPeerId, peerHint, platformLabel } from "./platform-meta";
import type {
    AgentView,
    ChannelView,
    ContactIdentityView,
    ContactView,
    ConversationView,
    MessageView
} from "@/lib/messaging-service";
import {
    cn,
    Card,
    Badge,
    Input,
    Button,
    Dialog,
    Select,
    CardBody,
    Textarea,
    DialogTitle,
    DialogHeader,
    DialogContent,
    DialogDescription
} from "@polaris/ui";
import {
    assignConversationAction,
    createContactAction,
    deleteConversationAction,
    getMessagesAction,
    listAgentsAction,
    listContactsAction,
    listConversationsAction,
    sendMessageAction,
    startConversationAction
} from "./actions";

export function InboxView({
    initialChannels,
    initialConversations,
    bridgeReady
}: {
    initialChannels: ChannelView[];
    initialConversations: ConversationView[];
    bridgeReady: boolean;
}) {
    const t = useTranslations("admin");
    const [channels, setChannels] = useState(initialChannels);
    const [conversations, setConversations] = useState(initialConversations);
    const [activeId, setActiveId] = useState<string | null>(initialConversations[0]?.id ?? null);
    const [connecting, setConnecting] = useState(false);
    const [newChat, setNewChat] = useState(false);
    const [agents, setAgents] = useState<AgentView[]>([]);

    const connectedChannels = useMemo(
        () => channels.filter((c) => c.status === "connected"),
        [channels]
    );

    // Load the assignable agents once, for the thread's assignment control.
    useEffect(() => {
        void listAgentsAction()
            .then(setAgents)
            .catch(() => undefined);
    }, []);

    const refreshConversations = useCallback(async () => {
        try {
            setConversations(await listConversationsAction());
        } catch {
            // Transient; the next poll retries.
        }
    }, []);

    // Poll the conversation list so new inbound threads appear without a reload.
    useEffect(() => {
        const timer = setInterval(refreshConversations, 5000);
        return () => clearInterval(timer);
    }, [refreshConversations]);

    const active = useMemo(
        () => conversations.find((item) => item.id === activeId) ?? null,
        [conversations, activeId]
    );

    return (
        <div className="flex h-[calc(100dvh-8rem)] flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("inbox.view.title")}
                </h1>
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setNewChat(true)}
                        disabled={connectedChannels.length === 0}
                    >
                        <Plus className="size-4" /> {t("inbox.view.newChat")}
                    </Button>
                    <Button size="sm" onClick={() => setConnecting(true)}>
                        <Plus className="size-4" /> {t("inbox.view.connectChannel")}
                    </Button>
                </div>
            </div>

            {/* Two panes side by side once there is room for both. On a phone they
                take turns: the list until a conversation is picked, the thread after,
                with the thread's own back arrow returning to the list. */}
            <div className="flex min-h-0 flex-1 gap-3">
                <Card
                    className={cn(
                        "flex w-full shrink-0 flex-col overflow-hidden md:w-72",
                        active && "hidden md:flex"
                    )}
                >
                    <CardBody className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-2">
                        {conversations.length === 0 ? (
                            <div className="flex flex-col items-start gap-2 p-3">
                                <p className="text-sm text-muted-foreground">
                                    {t("inbox.view.empty")}
                                </p>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => setNewChat(true)}
                                    disabled={connectedChannels.length === 0}
                                >
                                    <Plus className="size-4" /> {t("inbox.view.newChat")}
                                </Button>
                            </div>
                        ) : (
                            conversations.map((conversation) => {
                                const meta = PLATFORM_LOGO[conversation.platform];
                                const Logo = meta?.Logo;
                                return (
                                    <button
                                        key={conversation.id}
                                        type="button"
                                        onClick={() => setActiveId(conversation.id)}
                                        className={cn(
                                            "flex items-center gap-2 rounded-md p-2 text-left transition-colors hover:bg-muted",
                                            conversation.id === activeId && "bg-muted"
                                        )}
                                    >
                                        <div
                                            className="grid size-8 shrink-0 place-items-center rounded-full"
                                            style={{
                                                color: meta?.color,
                                                backgroundColor: meta
                                                    ? `${meta.color}1a`
                                                    : undefined
                                            }}
                                            title={platformLabel(t, conversation.platform)}
                                        >
                                            {Logo ? (
                                                <Logo className="size-4" />
                                            ) : (
                                                <MessagesSquare className="size-4" />
                                            )}
                                        </div>
                                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                            <span className="flex items-center justify-between gap-2">
                                                <span className="truncate text-sm font-medium">
                                                    {conversation.peerName ??
                                                        humanPeerId(
                                                            conversation.platform,
                                                            conversation.peerId
                                                        )}
                                                </span>
                                                {conversation.unread > 0 && (
                                                    <Badge>{conversation.unread}</Badge>
                                                )}
                                            </span>
                                            <span className="truncate text-xs text-muted-foreground">
                                                {conversation.channelName}
                                            </span>
                                        </div>
                                    </button>
                                );
                            })
                        )}
                    </CardBody>
                </Card>

                <Card
                    className={cn(
                        "flex min-w-0 flex-1 flex-col overflow-hidden",
                        !active && "hidden md:flex"
                    )}
                >
                    {active ? (
                        <Thread
                            key={active.id}
                            conversation={active}
                            agents={agents}
                            onBack={() => setActiveId(null)}
                            onSent={refreshConversations}
                            onDeleted={() => {
                                setActiveId(null);
                                refreshConversations();
                            }}
                        />
                    ) : (
                        <CardBody className="grid flex-1 place-items-center text-sm text-muted-foreground">
                            <span className="flex flex-col items-center gap-2">
                                <MessagesSquare className="size-6" />
                                {t("inbox.view.selectConversation")}
                            </span>
                        </CardBody>
                    )}
                </Card>
            </div>

            {connecting && (
                <ConnectChannelDialog
                    bridgeReady={bridgeReady}
                    onClose={() => setConnecting(false)}
                    onConnected={(channel) => {
                        setChannels((current) => [...current, channel]);
                        setConnecting(false);
                    }}
                />
            )}
            {newChat && (
                <NewChatDialog
                    channels={connectedChannels}
                    onClose={() => setNewChat(false)}
                    onStarted={(conversationId) => {
                        setNewChat(false);
                        void refreshConversations();
                        setActiveId(conversationId);
                    }}
                />
            )}
        </div>
    );
}

function Thread({
    conversation,
    agents,
    onBack,
    onSent,
    onDeleted
}: {
    conversation: ConversationView;
    agents: AgentView[];
    /** Returns to the conversation list, on viewports showing one pane at a time. */
    onBack: () => void;
    onSent: () => void;
    onDeleted: () => void;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [messages, setMessages] = useState<MessageView[]>([]);
    const [text, setText] = useState("");
    const [optionsMode, setOptionsMode] = useState(false);
    const [optionsText, setOptionsText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [pending, startTransition] = useTransition();
    // The newest message, kept in view - unless the reader has scrolled up into
    // what was said before, which the poll must not pull them out of.
    const follow = useFollowBottom<HTMLDivElement>(messages);
    // Who this was just handed to, before the list has been re-read. Without it the
    // select snaps back to the old name for as long as the round trip takes, which
    // reads as the click having missed. Cleared when a fresh conversation arrives.
    const [assignedTo, setAssignedTo] = useState<string | null | undefined>(undefined);

    useEffect(() => setAssignedTo(undefined), [conversation.id, conversation.assigneeId]);

    // Another conversation is another thread: it opens on its newest message,
    // whatever the reader was looking at in the one before.
    useEffect(() => follow.stick(), [conversation.id, follow]);

    const load = useCallback(async () => {
        try {
            setMessages(await getMessagesAction(conversation.id));
        } catch {
            // Transient; the next poll retries.
        }
    }, [conversation.id]);

    useEffect(() => {
        void load();
        const timer = setInterval(load, 4000);
        return () => clearInterval(timer);
    }, [load]);

    function send() {
        setError(null);
        const options = optionsMode
            ? optionsText
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean)
            : [];
        const interactive =
            optionsMode && options.length > 0
                ? {
                      text: text.trim() || t("inbox.thread.chooseOption"),
                      options: options.map((label, index) => ({ id: `opt${index}`, label }))
                  }
                : undefined;
        const body = text.trim();
        if (!body && !interactive) {
            setError(t("inbox.errors.typeMessage"));
            return;
        }
        // Optimistic UI: show the message immediately with a "sending" state, clear the
        // composer, then reconcile with the server. On failure the bubble is marked
        // failed (rollback) instead of vanishing, so nothing is silently lost.
        const optimisticId = `pending-${Date.now()}`;
        const optimistic: MessageView = {
            id: optimisticId,
            direction: "outbound",
            kind: interactive ? "interactive" : "text",
            body: interactive ? interactive.text : body,
            ack: "sending",
            selection: null,
            senderId: null,
            createdAt: new Date().toISOString()
        };
        setMessages((prev) => [...prev, optimistic]);
        setText("");
        setOptionsText("");
        setOptionsMode(false);
        startTransition(async () => {
            const result = await sendMessageAction({
                conversationId: conversation.id,
                text: interactive ? undefined : body,
                interactive
            });
            if (result.error) {
                setMessages((prev) =>
                    prev.map((message) =>
                        message.id === optimisticId ? { ...message, ack: "failed" } : message
                    )
                );
                setError(result.error);
                return;
            }
            // Replace the optimistic bubble with the server's persisted messages.
            await load();
            onSent();
        });
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={onBack}
                        aria-label={t("inbox.thread.back")}
                        title={t("inbox.thread.back")}
                        className="-ml-1 shrink-0 md:hidden"
                    >
                        <ChevronLeft className="size-4" />
                    </Button>
                    <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                            {conversation.peerName ??
                                humanPeerId(conversation.platform, conversation.peerId)}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                            {conversation.channelName}
                        </p>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Select
                        value={
                            (assignedTo === undefined ? conversation.assigneeId : assignedTo) ??
                            "none"
                        }
                        onValueChange={(value) => {
                            const assigneeId = value === "none" ? null : value;
                            setAssignedTo(assigneeId);
                            void assignConversationAction({
                                conversationId: conversation.id,
                                assigneeId
                            }).then(onSent);
                        }}
                        options={[
                            { value: "none", label: t("inbox.thread.unassigned") },
                            ...agents.map((agent) => ({ value: agent.id, label: agent.name }))
                        ]}
                        className="h-8 w-32 sm:w-40"
                        aria-label={t("inbox.thread.assign")}
                    />
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                            void assignConversationAction({
                                conversationId: conversation.id,
                                status: conversation.status === "closed" ? "open" : "closed"
                            }).then(onSent)
                        }
                    >
                        {conversation.status === "closed"
                            ? t("inbox.thread.reopen")
                            : t("inbox.thread.close")}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("inbox.thread.delete")}
                        title={t("inbox.thread.delete")}
                        onClick={() => setConfirmDelete(true)}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                </div>
            </div>
            <div
                ref={follow.ref}
                onScroll={follow.onScroll}
                className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3"
            >
                {messages.map((message) => (
                    <MessageBubble key={message.id} message={message} />
                ))}
            </div>
            <div className="flex flex-col gap-2 border-t border-border p-3">
                {error && <p className="text-sm text-danger">{error}</p>}
                {optionsMode && (
                    <Textarea
                        value={optionsText}
                        onChange={(event) => setOptionsText(event.target.value)}
                        placeholder={t("inbox.thread.optionsPlaceholder")}
                        rows={3}
                        className="w-full rounded-md border border-border bg-surface p-2 text-sm "
                    />
                )}
                <div className="flex items-center gap-2">
                    <Input
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !optionsMode) {
                                event.preventDefault();
                                send();
                            }
                        }}
                        placeholder={
                            optionsMode
                                ? t("inbox.thread.promptPlaceholder")
                                : t("inbox.thread.messagePlaceholder")
                        }
                    />
                    <Button
                        type="button"
                        variant={optionsMode ? "secondary" : "ghost"}
                        size="sm"
                        onClick={() => setOptionsMode((value) => !value)}
                        title={t("inbox.thread.optionsTitle")}
                    >
                        {t("inbox.thread.options")}
                    </Button>
                    <Button size="sm" onClick={send} disabled={pending}>
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Send className="size-4" />
                        )}
                    </Button>
                </div>
            </div>
            {confirmDelete && (
                <Dialog open onOpenChange={(open) => !open && !deleting && setConfirmDelete(false)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t("inbox.thread.delete")}</DialogTitle>
                            <DialogDescription>
                                {t("inbox.thread.deleteDescription", {
                                    platform: platformLabel(t, conversation.platform)
                                })}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="ghost"
                                onClick={() => setConfirmDelete(false)}
                                disabled={deleting}
                            >
                                {tc("actions.cancel")}
                            </Button>
                            <Button
                                variant="danger"
                                disabled={deleting}
                                onClick={async () => {
                                    setDeleting(true);
                                    const result = await deleteConversationAction(conversation.id);
                                    setDeleting(false);
                                    if (result.error) {
                                        setError(result.error);
                                        setConfirmDelete(false);
                                        return;
                                    }
                                    onDeleted();
                                }}
                            >
                                {deleting && <Loader2 className="size-4 animate-spin" />}
                                {t("inbox.thread.deleteConfirm")}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
}

function MessageBubble({ message }: { message: MessageView }) {
    const t = useTranslations("admin");
    const outbound = message.direction === "outbound";
    return (
        <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
            <div
                className={cn(
                    "max-w-[75%] rounded-lg px-3 py-2 text-sm",
                    outbound ? "bg-primary text-primary-foreground" : "bg-muted"
                )}
            >
                {message.kind === "interactive" && message.selection ? (
                    <span className="italic">
                        {t("inbox.thread.chose", { selection: message.selection })}
                    </span>
                ) : (
                    <span className="whitespace-pre-wrap break-words">{message.body}</span>
                )}
                {outbound && message.ack === "sending" && (
                    <span className="mt-1 block text-xs text-primary-foreground/70">
                        {t("inbox.thread.sending")}
                    </span>
                )}
                {outbound && message.ack === "failed" && (
                    <span className="mt-1 block text-xs text-danger-foreground/80">
                        {t("inbox.thread.failed")}
                    </span>
                )}
            </div>
        </div>
    );
}

// Start a new outbound conversation: pick a saved contact (person) and one of their
// handles, or type a raw recipient id, then the channel and first message. Picking a
// handle auto-selects a channel of its platform. WhatsApp accepts a plain phone
// number (normalized server-side); Telegram/Discord/Slack take the platform-side id.
function NewChatDialog({
    channels,
    onClose,
    onStarted
}: {
    channels: ChannelView[];
    onClose: () => void;
    onStarted: (conversationId: string) => void;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
    const [contacts, setContacts] = useState<ContactView[]>([]);
    const [contactId, setContactId] = useState("");
    const [identityId, setIdentityId] = useState("");
    const [pickedPlatform, setPickedPlatform] = useState<string | null>(null);
    const [peerId, setPeerId] = useState("");
    const [peerName, setPeerName] = useState("");
    const [text, setText] = useState("");
    const [save, setSave] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        void listContactsAction()
            .then(setContacts)
            .catch(() => undefined);
    }, []);

    const channel = channels.find((item) => item.id === channelId) ?? channels[0];
    const platform = channel?.platform ?? "";
    const selectedContact = contacts.find((item) => item.id === contactId) ?? null;
    // Only contacts with at least one handle can be messaged.
    const usableContacts = contacts.filter((item) => item.identities.length > 0);

    // Fill the recipient from a saved handle and switch to a channel of its platform,
    // so the send targets the right network without hand-matching them.
    function pickIdentity(identity: ContactIdentityView, name: string) {
        setPeerId(editablePeer(identity.platform, identity.peerId));
        setPeerName(name);
        setIdentityId(identity.id);
        setPickedPlatform(identity.platform);
        const match = channels.find((item) => item.platform === identity.platform);
        if (match) setChannelId(match.id);
    }

    // Typing a raw recipient drops the saved-handle association, so the manual
    // per-platform guards (e.g. the Telegram numeric check) apply instead.
    function editPeerId(value: string) {
        setPeerId(value);
        setIdentityId("");
        setPickedPlatform(null);
    }

    function pickContact(id: string) {
        setContactId(id);
        const found = contacts.find((item) => item.id === id);
        if (found?.identities[0]) pickIdentity(found.identities[0], found.name);
    }

    // Telegram bots can only message a numeric chat id (of someone who messaged the
    // bot first); a @username never works, so guard it before the API rejects it.
    const telegramInvalid =
        platform === "telegram" && peerId.trim() !== "" && !/^-?\d+$/.test(peerId.trim());
    // A saved handle must be sent over a channel of its own platform. If none is
    // connected, or the selected channel is on another platform, block the send so a
    // recipient is never delivered over a mismatched network.
    const pickedPlatformLabel = pickedPlatform ? platformLabel(t, pickedPlatform) : "";
    const noChannelForPicked =
        pickedPlatform !== null && !channels.some((item) => item.platform === pickedPlatform);
    const platformMismatch = pickedPlatform !== null && pickedPlatform !== platform;
    const ready =
        Boolean(channelId) &&
        peerId.trim() !== "" &&
        text.trim() !== "" &&
        !telegramInvalid &&
        !platformMismatch;

    function submit() {
        setError(null);
        startTransition(async () => {
            if (save && !selectedContact && peerName.trim() && platform) {
                await createContactAction({
                    name: peerName.trim(),
                    platform: platform as Platform,
                    peerId: peerId.trim()
                }).catch(() => undefined);
            }
            const result = await startConversationAction({
                channelId,
                peerId: peerId.trim(),
                peerName: peerName.trim() || undefined,
                text: text.trim()
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.conversationId) onStarted(result.conversationId);
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("inbox.view.newChat")}</DialogTitle>
                    <DialogDescription>{t("inbox.newChat.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    {usableContacts.length > 0 && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("inbox.newChat.contact")}</span>
                            <Select
                                value={contactId}
                                onValueChange={pickContact}
                                placeholder={t("inbox.newChat.contactPlaceholder")}
                                options={usableContacts.map((item) => ({
                                    value: item.id,
                                    label: item.name
                                }))}
                            />
                        </label>
                    )}
                    {selectedContact && selectedContact.identities.length > 1 && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("inbox.newChat.handle")}</span>
                            <Select
                                value={identityId}
                                onValueChange={(value) => {
                                    const found = selectedContact.identities.find(
                                        (item) => item.id === value
                                    );
                                    if (found) pickIdentity(found, selectedContact.name);
                                }}
                                options={selectedContact.identities.map((item) => ({
                                    value: item.id,
                                    label: `${platformLabel(t, item.platform)} - ${humanPeerId(item.platform, item.peerId)}`
                                }))}
                            />
                        </label>
                    )}
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("inbox.newChat.channel")}</span>
                        <Select
                            value={channelId}
                            onValueChange={setChannelId}
                            options={channels.map((item) => ({
                                value: item.id,
                                label: `${item.name} - ${platformLabel(t, item.platform)}`
                            }))}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("inbox.newChat.to")}</span>
                        {identityId ? (
                            // A saved contact handle is chosen - use it as-is; no need to
                            // retype a number or id (that is the point of saving the contact).
                            <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                                <span className="truncate">
                                    {humanPeerId(pickedPlatform ?? platform, peerId)}
                                </span>
                                <button
                                    type="button"
                                    className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                                    onClick={() => editPeerId(peerId)}
                                >
                                    {t("inbox.newChat.enterManually")}
                                </button>
                            </div>
                        ) : platform === "discord" ? (
                            <DiscordPeerFields
                                botChannelId={channelId}
                                draft={peerId}
                                onDraft={editPeerId}
                            />
                        ) : (
                            <>
                                <Input
                                    value={peerId}
                                    onChange={(event) => editPeerId(event.target.value)}
                                    placeholder={
                                        platform === "whatsapp"
                                            ? "34600111222"
                                            : t("inbox.newChat.recipientPlaceholder")
                                    }
                                />
                                {peerHint(t, platform) && (
                                    <span className="text-xs text-muted-foreground">
                                        {peerHint(t, platform)}
                                    </span>
                                )}
                            </>
                        )}
                    </label>
                    {noChannelForPicked && (
                        <p className="text-xs text-danger">
                            {t("inbox.newChat.noChannel", { platform: pickedPlatformLabel })}
                        </p>
                    )}
                    {platformMismatch && !noChannelForPicked && (
                        <p className="text-xs text-danger">
                            {t("inbox.newChat.mismatch", { platform: pickedPlatformLabel })}
                        </p>
                    )}
                    {platform === "telegram" && (
                        <p className="rounded-md border border-warning-edge bg-warning-soft p-2 text-xs text-foreground">
                            {t.rich("inbox.newChat.telegramNote", {
                                code: (chunks) => <code key="code">{chunks}</code>
                            })}
                        </p>
                    )}
                    {telegramInvalid && (
                        <p className="text-xs text-danger">{t("inbox.newChat.telegramInvalid")}</p>
                    )}
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("inbox.newChat.name")}</span>
                        <Input
                            value={peerName}
                            onChange={(event) => setPeerName(event.target.value)}
                            placeholder={t("inbox.newChat.namePlaceholder")}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("inbox.newChat.message")}</span>
                        <Input
                            value={text}
                            onChange={(event) => setText(event.target.value)}
                            placeholder={t("inbox.newChat.messagePlaceholder")}
                        />
                    </label>
                    {!selectedContact && (
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={save}
                                onChange={(event) => setSave(event.target.checked)}
                            />
                            <span>{t("inbox.newChat.saveContact")}</span>
                        </label>
                    )}
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={submit} disabled={pending || !ready}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {t("inbox.newChat.send")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

// Manage contacts (people): list them with their handles, add a person, or open one
// to edit its name, note, and the handles it can be reached on across platforms.
