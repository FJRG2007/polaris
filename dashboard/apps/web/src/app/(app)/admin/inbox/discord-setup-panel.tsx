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

/** What each privileged intent buys, so switching one on is a decision rather
 *  than a name from a portal. */
const INTENT_EFFECT: Record<string, string> = {
    "Server Members": "Needed to reach someone by username. Their numeric User ID works without it.",
    "Message Content": "Without it, messages the bot receives in server channels arrive empty."
};

export function DiscordSetupPanel({ channelId }: { channelId: string }) {
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
                <Loader2 className="size-4 animate-spin" /> Checking what the bot can reach...
            </div>
        );
    }

    if (!setup) {
        return (
            <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
                {error ?? "The bridge is not running this bot right now, so there is nothing to check."}
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="text-sm font-medium">
                        {guilds === 0
                            ? "The bot is in no server yet"
                            : `In ${guilds} server${guilds === 1 ? "" : "s"}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {guilds === 0
                            ? "It can only send once somebody adds it to one."
                            : "Server channels are pickable when you write a message."}
                    </p>
                </div>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Check again"
                    title="Check again"
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
                        Add the bot to a server
                        <ExternalLink className="size-3.5" />
                    </a>
                    <span className="text-xs text-muted-foreground">
                        Discord asks which of your servers, then to confirm:{" "}
                        {DISCORD_BOT_PERMISSIONS.join(", ").toLowerCase()}.
                    </span>
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">
                    The bot has not reported its application id, so there is no invite link to
                    build. Reconnect it and check again.
                </p>
            )}

            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                <span className="text-sm font-medium">Privileged intents</span>
                {missing.length === 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs text-success">
                        <CheckCircle2 className="size-3.5" /> Both are on.
                    </span>
                ) : (
                    <>
                        {missing.map((intent) => (
                            <span key={intent} className="text-xs text-warning">
                                {intent} is off. {INTENT_EFFECT[intent] ?? ""}
                            </span>
                        ))}
                        {portal ? (
                            <a
                                href={portal}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
                            >
                                Switch them on under Bot {">"} Privileged Gateway Intents
                                <ExternalLink className="size-3" />
                            </a>
                        ) : null}
                        <span className="text-xs text-muted-foreground">
                            Reconnect the channel afterwards - the intents are chosen when the bot
                            logs in.
                        </span>
                    </>
                )}
            </div>
        </div>
    );
}
