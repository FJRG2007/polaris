"use client";

/**
 * The Inbox UI: a channels bar, a conversation list, and the active thread with a
 * composer. Conversations and the open thread are short-polled (the app's
 * established realtime pattern); sends and channel connects go through the inbox
 * server actions. The composer can send plain text or an interactive prompt
 * (rendered as native buttons or a poll per the channel's capabilities).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Loader2, MessagesSquare, Plus, Send, Trash2 } from "lucide-react";
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
    channelStateAction,
    connectChannelAction,
    deleteChannelAction,
    getMessagesAction,
    listConversationsAction,
    sendMessageAction
} from "./actions";
import type { ChannelView, ConversationView, MessageView } from "@/lib/messaging-service";

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
                <Button size="sm" onClick={() => setConnecting(true)}>
                    <Plus className="size-4" /> Connect channel
                </Button>
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
                            <p className="p-3 text-sm text-muted-foreground">
                                No conversations yet. Message your bot to start one.
                            </p>
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
                        <Thread key={active.id} conversation={active} onSent={refreshConversations} />
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
        </div>
    );
}

function ChannelChip({ channel, onRemoved }: { channel: ChannelView; onRemoved: (id: string) => void }) {
    const [pending, startTransition] = useTransition();
    const tone =
        channel.status === "connected"
            ? "border-success/40 text-success"
            : channel.status === "error"
              ? "border-danger/40 text-danger"
              : undefined;
    return (
        <span className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
            <span className="font-medium">{channel.name}</span>
            <Badge className={cn(tone)}>{channel.status}</Badge>
            <button
                type="button"
                aria-label="Remove channel"
                className="text-muted-foreground hover:text-danger disabled:opacity-50"
                disabled={pending}
                onClick={() =>
                    startTransition(async () => {
                        const result = await deleteChannelAction(channel.id);
                        if (!result.error) onRemoved(channel.id);
                    })
                }
            >
                <Trash2 className="size-3.5" />
            </button>
        </span>
    );
}

function Thread({ conversation, onSent }: { conversation: ConversationView; onSent: () => void }) {
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
            <div className="border-b border-border p-3">
                <p className="text-sm font-medium">{conversation.peerName ?? conversation.peerId}</p>
                <p className="text-xs text-muted-foreground">{conversation.channelName}</p>
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

type ChannelKind = "telegram" | "whatsapp-cloud" | "whatsapp-web";

function ConnectChannelDialog({
    bridgeReady,
    onClose,
    onConnected
}: {
    bridgeReady: boolean;
    onClose: () => void;
    onConnected: (channel: ChannelView) => void;
}) {
    const [phase, setPhase] = useState<"form" | "qr">("form");
    const [kind, setKind] = useState<ChannelKind>("telegram");
    const [name, setName] = useState("");
    const [token, setToken] = useState("");
    const [phoneNumberId, setPhoneNumberId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [qrChannelId, setQrChannelId] = useState<string | null>(null);
    const [qr, setQr] = useState<string | null>(null);
    const [qrStatus, setQrStatus] = useState("connecting");

    const isCloud = kind === "whatsapp-cloud";
    const isWeb = kind === "whatsapp-web";
    const needsToken = !isWeb;
    const ready =
        bridgeReady &&
        name.trim() !== "" &&
        (!needsToken || token.trim() !== "") &&
        (!isCloud || phoneNumberId.trim() !== "");

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
        const input = isCloud
            ? {
                  platform: "whatsapp" as const,
                  provider: "whatsapp-cloud",
                  name: name.trim(),
                  token: token.trim(),
                  config: { phoneNumberId: phoneNumberId.trim() }
              }
            : isWeb
              ? { platform: "whatsapp" as const, provider: "whatsapp-web", name: name.trim() }
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
                platform: isCloud ? "whatsapp" : "telegram",
                provider: isCloud ? "whatsapp-cloud" : null,
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
                ) : (
                    <>
                        <DialogHeader>
                            <DialogTitle>Connect a channel</DialogTitle>
                            <DialogDescription>
                                Telegram uses a @BotFather token. WhatsApp Cloud uses a Meta token + phone-number id (with
                                its webhook pointed here). WhatsApp (QR) is free but links your phone and carries a ban
                                risk. Discord and Slack are on the way.
                            </DialogDescription>
                        </DialogHeader>
                        {!bridgeReady && (
                            <p className="text-sm text-danger">
                                The messaging bridge is not configured yet. Set MESSAGING_BRIDGE_URL to enable channels.
                            </p>
                        )}
                        <div className="flex flex-col gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">Channel</span>
                                <Select
                                    value={kind}
                                    onValueChange={(value) => setKind(value as ChannelKind)}
                                    options={[
                                        { value: "telegram", label: "Telegram" },
                                        { value: "whatsapp-cloud", label: "WhatsApp (Cloud API)" },
                                        { value: "whatsapp-web", label: "WhatsApp (QR, free)" }
                                    ]}
                                />
                            </label>
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
                                    <span className="font-medium">{isCloud ? "Access token" : "Bot token"}</span>
                                    <Input
                                        type="password"
                                        value={token}
                                        onChange={(event) => setToken(event.target.value)}
                                        placeholder={isCloud ? "EAAG..." : "123456:ABC-DEF..."}
                                    />
                                </label>
                            )}
                            {isCloud && (
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
                            <div className="flex justify-end gap-2">
                                <Button variant="ghost" onClick={onClose} disabled={pending}>
                                    Cancel
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
