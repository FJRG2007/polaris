"use client";

/**
 * Channels page: everything Polaris talks through in one list - messaging
 * channels and email senders alike - each as a card opening a Manage dialog to
 * rename it, replace its credentials or config, reconnect (or re-link WhatsApp
 * Web by scanning a fresh QR in place), or remove it. Connecting is a page of its
 * own, so every way in is offered side by side instead of one being a button and
 * the rest a dialog.
 */

import Link from "next/link";
import { SmsSenderCard } from "./sms-sender-card";
import { MAIL_PROVIDER_INFO } from "@polaris/core";
import type { ChannelView } from "@/lib/messaging-service";
import type { EmailChannelView } from "@/lib/mail-service";
import { DiscordSetupPanel } from "../discord-setup-panel";
import { EmailChannelDialog } from "./email-channel-dialog";
import type { SmsSenderView } from "@/lib/notifications/sms-service";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState, useTransition, type ComponentType } from "react";
import {
    CHANNEL_STATUS_TONE,
    EMAIL_CHANNEL_MARK,
    PLATFORM_LOGO,
    platformLabel
} from "../platform-meta";
import {
    channelStateAction,
    deleteChannelAction,
    reconnectChannelAction,
    updateChannelAction
} from "../actions";
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
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    cn
} from "@polaris/ui";

type ChannelKind = "telegram" | "whatsapp-cloud" | "whatsapp-web" | "discord" | "slack";

/** What each channel kind lets you edit after connecting. whatsapp-web logs in by
 *  QR and stores no editable credential, so it only renames and reconnects. */
interface EditSpec {
    tokenLabel?: string;
    tokenPlaceholder?: string;
    needsPhoneNumberId?: boolean;
    help: string;
}

function editSpec(t: NamespaceTranslator<"admin">, kind: ChannelKind): EditSpec {
    switch (kind) {
        case "telegram":
            return {
                tokenLabel: t("inbox.catalog.tokens.botToken"),
                tokenPlaceholder: "123456:ABC-DEF...",
                help: t("inboxChannels.edit.telegram")
            };
        case "discord":
            return {
                tokenLabel: t("inbox.catalog.tokens.botToken"),
                tokenPlaceholder: t("inbox.catalog.discord.tokenPlaceholder"),
                help: t("inboxChannels.edit.discord")
            };
        case "slack":
            return {
                tokenLabel: t("inbox.catalog.tokens.botToken"),
                tokenPlaceholder: "xoxb-...",
                help: t("inboxChannels.edit.slack")
            };
        case "whatsapp-cloud":
            return {
                tokenLabel: t("inbox.catalog.tokens.accessToken"),
                tokenPlaceholder: "EAAG...",
                needsPhoneNumberId: true,
                help: t("inboxChannels.edit.whatsappCloud")
            };
        case "whatsapp-web":
            return { help: t("inboxChannels.edit.whatsappWeb") };
    }
}

function channelKind(channel: ChannelView): ChannelKind {
    if (channel.platform === "whatsapp") {
        return channel.provider === "whatsapp-cloud" ? "whatsapp-cloud" : "whatsapp-web";
    }
    return channel.platform as ChannelKind;
}

