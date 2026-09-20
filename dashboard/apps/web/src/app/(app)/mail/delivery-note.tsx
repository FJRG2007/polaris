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
import { Clock, MailCheck, TriangleAlert } from "lucide-react";

export function DeliveryNote({ delivery }: { delivery: MailDeliveryView }) {
    const format = useDisplayFormat();
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
                    delivery.detail
                ) : (
                    <>
                        Your outgoing server accepted it at{" "}
                        {format.dateTime(new Date(delivery.sentAt))}, and nothing has come back
                        since. That is as much as Polaris can know about a message once it is
                        handed over.
                    </>
                )}
                {copyNote(delivery.sentCopy)}{" "}
                {settled && delivery.reportThreadId ? (
                    <Link
                        href={`/mail/t/${delivery.reportThreadId}`}
                        className="underline underline-offset-2"
                    >
                        Read the report
                    </Link>
                ) : null}
            </span>
        </p>
    );
}

/** Said only when there is no copy, because "a copy was filed in Sent" is the
 *  ordinary case and the reader is looking at the copy while they read it. */
function copyNote(copy: MailDeliveryView["sentCopy"]): string {
    if (copy === "failed") return " The mail server would not keep a copy of it in Sent.";
    if (copy === "none") return " This mailbox has no Sent folder, so no copy was kept.";
    return "";
}
