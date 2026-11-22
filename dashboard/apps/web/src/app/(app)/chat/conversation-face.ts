import type { AvatarPerson } from "@/components/avatar";

/**
 * The one person a conversation is drawn as, or null when it is drawn as a
 * group.
 *
 * A one-to-one is the person on the other end. The conversation with yourself
 * has nobody on the other end - its list of others is empty - so it used to
 * fall through to a group's initials, and the one chat that is you was the one
 * chat without your face. It is drawn as you: your picture, and your
 * decorations wherever the face asks for them.
 *
 * Pure so the rule is asserted without rendering anything.
 */
export function conversationFace(
    channel: { readonly self?: boolean; readonly others: readonly AvatarPerson[] },
    viewer: AvatarPerson
): AvatarPerson | null {
    if (channel.others.length === 1) return channel.others[0] ?? null;
    if (channel.self && channel.others.length === 0) return viewer;
    return null;
}
