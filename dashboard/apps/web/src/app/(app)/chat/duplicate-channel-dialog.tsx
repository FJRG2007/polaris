"use client";

/**
 * A copy of a channel, from its row in the rail.
 *
 * The name is offered already free - the original's with the first number that
 * nobody in the space has used - because a copy is usually renamed later, and a
 * dialog that opens on a name it will refuse is a dialog that argues first.
 */

import * as core from "@polaris/core";
import { useChat } from "./chat-context";
import { useRouter } from "next/navigation";
import { Hash, Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { duplicateChannelAction } from "./actions";
import { freeCopyName } from "@/lib/chat/copy-name";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

export function DuplicateChannelDialog({
    channel,
    onOpenChange
}: {
    /** The channel being copied. Null closes the dialog. */
    channel: ChatChannelView | null;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("chat");
    const tc = useTranslations("common");
    const router = useRouter();
    const { channels, refresh } = useChat();
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const taken = useMemo(
        () =>
            new Set(
                channels
                    .filter((entry) => channel && entry.spaceId === channel.spaceId)
                    .map((entry) => entry.name)
            ),
        [channels, channel]
    );
    // Read when the dialog opens, not followed after: the rail refreshing while
    // somebody types must not rewrite the name under them.
    const takenNow = useRef(taken);
    takenNow.current = taken;

    // A fresh name each time it opens, never the last attempt's.
    useEffect(() => {
        if (!channel) return;
        setName(freeCopyName(channel.name, takenNow.current));
        setError("");
    }, [channel]);

    const stored = useMemo(() => core.normalizeChannelName(name), [name]);

    const duplicate = async () => {
        if (!channel || !stored || busy) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () => duplicateChannelAction({ channelId: channel.id, name }),
            setError
        );
        setBusy(false);
        if (!result || result.error || !result.id) {
            if (result?.error) setError(result.error);
            return;
        }
        onOpenChange(false);
        refresh();
        router.push(`/chat/c/${result.id}`);
    };

    return (
        <Dialog open={channel !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("channelMenu.duplicateTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("channelMenu.duplicateHint", { name: channel?.name ?? "" })}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-1">
                    <Input
                        value={name}
                        autoFocus
                        aria-label={t("channelMenu.copyName")}
                        maxLength={core.MAX_CHAT_CHANNEL_NAME}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void duplicate();
                        }}
                    />
                    {stored && stored !== name && (
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Hash className="size-3" />
                            {stored}
                        </p>
                    )}
                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button size="sm" disabled={busy || !stored} onClick={() => void duplicate()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("channelMenu.duplicateConfirm")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
