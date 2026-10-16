"use client";

/**
 * The card under a message that carries an invitation link.
 *
 * Drawn from what the server resolved for this reader when the page was read
 * (`ChatMessageView.invites`): which space, whether it can still be used,
 * whether they are already in it, and how many people are in it and around.
 * Joining goes through the same action the invitation page uses, so every
 * bound and every ban is checked the same way.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { acceptInviteAction } from "./actions";
import { Loader2, ShieldX } from "lucide-react";
import { ChatAvatar } from "@/components/chat-avatar";
import type { ChatInviteCard } from "@/lib/chat/invite-cards";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function InviteCards({
    invites,
    mine
}: {
    invites: readonly ChatInviteCard[];
    /** The reader sent this message, which changes the line above the card. */
    mine: boolean;
}) {
    if (invites.length === 0) return null;
    return (
        <ul className="mt-1 flex flex-col gap-1">
            {invites.map((card) => (
                <li key={card.code}>
                    <InviteCard card={card} mine={mine} />
                </li>
            ))}
        </ul>
    );
}

export function InviteCard({ card, mine }: { card: ChatInviteCard; mine: boolean }) {
    const t = useTranslations("chat");
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    // Optimistic: the button reads Joined the moment it is pressed, and goes
    // back if the server refuses.
    const [joined, setJoined] = useState(card.member);
    const [error, setError] = useState("");
    const valid = card.spaceId !== null && card.usable;

    const open = (channelId: string | null) => {
        router.push(channelId ? `/chat/c/${channelId}` : "/chat");
        router.refresh();
    };

    const join = async () => {
        if (joined) {
            open(card.channelId);
            return;
        }
        setBusy(true);
        setError("");
        setJoined(true);
        const result = await runAction(() => acceptInviteAction(card.code), setError);
        setBusy(false);
        if (!result || result.error) {
            setJoined(false);
            if (result?.error) setError(result.error);
            return;
        }
        open(result.channelId ?? card.channelId);
    };

    return (
        <div className="flex w-full max-w-md flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                {valid
                    ? mine
                        ? t("inviteCard.youSent")
                        : t("inviteCard.youWereInvited")
                    : mine
                      ? t("inviteCard.youSentBut")
                      : t("inviteCard.youReceivedBut")}
            </span>
            <div className="flex min-w-0 items-center gap-3">
                {valid && card.spaceId ? (
                    <ChatAvatar
                        kind="space"
                        id={card.spaceId}
                        name={card.spaceName}
                        color={card.spaceColor}
                        size={48}
                        square
                        invite={card.code}
                    />
                ) : (
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-danger-soft text-danger">
                        <ShieldX className="size-6" />
                    </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                    <span
                        className={
                            valid
                                ? "truncate font-semibold"
                                : "truncate font-semibold text-danger"
                        }
                        title={valid ? card.spaceName : undefined}
                    >
                        {valid ? card.spaceName : t("inviteCard.invalid")}
                    </span>
                    {valid ? (
                        <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                                <span className="size-2 rounded-full bg-success" aria-hidden />
                                {t("inviteCard.online", { count: card.online })}
                            </span>
                            <span className="flex items-center gap-1">
                                <span
                                    className="size-2 rounded-full bg-muted-foreground"
                                    aria-hidden
                                />
                                {t("inviteCard.members", { count: card.members })}
                            </span>
                        </span>
                    ) : (
                        <span className="text-xs text-muted-foreground">
                            {mine ? t("inviteCard.trySending") : t("inviteCard.tryAsking")}
                        </span>
                    )}
                </div>
                {valid && (
                    <Button
                        size="sm"
                        variant={joined ? "secondary" : "primary"}
                        disabled={busy}
                        title={joined ? t("inviteCard.goTo") : undefined}
                        onClick={() => void join()}
                        className="shrink-0"
                    >
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {joined ? t("inviteCard.joined") : t("inviteCard.join")}
                    </Button>
                )}
            </div>
            {error && (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}
