"use client";

/**
 * The connected channels, the Add channel button, and the code senders: which
 * channel carries WhatsApp and Telegram verification codes for every account.
 */

import Link from "next/link";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setCodeSenderAction } from "./actions";
import { ChannelCard } from "../email/channel-card";
import { IntegrationLogo } from "@/components/logos";
import { providerRowFor } from "./messaging-providers";
import { MessagingChannelDialog } from "./channel-dialog";
import { Button, buttonVariants, Card, CardBody, Select, Switch } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { MessagingChannelView } from "@/lib/messaging/channel-admin";
import type { SmsCodeSenderOption } from "@/lib/messaging/code-senders";

type CodePlatform = "whatsapp" | "telegram" | "sms";

const STATUS_KEYS = {
    connected: "messaging.status.connected",
    connecting: "messaging.status.connecting",
    error: "messaging.status.error",
    disconnected: "messaging.status.disconnected"
} as const;

const NONE = "none";

export function MessagingAdmin({
    initialChannels,
    codeSenders,
    smsSenders
}: {
    initialChannels: MessagingChannelView[];
    codeSenders: Record<CodePlatform, string | null>;
    smsSenders: SmsCodeSenderOption[];
}) {
    const t = useTranslations("admin");
    const router = useRouter();
    const [channels, setChannels] = useState(initialChannels);
    // undefined: closed; null: adding; a channel: managing it.
    const [open, setOpen] = useState<MessagingChannelView | null | undefined>(undefined);

    return (
        <>
            <section className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-medium">{t("messaging.channels.title")}</h2>
                    <Button size="sm" onClick={() => setOpen(null)}>
                        <Plus className="size-4" /> {t("messaging.channels.add")}
                    </Button>
                </div>
                {channels.length === 0 ? (
                    <Card>
                        <CardBody>
                            <p className="text-sm text-muted-foreground">{t("messaging.channels.empty")}</p>
                        </CardBody>
                    </Card>
                ) : (
                    channels.map((channel) => {
                        const row = providerRowFor(channel.platform, channel.provider);
                        const statusKey =
                            STATUS_KEYS[channel.status as keyof typeof STATUS_KEYS] ?? STATUS_KEYS.disconnected;
                        return (
                            <ChannelCard
                                key={channel.id}
                                Logo={({ className }) => (
                                    <IntegrationLogo slug={row?.id ?? channel.platform} className={className} />
                                )}
                                name={channel.name}
                                status={channel.status}
                                statusLabel={t(statusKey)}
                                detail={[row?.name ?? channel.platform, channel.externalId].filter(Boolean).join(" - ")}
                                error={row?.banRisk ? t("messaging.providers.banRisk") : null}
                                ready={channel.status === "connected" ? t("messaging.channels.ready") : null}
                                onManage={() => setOpen(channel)}
                            />
                        );
                    })
                )}
            </section>
            <CodeSendersCard channels={channels} saved={codeSenders} smsSenders={smsSenders} />
            {open !== undefined ? (
                <MessagingChannelDialog
                    channel={open}
                    onClose={() => setOpen(undefined)}
                    onSaved={() => router.refresh()}
                    onRemoved={(id) => setChannels((prev) => prev.filter((entry) => entry.id !== id))}
                />
            ) : null}
        </>
    );
}

