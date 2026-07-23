"use client";

/**
 * The Inbox UI: a channels bar, a conversation list, and the active thread with a
 * composer. Conversations and the open thread are short-polled (the app's
 * established realtime pattern); sends and channel connects go through the inbox
 * server actions. The composer can send plain text or an interactive prompt
 * (rendered as native buttons or a poll per the channel's capabilities).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { ReactElement } from "react";
import { Loader2, MessagesSquare, Plus, Send, Trash2, Users } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    cn
} from "@polaris/ui";
import {
    assignConversationAction,
    channelStateAction,
    connectChannelAction,
    createContactAction,
    deleteChannelAction,
    deleteContactAction,
    getMessagesAction,
    listAgentsAction,
    listContactsAction,
    listConversationsAction,
    sendMessageAction,
    startConversationAction
} from "./actions";
import type { Platform } from "@polaris/messaging";
import type { AgentView, ChannelView, ContactView, ConversationView, MessageView } from "@/lib/messaging-service";
import { DiscordLogo, SlackLogo, TelegramLogo, WhatsAppLogo } from "./channel-logos";

export function InboxView({
    initialChannels,
    initialConversations,
    bridgeReady
}: {
    initialChannels: ChannelView[];
    initialConversations: ConversationView[];
    bridgeReady: boolean;
}) {
    const [channels, setChannels] = useState(initialChannels);
    const [conversations, setConversations] = useState(initialConversations);
    const [activeId, setActiveId] = useState<string | null>(initialConversations[0]?.id ?? null);
    const [connecting, setConnecting] = useState(false);
    const [newChat, setNewChat] = useState(false);
    const [contactsOpen, setContactsOpen] = useState(false);
    const [agents, setAgents] = useState<AgentView[]>([]);

    const connectedChannels = useMemo(() => channels.filter((c) => c.status === "connected"), [channels]);

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

    const active = useMemo(() => conversations.find((item) => item.id === activeId) ?? null, [conversations, activeId]);

    return (
        <div className="flex h-[calc(100vh-8rem)] flex-col gap-3">
            <div className="flex items-center justify-between">
                <h1 className="text-lg font-semibold tracking-tight">Inbox</h1>
                <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setContactsOpen(true)}>
                        <Users className="size-4" /> Contacts
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setNewChat(true)}
                        disabled={connectedChannels.length === 0}
                    >
                        <Plus className="size-4" /> New chat
                    </Button>
                    <Button size="sm" onClick={() => setConnecting(true)}>
                        <Plus className="size-4" /> Connect channel
                    </Button>
                </div>
            </div>

            {channels.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {channels.map((channel) => (
                        <ChannelChip
                            key={channel.id}
                            channel={channel}
                            onRemoved={(id) => {
                                setChannels((current) => current.filter((item) => item.id !== id));
                                void refreshConversations();
                            }}
                        />
                    ))}
                </div>
            )}

            <div className="flex min-h-0 flex-1 gap-3">
                <Card className="flex w-72 shrink-0 flex-col overflow-hidden">
                    <CardBody className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
                        {conversations.length === 0 ? (
                            <div className="flex flex-col items-start gap-2 p-3">
                                <p className="text-sm text-muted-foreground">
                                    No conversations yet. Start one, or wait for an incoming message.
                                </p>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => setNewChat(true)}
                                    disabled={connectedChannels.length === 0}
                                >
                                    <Plus className="size-4" /> New chat
                                </Button>
                            </div>
                        ) : (
                            conversations.map((conversation) => (
                                <button
                                    key={conversation.id}
                                    type="button"
                                    onClick={() => setActiveId(conversation.id)}
                                    className={cn(
                                        "flex flex-col gap-0.5 rounded-md p-2 text-left transition-colors hover:bg-muted",
                                        conversation.id === activeId && "bg-muted"
                                    )}
                                >
                                    <span className="flex items-center justify-between gap-2">
                                        <span className="truncate text-sm font-medium">
                                            {conversation.peerName ?? conversation.peerId}
                                        </span>
                                        {conversation.unread > 0 && <Badge>{conversation.unread}</Badge>}
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground">
                                        {conversation.channelName}
                                    </span>
                                </button>
                            ))
                        )}
                    </CardBody>
                </Card>

                <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
                    {active ? (
                        <Thread key={active.id} conversation={active} agents={agents} onSent={refreshConversations} />
                    ) : (
                        <CardBody className="grid flex-1 place-items-center text-sm text-muted-foreground">
                            <span className="flex flex-col items-center gap-2">
                                <MessagesSquare className="size-6" />
                                Select a conversation
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
            {contactsOpen && <ContactsDialog onClose={() => setContactsOpen(false)} />}
        </div>
    );
}

function ChannelChip({ channel, onRemoved }: { channel: ChannelView; onRemoved: (id: string) => void }) {
    const [pending, startTransition] = useTransition();
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const tone =
        channel.status === "connected"
            ? "border-success/40 text-success"
            : channel.status === "error"
              ? "border-danger/40 text-danger"
              : undefined;
    return (
        <>
            <span className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
                <span className="font-medium">{channel.name}</span>
                <Badge className={cn(tone)}>{channel.status}</Badge>
                <button
                    type="button"
                    aria-label="Remove channel"
                    className="text-muted-foreground hover:text-danger disabled:opacity-50"
                    disabled={pending}
                    onClick={() => {
                        setError(null);
                        setConfirming(true);
                    }}
                >
                    <Trash2 className="size-3.5" />
                </button>
            </span>
            <Dialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Remove {channel.name}?</DialogTitle>
                        <DialogDescription>
                            This disconnects the channel and deletes its conversations and messages. It cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
                            Cancel
                        </Button>
                        <Button
                            variant="danger"
                            disabled={pending}
                            onClick={() =>
                                startTransition(async () => {
                                    const result = await deleteChannelAction(channel.id);
                                    if (result.error) {
                                        setError(result.error);
                                        return;
                                    }
                                    setConfirming(false);
                                    onRemoved(channel.id);
                                })
                            }
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Remove
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

function Thread({
    conversation,
    agents,
    onSent
}: {
    conversation: ConversationView;
    agents: AgentView[];
    onSent: () => void;
}) {
    const [messages, setMessages] = useState<MessageView[]>([]);
    const [text, setText] = useState("");
    const [optionsMode, setOptionsMode] = useState(false);
    const [optionsText, setOptionsText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const scrollRef = useRef<HTMLDivElement>(null);

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

    useEffect(() => {
        const element = scrollRef.current;
        if (element) element.scrollTop = element.scrollHeight;
    }, [messages]);

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
                ? { text: text.trim() || "Choose an option", options: options.map((label, index) => ({ id: `opt${index}`, label })) }
                : undefined;
        const body = text.trim();
        if (!body && !interactive) {
            setError("Type a message first");
            return;
        }
        startTransition(async () => {
            const result = await sendMessageAction({
                conversationId: conversation.id,
                text: interactive ? undefined : body,
                interactive
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            setText("");
            setOptionsText("");
            setOptionsMode(false);
            await load();
            onSent();
        });
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-border p-3">
                <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{conversation.peerName ?? conversation.peerId}</p>
                    <p className="truncate text-xs text-muted-foreground">{conversation.channelName}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Select
                        value={conversation.assigneeId ?? "none"}
                        onValueChange={(value) =>
                            void assignConversationAction({
                                conversationId: conversation.id,
                                assigneeId: value === "none" ? null : value
                            }).then(onSent)
                        }
                        options={[
                            { value: "none", label: "Unassigned" },
                            ...agents.map((agent) => ({ value: agent.id, label: agent.name }))
                        ]}
                        className="h-8 w-40"
                        aria-label="Assign agent"
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
                        {conversation.status === "closed" ? "Reopen" : "Close"}
                    </Button>
                </div>
            </div>
            <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                {messages.map((message) => (
                    <MessageBubble key={message.id} message={message} />
                ))}
            </div>
            <div className="flex flex-col gap-2 border-t border-border p-3">
                {error && <p className="text-sm text-danger">{error}</p>}
                {optionsMode && (
                    <textarea
                        value={optionsText}
                        onChange={(event) => setOptionsText(event.target.value)}
                        placeholder={"One option per line"}
                        rows={3}
                        className="w-full rounded-md border border-input bg-surface p-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                        placeholder={optionsMode ? "Prompt shown above the options" : "Type a message"}
                    />
                    <Button
                        type="button"
                        variant={optionsMode ? "secondary" : "ghost"}
                        size="sm"
                        onClick={() => setOptionsMode((value) => !value)}
                        title="Send selectable options"
                    >
                        Options
                    </Button>
                    <Button size="sm" onClick={send} disabled={pending}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function MessageBubble({ message }: { message: MessageView }) {
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
                    <span className="italic">chose: {message.selection}</span>
                ) : (
                    <span className="whitespace-pre-wrap break-words">{message.body}</span>
                )}
                {outbound && message.ack === "failed" && (
                    <span className="mt-1 block text-xs text-danger-foreground/80">failed to send</span>
                )}
            </div>
        </div>
    );
}

type ChannelKind = "telegram" | "whatsapp-cloud" | "whatsapp-web" | "discord" | "slack";

const CHANNEL_PLATFORM: Record<ChannelKind, ChannelView["platform"]> = {
    telegram: "telegram",
    "whatsapp-cloud": "whatsapp",
    "whatsapp-web": "whatsapp",
    discord: "discord",
    slack: "slack"
};

const CHANNEL_PROVIDER: Record<ChannelKind, string | null> = {
    telegram: null,
    "whatsapp-cloud": "whatsapp-cloud",
    "whatsapp-web": "whatsapp-web",
    discord: null,
    slack: null
};

interface ChannelKindMeta {
    kind: ChannelKind;
    name: string;
    tagline: string;
    /** Brand color for the logo tile; also tints the logo (currentColor). */
    color: string;
    Logo: (props: { className?: string }) => ReactElement;
    badge?: string;
    /** Label for the token field; omit for channels that need no upfront token (QR). */
    tokenLabel?: string;
    tokenPlaceholder?: string;
    /** WhatsApp Cloud also needs a phone-number id. */
    needsPhoneNumberId?: boolean;
    /** One line shown under the form explaining where to get the credentials. */
    help: string;
}

