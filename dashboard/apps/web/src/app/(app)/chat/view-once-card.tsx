"use client";

/**
 * A photo or video sent to be seen once, as a message draws it.
 *
 * Never the file: a browser is refused the bytes and the still, so this is a
 * closed card. In the phone app the card opens it, once, in the app's own
 * protected screen; anywhere else it says where it can be opened. The sender
 * sees how many have opened it. See `lib/chat/view-once`.
 */

import { cn } from "@polaris/ui";
import { useSyncExternalStore } from "react";
import type { ChatAttachmentView } from "@/lib/chat/messages";
import { canViewOnce, openViewOnce } from "@/lib/mobile-bridge";
import { Camera, Eye, EyeOff, Images, Timer } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

const never = () => () => {};

export function ViewOnceCard({
    file,
    mine
}: {
    file: ChatAttachmentView & { viewOnce: NonNullable<ChatAttachmentView["viewOnce"]> };
    mine: boolean;
}) {
    const t = useTranslations("chat");
    // Read after hydration: the server has no phone to ask.
    const phone = useSyncExternalStore(never, canViewOnce, () => false);
    const { opened, openedCount, seconds, captured } = file.viewOnce;
    const video = file.contentType.startsWith("video/");
    const what = video ? t("viewOnce.video") : t("viewOnce.photo");
    const openable = phone && !mine && !opened;

    const status = mine
        ? openedCount > 0
            ? t("viewOnce.openedBy", { count: openedCount })
            : t("viewOnce.notOpened")
        : opened
          ? t("viewOnce.opened")
          : phone
            ? t("viewOnce.tapToView")
            : t("viewOnce.openOnPhone");

    const body = (
        <>
            {opened || (mine && openedCount > 0) ? (
                <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
                <Eye className="size-4 shrink-0 text-primary" aria-hidden />
            )}
            <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium" title={what}>{what}</span>
                <span className="truncate text-muted-foreground" title={status}>{status}</span>
            </span>
            <span className="ms-auto flex shrink-0 items-center gap-2 text-muted-foreground">
                {captured && (
                    <span className="flex items-center gap-1" title={t(`viewOnce.captured.${captured}`)}>
                        {captured === "camera" ? (
                            <Camera className="size-3.5 shrink-0" aria-hidden />
                        ) : (
                            <Images className="size-3.5 shrink-0" aria-hidden />
                        )}
                        <span className="sr-only">{t(`viewOnce.captured.${captured}`)}</span>
                    </span>
                )}
                <span className="flex items-center gap-1">
                    <Timer className="size-3.5 shrink-0" aria-hidden />
                    {seconds === null ? t("viewOnce.untilClosed") : t("viewOnce.seconds", { seconds })}
                </span>
            </span>
        </>
    );
    const shape =
        "flex w-full max-w-xs items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-start text-xs";

    if (!openable) {
        return <div className={cn(shape, opened && "opacity-70")}>{body}</div>;
    }
    return (
        <button
            type="button"
            className={cn(shape, "transition-colors hover:bg-card-hover")}
            onClick={() => openViewOnce(file.id)}
        >
            {body}
        </button>
    );
}
