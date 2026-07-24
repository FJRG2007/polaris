"use client";

/**
 * Channels page: every connected messaging channel as a card (the same shape as
 * the Integrations marketplace), each opening a Manage dialog to rename it, replace
 * its credentials or config, reconnect (or re-link WhatsApp Web by scanning a fresh
 * QR in place), or remove it. These channels are what the Watch app targets for
 * alerts and what the Inbox sends through. Connecting reuses
 * the Inbox's ConnectChannelDialog so the connect flow is identical everywhere.
 */

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
    CheckCircle2,
    Loader2,
    MessagesSquare,
    Plus,
    QrCode,
    RefreshCw,
    Settings2
} from "lucide-react";
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
    cn
} from "@polaris/ui";
import type { ChannelView } from "@/lib/messaging-service";
import {
    channelStateAction,
    deleteChannelAction,
    reconnectChannelAction,
    updateChannelAction
} from "../actions";
import { CHANNEL_STATUS_TONE, PLATFORM_LABEL, PLATFORM_LOGO } from "../platform-meta";
import { ConnectChannelDialog } from "../inbox-view";

type ChannelKind = "telegram" | "whatsapp-cloud" | "whatsapp-web" | "discord" | "slack";

/** What each channel kind lets you edit after connecting. whatsapp-web logs in by
 *  QR and stores no editable credential, so it only renames and reconnects. */
interface EditSpec {
    tokenLabel?: string;
    tokenPlaceholder?: string;
    needsPhoneNumberId?: boolean;
    help: string;
}

const EDIT_SPEC: Record<ChannelKind, EditSpec> = {
    telegram: {
        tokenLabel: "Bot token",
        tokenPlaceholder: "123456:ABC-DEF...",
        help: "From @BotFather. Leave the token blank to keep the current one."
    },
    discord: {
        tokenLabel: "Bot token",
        tokenPlaceholder: "Bot token from the Developer Portal",
        help: "From the Discord Developer Portal (Bot > Token). Leave blank to keep the current one."
    },
    slack: {
        tokenLabel: "Bot token",
        tokenPlaceholder: "xoxb-...",
        help: "The Bot User OAuth token (xoxb-...). Leave blank to keep the current one."
    },
    "whatsapp-cloud": {
        tokenLabel: "Access token",
        tokenPlaceholder: "EAAG...",
        needsPhoneNumberId: true,
        help: "Meta access token and phone-number id. Leave a field blank to keep it."
    },
    "whatsapp-web": {
        help: "Linked by QR. Use Re-link to show a QR and scan again if the session dropped; remove and re-add to link a different number."
    }
};

function channelKind(channel: ChannelView): ChannelKind {
    if (channel.platform === "whatsapp") {
        return channel.provider === "whatsapp-cloud" ? "whatsapp-cloud" : "whatsapp-web";
    }
    return channel.platform as ChannelKind;
}

