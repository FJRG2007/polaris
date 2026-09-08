"use client";

/**
 * Whether an organization here may keep a chat of its own.
 *
 * The question is storage rather than policy. A second chat is a second set of
 * conversations to hold, and a house that would rather have one says so once
 * here instead of asking every organization not to.
 *
 * It is not a delete. Withdrawing the choice folds what an organization already
 * has back into the chat everybody shares, where its people can still read it -
 * a switch that made conversations disappear is a switch nobody could safely
 * change their mind about.
 */

import { useState } from "react";
import { Switch } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { setOrgChatOfferedAction } from "./actions";

export function OrgChatView({ offered }: { offered: boolean }) {
    const [on, setOn] = useState(offered);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const change = async (next: boolean) => {
        if (saving) return;
        setSaving(true);
        setError("");
        setOn(next);
        const result = await runAction(() => setOrgChatOfferedAction(next), setError);
        setSaving(false);
        if (!result || result.error) setOn(!next);
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-sm font-medium">Organizations may keep their own chat</p>
                    <p className="text-muted-foreground text-xs">
                        An organization that takes this gets a second chat for the people in it,
                        reached from the shelf switch in the header. Turned off, everybody shares
                        one chat - and any organization already keeping its own has those
                        conversations folded back into it rather than hidden.
                    </p>
                </div>
                <Switch
                    checked={on}
                    onChange={change}
                    disabled={saving}
                    aria-label="Organizations may keep their own chat"
                />
            </div>
            {error && (
                <p role="alert" className="text-danger text-xs">
                    {error}
                </p>
            )}
        </div>
    );
}
