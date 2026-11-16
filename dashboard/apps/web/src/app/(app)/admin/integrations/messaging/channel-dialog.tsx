"use client";

/**
 * Connecting and managing a messaging channel. One dialog for both: the form
 * comes from the provider catalogue, and an existing channel's credential is
 * never sent back to the browser - an empty secret field means "keep it".
 *
 * WhatsApp Web has no credential: it waits for a QR scan, which this dialog
 * polls for until the phone links.
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import { AlertTriangle, Loader2, RefreshCw, Trash2 } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    isDirty
} from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { EmailProviderSelect } from "../email/email-provider-select";
import type { MessagingChannelView } from "@/lib/messaging/channel-admin";
import {
    DEFAULT_MESSAGING_PROVIDER,
    MESSAGING_PROVIDERS,
    providerRowFor,
    type MessagingFieldName,
    type MessagingProviderRow
} from "./messaging-providers";
import {
    connectMessagingChannelAction,
    deleteMessagingChannelAction,
    messagingChannelStateAction,
    reconnectMessagingChannelAction,
    updateMessagingChannelAction
} from "./actions";

const QR_POLL_MS = 2_000;

function rowById(id: string): MessagingProviderRow {
    return MESSAGING_PROVIDERS.find((row) => row.id === id) ?? MESSAGING_PROVIDERS[0]!;
}

function initialSettings(row: MessagingProviderRow, existing?: Record<string, string>): Record<string, string> {
    return Object.fromEntries(row.fields.map((field) => [field.name, existing?.[field.name] ?? ""]));
}

export function MessagingChannelDialog({
    channel,
    onClose,
    onSaved,
    onRemoved
}: {
    /** The channel being managed, or null when adding one. */
    channel: MessagingChannelView | null;
    onClose: () => void;
    onSaved: () => void;
    onRemoved: (id: string) => void;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const editing = channel !== null;
    const [confirm, confirmElement] = useConfirm();
    const [rowId, setRowId] = useState(
        () => (channel ? providerRowFor(channel.platform, channel.provider)?.id : undefined) ?? DEFAULT_MESSAGING_PROVIDER
    );
    const row = rowById(rowId);
    const [name, setName] = useState(channel?.name ?? "");
    const [secret, setSecret] = useState("");
    const [settings, setSettings] = useState(() => initialSettings(row, channel?.settings));
    const [error, setError] = useState<string | null>(null);
    const [qrChannel, setQrChannel] = useState<string | null>(null);
    const [qr, setQr] = useState<string | null>(null);
    const [qrStatus, setQrStatus] = useState("connecting");
    const [busy, startBusy] = useTransition();

    const options = useMemo(
        () =>
            MESSAGING_PROVIDERS.map((entry) => ({
                slug: entry.id,
                name: entry.banRisk ? t("messaging.providers.banRiskName", { name: entry.name }) : entry.name,
                aliases: entry.aliases
            })),
        [t]
    );

    // While a WhatsApp Web channel waits for its scan, poll for the QR and the link.
    useEffect(() => {
        if (!qrChannel) return;
        let stopped = false;
        const tick = async () => {
            const state = await messagingChannelStateAction(qrChannel);
            if (stopped) return;
            setQrStatus(state.status);
            if (state.qr) setQr(state.qr);
            if (state.status === "connected") onSaved();
        };
        void tick();
        const timer = setInterval(() => void tick(), QR_POLL_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [qrChannel, onSaved]);

    function changeProvider(next: string) {
        setError(null);
        setRowId(next);
        setSettings((prev) => initialSettings(rowById(next), prev));
    }

    const needsSecret = !row.qr && !editing;
    const missing =
        !name.trim() ||
        (needsSecret && !secret.trim()) ||
        row.fields.some((field) => !field.optional && !settings[field.name]?.trim());
    const values = { name, secret, settings };
    const [loaded] = useState(() => values);
    const unchanged = editing && !isDirty(loaded, values);

    function save() {
        setError(null);
        startBusy(async () => {
            if (editing) {
                const result = await updateMessagingChannelAction({
                    channelId: channel.id,
                    ...(name.trim() !== channel.name ? { name: name.trim() } : {}),
                    ...(secret.trim() ? { token: secret.trim() } : {}),
                    ...(row.fields.length > 0 ? { settings } : {})
                });
                if (result.error) return setError(result.error);
                onSaved();
                onClose();
                return;
            }
            const result = await connectMessagingChannelAction({
                platform: row.platform,
                ...(row.provider ? { provider: row.provider } : {}),
                name: name.trim(),
                ...(secret.trim() ? { token: secret.trim() } : {}),
                ...(row.fields.length > 0 ? { settings } : {})
            });
            if (result.error || !result.channel) return setError(result.error ?? t("messaging.errors.connectFailed"));
            if (row.qr && result.channel.status !== "connected") {
                setQrChannel(result.channel.id);
                return;
            }
            onSaved();
            onClose();
        });
    }

    function reconnect() {
        if (!channel) return;
        setError(null);
        startBusy(async () => {
            const result = await reconnectMessagingChannelAction(channel.id);
            if (result.error) return setError(result.error);
            if (row.qr && result.status !== "connected") return setQrChannel(channel.id);
            onSaved();
        });
    }

    async function remove() {
        if (!channel) return;
        const ok = await confirm({
            title: t("messaging.manage.removeTitle", { name: channel.name }),
            description: t("messaging.manage.removeDescription"),
            confirmLabel: t("messaging.manage.remove"),
            danger: true
        });
        if (!ok) return;
        startBusy(async () => {
            const result = await deleteMessagingChannelAction(channel.id);
            if (result.error) return setError(result.error);
            onRemoved(channel.id);
            onClose();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {qrChannel
                            ? t("messaging.qr.title")
                            : editing
                              ? t("messaging.manage.title", { name: channel.name })
                              : t("messaging.add.title")}
                    </DialogTitle>
                    <DialogDescription>
                        {qrChannel ? t("messaging.qr.steps") : t("messaging.add.description")}
                    </DialogDescription>
                </DialogHeader>
                {qrChannel ? (
                    <div className="flex flex-col items-center gap-3 py-2">
                        {qr ? (
                            // A data-URL QR; next/image does not handle these.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={qr} alt={t("messaging.qr.alt")} className="size-56 rounded-md border border-border" />
                        ) : (
                            <div className="flex size-56 items-center justify-center rounded-md border border-border">
                                <Loader2 className="size-6 animate-spin text-muted-foreground" />
                            </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                            {qrStatus === "connected"
                                ? t("messaging.qr.connected")
                                : qrStatus === "error"
                                  ? t("messaging.qr.failed")
                                  : t("messaging.qr.waiting")}
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("messaging.add.provider")}</span>
                            <EmailProviderSelect
                                options={options}
                                value={rowId}
                                onChange={changeProvider}
                                disabled={editing || busy}
                            />
                        </label>
                        {row.banRisk ? (
                            <p className="flex items-start gap-2 text-xs text-warning">
                                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                                {t("messaging.providers.banRisk")}
                            </p>
                        ) : null}
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("messaging.add.name")}</span>
                            <Input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
                        </label>
                        {row.qr ? null : (
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">{t(`messaging.secret.${secretKey(row)}` as const)}</span>
                                <Input
                                    type="password"
                                    autoComplete="off"
                                    value={secret}
                                    onChange={(event) => setSecret(event.target.value)}
                                    placeholder={editing ? t("messaging.add.keepSecret") : ""}
                                />
                            </label>
                        )}
                        {row.fields.map((field) => (
                            <label key={field.name} className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">
                                    {t(`messaging.fields.${field.name}` as const)}
                                    {field.optional ? (
                                        <span className="text-muted-foreground"> {t("messaging.add.optional")}</span>
                                    ) : null}
                                </span>
                                <Input
                                    value={settings[field.name] ?? ""}
                                    placeholder={PLACEHOLDERS[field.name]}
                                    onChange={(event) =>
                                        setSettings((prev) => ({ ...prev, [field.name]: event.target.value }))
                                    }
                                />
                            </label>
                        ))}
                        {row.template ? (
                            <p className="text-xs text-muted-foreground">
                                {t(row.id === "whatsapp-twilio" ? "messaging.add.twilioTemplateHint" : "messaging.add.templateHint")}
                            </p>
                        ) : null}
                    </div>
                )}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <div className="flex items-center justify-between gap-2">
                    {editing && !qrChannel ? (
                        <div className="flex gap-1">
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={t("messaging.manage.remove")}
                                title={t("messaging.manage.remove")}
                                onClick={() => void remove()}
                                disabled={busy}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={t("messaging.manage.reconnect")}
                                title={t("messaging.manage.reconnect")}
                                onClick={reconnect}
                                disabled={busy}
                            >
                                <RefreshCw className="size-4" />
                            </Button>
                        </div>
                    ) : (
                        <span />
                    )}
                    <div className="flex gap-2">
                        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                            {qrChannel || editing ? t("messaging.add.close") : tc("actions.cancel")}
                        </Button>
                        {qrChannel ? null : (
                            <Button type="button" onClick={save} disabled={busy || missing || unchanged}>
                                {busy && <Loader2 className="size-4 animate-spin" />}
                                {editing ? tc("actions.save") : t("messaging.add.connect")}
                            </Button>
                        )}
                    </div>
                </div>
                {confirmElement}
            </DialogContent>
        </Dialog>
    );
}

/** Which words name the credential: a bot token, a webhook address, an API key. */
function secretKey(row: MessagingProviderRow): "botToken" | "webhookUrl" | "accessToken" | "authToken" | "apiKey" {
    if (row.id === "whatsapp-cloud") return "accessToken";
    if (row.id === "whatsapp-twilio") return "authToken";
    if (row.id === "whatsapp-360dialog") return "apiKey";
    if (row.provider?.endsWith("-webhook")) return "webhookUrl";
    return "botToken";
}

/** Shapes, not values: what each field looks like. */
const PLACEHOLDERS: Record<MessagingFieldName, string> = {
    phoneNumberId: "1234567890",
    accountSid: "AC...",
    from: "+15550100",
    contentSid: "HX...",
    codeTemplate: "verification_code",
    codeTemplateLanguage: "en_US"
};
