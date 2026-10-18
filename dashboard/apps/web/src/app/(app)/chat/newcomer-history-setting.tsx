"use client";

/**
 * Whether people who join a channel later read what was said before they
 * joined: the channel's own choice, and - for whoever runs the space - the
 * default every channel that does not choose follows.
 *
 * Saved as soon as it changes, shown changed while the server answers and put
 * back if it refuses. The server asks the same permission again.
 */

import { useEffect, useState } from "react";
import { Select, Switch } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { setNewcomerHistoryAction } from "./actions";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { useTranslations } from "@/components/i18n/i18n-provider";

type Choice = "inherit" | "on" | "off";

export function NewcomerHistorySetting({ channel }: { channel: ChatChannelView }) {
    const t = useTranslations("chat");
    const [choice, setChoice] = useState<Choice>(channel.newcomerHistory as Choice);
    const [spaceDefault, setSpaceDefault] = useState(channel.spaceNewcomerHistory ?? true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => setChoice(channel.newcomerHistory as Choice), [channel.newcomerHistory]);
    useEffect(
        () => setSpaceDefault(channel.spaceNewcomerHistory ?? true),
        [channel.spaceNewcomerHistory]
    );
    if (!channel.spaceId) return null;
    const spaceId = channel.spaceId;

    const save = async (
        input: Parameters<typeof setNewcomerHistoryAction>[0],
        undo: () => void
    ) => {
        setBusy(true);
        setError("");
        const result = await runAction(() => setNewcomerHistoryAction(input), setError);
        setBusy(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            undo();
        }
    };

    const pick = (next: Choice) => {
        if (next === choice) return;
        const was = choice;
        setChoice(next);
        void save({ scope: "channel", channelId: channel.id, value: next }, () => setChoice(was));
    };

    const flipDefault = (next: boolean) => {
        const was = spaceDefault;
        setSpaceDefault(next);
        void save({ scope: "space", spaceId, value: next }, () => setSpaceDefault(was));
    };

    const state = spaceDefault
        ? t("channelSettings.newcomerHistoryOn")
        : t("channelSettings.newcomerHistoryOff");
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">{t("channelSettings.newcomerHistory")}</span>
                <Select
                    value={choice}
                    disabled={busy}
                    onValueChange={(value) => pick(value as Choice)}
                    aria-label={t("channelSettings.newcomerHistory")}
                    options={[
                        {
                            value: "inherit",
                            label: t("channelSettings.newcomerHistoryInherit", { state })
                        },
                        { value: "on", label: t("channelSettings.newcomerHistoryOn") },
                        { value: "off", label: t("channelSettings.newcomerHistoryOff") }
                    ]}
                />
                <span className="text-xs text-muted-foreground">
                    {t("channelSettings.newcomerHistoryHint")}
                </span>
            </div>
            <label className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">
                        {t("channelSettings.newcomerHistoryDefault")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        {channel.mayManageSpaceDefault
                            ? t("channelSettings.newcomerHistoryDefaultHint")
                            : t("channelSettings.newcomerHistoryDefaultLocked")}
                    </span>
                </span>
                <Switch
                    checked={spaceDefault}
                    disabled={busy || !channel.mayManageSpaceDefault}
                    onChange={(next: boolean) => flipDefault(next)}
                    aria-label={t("channelSettings.newcomerHistoryDefault")}
                />
            </label>
            {error && <p className="text-xs text-danger">{error}</p>}
        </div>
    );
}
