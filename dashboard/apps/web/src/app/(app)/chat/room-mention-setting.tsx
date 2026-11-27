"use client";

/**
 * Whether members who do not run the space may use @everyone and @here.
 *
 * Shown to everybody in a space channel's settings so the rule is visible, and
 * switchable only by whoever runs the space - the same answer the send gives.
 */

import { Switch, useOptimisticToggle } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { setSpaceRoomMentionsAction } from "./actions";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useState } from "react";

export function RoomMentionSetting({ channel }: { channel: ChatChannelView }) {
    const t = useTranslations("chat");
    const [error, setError] = useState("");
    const [allowed, flip] = useOptimisticToggle(
        channel.membersMayMentionEveryone,
        async (next) => {
            setError("");
            return (
                (await runAction(
                    () => setSpaceRoomMentionsAction({ spaceId: channel.spaceId ?? "", value: next }),
                    setError
                )) ?? { error: true }
            );
        },
        { onRefused: setError }
    );
    if (!channel.spaceId) return null;
    return (
        <div className="flex flex-col gap-1">
            <label className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{t("channelSettings.roomMentions")}</span>
                    <span className="text-xs text-muted-foreground">
                        {channel.mayManageSpaceDefault
                            ? t("channelSettings.roomMentionsHint")
                            : t("channelSettings.roomMentionsLocked")}
                    </span>
                </span>
                <Switch
                    checked={allowed}
                    disabled={!channel.mayManageSpaceDefault}
                    onChange={flip}
                    aria-label={t("channelSettings.roomMentions")}
                />
            </label>
            {error && <p className="text-xs text-danger">{error}</p>}
        </div>
    );
}
