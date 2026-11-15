"use client";

/**
 * The connected channels, the Add channel button, and the code senders: which
 * channel carries WhatsApp and Telegram verification codes for every account.
 */

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setCodeSenderAction } from "./actions";
import { ChannelCard } from "../email/channel-card";
import { IntegrationLogo } from "@/components/logos";
import { providerRowFor } from "./messaging-providers";
import { MessagingChannelDialog } from "./channel-dialog";
import { Button, Card, CardBody, Select } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { MessagingChannelView } from "@/lib/messaging/channel-admin";

type CodePlatform = "whatsapp" | "telegram";

const STATUS_KEYS = {
    connected: "messaging.status.connected",
    connecting: "messaging.status.connecting",
    error: "messaging.status.error",
    disconnected: "messaging.status.disconnected"
} as const;

const NONE = "none";

export function MessagingAdmin({
    initialChannels,
    codeSenders
}: {
    initialChannels: MessagingChannelView[];
    codeSenders: Record<CodePlatform, string | null>;
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
            <CodeSendersCard channels={channels} saved={codeSenders} />
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
    saved
}: {
    channels: MessagingChannelView[];
    saved: Record<CodePlatform, string | null>;
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
    platform: CodePlatform;
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
