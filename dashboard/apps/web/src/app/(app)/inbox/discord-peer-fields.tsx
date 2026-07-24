"use client";

/**
 * The Discord recipient picker. Discord has two kinds of recipient: a server text
 * channel (the bot posts to it) or a user DM. For a channel it fetches the bot's
 * servers and channels from the bridge and offers them as dropdowns; if the bridge
 * cannot enumerate them (older bridge, or the bot is in no server) it falls back to
 * a manual channel-id field. For a DM it takes the user id. The value it reports is
 * the encoded peer id (bare channel id, or user:<id>), ready to store or send.
 */

import { useEffect, useState } from "react";
import { Input, Select } from "@polaris/ui";
import type { TargetGroup } from "@polaris/messaging";
import { firstDiscordChannelAction, listChannelTargetsAction } from "./actions";
import { type DiscordTarget, encodeDiscordPeer, parseDiscordPeer } from "./platform-meta";

export function DiscordPeerFields({
    botChannelId,
    draft,
    onDraft
}: {
    /** A connected Discord bot channel to enumerate servers/channels from. When
     *  omitted (Contacts, where no channel is in context) the first connected
     *  Discord channel is resolved automatically. */
    botChannelId?: string | null;
    draft: string;
    onDraft: (value: string) => void;
}) {
    const { id } = parseDiscordPeer(draft);
    const [bot, setBot] = useState<string | null>(botChannelId ?? null);
    const [groups, setGroups] = useState<TargetGroup[] | null>(null);
    const [guildId, setGuildId] = useState("");
    // The chosen target type is tracked separately from the draft: an empty draft
    // (no id yet, or a just-cleared channel) encodes to "" and carries no target,
    // so deriving it from the draft alone would snap the picker back to "channel".
    const [target, setTarget] = useState<DiscordTarget>(() => parseDiscordPeer(draft).target);

    // Keep the target in sync when a non-empty draft arrives from the caller (e.g.
    // filling the recipient from a saved handle); an empty draft leaves it untouched.
    useEffect(() => {
        if (draft.trim() === "") return;
        setTarget(parseDiscordPeer(draft).target);
    }, [draft]);

    // Resolve a bot channel to query when the caller did not supply one.
    useEffect(() => {
        if (botChannelId) {
            setBot(botChannelId);
            return;
        }
        let active = true;
        void firstDiscordChannelAction()
            .then((value) => active && setBot(value))
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [botChannelId]);

    // Fetch the bot's servers and channels for the channel-target dropdowns.
    useEffect(() => {
        if (target !== "channel" || !bot) {
            setGroups(null);
            return;
        }
        let active = true;
        void listChannelTargetsAction(bot)
            .then((value) => active && setGroups(value))
            .catch(() => active && setGroups([]));
        return () => {
            active = false;
        };
    }, [target, bot]);

    // Default the selected server to the one holding the current channel, else first.
    useEffect(() => {
        if (!groups || groups.length === 0) return;
        const owning = groups.find((group) => group.targets.some((item) => item.id === id));
        setGuildId((prev) => prev || owning?.id || groups[0]!.id);
    }, [groups, id]);

    const guild = groups?.find((group) => group.id === guildId) ?? null;

    return (
        <div className="flex flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
                <div className="w-40 shrink-0">
                    <Select
                        value={target}
                        onValueChange={(value) => {
                            const next = value as DiscordTarget;
                            setTarget(next);
                            onDraft(encodeDiscordPeer(next, ""));
                        }}
                        options={[
                            { value: "channel", label: "Server channel" },
                            { value: "user", label: "Direct message" }
                        ]}
                    />
                </div>
                {target === "user" && (
                    <Input
                        className="flex-1"
                        value={id}
                        onChange={(event) => onDraft(encodeDiscordPeer("user", event.target.value))}
                        placeholder="User id to DM"
                    />
                )}
            </div>

            {target === "channel" &&
                (groups && groups.length > 0 ? (
                    <div className="flex items-center gap-2">
                        <div className="w-40 shrink-0">
                            <Select
                                value={guildId}
                                onValueChange={(value) => {
                                    setGuildId(value);
                                    onDraft(encodeDiscordPeer("channel", ""));
                                }}
                                options={groups.map((group) => ({
                                    value: group.id,
                                    label: group.name
                                }))}
                            />
                        </div>
                        <div className="flex-1">
                            <Select
                                value={id}
                                onValueChange={(value) =>
                                    onDraft(encodeDiscordPeer("channel", value))
                                }
                                placeholder="Pick a channel"
                                options={(guild?.targets ?? []).map((item) => ({
                                    value: item.id,
                                    label: item.name
                                }))}
                            />
                        </div>
                    </div>
                ) : (
                    <Input
                        value={id}
                        onChange={(event) =>
                            onDraft(encodeDiscordPeer("channel", event.target.value))
                        }
                        placeholder="Channel id the bot can post to"
                    />
                ))}

            <span className="text-xs text-muted-foreground">
                {target === "user"
                    ? "DM a user by their id (developer mode on, right-click a user > Copy User ID)."
                    : groups && groups.length > 0
                      ? "Pick a server and a channel the bot can post to."
                      : "A text channel id the bot can post to (right-click the channel > Copy Channel ID)."}
            </span>
        </div>
    );
}
