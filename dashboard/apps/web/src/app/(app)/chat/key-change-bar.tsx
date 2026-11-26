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
import * as keyLog from "@/lib/chat/e2ee/key-log-client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Dialog, DialogFooter, DialogHeader, DialogTitle, DialogContent, DialogDescription } from "@polaris/ui";

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

/**
 * The group form of the line (design 4.6: "un aviso por miembro cuya clave
 * cambia"): the members whose key changed since this browser last saw it,
 * named, with Dismiss. A group has no safety number of its own - each pair
 * compares theirs in their one-to-one conversation - so there is no Verify.
 */
export function GroupKeyChangeBar({
    channelId,
    viewerId,
    members
}: {
    channelId: string;
    viewerId: string;
    members: ReadonlyArray<{ id: string; name: string }>;
}) {
    const t = useTranslations("chat");
    const ids = useMemo(() => members.map((m) => m.id).slice(0, peerKeys.PEERS_PER_CHECK), [members]);
    const key = ids.join(",");
    const changedKey = useSyncExternalStore(
        peerKeys.subscribeBooks,
        () => {
            const book = peerKeys.readBook(viewerId);
            return ids.filter((id) => book[id]?.changed === true).join(",");
        },
        () => ""
    );

    useEffect(() => {
        if (key) void peerKeys.checkPeers(viewerId, channelId, key.split(","));
    }, [viewerId, channelId, key]);

    const changed = changedKey ? changedKey.split(",") : [];
    if (!changed.length) return null;
    const names = changed.map((id) => members.find((m) => m.id === id)?.name ?? "").filter(Boolean);
    return (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2">
            <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 flex-1 break-words text-xs">
                {t("info.groupKeysChanged", { count: names.length, name: names[0] ?? "", names: names.join(", ") })}
            </p>
            <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => peerKeys.updateBook(viewerId, (book) => changed.reduce((next, id) => peerKeys.acknowledgePeer(next, id), book))}
            >
                {t("info.safetyDismiss")}
            </Button>
        </div>
    );
}

/** One own-entry check per page and account: the log is asked once, not per conversation. */
const alarms = new Map<string, Promise<number>>();

/** The notices each account put away in this page, by what they said: a different one shows again. */
const dismissedNotices = new Map<string, ReadonlySet<string>>();

/**
 * The account's own alarm (design 4.6): the key log holds a key for this
 * account that this browser's copy did not make - which is what anybody else
 * would be handed if the server substituted it - or the log contradicted
 * itself, or was reset to a key the old one never handed over to. Shown above
 * the box of every sealed conversation until dismissed; a dismissed notice
 * stays away for the page, but a different problem (another kind, another
 * count of foreign keys, another reset key) is shown again. A reset offers to
 * trust exactly the key it was reset to, after a confirmation.
 */
export function KeyLogNotice({ viewerId }: { viewerId: string }) {
    const t = useTranslations("chat");
    const [foreign, setForeign] = useState(0);
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => dismissedNotices.get(viewerId) ?? new Set());
    const [trusting, setTrusting] = useState<string | null>(null);
    const problem = useSyncExternalStore(
        keyLog.subscribeLog,
        () => {
            const kind = keyLog.logProblem(viewerId);
            return kind === "log-reset" ? `log-reset:${keyLog.pendingReset(viewerId) ?? ""}` : kind ? `problem:${kind}` : null;
        },
        () => null
    );

    useEffect(() => {
        let live = true;
        let check = alarms.get(viewerId);
        if (!check) {
            // Loaded on first use, as the safety number loads it: the account key client is not on the chat page otherwise.
            check = import("@/lib/chat/e2ee/account-key-client")
                .then((client) => client.ownKeyAlarm())
                .then((alarm) => (alarm && alarm.ownId === viewerId ? alarm.foreign.length : 0)).catch(() => 0);
            alarms.set(viewerId, check);
        }
        void check.then((count) => live && setForeign(count));
        return () => {
            live = false;
        };
    }, [viewerId]);

    const notice = [foreign ? `foreign:${foreign}` : null, problem].find((n): n is string => !!n && !dismissed.has(n));
    if (!notice) return null;
    const resetKey = notice.startsWith("log-reset:") ? notice.slice("log-reset:".length) : "";
    const dismiss = () => {
        const next = new Set(dismissed).add(notice);
        dismissedNotices.set(viewerId, next);
        setDismissed(next);
    };
    return (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2">
            <ShieldAlert className="size-4 shrink-0 text-danger" aria-hidden />
            <p className="min-w-0 flex-1 break-words text-xs">
                {t(notice.startsWith("foreign:") ? "info.keyLogForeign" : resetKey ? "info.keyLogReset" : "info.keyLogFailed")}
            </p>
            <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" onClick={dismiss}>
                    {t("info.safetyDismiss")}
                </Button>
                {resetKey && (
                    <Button size="sm" onClick={() => setTrusting(resetKey)}>
                        {t("info.keyLogTrust")}
                    </Button>
                )}
            </div>
            <Dialog open={trusting !== null} onOpenChange={(open) => !open && setTrusting(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("info.keyLogTrustTitle")}</DialogTitle>
                        <DialogDescription>{t("info.keyLogTrustBody")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setTrusting(null)}>
                            {t("info.keyLogTrustCancel")}
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => {
                                // The key this dialog was opened for, never whatever the log points at by now.
                                if (trusting) keyLog.trustLogReset(viewerId, trusting);
                                setTrusting(null);
                                // Pinned on this ask, not the next conversation's: a log that does not extend the old head fails here.
                                void keyLog.askLog(viewerId, { op: "own" });
                            }}
                        >
                            {t("info.keyLogTrust")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
