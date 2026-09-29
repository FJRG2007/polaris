"use client";

/**
 * What became of a message this Polaris sent, on the message itself.
 *
 * The line every mail client gets wrong by omission: it shows the message in
 * Sent and stops, so "it is in Sent" reads as "they got it" - and for the one
 * case where they did not, the evidence arrived as a separate message from
 * `mailer-daemon` two folders away and nobody tied the two together.
 *
 * The wording is the whole point of this component, so it is worth being blunt
 * about the rule: **for a mailbox at somebody else's provider, the most Polaris
 * ever knows is that the provider took it.** Not that it was delivered, not that
 * it was read. So the good case says exactly that and says nothing came back,
 * which is a fact rather than a reassurance, and only a report coming back is
 * ever allowed to claim more.
 */

import Link from "next/link";
import type { MailDeliveryView } from "@/lib/mailbox/delivery";
import { useDisplayFormat } from "@/components/display-format";
import { mailRefusalText } from "@/lib/mailbox/refusal-text";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Clock, MailCheck, TriangleAlert } from "lucide-react";

export function DeliveryNote({ delivery }: { delivery: MailDeliveryView }) {
    const format = useDisplayFormat();
    const t = useTranslations("mail");
    const settled = delivery.state === "bounced" || delivery.state === "delayed";
    const bad = delivery.state === "bounced" || delivery.state === "partial";
    const Icon = bad ? TriangleAlert : delivery.state === "delayed" ? Clock : MailCheck;

    return (
        <p
            className={
                bad
                    ? "mb-3 flex items-start gap-1.5 rounded-md border border-warning-edge bg-warning-soft px-3 py-1.5 text-[12px] text-foreground"
                    : "mb-3 flex items-start gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] text-muted-foreground"
            }
        >
            <Icon
                className={`mt-px size-3.5 shrink-0 ${bad ? "text-warning" : ""}`}
                aria-hidden
            />
            <span className="min-w-0">
                {settled || delivery.state === "partial" ? (
                    mailRefusalText(t, delivery.detail)
                ) : (
                    t("delivery.accepted", { time: format.dateTime(new Date(delivery.sentAt)) })
                )}
                {delivery.sentCopy === "failed"
                    ? t("delivery.copyFailed")
                    : delivery.sentCopy === "none"
                      ? t("delivery.noSent")
                      : ""}{" "}
                {settled && delivery.reportThreadId ? (
                    <Link
                        href={`/mail/t/${delivery.reportThreadId}`}
                        className="underline underline-offset-2"
                    >
                        {t("delivery.readReport")}
                    </Link>
                ) : null}
            </span>
        </p>
    );
}