export function ChannelsView({
    initialChannels,
    bridgeReady
}: {
    initialChannels: ChannelView[];
    bridgeReady: boolean;
}) {
    const [channels, setChannels] = useState(initialChannels);
    const [connecting, setConnecting] = useState(false);
    const [managing, setManaging] = useState<ChannelView | null>(null);

    function patchChannel(id: string, patch: Partial<ChannelView>) {
        setChannels((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
        setManaging((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev));
    }

    return (
        <div className="flex max-w-4xl flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <h1 className="text-lg font-semibold">Channels</h1>
                    <p className="text-sm text-muted-foreground">
                        Messaging channels connected to Polaris. The Inbox and Watch alerts send
                        through these.
                    </p>
                </div>
                <Button onClick={() => setConnecting(true)} disabled={!bridgeReady}>
                    <Plus className="size-4" /> Connect a channel
                </Button>
            </div>

            {!bridgeReady && (
                <Card>
                    <CardBody className="text-sm text-muted-foreground">
                        The messaging bridge is not running yet. Install it from the{" "}
                        <Link href="/apps/marketplace" className="text-primary hover:underline">
                            Apps marketplace
                        </Link>{" "}
                        to connect channels.
                    </CardBody>
                </Card>
            )}

            {channels.length === 0 ? (
                <Card>
                    <CardBody className="text-sm text-muted-foreground">
                        No channels connected yet. Connect one to start messaging and to target it
                        from Watch alerts.
                    </CardBody>
                </Card>
            ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {channels.map((channel) => {
                        const meta = PLATFORM_LOGO[channel.platform];
                        const Logo = meta?.Logo;
                        const connected = channel.status === "connected";
                        return (
                            <Card key={channel.id}>
                                <CardBody className="flex flex-col gap-3">
                                    <div className="flex items-start gap-3">
                                        <div
                                            className="grid size-10 shrink-0 place-items-center rounded-md"
                                            style={{
                                                color: meta?.color,
                                                backgroundColor: meta
                                                    ? `${meta.color}1a`
                                                    : undefined
                                            }}
                                        >
                                            {Logo ? (
                                                <Logo className="size-6" />
                                            ) : (
                                                <MessagesSquare className="size-6" />
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <h2 className="truncate text-sm font-medium">
                                                    {channel.name}
                                                </h2>
                                                <Badge
                                                    className={cn(
                                                        CHANNEL_STATUS_TONE[channel.status]
                                                    )}
                                                >
                                                    {channel.status}
                                                </Badge>
                                            </div>
                                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                                {PLATFORM_LABEL[channel.platform] ??
                                                    channel.platform}
                                                {channel.provider === "whatsapp-cloud"
                                                    ? " Cloud"
                                                    : ""}
                                                {channel.externalId
                                                    ? ` - ${channel.externalId}`
                                                    : ""}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-end gap-2">
                                        {connected && (
                                            <span className="mr-auto inline-flex items-center gap-1 text-xs text-success">
                                                <CheckCircle2 className="size-3.5" /> Connected
                                            </span>
                                        )}
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            onClick={() => setManaging(channel)}
                                        >
                                            <Settings2 className="size-4" /> Manage
                                        </Button>
                                    </div>
                                </CardBody>
                            </Card>
                        );
                    })}
                </div>
            )}

            {connecting && (
                <ConnectChannelDialog
                    bridgeReady={bridgeReady}
                    onClose={() => setConnecting(false)}
                    onConnected={(channel) => {
                        setChannels((prev) => [
                            ...prev.filter((item) => item.id !== channel.id),
                            channel
                        ]);
                        setConnecting(false);
                    }}
                />
            )}
            {managing && (
                <ChannelManageDialog
                    channel={managing}
                    onClose={() => setManaging(null)}
                    onUpdated={patchChannel}
                    onRemoved={(id) => {
                        setChannels((prev) => prev.filter((item) => item.id !== id));
                        setManaging(null);
                    }}
                />
            )}
        </div>
    );
}

function ChannelManageDialog({
    channel,
    onClose,
    onUpdated,
    onRemoved
}: {
    channel: ChannelView;
    onClose: () => void;
    onUpdated: (id: string, patch: Partial<ChannelView>) => void;
    onRemoved: (id: string) => void;
}) {
    const spec = EDIT_SPEC[channelKind(channel)];
    const meta = PLATFORM_LOGO[channel.platform];
    const [name, setName] = useState(channel.name);
    const [token, setToken] = useState("");
    const [phoneNumberId, setPhoneNumberId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [saving, startSave] = useTransition();
    const [reconnecting, startReconnect] = useTransition();
    const [removing, startRemove] = useTransition();

    // whatsapp-web logs in by QR, so re-linking a dead session means scanning again.
    const isWeb = channelKind(channel) === "whatsapp-web";
    const [linking, setLinking] = useState(false);
    const [qr, setQr] = useState<string | null>(null);
    const [qrStatus, setQrStatus] = useState<string>("connecting");

    // While re-linking whatsapp-web, poll the bridge for the QR and the eventual
    // connected status - the same onboarding the connect flow uses, so a dead session
    // is re-linked in place instead of removing and re-adding the channel.
    useEffect(() => {
        if (!linking) return;
        let active = true;
        const poll = async () => {
            const state = await channelStateAction(channel.id);
            if (!active) return;
            setQrStatus(state.status);
            if (state.qr) setQr(state.qr);
            if (state.status === "connected") {
                onUpdated(channel.id, { status: "connected" });
                setLinking(false);
            } else if (state.status === "error" || state.status === "disconnected") {
                // Terminal failure (e.g. QR retries exhausted): stop polling so we stop
                // hammering the bridge and re-persisting the dead status every 2.5s, and
                // re-enable the Re-link button so "try Re-link again" is actionable.
                setQr(null);
                onUpdated(channel.id, { status: state.status });
                setLinking(false);
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), 2500);
        return () => {
            active = false;
            clearInterval(timer);
        };
        // onUpdated is a fresh closure each render; re-subscribing would reset the poll.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [linking, channel.id]);

    const dirty =
        name.trim() !== channel.name || token.trim() !== "" || phoneNumberId.trim() !== "";

    function save() {
        setError(null);
        startSave(async () => {
            const result = await updateChannelAction({
                channelId: channel.id,
                ...(name.trim() && name.trim() !== channel.name ? { name: name.trim() } : {}),
                ...(token.trim() ? { token: token.trim() } : {}),
                ...(phoneNumberId.trim() ? { config: { phoneNumberId: phoneNumberId.trim() } } : {})
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            onUpdated(channel.id, {
                name: name.trim() || channel.name,
                ...(result.status ? { status: result.status } : {})
            });
            setToken("");
            setPhoneNumberId("");
        });
    }

    function reconnect() {
        setError(null);
        setQr(null);
        startReconnect(async () => {
            const result = await reconnectChannelAction(channel.id);
            if (result.error) {
                setError(result.error);
                return;
            }
            // whatsapp-web re-init emits a QR to re-link; show it and poll for connected.
            // Other platforms reconnect from stored credentials with no scan.
            if (isWeb) {
                setQrStatus(result.status ?? "connecting");
                setLinking(true);
                return;
            }
            if (result.status) onUpdated(channel.id, { status: result.status });
        });
    }

    function remove() {
        setError(null);
        startRemove(async () => {
            const result = await deleteChannelAction(channel.id);
            if (result.error) {
                setError(result.error);
                return;
            }
            onRemoved(channel.id);
        });
    }

    const busy = saving || reconnecting || removing;
    const linkFailed = isWeb && (qrStatus === "error" || qrStatus === "disconnected");

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <span
                            className="grid size-7 shrink-0 place-items-center rounded"
                            style={{
                                color: meta?.color,
                                backgroundColor: meta ? `${meta.color}1a` : undefined
                            }}
                        >
                            {meta?.Logo ? (
                                <meta.Logo className="size-4" />
                            ) : (
                                <MessagesSquare className="size-4" />
                            )}
                        </span>
                        Manage {channel.name}
                    </DialogTitle>
                    <DialogDescription>{spec.help}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
                        <span className="text-muted-foreground">
                            Status:{" "}
                            <span className={cn(CHANNEL_STATUS_TONE[channel.status])}>
                                {channel.status}
                            </span>
                        </span>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={reconnect}
                            disabled={busy || linking}
                        >
                            {reconnecting ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : isWeb ? (
                                <QrCode className="size-4" />
                            ) : (
                                <RefreshCw className="size-4" />
                            )}
                            {isWeb ? "Re-link" : "Reconnect"}
                        </Button>
                    </div>

                    {isWeb && (linking || linkFailed) && (
                        <div className="flex flex-col items-center gap-3 rounded-md border border-border p-3">
                            {linkFailed ? null : qr ? (
                                // A data-URL QR; next/image does not handle these.
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={qr}
                                    alt="WhatsApp QR code"
                                    className="size-56 rounded-md border border-border"
                                />
                            ) : (
                                <div className="grid size-56 place-items-center rounded-md border border-border">
                                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                                </div>
                            )}
                            <p className="text-center text-xs text-muted-foreground">
                                {linkFailed
                                    ? "Connection failed - try Re-link again."
                                    : "On your phone: WhatsApp > Linked devices > Link a device, then scan this code."}
                            </p>
                        </div>
                    )}

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Support bot"
                        />
                    </label>

                    {spec.tokenLabel && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{spec.tokenLabel}</span>
                            <Input
                                type="password"
                                autoComplete="off"
                                value={token}
                                onChange={(event) => setToken(event.target.value)}
                                placeholder={`Saved - enter a new token to replace it`}
                            />
                            <span className="text-xs text-muted-foreground">
                                {spec.tokenPlaceholder}
                            </span>
                        </label>
                    )}

                    {spec.needsPhoneNumberId && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Phone number id</span>
                            <Input
                                value={phoneNumberId}
                                onChange={(event) => setPhoneNumberId(event.target.value)}
                                placeholder="Leave blank to keep the current one"
                            />
                        </label>
                    )}

                    {error && <p className="text-sm text-danger">{error}</p>}

                    <div className="flex items-center justify-between gap-2">
                        <Button
                            type="button"
                            variant="danger"
                            onClick={() => setConfirming(true)}
                            disabled={busy}
                        >
                            Remove
                        </Button>
                        <div className="flex gap-2">
                            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                                Close
                            </Button>
                            <Button type="button" onClick={save} disabled={busy || !dirty}>
                                {saving && <Loader2 className="size-4 animate-spin" />}
                                Save
                            </Button>
                        </div>
                    </div>
                </div>

                <Dialog open={confirming} onOpenChange={(open) => !removing && setConfirming(open)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Remove {channel.name}?</DialogTitle>
                            <DialogDescription>
                                This disconnects the channel and deletes its conversations and
                                messages. It cannot be undone.
                            </DialogDescription>
                        </DialogHeader>
                        {error && <p className="text-sm text-danger">{error}</p>}
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="ghost"
                                onClick={() => setConfirming(false)}
                                disabled={removing}
                            >
                                Cancel
                            </Button>
                            <Button variant="danger" onClick={remove} disabled={removing}>
                                {removing && <Loader2 className="size-4 animate-spin" />}
                                Remove
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            </DialogContent>
        </Dialog>
    );
}
