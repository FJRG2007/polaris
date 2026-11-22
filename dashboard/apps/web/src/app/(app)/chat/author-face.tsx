"use client";

/**
 * The face and the tag of whoever wrote a message, for the places that show a
 * message with nothing to press on it - the delete confirmation, a preview.
 *
 * A message nobody's account wrote is drawn as what wrote it: Polar with its
 * face and its AI tag, one of Polaris's apps with its mark and the APP tag, a
 * webhook with its picture and the same tag. Drawn as a person instead, it got
 * the initials of a name nobody has and no tag at all.
 */

import Link from "next/link";
import { Blocks } from "lucide-react";
import { messageLink } from "./links";
import { POLARIS_APPS } from "@/lib/apps";
import { WebhookFace } from "./webhook-face";
import { Avatar } from "@/components/avatar";
import type { ChatMessageView } from "@/lib/chat/messages";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PolarBadge, PolarFace } from "@/components/polar/polar-bot";

/** The face of a message one of Polaris's own apps wrote: the app's mark. */
export function AppAgentFace({ agent }: { agent: string }) {
    const Icon = POLARIS_APPS.find((app) => app.id === agent)?.icon ?? Blocks;
    return (
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Icon className="size-4 shrink-0" aria-hidden />
        </span>
    );
}

type Authored = Pick<ChatMessageView, "authorId" | "fromAgent" | "fromWebhook" | "webhookAvatar" | "published" | "publishedFrom">;

/** Whoever wrote the message, as a 28px face. */
export function AuthorFace({ message, name }: { message: Authored; name: string }) {
    if (message.fromAgent === "polar") return <PolarFace size={28} />;
    if (message.fromAgent) return <AppAgentFace agent={message.fromAgent} />;
    if (message.fromWebhook) return <WebhookFace src={message.webhookAvatar} />;
    return <Avatar person={{ id: message.authorId, name }} size={28} />;
}

/** The tag beside the name of something that is not a person, or nothing. */
export function AuthorTag({ message }: { message: Authored }) {
    const t = useTranslations("chat");
    if (message.fromAgent === "polar") return <PolarBadge />;
    if (message.published) {
        const tag = "shrink-0 self-center rounded bg-primary px-1 text-[0.625rem] font-semibold uppercase leading-4 text-primary-foreground";
        // A link back to the original, where the reader may open it; the
        // message route says why when they cannot.
        return message.publishedFrom ? (
            <Link
                className={`${tag} hover:underline`}
                href={messageLink("", message.publishedFrom.channelId, message.publishedFrom.messageId)}
                title={t("follow.publishedHint")}
            >
                {t("follow.publishedTag")}
            </Link>
        ) : (
            <span className={tag} title={t("follow.publishedHint")}>
                {t("follow.publishedTag")}
            </span>
        );
    }
    if (!message.fromWebhook && !message.fromAgent) return null;
    return (
        <span
            className="shrink-0 self-center rounded bg-primary px-1 text-[0.625rem] font-semibold uppercase leading-4 text-primary-foreground"
            title={t(message.fromWebhook ? "messageList.webhookHint" : "messageList.appHint")}
        >
            {t("messageList.app")}
        </span>
    );
}
