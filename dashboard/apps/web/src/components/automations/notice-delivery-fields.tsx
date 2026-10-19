"use client";

/**
 * Where a "tell somebody" step delivers: the bell, email (only where this
 * Polaris has an email channel), the account's own notification destinations,
 * and a chat channel through one of its webhooks. Channels are ticked, the way
 * a notify step picks its services elsewhere, and at least one stays on.
 *
 * Shared by core's Notify node and the Places step (through the app host), so
 * both offer the same channels with the same words.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { Checkbox, Select, Skeleton } from "@polaris/ui";
import type { ChatWebhookChoice } from "@/lib/chat/webhooks";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { noticeChannelsAction, type NoticeDestinationChoice } from "@/app/(app)/automations/actions";

interface Channels {
    readonly mail: boolean;
    readonly canSetUpMail: boolean;
    readonly destinations: readonly NoticeDestinationChoice[];
    readonly webhooks: readonly ChatWebhookChoice[];
}

export interface NoticeDeliveryFieldsProps {
    /** Left out on a step saved before there was a choice: the bell. */
    readonly value: core.NoticeDelivery | undefined;
    readonly onChange: (delivery: core.NoticeDelivery) => void;
    readonly disabled?: boolean;
}

function Row({
    label,
    hint,
    checked,
    disabled,
    onChange,
    children
}: {
    label: string;
    hint?: React.ReactNode;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
    children?: React.ReactNode;
}) {
    return (
        <div className="min-w-0 space-y-1">
            <label className="flex min-w-0 items-start gap-2 text-sm">
                <Checkbox
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => onChange(event.target.checked)}
                />
                <span className="min-w-0 break-words">{label}</span>
            </label>
            {hint ? <p className="ml-6 text-xs text-muted-foreground">{hint}</p> : null}
            {children ? <div className="ml-6 min-w-0 space-y-1">{children}</div> : null}
        </div>
    );
}

