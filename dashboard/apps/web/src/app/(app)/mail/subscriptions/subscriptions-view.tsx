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
import { useMemo, useState, useTransition } from "react";
import { UnsubscribeButton } from "../unsubscribe-button";
import { useDisplayFormat } from "@/components/display-format";
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
    const { accounts } = useMail();
    const format = useDisplayFormat();
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
            <h1 className="text-[17px] font-semibold tracking-tight">Subscriptions</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
                Senders that publish a way off their list. Polaris notes them as their mail arrives,
                so this is everything it has seen rather than everything you ever signed up to.
                {capped ? " Only the ones that wrote most recently are shown." : ""}
            </p>

            {accounts.length === 0 ? (
                <div className="mt-6">
                    <EmptyState
                        icon={<MailX className="size-5 shrink-0" aria-hidden />}
                        title="No mailbox yet"
                        description="Connect one and the lists it receives appear here."
                    />
                </div>
            ) : subscriptions.length === 0 ? (
                <div className="mt-6">
                    <EmptyState
                        icon={<MailX className="size-5 shrink-0" aria-hidden />}
                        title="Nothing to leave yet"
                        description="Newsletters and mailing lists appear here as they arrive."
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
                                placeholder="Find a sender"
                                aria-label="Find a sender"
                                className="pl-8"
                            />
                        </div>
                        {ignored > 0 ? (
                            <p className="text-[12px] text-warning">
                                {ignored === 1
                                    ? "1 sender kept writing after you asked."
                                    : `${ignored} senders kept writing after you asked.`}
                            </p>
                        ) : null}
                    </div>

                    {shown.length === 0 ? (
                        <p className="mt-4 text-[13px] text-muted-foreground">
                            No sender matches that.
                        </p>
                    ) : (
                        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                            {shown.map((one) => (
                                <Row
                                    key={one.id}
                                    subscription={one}
                                    mailbox={
                                        accounts.length > 1
                                            ? (accounts.find((account) => account.id === one.accountId)
                                                  ?.address ?? "")
                                            : ""
                                    }
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
    format
}: {
    subscription: MailSubscriptionView;
    mailbox: string;
    format: ReturnType<typeof useDisplayFormat>;
}) {
    const router = useRouter();
    const toast = useToast();
    const [busy, startBusy] = useTransition();

    const name = subscription.senderName || subscription.sender;
    const messages =
        subscription.messageCount === 1
            ? "1 message"
            : `${subscription.messageCount} messages`;

    return (
        <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <SenderFace
                name={subscription.senderName}
                address={subscription.sender}
                className="size-7"
            />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium" title={subscription.sender}>
                    {name}
                </span>
                <span className="block truncate text-[12px] text-foreground-subtle">
                    {subscription.senderName ? `${subscription.sender} - ` : ""}
                    {messages}, last on {format.date(subscription.lastMessageAt)}
                    {mailbox ? ` - to ${mailbox}` : ""}
                </span>
                {subscription.askedAt ? (
                    <span
                        className={
                            subscription.stillSending
                                ? "block text-[12px] text-warning"
                                : "block text-[12px] text-foreground-subtle"
                        }
                    >
                        {subscription.kind === "link"
                            ? `Their page was opened on ${format.date(subscription.askedAt)}`
                            : `Asked on ${format.date(subscription.askedAt)}`}
                        {subscription.stillSending ? ", and they have written since." : "."}
                    </span>
                ) : null}
                {subscription.source === "body" ? (
                    <span className="block text-[12px] text-foreground-subtle">
                        Found in their message rather than published as a header.
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
                                title: `${subscription.sender} now goes straight to the trash.`
                            });
                            router.refresh();
                        })
                    }
                >
                    <BellOff className="size-3.5 shrink-0" aria-hidden />
                    Block
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
                label={subscription.askedAt ? "Ask again" : "Unsubscribe"}
            />
        </li>
    );
}
