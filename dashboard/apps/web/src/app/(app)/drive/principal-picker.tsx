"use client";

/**
 * Choosing the one person or group an access rule names.
 *
 * It used to be a dropdown of every account on the instance. That was a user
 * directory, and it stopped being defensible the moment everybody owned a drive
 * and could open this screen: a list of who exists here is not something a file
 * hands out. So people are searched for - two letters minimum, nobody listed,
 * and anybody who has taken themselves out of being found stays out - while
 * groups, which are a short list the account is already in, stay a dropdown.
 */

import { Select } from "@polaris/ui";
import { useEffect, useState } from "react";
import type { SharePerson } from "@/lib/drive-sharing";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import { findSharePeopleAction, myShareGroupsAction } from "./sharing-actions";

export function PrincipalPicker({
    value,
    onChange
}: {
    /** `user:<id>`, `group:<id>`, or empty for nobody chosen. */
    value: string;
    onChange: (value: string) => void;
}) {
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [groups, setGroups] = useState<SharePerson[]>([]);

    useEffect(() => {
        void myShareGroupsAction().then(setGroups);
    }, []);

    // The two controls are one answer, so choosing in either clears the other:
    // a rule names one principal, and leaving a stale name visible beside the
    // one being saved is how somebody grants the wrong person.
    const groupId = value.startsWith("group:") ? value.slice("group:".length) : "";

    return (
        <div className="flex flex-col gap-2">
            <PeoplePicker
                picked={picked}
                onChange={(next) => {
                    const last = next[next.length - 1];
                    setPicked(last ? [last] : []);
                    onChange(last ? `user:${last.id}` : "");
                }}
                max={1}
                label="Find a person"
                search={findSharePeopleAction}
            />
            {groups.length > 0 && (
                <Select
                    value={groupId}
                    onValueChange={(next) => {
                        setPicked([]);
                        onChange(next ? `group:${next}` : "");
                    }}
                    placeholder="Or a group..."
                    options={groups.map((group) => ({ value: group.id, label: group.name }))}
                />
            )}
        </div>
    );
}
