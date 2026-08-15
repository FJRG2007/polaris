"use client";

/**
 * How long to go quiet for.
 *
 * One list, used by the conversation's own menu and by a right-click in the
 * list, because "mute" is reached from both and a set of durations that differed
 * between them would be two features wearing one word.
 *
 * The last option is the one that carries its weight. A silence that always
 * lapses makes somebody re-mute the same noisy channel every morning; one that
 * never does makes them forget a conversation exists. Offering both, and saying
 * which is on, is the whole of it.
 */

import * as core from "@polaris/core";
import { Bell, BellOff } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useDisplayFormat } from "@/components/display-format";
import type { ChatChannelView } from "@/lib/chat/chat-service";

/** The menu primitives to draw with, so this works inside a dropdown and inside
 *  a right-click menu without either knowing about the other. Typed loosely on
 *  purpose: the two menus' components differ in props this does not use, and
 *  narrowing to their intersection would be a type nothing satisfies. */
export interface MenuParts {
    readonly Item: ComponentType<{ children?: ReactNode; onSelect?: (event: Event) => void }>;
    readonly Sub: ComponentType<{ children?: ReactNode }>;
    readonly SubTrigger: ComponentType<{ children?: ReactNode }>;
    readonly SubContent: ComponentType<{ children?: ReactNode }>;
}

export function MuteOptions({
    channel,
    parts,
    onChoose
}: {
    channel: ChatChannelView;
    parts: MenuParts;
    /** Minutes, `MUTE_FOREVER`, or null to let it through again. */
    onChoose: (minutes: number | null) => void;
}) {
    const { Item, Sub, SubTrigger, SubContent } = parts;
    const format = useDisplayFormat();

    // Already quiet: the useful option is turning it back on, with the answer to
    // "until when" in front of it rather than left to be discovered.
    if (channel.muted) {
        return (
            <Item onSelect={() => onChoose(null)}>
                <Bell className="size-3.5" />
                {channel.mutedUntil
                    ? `Unmute (quiet until ${format.time(channel.mutedUntil)})`
                    : "Unmute"}
            </Item>
        );
    }

    return (
        <Sub>
            <SubTrigger>
                <BellOff className="size-3.5" />
                Mute
            </SubTrigger>
            <SubContent>
                {core.MUTE_DURATIONS.map((minutes) => (
                    <Item key={minutes} onSelect={() => onChoose(minutes)}>
                        {core.MUTE_LABELS[minutes]}
                    </Item>
                ))}
                <Item onSelect={() => onChoose(core.MUTE_FOREVER)}>
                    {core.MUTE_LABELS[core.MUTE_FOREVER]}
                </Item>
            </SubContent>
        </Sub>
    );
}
