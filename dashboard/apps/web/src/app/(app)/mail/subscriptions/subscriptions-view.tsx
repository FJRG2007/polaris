"use client";

/**
 * The senders you could stop, all of them, in one list.
 *
 * Ordered by who wrote most recently rather than by who writes most: the list
 * somebody wants to leave is nearly always one they were reminded of this
 * morning, and "how much of my mail is this" is already on the row.
 *
 * The row that has been asked once and is still arriving is the only one that
 * gets any emphasis. It is also the only one this screen can do anything more
 * about - a list that ignored an unsubscribe is not going to honour a second
 * one, so what it offers there is the block, which does not depend on the
 * sender's cooperation.
 */

import { refusalOf } from "../refusal";
import { useMail } from "../mail-shell";
import { useRouter } from "next/navigation";
import { SenderFace } from "../sender-face";
import { blockSenderAction } from "../actions";
import { BellOff, MailX, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useBusy } from "../use-busy";
import { UnsubscribeButton } from "../unsubscribe-button";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, EmptyState, Input, useToast } from "@polaris/ui";
import type { MailSubscriptionView } from "@/lib/mailbox/subscriptions";

export function SubscriptionsView({
    subscriptions,
    capped = false
}: {
    subscriptions: MailSubscriptionView[];
    /** Set when the read hit its bound, so the screen says the list is not the
     *  whole of it instead of implying it is. */
    capped?: boolean;
}) {
    const { accounts, accountColor } = useMail();
    const format = useDisplayFormat();
    const t = useTranslations("mail");
    const [query, setQuery] = useState("");

    const shown = useMemo(() => {
        const wanted = query.trim().toLowerCase();
        if (!wanted) return subscriptions;
        return subscriptions.filter(
            (one) =>
                one.sender.includes(wanted) ||
                one.senderName.toLowerCase().includes(wanted) ||
                one.listId.toLowerCase().includes(wanted)
        );
    }, [subscriptions, query]);

    const ignored = subscriptions.filter((one) => one.stillSending).length;

    return (
        <div className="mx-auto w-full max-w-4xl px-4 py-6">
            <h1 className="text-[17px] font-semibold tracking-tight">{t("subscriptions.title")}</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
                {t("subscriptions.lead")}
                {capped ? t("subscriptions.capped") : ""}
            </p>

            {accounts.length === 0 ? (
                <div className="mt-6">
                    <EmptyState
                        icon={<MailX className="size-5 shrink-0" aria-hidden />}
                        title={t("subscriptions.noMailboxTitle")}
                        description={t("subscriptions.noMailboxBody")}
                    />
                </div>
            ) : subscriptions.length === 0 ? (
                <div className="mt-6">
                    <EmptyState
                        icon={<MailX className="size-5 shrink-0" aria-hidden />}
                        title={t("subscriptions.emptyTitle")}
                        description={t("subscriptions.emptyBody")}
                    />
                </div>
            ) : (
                <>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                        <div className="relative min-w-0 flex-1">
                            <Search
                                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 shrink-0 -translate-y-1/2 text-foreground-subtle"
                                aria-hidden
                            />
                            <Input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t("subscriptions.find")}
                                aria-label={t("subscriptions.find")}
                                className="pl-8"
                            />
                        </div>
                        {ignored > 0 ? (
                            <p className="text-[12px] text-warning">
                                {t("subscriptions.ignored", { count: ignored })}
                            </p>
                        ) : null}
                    </div>

                    {shown.length === 0 ? (
                        <p className="mt-4 text-[13px] text-muted-foreground">
                            {t("subscriptions.noMatch")}
                        </p>
                    ) : (
                        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                            {shown.map((one) => (
                                <Row
                                    key={one.id}
                                    subscription={one}
                                    // Which mailbox this list writes to, for
                                    // somebody who has several. Empty for
                                    // somebody who has one, where it is the
                                    // answer to a question nobody asked.
                                    mailbox={
                                        accounts.length > 1
                                            ? (accounts.find(
                                                  (account) => account.id === one.accountId
                                              )?.address ?? "")
                                            : ""
                                    }
                                    colour={accountColor(one.accountId)}
                                    format={format}
                                />
                            ))}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}

function Row({
    subscription,
    mailbox,
    colour,
    format
}: {
    subscription: MailSubscriptionView;
    /** The mailbox this sender writes to, or "" where there is only one. */
    mailbox: string;
    /** That mailbox's own colour, the same one the rail and every merged list
     *  draw it with. */
    colour: string;
    format: ReturnType<typeof useDisplayFormat>;
}) {
    const router = useRouter();
    const toast = useToast();
    const t = useTranslations("mail");
    const [busy, startBusy] = useBusy();

    const name = subscription.senderName || subscription.sender;

    return (
        <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <SenderFace name={subscription.senderName} address={subscription.sender} />
            <span className="min-w-0 flex-1">
                <span
                    className="block truncate text-[13px] font-medium"
                    title={subscription.sender}
                >
                    {name}
                </span>
                <span className="block truncate text-[12px] text-foreground-subtle">
                    {subscription.senderName ? `${subscription.sender} - ` : ""}
                    {t("subscriptions.messages", {
                        count: subscription.messageCount,
                        date: format.date(subscription.lastMessageAt)
                    })}
                </span>
                {/* Which mailbox it arrives in, on a line of its own rather than
                    at the end of one that truncates - where it was the first
                    thing to go, on exactly the rows long enough to need it. The
                    dot is the mailbox's own, so this row and the rail agree
                    without either being read. */}
                {mailbox ? (
                    <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-foreground-subtle">
                        <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: colour }}
                            aria-hidden
                        />
                        <span className="truncate" title={mailbox}>
                            {t("subscriptions.to", { mailbox })}
                        </span>
                    </span>
                ) : null}
                {subscription.askedAt ? (
                    <span
                        className={
                            subscription.stillSending
                                ? "block text-[12px] text-warning"
                                : "block text-[12px] text-foreground-subtle"
                        }
                    >
                        {t("subscriptions.asked", {
                            kind: subscription.kind === "link" ? "link" : "mail",
                            date: format.date(subscription.askedAt),
                            since: subscription.stillSending ? "yes" : "no"
                        })}
                    </span>
                ) : null}
                {subscription.source === "body" ? (
                    <span className="block text-[12px] text-foreground-subtle">
                        {t("subscriptions.fromBody")}
                    </span>
                ) : null}
            </span>

            {subscription.stillSending ? (
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                        startBusy(async () => {
                            const answer = await blockSenderAction(subscription.accountId, {
                                address: subscription.sender,
                                as: "trash"
                            });
                            const said = refusalOf(answer);
                            if (said) {
                                toast.show({ title: said });
                                return;
                            }
                            toast.show({
                                title: t("subscriptions.blocked", { sender: subscription.sender })
                            });
                            router.refresh();
                        })
                    }
                >
                    <BellOff className="size-3.5 shrink-0" aria-hidden />
                    {t("subscriptions.block")}
                </Button>
            ) : null}

            <UnsubscribeButton
                target={{
                    kind: subscription.kind,
                    url: subscription.url,
                    source: subscription.source,
                    sender: name,
                    subscriptionId: subscription.id
                }}
                label={subscription.askedAt ? t("subscriptions.askAgain") : t("unsubscribe.label")}
            />
        </li>
    );
}