// The channel marketplace: the picker renders one card per entry, so new channels
// are added here without touching the dialog. Order is the display order.
const CHANNEL_CATALOG: ChannelKindMeta[] = [
    {
        kind: "whatsapp-web",
        name: "WhatsApp (QR)",
        tagline: "Free. Links your phone by QR - unofficial, carries a ban risk.",
        color: "#25D366",
        Logo: WhatsAppLogo,
        badge: "Free",
        help: "Scan a QR with your phone to link it. Free but unofficial - use a spare number, not your main one."
    },
    {
        kind: "whatsapp-cloud",
        name: "WhatsApp Cloud",
        tagline: "Official Meta API. Native buttons and templates, paid.",
        color: "#25D366",
        Logo: WhatsAppLogo,
        badge: "Official",
        tokenLabel: "Access token",
        tokenPlaceholder: "EAAG...",
        needsPhoneNumberId: true,
        help: "Meta access token + phone-number id from the WhatsApp API setup page. Point its webhook at this Polaris."
    },
    {
        kind: "telegram",
        name: "Telegram",
        tagline: "A @BotFather bot. Buttons and inline menus.",
        color: "#229ED9",
        Logo: TelegramLogo,
        tokenLabel: "Bot token",
        tokenPlaceholder: "123456:ABC-DEF...",
        help: "Create a bot with @BotFather in Telegram and paste the token it gives you."
    },
    {
        kind: "discord",
        name: "Discord",
        tagline: "A bot application. Buttons and select menus.",
        color: "#5865F2",
        Logo: DiscordLogo,
        tokenLabel: "Bot token",
        tokenPlaceholder: "Bot token from the Developer Portal",
        help: "Create an app and bot in the Discord Developer Portal and paste the bot token."
    },
    {
        kind: "slack",
        name: "Slack",
        tagline: "A workspace app. Blocks and interactive actions.",
        color: "#E01E5A",
        Logo: SlackLogo,
        tokenLabel: "Bot token",
        tokenPlaceholder: "xoxb-...",
        help: "Install a Slack app to your workspace and paste its Bot User OAuth token (starts with xoxb-)."
    }
];

