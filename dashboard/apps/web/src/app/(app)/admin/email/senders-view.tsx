"use client";

/**
 * The email senders this account added: one card each, opening the same dialog
 * that adds one. A sender is not proven until a test message arrives, so the
 * dialog stays open on a sender straight after it is saved.
 */

import { useState } from "react";
import { Plus } from "lucide-react";
import { MAIL_PROVIDER_INFO } from "@polaris/core";
import { Button, Card, CardBody } from "@polaris/ui";
import { ChannelCard } from "../channel-card";
import { EMAIL_CHANNEL_MARK } from "../inbox/platform-meta";
import { EmailChannelDialog } from "./email-channel-dialog";
import type { EmailChannelView } from "@/lib/mail-service";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function EmailSendersView({ initialSenders }: { initialSenders: EmailChannelView[] }) {
    const t = useTranslations("admin");
    const [senders, setSenders] = useState(initialSenders);
    // "new" while adding one; the saved sender once it exists, so its test is next.
    const [editing, setEditing] = useState<EmailChannelView | "new" | null>(null);

    return (
        <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <h2 className="text-sm font-medium">{t("email.senders.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("email.senders.hint")}</p>
                </div>
                <Button size="sm" onClick={() => setEditing("new")}>
                    <Plus className="size-4" /> {t("email.senders.add")}
                </Button>
            </div>
            {senders.length === 0 ? (
                <Card>
                    <CardBody className="text-sm text-muted-foreground">
                        {t("email.senders.empty")}
                    </CardBody>
                </Card>
            ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {senders.map((sender) => (
                        <ChannelCard
                            key={sender.id}
                            Logo={EMAIL_CHANNEL_MARK.Logo}
                            color={EMAIL_CHANNEL_MARK.color}
                            name={sender.name}
                            status={sender.status}
                            statusLabel={t("inboxChannels.status", {
                                status: sender.status === "connected" ? "ready" : sender.status
                            })}
                            detail={[MAIL_PROVIDER_INFO[sender.provider].label, sender.from]
                                .filter(Boolean)
                                .join(" - ")}
                            error={sender.error}
                            ready={
                                sender.status === "connected" && !sender.error
                                    ? t("inboxChannels.readyToSend")
                                    : null
                            }
                            onManage={() => setEditing(sender)}
                        />
                    ))}
                </div>
            )}
            {editing && (
                <EmailChannelDialog
                    channel={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={(saved) => {
                        setSenders((prev) =>
                            prev.some((item) => item.id === saved.id)
                                ? prev.map((item) => (item.id === saved.id ? saved : item))
                                : [...prev, saved]
                        );
                        setEditing(saved);
                    }}
                    onRemoved={(id) => {
                        setSenders((prev) => prev.filter((item) => item.id !== id));
                        setEditing(null);
                    }}
                />
            )}
        </section>
    );
}