function CodeSendersCard({
    channels,
    saved,
    smsSenders
}: {
    channels: MessagingChannelView[];
    saved: Record<CodePlatform, string | null>;
    smsSenders: SmsCodeSenderOption[];
}) {
    const t = useTranslations("admin");
    return (
        <section className="flex flex-col gap-3">
            <div>
                <h2 className="text-sm font-medium">{t("messaging.codes.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("messaging.codes.hint")}</p>
            </div>
            <Card>
                <CardBody className="flex flex-col gap-4">
                    {(["whatsapp", "telegram"] as const).map((platform) => (
                        <CodeSenderRow
                            key={platform}
                            platform={platform}
                            channels={channels.filter((channel) => channel.platform === platform)}
                            saved={saved[platform]}
                        />
                    ))}
                    <SmsCodesRow senders={smsSenders} saved={saved.sms ?? null} />
                </CardBody>
            </Card>
        </section>
    );
}

function CodeSenderRow({
    platform,
    channels,
    saved: initial
}: {
    platform: Exclude<CodePlatform, "sms">;
    channels: MessagingChannelView[];
    saved: string | null;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [saved, setSaved] = useState(initial ?? NONE);
    const [choice, setChoice] = useState(initial ?? NONE);
    const [error, setError] = useState<string | null>(null);
    const [saving, startSave] = useTransition();
    const options = [
        { value: NONE, label: t("messaging.codes.none") },
        ...channels.map((channel) => ({
            value: channel.id,
            label:
                channel.status === "connected"
                    ? channel.name
                    : t("messaging.codes.notConnected", { name: channel.name })
        }))
    ];

    function save() {
        setError(null);
        startSave(async () => {
            const result = await setCodeSenderAction({ platform, channelId: choice === NONE ? null : choice });
            if (result.error) return setError(result.error);
            setSaved(choice);
        });
    }

    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t(`messaging.codes.${platform}` as const)}</span>
            {channels.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t(`messaging.codes.${platform}Empty` as const)}</p>
            ) : (
                <div className="flex min-w-0 items-center gap-2">
                    <div className="min-w-0 flex-1">
                        <Select value={choice} onValueChange={setChoice} options={options} />
                    </div>
                    <Button size="sm" onClick={save} disabled={saving || choice === saved}>
                        {saving ? tc("actions.saving") : tc("actions.save")}
                    </Button>
                </div>
            )}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}

/**
 * SMS codes: off unless an administrator turns them on, and only switchable on
 * while one of their SMS senders is connected - a switch that could be on with
 * nothing to send through would offer every account a way in that sends nothing.
 * While it is off, nobody sees SMS as a second factor at all.
 */
function SmsCodesRow({ senders, saved: initial }: { senders: SmsCodeSenderOption[]; saved: string | null }) {
    const t = useTranslations("admin");
    const [saved, setSaved] = useState<string | null>(initial);
    const [error, setError] = useState<string | null>(null);
    const [saving, startSave] = useTransition();
    const connected = senders.filter((sender) => sender.connected);
    const current = senders.find((sender) => sender.id === saved) ?? null;
    const on = saved !== null;
    // Turning it off is always allowed; turning it on needs a connected sender.
    const blocked = !on && connected.length === 0;
    const reasonId = "sms-codes-reason";

    function store(next: string | null) {
        const previous = saved;
        setError(null);
        setSaved(next);
        startSave(async () => {
            const result = await setCodeSenderAction({ platform: "sms", channelId: next });
            if (result.error) {
                setSaved(previous);
                setError(result.error);
            }
        });
    }

    return (
        <div className="flex flex-col gap-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{t("messaging.codes.sms")}</span>
                <Switch
                    checked={on}
                    disabled={saving || blocked}
                    onChange={(next) => store(next ? (connected[0]?.id ?? null) : null)}
                    aria-label={t("messaging.codes.sms")}
                    aria-describedby={reasonId}
                />
            </div>
            {blocked ? (
                <div id={reasonId} className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("messaging.codes.smsEmpty")}</p>
                    <Link href="/admin/integrations/email" className={buttonVariants({ size: "sm", variant: "secondary" })}>
                        {t("messaging.codes.smsAdd")}
                    </Link>
                </div>
            ) : on && !current?.connected ? (
                <div id={reasonId} className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 text-xs text-warning">{t("messaging.codes.smsStopped")}</p>
                    <Link href="/admin/integrations/email" className={buttonVariants({ size: "sm", variant: "secondary" })}>
                        {t("messaging.codes.smsFix")}
                    </Link>
                </div>
            ) : (
                <p id={reasonId} className="text-xs text-muted-foreground">
                    {on ? t("messaging.codes.smsOn") : t("messaging.codes.smsOff")}
                </p>
            )}
            {on && connected.length > 1 ? (
                <div className="min-w-0">
                    <Select
                        value={saved ?? ""}
                        disabled={saving}
                        onValueChange={(value) => value !== saved && store(value)}
                        options={connected.map((sender) => ({ value: sender.id, label: sender.name }))}
                    />
                </div>
            ) : null}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}