const CHANNEL_META: Record<ChannelKind, ChannelKindMeta> = Object.fromEntries(
    CHANNEL_CATALOG.map((meta) => [meta.kind, meta])
) as Record<ChannelKind, ChannelKindMeta>;

function ConnectChannelDialog({
    bridgeReady,
    onClose,
    onConnected
}: {
    bridgeReady: boolean;
    onClose: () => void;
    onConnected: (channel: ChannelView) => void;
}) {
    const [phase, setPhase] = useState<"picker" | "form" | "qr">("picker");
    const [kind, setKind] = useState<ChannelKind>("telegram");
    const [name, setName] = useState("");
    const [token, setToken] = useState("");
    const [phoneNumberId, setPhoneNumberId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [qrChannelId, setQrChannelId] = useState<string | null>(null);
    const [qr, setQr] = useState<string | null>(null);
    const [qrStatus, setQrStatus] = useState("connecting");

    const meta = CHANNEL_META[kind];
    const isWeb = kind === "whatsapp-web";
    const needsToken = Boolean(meta.tokenLabel);
    const ready =
        bridgeReady &&
        name.trim() !== "" &&
        (!needsToken || token.trim() !== "") &&
        (!meta.needsPhoneNumberId || phoneNumberId.trim() !== "");

    // Pick a channel from the marketplace grid: seed the name and clear prior input.
    function pick(next: ChannelKind) {
        setKind(next);
        setName(CHANNEL_META[next].name);
        setToken("");
        setPhoneNumberId("");
        setError(null);
        setPhase("form");
    }

    // While onboarding whatsapp-web, poll the bridge for the QR and connected state.
    useEffect(() => {
        if (phase !== "qr" || !qrChannelId) return;
        let active = true;
        const poll = async () => {
            const state = await channelStateAction(qrChannelId);
            if (!active) return;
            setQrStatus(state.status);
            if (state.qr) setQr(state.qr);
            if (state.status === "connected") {
                onConnected({
                    id: qrChannelId,
                    platform: "whatsapp",
                    provider: "whatsapp-web",
                    name: name.trim(),
                    externalId: state.externalId ?? null,
                    status: "connected",
                    capabilities: null
                });
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), 2500);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [phase, qrChannelId, name, onConnected]);

    function submit() {
        setError(null);
        const input =
            kind === "whatsapp-cloud"
                ? {
                      platform: "whatsapp" as const,
                      provider: "whatsapp-cloud",
                      name: name.trim(),
                      token: token.trim(),
                      config: { phoneNumberId: phoneNumberId.trim() }
                  }
                : kind === "whatsapp-web"
                  ? { platform: "whatsapp" as const, provider: "whatsapp-web", name: name.trim() }
                  : kind === "discord"
                    ? { platform: "discord" as const, name: name.trim(), token: token.trim() }
                    : kind === "slack"
                      ? { platform: "slack" as const, name: name.trim(), token: token.trim() }
                      : { platform: "telegram" as const, name: name.trim(), token: token.trim() };
        startTransition(async () => {
            const result = await connectChannelAction(input);
            if (result.error) {
                setError(result.error);
                return;
            }
            if (isWeb && result.channelId) {
                setQrChannelId(result.channelId);
                setPhase("qr");
                return;
            }
            onConnected({
                id: result.channelId ?? crypto.randomUUID(),
                platform: CHANNEL_PLATFORM[kind],
                provider: CHANNEL_PROVIDER[kind],
                name: name.trim(),
                externalId: null,
                status: "connected",
                capabilities: null
            });
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                {phase === "qr" ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Scan to link WhatsApp</DialogTitle>
                            <DialogDescription>
                                On your phone: WhatsApp {">"} Linked devices {">"} Link a device, then scan this code.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col items-center gap-3 py-2">
                            {qr ? (
                                // A data-URL QR; next/image does not handle these.
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={qr} alt="WhatsApp QR code" className="size-56 rounded-md border border-border" />
                            ) : (
                                <div className="flex size-56 items-center justify-center rounded-md border border-border">
                                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                                </div>
                            )}
                            <p className="text-xs text-muted-foreground">
                                {qrStatus === "connected"
                                    ? "Connected."
                                    : qrStatus === "error"
                                      ? "Connection failed - try again."
                                      : "Waiting for the scan..."}
                            </p>
                        </div>
                        <div className="flex justify-end">
                            <Button variant="ghost" onClick={onClose}>
                                {qrStatus === "connected" ? "Done" : "Close"}
                            </Button>
                        </div>
                    </>
                ) : phase === "picker" ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Add a channel</DialogTitle>
                            <DialogDescription>
                                Pick a platform to connect. Add as many as you like and handle them all from one inbox.
                            </DialogDescription>
                        </DialogHeader>
                        {!bridgeReady && (
                            <p className="text-sm text-danger">
                                The messaging bridge is not installed yet. Install it from the{" "}
                                <a className="underline" href="/apps/marketplace">
                                    marketplace
                                </a>{" "}
                                to enable channels.
                            </p>
                        )}
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {CHANNEL_CATALOG.map((item) => {
                                const Logo = item.Logo;
                                return (
                                    <button
                                        key={item.kind}
                                        type="button"
                                        disabled={!bridgeReady}
                                        onClick={() => pick(item.kind)}
                                        className="flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        <div
                                            className="grid size-10 shrink-0 place-items-center rounded-md"
                                            style={{ color: item.color, backgroundColor: `${item.color}1a` }}
                                        >
                                            <Logo className="size-5" />
                                        </div>
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-medium">{item.name}</span>
                                                {item.badge && <Badge>{item.badge}</Badge>}
                                            </div>
                                            <p className="text-xs text-muted-foreground">{item.tagline}</p>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex justify-end">
                            <Button variant="ghost" onClick={onClose}>
                                Cancel
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <span
                                    className="grid size-7 shrink-0 place-items-center rounded"
                                    style={{ color: meta.color, backgroundColor: `${meta.color}1a` }}
                                >
                                    <meta.Logo className="size-4" />
                                </span>
                                Connect {meta.name}
                            </DialogTitle>
                            <DialogDescription>{meta.help}</DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">Name</span>
                                <Input
                                    value={name}
                                    onChange={(event) => setName(event.target.value)}
                                    placeholder="Support bot"
                                />
                            </label>
                            {needsToken && (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">{meta.tokenLabel}</span>
                                    <Input
                                        type="password"
                                        value={token}
                                        onChange={(event) => setToken(event.target.value)}
                                        placeholder={meta.tokenPlaceholder}
                                    />
                                </label>
                            )}
                            {meta.needsPhoneNumberId && (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Phone number id</span>
                                    <Input
                                        value={phoneNumberId}
                                        onChange={(event) => setPhoneNumberId(event.target.value)}
                                        placeholder="From the WhatsApp > API setup page"
                                    />
                                </label>
                            )}
                            {error && <p className="text-sm text-danger">{error}</p>}
                            <div className="flex items-center justify-between gap-2">
                                <Button
                                    variant="ghost"
                                    onClick={() => {
                                        setError(null);
                                        setPhase("picker");
                                    }}
                                    disabled={pending}
                                >
                                    Back
                                </Button>
                                <Button onClick={submit} disabled={pending || !ready}>
                                    {pending && <Loader2 className="size-4 animate-spin" />}
                                    {isWeb ? "Show QR" : "Connect"}
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

const PLATFORM_LABEL: Record<string, string> = {
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    discord: "Discord",
    slack: "Slack"
};

// Per-platform hint for the recipient id when starting a chat or saving a contact.
const PEER_HINT: Record<string, string> = {
    whatsapp: "Phone number with country code, e.g. 34600111222",
    telegram: "Numeric chat id - they must have messaged the bot first",
    discord: "User or channel id",
    slack: "Channel or user id"
};

const PLATFORM_OPTIONS = [
    { value: "whatsapp", label: "WhatsApp" },
    { value: "telegram", label: "Telegram" },
    { value: "discord", label: "Discord" },
    { value: "slack", label: "Slack" }
];

// Start a new outbound conversation: pick a connected channel, a saved contact or
// a raw recipient id, and the first message. WhatsApp accepts a plain phone number
// (normalized server-side); Telegram/Discord/Slack take the platform-side id.
function NewChatDialog({
    channels,
    onClose,
    onStarted
}: {
    channels: ChannelView[];
    onClose: () => void;
    onStarted: (conversationId: string) => void;
}) {
    const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
    const [contacts, setContacts] = useState<ContactView[]>([]);
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
    const platformContacts = contacts.filter((item) => item.platform === platform);
    const ready = Boolean(channelId) && peerId.trim() !== "" && text.trim() !== "";

    function submit() {
        setError(null);
        startTransition(async () => {
            if (save && peerName.trim() && platform) {
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
                    <DialogTitle>New chat</DialogTitle>
                    <DialogDescription>Message someone on a connected channel to start a conversation.</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Channel</span>
                        <Select
                            value={channelId}
                            onValueChange={setChannelId}
                            options={channels.map((item) => ({
                                value: item.id,
                                label: `${item.name} - ${PLATFORM_LABEL[item.platform] ?? item.platform}`
                            }))}
                        />
                    </label>
                    {platformContacts.length > 0 && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Contact</span>
                            <Select
                                value=""
                                onValueChange={(id) => {
                                    const found = platformContacts.find((item) => item.id === id);
                                    if (found) {
                                        setPeerId(found.peerId);
                                        setPeerName(found.name);
                                    }
                                }}
                                placeholder="Pick a saved contact (optional)"
                                options={platformContacts.map((item) => ({ value: item.id, label: item.name }))}
                            />
                        </label>
                    )}
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">To</span>
                        <Input
                            value={peerId}
                            onChange={(event) => setPeerId(event.target.value)}
                            placeholder={PEER_HINT[platform] ?? "Recipient id"}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name (optional)</span>
                        <Input value={peerName} onChange={(event) => setPeerName(event.target.value)} placeholder="Display name" />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Message</span>
                        <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="First message" />
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} />
                        <span>Save as contact</span>
                    </label>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending || !ready}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Send
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

// Manage saved contacts: list, add (name + platform + recipient id), remove.
function ContactsDialog({ onClose }: { onClose: () => void }) {
    const [contacts, setContacts] = useState<ContactView[] | null>(null);
    const [name, setName] = useState("");
    const [platform, setPlatform] = useState<Platform>("whatsapp");
    const [peerId, setPeerId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback(
        () =>
            listContactsAction()
                .then(setContacts)
                .catch(() => setContacts([])),
        []
    );
    useEffect(() => {
        void load();
    }, [load]);

    const canAdd = name.trim() !== "" && peerId.trim() !== "";

    function add() {
        setError(null);
        startTransition(async () => {
            const result = await createContactAction({ name: name.trim(), platform, peerId: peerId.trim() });
            if (result.error) {
                setError(result.error);
                return;
            }
            setName("");
            setPeerId("");
            await load();
        });
    }

    function remove(id: string) {
        startTransition(async () => {
            await deleteContactAction(id);
            await load();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Contacts</DialogTitle>
                    <DialogDescription>Save people you message often, then pick them when starting a chat.</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto">
                        {contacts === null ? (
                            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                                <Loader2 className="size-4 animate-spin" /> Loading...
                            </div>
                        ) : contacts.length === 0 ? (
                            <p className="py-4 text-sm text-muted-foreground">No contacts yet.</p>
                        ) : (
                            contacts.map((item) => (
                                <div key={item.id} className="flex items-center justify-between gap-2 py-2">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">{item.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {PLATFORM_LABEL[item.platform] ?? item.platform} - {item.peerId}
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        aria-label="Remove contact"
                                        className="text-muted-foreground hover:text-danger disabled:opacity-50"
                                        disabled={pending}
                                        onClick={() => remove(item.id)}
                                    >
                                        <Trash2 className="size-4" />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                        <span className="text-sm font-medium">Add a contact</span>
                        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" />
                        <Select value={platform} onValueChange={(value) => setPlatform(value as Platform)} options={PLATFORM_OPTIONS} />
                        <Input
                            value={peerId}
                            onChange={(event) => setPeerId(event.target.value)}
                            placeholder={PEER_HINT[platform] ?? "Recipient id"}
                        />
                        {error && <p className="text-sm text-danger">{error}</p>}
                        <div className="flex justify-end">
                            <Button size="sm" onClick={add} disabled={pending || !canAdd}>
                                {pending && <Loader2 className="size-4 animate-spin" />}
                                Add
                            </Button>
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <Button variant="ghost" onClick={onClose}>
                            Close
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