export function ChannelsView({
    initialChannels,
    initialEmailChannels,
    smsSenders,
    bridgeReady
}: {
    initialChannels: ChannelView[];
    initialEmailChannels: EmailChannelView[];
    smsSenders: SmsSenderView[];
    bridgeReady: boolean;
}) {
    const t = useTranslations("admin");
    const [channels, setChannels] = useState(initialChannels);
    const [managing, setManaging] = useState<ChannelView | null>(null);
    const [emailChannels, setEmailChannels] = useState(initialEmailChannels);
    // Only ever an existing sender: adding one is the marketplace's job.
    const [emailDialog, setEmailDialog] = useState<EmailChannelView | null>(null);

    function patchChannel(id: string, patch: Partial<ChannelView>) {
        setChannels((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
        setManaging((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev));
    }

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("inboxChannels.title")}</h1>
                    <p className="text-sm text-muted-foreground">{t("inboxChannels.intro")}</p>
                </div>
                <Button asChild>
                    <Link href="/admin/inbox/channels/connect">
                        <Plus className="size-4" /> {t("inboxChannels.connect")}
                    </Link>
                </Button>
            </div>

            {!bridgeReady && (
                <Card>
                    <CardBody className="text-sm text-muted-foreground">
                        {t.rich("inboxChannels.bridgeMissing", {
                            link: (chunks) => (
                                <Link
                                    key="link"
                                    href="/apps/marketplace"
                                    className="text-primary hover:underline"
                                >
                                    {chunks}
                                </Link>
                            )
                        })}
                    </CardBody>
                </Card>
            )}

            {channels.length === 0 && emailChannels.length === 0 ? (
                <Card>
                    <CardBody className="text-sm text-muted-foreground">
                        {t("inboxChannels.empty")}
                    </CardBody>
                </Card>
            ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {channels.map((channel) => {
                        const meta = PLATFORM_LOGO[channel.platform];
                        return (
                            <ChannelCard
                                key={channel.id}
                                Logo={meta?.Logo ?? MessagesSquare}
                                color={meta?.color}
                                name={channel.name}
                                status={channel.status}
                                statusLabel={t("inboxChannels.status", { status: channel.status })}
                                detail={[
                                    `${platformLabel(t, channel.platform)}${
                                        channel.provider === "whatsapp-cloud" ? " Cloud" : ""
                                    }`,
                                    channel.externalId
                                ]
                                    .filter(Boolean)
                                    .join(" - ")}
                                ready={channel.status === "connected" ? t("inboxChannels.connected") : null}
                                onManage={() => setManaging(channel)}
                            />
                        );
                    })}
                    {emailChannels.map((channel) => (
                        <ChannelCard
                            key={channel.id}
                            Logo={EMAIL_CHANNEL_MARK.Logo}
                            color={EMAIL_CHANNEL_MARK.color}
                            name={channel.name}
                            status={channel.status}
                            statusLabel={t("inboxChannels.status", {
                                status: channel.status === "connected" ? "ready" : channel.status
                            })}
                            detail={[MAIL_PROVIDER_INFO[channel.provider].label, channel.from]
                                .filter(Boolean)
                                .join(" - ")}
                            error={channel.error}
                            ready={
                                channel.status === "connected" && !channel.error
                                    ? t("inboxChannels.readyToSend")
                                    : null
                            }
                            onManage={() => setEmailDialog(channel)}
                        />
                    ))}
                </div>
            )}

            <SmsSenderCard senders={smsSenders} />

            {emailDialog && (
                <EmailChannelDialog
                    channel={emailDialog}
                    onClose={() => setEmailDialog(null)}
                    onSaved={(saved) => {
                        setEmailChannels((prev) =>
                            prev.some((item) => item.id === saved.id)
                                ? prev.map((item) => (item.id === saved.id ? saved : item))
                                : [...prev, saved]
                        );
                        // Keep the dialog on the saved channel so the test message
                        // is available straight after adding it.
                        setEmailDialog(saved);
                    }}
                    onRemoved={(id) => {
                        setEmailChannels((prev) => prev.filter((item) => item.id !== id));
                        setEmailDialog(null);
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

/** One connected channel, whatever it carries. A messaging channel and an email
 *  sender differ only in what their subtitle says, so they share a card: the list
 *  reads as one set of things Polaris talks through rather than two. */
function ChannelCard({
    Logo,
    color,
    name,
    status,
    statusLabel,
    detail,
    error,
    ready,
    onManage
}: {
    Logo: ComponentType<{ className?: string }>;
    color?: string;
    name: string;
    status: string;
    statusLabel: string;
    detail: string;
    /** Why the last check or send failed, when it did. */
    error?: string | null;
    /** The line shown when the channel is working, or null when it is not. */
    ready: string | null;
    onManage: () => void;
}) {
    const t = useTranslations("admin");
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                    <div
                        className="grid size-10 shrink-0 place-items-center rounded-md"
                        style={{ color, backgroundColor: color ? `${color}1a` : undefined }}
                    >
                        <Logo className="size-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <h2 className="truncate text-sm font-medium">{name}</h2>
                            <Badge className={cn(CHANNEL_STATUS_TONE[status])}>{statusLabel}</Badge>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>
                    </div>
                </div>
                {error ? <p className="text-xs text-danger">{error}</p> : null}
                <div className="flex items-center justify-end gap-2">
                    {ready ? (
                        <span className="mr-auto inline-flex items-center gap-1 text-xs text-success">
                            <CheckCircle2 className="size-3.5" /> {ready}
                        </span>
                    ) : null}
                    <Button size="sm" variant="secondary" onClick={onManage}>
                        <Settings2 className="size-4" /> {t("inboxChannels.manage.button")}
                    </Button>
                </div>
            </CardBody>
        </Card>
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
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const spec = editSpec(t, channelKind(channel));
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
                        {t("inboxChannels.manage.title", { name: channel.name })}
                    </DialogTitle>
                    <DialogDescription>{spec.help}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
                        <span className="text-muted-foreground">
                            {t.rich("inboxChannels.manage.status", {
                                status: t("inboxChannels.status", { status: channel.status }),
                                tone: (chunks) => (
                                    <span key="tone" className={cn(CHANNEL_STATUS_TONE[channel.status])}>
                                        {chunks}
                                    </span>
                                )
                            })}
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
                            {isWeb ? t("inboxChannels.manage.relink") : t("inboxChannels.manage.reconnect")}
                        </Button>
                    </div>

                    {isWeb && (linking || linkFailed) && (
                        <div className="flex flex-col items-center gap-3 rounded-md border border-border p-3">
                            {linkFailed ? null : qr ? (
                                // A data-URL QR; next/image does not handle these.
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={qr}
                                    alt={t("inbox.qr.alt")}
                                    className="size-56 rounded-md border border-border"
                                />
                            ) : (
                                <div className="grid size-56 place-items-center rounded-md border border-border">
                                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                                </div>
                            )}
                            <p className="text-center text-xs text-muted-foreground">
                                {linkFailed
                                    ? t("inboxChannels.manage.linkFailed")
                                    : t("inbox.qr.steps")}
                            </p>
                        </div>
                    )}

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("inbox.connect.name")}</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("inbox.connect.namePlaceholder")}
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
                                placeholder={t("inboxChannels.manage.tokenPlaceholder")}
                            />
                            <span className="text-xs text-muted-foreground">
                                {spec.tokenPlaceholder}
                            </span>
                        </label>
                    )}

                    {channel.platform === "discord" && !channel.provider && (
                        <DiscordSetupPanel channelId={channel.id} />
                    )}

                    {spec.needsPhoneNumberId && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("inbox.connect.phoneNumberId")}</span>
                            <Input
                                value={phoneNumberId}
                                onChange={(event) => setPhoneNumberId(event.target.value)}
                                placeholder={t("inboxChannels.manage.keepCurrent")}
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
                            {t("inboxChannels.manage.remove")}
                        </Button>
                        <div className="flex gap-2">
                            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                                {t("inbox.connect.close")}
                            </Button>
                            <Button type="button" onClick={save} disabled={busy || !dirty}>
                                {saving && <Loader2 className="size-4 animate-spin" />}
                                {tc("actions.save")}
                            </Button>
                        </div>
                    </div>
                </div>

                <Dialog open={confirming} onOpenChange={(open) => !removing && setConfirming(open)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>
                                {t("inboxChannels.manage.removeTitle", { name: channel.name })}
                            </DialogTitle>
                            <DialogDescription>
                                {t("inboxChannels.manage.removeDescription")}
                            </DialogDescription>
                        </DialogHeader>
                        {error && <p className="text-sm text-danger">{error}</p>}
                        <DialogFooter>
                            <Button
                                variant="ghost"
                                onClick={() => setConfirming(false)}
                                disabled={removing}
                            >
                                {tc("actions.cancel")}
                            </Button>
                            <Button variant="danger" onClick={remove} disabled={removing}>
                                {removing && <Loader2 className="size-4 animate-spin" />}
                                {t("inboxChannels.manage.remove")}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </DialogContent>
        </Dialog>
    );
}
