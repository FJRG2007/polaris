"use client";

/**
 * The people picker as Chat uses it.
 *
 * Two rules, and which one is decided by what the people are being picked for.
 * Writing to one person is open to anybody who has the chat. Putting people in a
 * group - starting one, adding to one, bringing somebody into a call that lives
 * in one - takes friends and colleagues only, and the picker says so beside
 * every name it cannot use, with the request that would change it, rather than
 * offering them and letting the server refuse.
 */

import { useCallback } from "react";
import { AskFriendButton } from "./ask-friend-button";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import { searchGroupPeopleAction, searchPeopleAction, type GroupCandidate } from "./actions";

export function ChatPeoplePicker({
    forGroup,
    picked,
    onChange,
    exclude,
    label,
    meetingId
}: {
    /** Whether the people picked end up in a group. */
    forGroup: boolean;
    picked: readonly PickedPerson[];
    onChange: (picked: readonly PickedPerson[]) => void;
    exclude?: readonly string[];
    label?: string;
    /** The call the people are being brought into, whose conversation's own
     *  members may be picked whatever their standing - nobody adds them. */
    meetingId?: string;
}) {
    const searchGroup = useCallback(
        (query: string) => searchGroupPeopleAction(query, meetingId),
        [meetingId]
    );
    if (!forGroup) {
        return (
            <PeoplePicker
                picked={picked}
                onChange={onChange}
                exclude={exclude}
                label={label}
                search={searchPeopleAction}
            />
        );
    }
    return (
        <PeoplePicker<GroupCandidate>
            picked={picked}
            onChange={onChange}
            exclude={exclude}
            label={label}
            search={searchGroup}
            unavailableAction={(person) =>
                person.requestable ? (
                    <AskFriendButton personId={person.id} name={person.name} />
                ) : null
            }
        />
    );
}
