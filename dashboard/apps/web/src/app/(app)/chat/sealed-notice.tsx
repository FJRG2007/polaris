"use client";

/**
 * What tells a reader a conversation is end-to-end encrypted, the way WhatsApp
 * does: a line at the very start of the conversation ("Messages and calls are
 * end-to-end encrypted. No one outside of this chat, not even WhatsApp, can
 * read or listen to them. Tap to learn more."), a small lock beside the
 * conversation's name, and both opening a short explainer that, in a
 * one-to-one conversation, carries the safety number to verify - WhatsApp's
 * "Encryption ... Tap to verify" and Signal's "View safety number".
 *
 * Shown only where sends really are sealed: `sealsSendsIn` is the same answer
 * the composer, polls, files and forum posts send by, so nothing here can say
 * "encrypted" about a conversation whose messages go in the clear. Nothing at
 * all while sealed chat is off, and nothing until the answer is known - a
 * question that cannot be answered leaves the mark off rather than claiming it.
 */

import { LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";
import { SafetyNumberView } from "./safety-number";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { sealedChatActive, sealsSendsIn } from "@/lib/chat/e2ee/sealed-chat";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";

/** The one other person of a one-to-one conversation, when it is one. */
export type SealedPeer = { readonly id: string; readonly name: string } | null;

/** Whether `channelId` is a sealed conversation; false while it is being told, and when it cannot be. */
export function useConversationSealed(channelId: string): boolean {
    const [answer, setAnswer] = useState<{ readonly channelId: string; readonly sealed: boolean } | null>(null);

    useEffect(() => {
        if (!sealedChatActive()) return;
        let live = true;
        sealsSendsIn(channelId).then(
            (sealed) => {
                if (live) setAnswer({ channelId, sealed });
            },
            () => undefined
        );
        return () => {
            live = false;
        };
    }, [channelId]);

    return sealedChatActive() && answer?.channelId === channelId && answer.sealed;
}

/** The explainer the notice and the lock open: what is sealed, and the safety number in a one-to-one. */
export function SealedExplainer({
    open,
    onOpenChange,
    channelId,
    peer
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    channelId: string;
    peer: SealedPeer;
}) {
    const t = useTranslations("chat");
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <div className="flex flex-col gap-5">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <LockKeyhole className="size-4 shrink-0" aria-hidden />
                            {t("sealedNotice.title")}
                        </DialogTitle>
                        <DialogDescription>{t("sealedNotice.body")}</DialogDescription>
                    </DialogHeader>
                    {peer ? (
                        <section className="flex flex-col gap-2">
                            <h3 className="text-sm font-medium">{t("sealedNotice.verify", { name: peer.name })}</h3>
                            <SafetyNumberView channelId={channelId} peerId={peer.id} peerName={peer.name} />
                        </section>
                    ) : (
                        <p className="text-sm text-muted-foreground">{t("sealedNotice.groupVerify")}</p>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** The line at the very start of a sealed conversation. */
export function SealedNotice({ channelId, peer }: { channelId: string; peer: SealedPeer }) {
    const t = useTranslations("chat");
    const sealed = useConversationSealed(channelId);
    const [open, setOpen] = useState(false);
    if (!sealed) return null;
    return (
        <div className="flex justify-center px-4 py-2">
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="flex max-w-md min-w-0 items-start gap-2 rounded-md bg-muted px-3 py-2 text-start text-xs text-muted-foreground hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">
                    {t("sealedNotice.line")} <span className="font-medium text-foreground">{t("sealedNotice.learnMore")}</span>
                </span>
            </button>
            <SealedExplainer open={open} onOpenChange={setOpen} channelId={channelId} peer={peer} />
        </div>
    );
}

/** The small lock beside a sealed conversation's name. */
export function SealedMark({ channelId, peer }: { channelId: string; peer: SealedPeer }) {
    const t = useTranslations("chat");
    const sealed = useConversationSealed(channelId);
    const [open, setOpen] = useState(false);
    if (!sealed) return null;
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title={t("sealedNotice.mark")}
                aria-label={t("sealedNotice.mark")}
                className="flex shrink-0 items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <LockKeyhole className="size-3.5" aria-hidden />
            </button>
            <SealedExplainer open={open} onOpenChange={setOpen} channelId={channelId} peer={peer} />
        </>
    );
}
