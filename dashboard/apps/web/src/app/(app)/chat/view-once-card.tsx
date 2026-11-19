"use client";

/**
 * A photo, video, recording or text sent to be seen once, as a message draws it.
 *
 * Never the file: a browser is refused the bytes and the still, so this is a
 * closed card. In the phone app the card opens it, once, in the app's own
 * protected screen; anywhere else it says where it can be opened. The sender
 * sees how many have opened it. See `lib/chat/view-once`.
 */

import { cn } from "@polaris/ui";
import { useSyncExternalStore } from "react";
import type { ChatAttachmentView } from "@/lib/chat/messages";
import { viewOnceText } from "@/lib/chat/view-once-choice";
import { canViewOnce, openViewOnce } from "@/lib/mobile-bridge";
import { useTranslations } from "@/components/i18n/i18n-provider";

const never = () => () => {};

/**
 * The mark a view-once message is known by: a "1" in a broken ring while it is
 * still to be seen, the plain ring once it has been. The same shape WhatsApp
 * and Signal use, so it reads without a word.
 */
function OnceMark({ spent }: { spent: boolean }) {
    return (
        <svg
            viewBox="0 0 24 24"
            className={cn("size-5 shrink-0", spent ? "text-muted-foreground" : "text-primary")}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden
        >
            <circle cx="12" cy="12" r="9" strokeDasharray={spent ? undefined : "4 2.6"} />
            {!spent && <path d="M10.5 9.5 12.5 8v8" />}
        </svg>
    );
}

export function ViewOnceCard({
    file,
    mine,
    direct = false
}: {
    file: ChatAttachmentView & { viewOnce: NonNullable<ChatAttachmentView["viewOnce"]> };
    mine: boolean;
    /** A conversation with one other person, where "opened" can only mean them. */
    direct?: boolean;
}) {
    const t = useTranslations("chat");
    // Read after hydration: the server has no phone to ask.
    const phone = useSyncExternalStore(never, canViewOnce, () => false);
    const { opened, openedCount, gone } = file.viewOnce;
    // Only what it is, the way WhatsApp draws it: how it was taken and how long
    // it stays up are for the screen that shows it, not a hint before it opens.
    const what = viewOnceText(file.contentType)
        ? t("viewOnce.message")
        : file.contentType.startsWith("video/")
          ? t("viewOnce.video")
          : file.contentType.startsWith("audio/")
            ? t("viewOnce.audio")
            : t("viewOnce.photo");
    const openable = phone && !mine && !opened && !gone;
    const spent = opened || gone || (mine && openedCount > 0);

    // Where it came from, the way Snapchat marks a picture that was not taken there
    // and then: said on the card, never the picture itself.
    const source =
        file.viewOnce.captured === "camera"
            ? t("viewOnce.fromCamera")
            : file.viewOnce.captured === "gallery"
              ? t("viewOnce.fromGallery")
              : null;
    const title = !mine && opened ? t("viewOnce.opened") : source ? `${what} - ${source}` : what;
    // Away from the phone app nothing here opens it, so the card says where.
    const status = mine
        ? openedCount > 0
            ? direct
                ? t("viewOnce.opened")
                : t("viewOnce.openedBy", { count: openedCount })
            : phone
              ? null
              : t("viewOnce.opensOnPhone")
        : opened
          ? null
          : gone
            ? t("viewOnce.gone")
            : phone
              ? null
              : t("viewOnce.openOnPhone");

    const body = (
        <>
            <OnceMark spent={spent} />
            <span className="sr-only">{t("viewOnce.label")}</span>
            <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium" title={title}>
                    {title}
                </span>
                {status && (
                    <span className="truncate text-muted-foreground" title={status}>
                        {status}
                    </span>
                )}
            </span>
        </>
    );
    const shape =
        "flex w-fit min-w-0 max-w-xs items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-start text-xs";

    if (!openable) {
        return <div className={cn(shape, (opened || gone) && "opacity-70")}>{body}</div>;
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