export function NoticeDeliveryFields({ value, onChange, disabled = false }: NoticeDeliveryFieldsProps) {
    const t = useTranslations("automations");
    const [channels, setChannels] = useState<Channels | null>(null);
    const [error, setError] = useState("");
    const [chatOpen, setChatOpen] = useState(Boolean(value?.chat));

    useEffect(() => {
        let cancelled = false;
        void noticeChannelsAction().then((answer) => {
            if (cancelled) return;
            if (answer.ok) setChannels(answer);
            else setError(answer.error);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const delivery = value ?? core.DEFAULT_NOTICE_DELIVERY;
    const set = (change: Partial<core.NoticeDelivery>) => onChange({ ...delivery, ...change });
    const none =
        !delivery.bell &&
        !delivery.email &&
        delivery.destinations.length === 0 &&
        delivery.chat === null;

    const webhooks = channels?.webhooks ?? [];
    const chosenHook = delivery.chat
        ? (webhooks.find((entry) => entry.id === delivery.chat?.webhookId) ?? null)
        : null;
    const hookGone = channels !== null && delivery.chat !== null && !chosenHook;
    const hookReset = chosenHook !== null && chosenHook.stamp !== delivery.chat?.stamp;

    return (
        <fieldset className="min-w-0 space-y-2" disabled={disabled}>
            <legend className="mb-1 text-sm">{t("delivery.label")}</legend>
            <Row
                label={t("delivery.bell")}
                checked={delivery.bell}
                disabled={disabled}
                onChange={(bell) => set({ bell })}
            />
            {channels === null && !error ? (
                <Skeleton className="h-16 w-full" />
            ) : (
                <>
                    <Row
                        label={t("delivery.email")}
                        checked={delivery.email}
                        disabled={disabled || (!channels?.mail && !delivery.email)}
                        onChange={(email) => set({ email })}
                        hint={
                            channels && !channels.mail ? (
                                <>
                                    {t("delivery.emailUnavailable")}{" "}
                                    {channels.canSetUpMail ? (
                                        <Link className="underline" href="/admin/email">
                                            {t("delivery.emailSetUp")}
                                        </Link>
                                    ) : (
                                        t("delivery.emailAskAdmin")
                                    )}
                                </>
                            ) : undefined
                        }
                    />
                    <Row
                        label={t("delivery.destinations")}
                        checked={delivery.destinations.length > 0}
                        disabled={disabled || (channels?.destinations.length ?? 0) === 0}
                        onChange={(on) =>
                            set({
                                destinations: on
                                    ? (channels?.destinations ?? [])
                                          .filter((entry) => entry.enabled)
                                          .slice(0, 10)
                                          .map((entry) => entry.id)
                                    : []
                            })
                        }
                        hint={
                            channels && channels.destinations.length === 0 ? (
                                <>
                                    {t("delivery.destinationsNone")}{" "}
                                    <Link className="underline" href="/account/notifications">
                                        {t("delivery.destinationsAdd")}
                                    </Link>
                                </>
                            ) : undefined
                        }
                    >
                        {delivery.destinations.length > 0 &&
                            channels?.destinations.map((entry) => (
                                <label
                                    key={entry.id}
                                    className="flex min-w-0 items-center gap-2 text-xs"
                                >
                                    <Checkbox
                                        checked={delivery.destinations.includes(entry.id)}
                                        disabled={disabled}
                                        onChange={(event) =>
                                            set({
                                                destinations: event.target.checked
                                                    ? [...delivery.destinations, entry.id].slice(0, 10)
                                                    : delivery.destinations.filter(
                                                          (id) => id !== entry.id
                                                      )
                                            })
                                        }
                                    />
                                    <span className="min-w-0 truncate" title={entry.targetHint}>
                                        {entry.enabled
                                            ? t("delivery.destinationOption", {
                                                  name: entry.name,
                                                  target: entry.targetHint
                                              })
                                            : t("delivery.destinationOff", { name: entry.name })}
                                    </span>
                                </label>
                            ))}
                    </Row>
                    <Row
                        label={t("delivery.chat")}
                        checked={chatOpen || delivery.chat !== null}
                        disabled={disabled}
                        onChange={(on) => {
                            setChatOpen(on);
                            if (!on) set({ chat: null });
                        }}
                        hint={
                            (chatOpen || delivery.chat) && webhooks.length === 0 ? (
                                <>
                                    {t("fields.webhookNone")}{" "}
                                    <Link className="underline" href="/chat">
                                        {t("fields.webhookOpenChat")}
                                    </Link>
                                </>
                            ) : undefined
                        }
                    >
                        {(chatOpen || delivery.chat) && webhooks.length > 0 ? (
                            <Select
                                value={delivery.chat?.webhookId ?? ""}
                                onValueChange={(webhookId) => {
                                    const entry = webhooks.find((option) => option.id === webhookId);
                                    if (entry)
                                        set({ chat: { webhookId: entry.id, stamp: entry.stamp } });
                                }}
                                options={webhooks.map((entry) => ({
                                    value: entry.id,
                                    label: t("fields.webhookOption", {
                                        name: entry.name,
                                        channel: entry.channelName,
                                        space: entry.spaceName
                                    })
                                }))}
                                placeholder={t("fields.webhookPick")}
                                aria-label={t("delivery.chat")}
                                disabled={disabled}
                            />
                        ) : null}
                        {chatOpen && !delivery.chat && webhooks.length > 0 ? (
                            <p className="text-xs text-warning-ink">{t("delivery.chatPick")}</p>
                        ) : null}
                        {hookGone && <p className="text-xs text-danger-ink">{t("fields.webhookGone")}</p>}
                        {hookReset && chosenHook && (
                            <p className="text-xs text-warning-ink">
                                {t("fields.webhookReset")}{" "}
                                <button
                                    type="button"
                                    className="underline"
                                    onClick={() =>
                                        set({
                                            chat: { webhookId: chosenHook.id, stamp: chosenHook.stamp }
                                        })
                                    }
                                >
                                    {t("fields.webhookUseNew")}
                                </button>
                            </p>
                        )}
                        {chosenHook && !hookReset && (
                            <p className="text-xs text-muted-foreground">
                                {t("fields.webhookPostsAs", { name: chosenHook.name })}
                            </p>
                        )}
                    </Row>
                </>
            )}
            {error && <p className="text-xs text-danger-ink">{error}</p>}
            {none && <p className="text-xs text-danger-ink">{t("delivery.none")}</p>}
        </fieldset>
    );
}
