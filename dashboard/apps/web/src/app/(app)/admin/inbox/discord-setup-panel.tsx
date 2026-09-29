"use client";

/**
 * What a Discord bot still needs after its token is accepted: to be in a server,
 * and to have the privileged intents its owner meant it to have. Both are read
 * back from the live connection rather than assumed, so this says what is
 * actually true of the bot right now.
 *
 * Shown straight after connecting and again from Manage, because this is the
 * setup people otherwise discover through a failed send.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@polaris/ui";
import type { ChannelSetup } from "@polaris/messaging";
import {
    DISCORD_BOT_PERMISSIONS,
    discordInviteUrl,
    discordPortalUrl
} from "@/lib/messaging/discord-invite";
import { channelStateAction } from "./actions";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** What each privileged intent buys, so switching one on is a decision rather
 *  than a name from a portal. The intents are named as Discord names them. */
function intentEffect(t: NamespaceTranslator<"admin">, intent: string): string {
    if (intent === "Server Members") return t("inbox.discordSetup.effects.serverMembers");
    if (intent === "Message Content") return t("inbox.discordSetup.effects.messageContent");
    return "";
}

export function DiscordSetupPanel({ channelId }: { channelId: string }) {
    const t = useTranslations("admin");
    const [setup, setSetup] = useState<ChannelSetup | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        const state = await channelStateAction(channelId);
        setError(state.error ?? null);
        setSetup(state.setup ?? null);
        setLoading(false);
    }, [channelId]);

    useEffect(() => {
        void load();
    }, [load]);

    const invite = discordInviteUrl(setup?.applicationId);
    const portal = discordPortalUrl(setup?.applicationId);
    const guilds = setup?.guilds ?? 0;
    const missing = setup?.missingIntents ?? [];

    if (loading && !setup) {
        return (
            <div className="flex items-center gap-2 rounded-md border border-border p-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t("inbox.discordSetup.checking")}
            </div>
        );
    }

    if (!setup) {
        return (
            <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
                {error ?? t("inbox.discordSetup.notRunning")}
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="text-sm font-medium">
                        {guilds === 0
                            ? t("inbox.discordSetup.noServer")
                            : t("inbox.discordSetup.inServers", { count: guilds })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {guilds === 0
                            ? t("inbox.discordSetup.noServerHint")
                            : t("inbox.discordSetup.serversHint")}
                    </p>
                </div>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("inbox.discordSetup.checkAgain")}
                    title={t("inbox.discordSetup.checkAgain")}
                    onClick={() => void load()}
                    disabled={loading}
                >
                    {loading ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <RefreshCw className="size-4" />
                    )}
                </Button>
            </div>

            {invite ? (
                <div className="flex flex-col gap-1.5">
                    <a
                        href={invite}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex w-fit items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    >
                        {t("inbox.discordSetup.addBot")}
                        <ExternalLink className="size-3.5" />
                    </a>
                    <span className="text-xs text-muted-foreground">
                        {t("inbox.discordSetup.addBotHint", {
                            permissions: DISCORD_BOT_PERMISSIONS.join(", ").toLowerCase()
                        })}
                    </span>
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">
                    {t("inbox.discordSetup.noAppId")}
                </p>
            )}

            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                <span className="text-sm font-medium">{t("inbox.discordSetup.intents")}</span>
                {missing.length === 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs text-success">
                        <CheckCircle2 className="size-3.5" /> {t("inbox.discordSetup.intentsOn")}
                    </span>
                ) : (
                    <>
                        {missing.map((intent) => (
                            <span key={intent} className="text-xs text-warning">
                                {t("inbox.discordSetup.intentOff", {
                                    intent,
                                    effect: intentEffect(t, intent)
                                })}
                            </span>
                        ))}
                        {portal ? (
                            <a
                                href={portal}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
                            >
                                {t("inbox.discordSetup.switchOn")}
                                <ExternalLink className="size-3" />
                            </a>
                        ) : null}
                        <span className="text-xs text-muted-foreground">
                            {t("inbox.discordSetup.reconnectAfter")}
                        </span>
                    </>
                )}
            </div>
        </div>
    );
}
