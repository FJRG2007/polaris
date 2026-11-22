"use client";

/**
 * Follow an announcement channel into a channel you run: what it publishes is
 * copied there. Lists the text channels of every space the reader administers,
 * each with Follow or Unfollow.
 */

import { useEffect, useState } from "react";
import { Hash, Loader2 } from "lucide-react";
import type { ChatFollowTarget } from "@/lib/chat/follows";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { followChannelAction, followTargetsAction, unfollowChannelAction } from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Skeleton,
    useToast
} from "@polaris/ui";

export function FollowDialog({
    open,
    onOpenChange,
    sourceChannelId,
    sourceName
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sourceChannelId: string;
    sourceName: string;
}) {
    const t = useTranslations("chat");
    const toast = useToast();
    const [targets, setTargets] = useState<ChatFollowTarget[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        let live = true;
        setTargets(null);
        setError(null);
        followTargetsAction(sourceChannelId).then(
            (result) => {
                if (!live) return;
                if (result.error) setError(result.error);
                else setTargets(result.targets ?? []);
            },
            () => live && setError(t("follow.loadFailed"))
        );
        return () => {
            live = false;
        };
    }, [open, sourceChannelId, t]);

    const toggle = async (target: ChatFollowTarget) => {
        if (busy) return;
        setBusy(target.channelId);
        const input = { sourceChannelId, targetChannelId: target.channelId };
        const previous = target.followId;
        // Drawn at once, put back on a refusal.
        const draw = (followId: string | null) =>
            setTargets((list) =>
                (list ?? []).map((row) => (row.channelId === target.channelId ? { ...row, followId } : row))
            );
        draw(previous ? null : "pending");
        try {
            const result = previous
                ? await unfollowChannelAction(input)
                : await followChannelAction(input);
            if (result.error) {
                draw(previous);
                toast.show({ title: result.error });
            } else if (!previous) {
                draw((result as { followId?: string }).followId ?? "pending");
                toast.show({ title: t("follow.followed", { channel: target.name }) });
            }
        } catch {
            draw(previous);
            toast.show({ title: t("follow.failed") });
        } finally {
            setBusy(null);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("follow.title", { channel: sourceName })}</DialogTitle>
                    <DialogDescription>{t("follow.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex max-h-80 min-h-0 flex-col gap-1 overflow-y-auto">
                    {error ? (
                        <p className="text-sm text-destructive">{error}</p>
                    ) : targets === null ? (
                        [0, 1, 2].map((index) => <Skeleton key={index} className="h-9 w-full" />)
                    ) : targets.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("follow.empty")}</p>
                    ) : (
                        targets.map((target) => (
                            <div key={target.channelId} className="flex min-w-0 items-center gap-2 py-1">
                                <Hash className="size-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate text-sm" title={`${target.spaceName} · #${target.name}`}>
                                    <span className="text-muted-foreground">{target.spaceName} · </span>
                                    {target.name}
                                </span>
                                <Button
                                    size="sm"
                                    variant={target.followId ? "outline" : "primary"}
                                    disabled={busy !== null}
                                    onClick={() => void toggle(target)}
                                >
                                    {busy === target.channelId && <Loader2 className="size-3.5 animate-spin" />}
                                    {target.followId ? t("follow.unfollow") : t("follow.follow")}
                                </Button>
                            </div>
                        ))
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
