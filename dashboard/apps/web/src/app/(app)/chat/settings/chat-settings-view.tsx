"use client";

/**
 * The Chat settings screen inside Chat's shell: its header, the reader's own
 * Chat settings, and the cards the page hands in.
 *
 * A choice shows at once, is kept for this browser so every message list
 * follows it, and goes back with a message if the server refuses it.
 */

import Link from "next/link";
import { ArrowLeft, Settings2 } from "lucide-react";
import { Card, CardBody, Select } from "@polaris/ui";
import { useEffect, useState, type ReactNode } from "react";
import { setCaptionPositionAction } from "../preference-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { rememberChatPreferences, useChatPreferences } from "../chat-preferences";
import {
    CAPTION_POSITIONS,
    type CaptionPosition,
    type ChatPreferences
} from "@/lib/chat/preference-schema";

export function ChatSettingsView({
    viewerId,
    initial,
    children
}: {
    viewerId: string;
    /** What the server read for this page: the newest answer there is. */
    initial: ChatPreferences;
    children?: ReactNode;
}) {
    const t = useTranslations("chat");
    const preferences = useChatPreferences(viewerId);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    useEffect(() => rememberChatPreferences(viewerId, initial), [viewerId, initial]);

    const changeCaption = async (next: CaptionPosition) => {
        if (next === preferences.captionPosition) return;
        const before = preferences;
        rememberChatPreferences(viewerId, { ...before, captionPosition: next });
        setError(null);
        setPending(true);
        const result = await setCaptionPositionAction(next).catch(() => ({ error: "failed" }));
        setPending(false);
        if ("error" in result) {
            rememberChatPreferences(viewerId, before);
            setError(t("chatSettings.saveFailed"));
        } else rememberChatPreferences(viewerId, result);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
                <Link
                    data-swipe-back
                    href="/chat"
                    aria-label={t("chatSettings.back")}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                <Settings2 className="size-4 shrink-0 text-muted-foreground" />
                <h1 className="min-w-0 truncate text-sm font-semibold">{t("chatSettings.title")}</h1>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
                    <p className="text-sm text-muted-foreground">{t("chatSettings.intro")}</p>
                    <Card>
                        <CardBody className="flex flex-col gap-2">
                            <div className="flex flex-wrap items-start justify-between gap-4">
                                <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <span className="text-sm font-medium">
                                        {t("chatSettings.captionPosition")}
                                    </span>
                                    <span
                                        id="chat-caption-position-hint"
                                        className="text-sm text-muted-foreground"
                                    >
                                        {t("chatSettings.captionPositionHint")}
                                    </span>
                                </div>
                                <Select
                                    value={preferences.captionPosition}
                                    onValueChange={(value) => void changeCaption(value as CaptionPosition)}
                                    disabled={pending}
                                    aria-label={t("chatSettings.captionPosition")}
                                    aria-describedby="chat-caption-position-hint"
                                    className="h-8 w-48 max-w-full shrink-0"
                                    options={CAPTION_POSITIONS.map((position) => ({
                                        value: position,
                                        label:
                                            position === "above"
                                                ? t("chatSettings.captionAbove")
                                                : t("chatSettings.captionBelow")
                                    }))}
                                />
                            </div>
                            {error ? (
                                <p role="alert" className="text-sm text-danger">
                                    {error}
                                </p>
                            ) : null}
                        </CardBody>
                    </Card>
                    {children}
                </div>
            </div>
        </div>
    );
}
