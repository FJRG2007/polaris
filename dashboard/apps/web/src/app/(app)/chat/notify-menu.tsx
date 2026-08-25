"use client";

/**
 * What a conversation, or a whole space, may interrupt you with.
 *
 * A different question from the mute beside it, and the reason both are offered.
 * A mute is a silence with an end: it takes the badge away too, which is right
 * for a conversation you want to stop hearing about and wrong for the busy one
 * you follow. This is the standing answer - every message, only the ones that
 * name you or the room, or nothing - and it never touches the unread marks, so
 * the room is still there to be found later.
 *
 * One list, drawn in the space menu and in the conversation menus, from the same
 * primitives the mute list borrows. A channel can also say "follow the server",
 * which is what one says until somebody decides otherwise; a space cannot,
 * because a space is where the answer comes from.
 */

import * as core from "@polaris/core";
import { Bell, Check } from "lucide-react";
import type { MenuParts } from "./mute-menu";

export function NotifyOptions({
    level,
    parts,
    inheritable = false,
    onChoose
}: {
    /** What is set now, so the list can say which one it is. */
    level: core.ChatChannelNotifyLevel;
    parts: MenuParts;
    /** Whether "follow the server" is one of the answers. Only a channel inside
     *  a space has anything to follow. */
    inheritable?: boolean;
    onChoose: (level: core.ChatChannelNotifyLevel) => void;
}) {
    const { Item, Sub, SubTrigger, SubContent } = parts;
    const offered: core.ChatChannelNotifyLevel[] = inheritable
        ? [...core.CHAT_CHANNEL_NOTIFY_LEVELS]
        : [...core.CHAT_NOTIFY_LEVELS];
    // A group belongs to no space, so what it stores as "follow the server"
    // means all - and a list with nothing ticked reads as a setting nobody has,
    // which is not the same as the one everything starts with.
    const current = inheritable ? level : core.resolveChatNotify(level, null);

    return (
        <Sub>
            <SubTrigger>
                <Bell className="size-3.5" />
                Notifications
            </SubTrigger>
            <SubContent>
                {offered.map((option) => (
                    <Item key={option} onSelect={() => onChoose(option)}>
                        {/* The tick keeps its width when it is not drawn, so the
                            labels line up rather than stepping left. */}
                        {option === current ? (
                            <Check className="size-3.5" />
                        ) : (
                            <span aria-hidden="true" className="size-3.5" />
                        )}
                        {core.CHAT_NOTIFY_LABEL[option]}
                    </Item>
                ))}
            </SubContent>
        </Sub>
    );
}
