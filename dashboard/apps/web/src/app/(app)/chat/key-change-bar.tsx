"use client";

/**
 * The line a one-to-one sealed conversation shows when the other person's
 * account key changed since this browser last saw it (design 4.6), as Signal's
 * "safety number changed": it may be them on a new key, or a key the server
 * substituted. Verify opens the safety number; Dismiss puts the line away.
 *
 * The key is checked once each time the conversation opens, after the first
 * frame - nothing waits on it, and no message is held back for it.
 */

import { ShieldAlert } from "lucide-react";
import { SafetyNumberView } from "./safety-number";
import * as peerKeys from "@/lib/chat/e2ee/peer-keys";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Dialog, DialogContent, DialogTitle } from "@polaris/ui";

export function KeyChangeBar({
    channelId,
    viewerId,
    peer
}: {
    channelId: string;
    viewerId: string;
    peer: { id: string; name: string };
}) {
    const t = useTranslations("chat");
    const [open, setOpen] = useState(false);
    const changed = useSyncExternalStore(
        peerKeys.subscribeBooks,
        () => peerKeys.readBook(viewerId)[peer.id]?.changed === true,
        () => false
    );

    useEffect(() => {
        void peerKeys.checkPeer(viewerId, channelId, peer.id);
    }, [viewerId, channelId, peer.id]);

    if (!changed) return null;
    return (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2">
            <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 flex-1 break-words text-xs">{t("info.safetyChanged", { name: peer.name })}</p>
            <div className="flex shrink-0 gap-2">
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => peerKeys.updateBook(viewerId, (book) => peerKeys.acknowledgePeer(book, peer.id))}
                >
                    {t("info.safetyDismiss")}
                </Button>
                <Button size="sm" onClick={() => setOpen(true)}>
                    {t("info.safetyVerify")}
                </Button>
            </div>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogTitle>{t("info.safetyNumber")}</DialogTitle>
                    <SafetyNumberView channelId={channelId} peerId={peer.id} peerName={peer.name} />
                </DialogContent>
            </Dialog>
        </div>
    );
}
