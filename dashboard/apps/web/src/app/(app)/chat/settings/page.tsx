/**
 * Chat settings (/chat/settings): how Chat behaves for the account signed in.
 *
 * Every person's own, reached from the conversation list. What the operator
 * decides for everybody stays under Polaris apps (/admin/apps/chat/settings);
 * nothing here changes what anybody else sees. The chat cards from Privacy are
 * drawn here too, so a reader looking for Chat's options finds all of them in
 * Chat.
 */

import Link from "next/link";
import { prisma } from "@polaris/db";
import { Bell, ShieldCheck } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { Button, Card, CardBody } from "@polaris/ui";
import { Messages } from "@/components/i18n/messages";
import { ChatSettingsView } from "./chat-settings-view";
import { loadChatPreferences } from "@/lib/chat/preferences";
import { resolveAutoDownload } from "@/lib/chat/auto-download";
import { moderationPolicy } from "@/lib/chat/moderation-policy";
import { instancePreviewsAllowed } from "@/lib/chat/link-preview-policy";
import { ChatTimerCard } from "@/app/(app)/account/privacy/chat-timer-card";
import { LinkPreviewsCard } from "@/app/(app)/account/privacy/link-previews-card";
import { AutoDownloadCard } from "@/app/(app)/account/privacy/auto-download-card";
import { ViewOnceWatermarkCard } from "@/app/(app)/account/privacy/view-once-watermark-card";

export const dynamic = "force-dynamic";

export default async function ChatSettingsPage() {
    const user = await requirePermission("chat.use");
    const t = await getTranslations("chat");
    const [preferences, chatPrivacy, previewsAllowed, policy] = await Promise.all([
        loadChatPreferences(user.id),
        prisma.userPrivacy.findUnique({
            where: { userId: user.id },
            select: {
                chatVanishAfter: true,
                viewOnceWatermark: true,
                linkPreviews: true,
                chatAutoDownload: true
            }
        }),
        instancePreviewsAllowed(),
        moderationPolicy()
    ]);

    const elsewhere = [
        {
            href: "/account/privacy",
            icon: ShieldCheck,
            title: t("chatSettings.whoCanMessage"),
            hint: t("chatSettings.whoCanMessageHint")
        },
        {
            href: "/account/notifications",
            icon: Bell,
            title: t("chatSettings.notifications"),
            hint: t("chatSettings.notificationsHint")
        }
    ];

    return (
        <Messages namespaces={["accountPrivacy"]}>
            <ChatSettingsView viewerId={user.id} initial={preferences}>
                <ChatTimerCard seconds={chatPrivacy?.chatVanishAfter ?? 0} />
                <ViewOnceWatermarkCard on={chatPrivacy?.viewOnceWatermark ?? true} />
                <LinkPreviewsCard
                    on={chatPrivacy?.linkPreviews ?? true}
                    forbidden={!previewsAllowed}
                />
                <AutoDownloadCard
                    choice={
                        chatPrivacy?.chatAutoDownload
                            ? resolveAutoDownload(chatPrivacy.chatAutoDownload, policy.autoDownload)
                            : null
                    }
                    instance={policy.autoDownload}
                />
                {elsewhere.map(({ href, icon: Icon, title, hint }) => (
                    <Card key={href}>
                        <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                            <Icon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-[14rem] flex-1">
                                <span className="block text-[0.8125rem]">{title}</span>
                                <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                                    {hint}
                                </span>
                            </span>
                            <Button size="sm" variant="secondary" asChild>
                                <Link href={href}>{t("chatSettings.open")}</Link>
                            </Button>
                        </CardBody>
                    </Card>
                ))}
            </ChatSettingsView>
        </Messages>
    );
}
