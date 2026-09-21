"use client";

/**
 * What happens when somebody sends a file they already have in Drive.
 *
 * The choice is a trade and both sides of it are real, so it is two answers with
 * their consequences written next to them rather than a switch somebody has to
 * guess the meaning of. Copying pays for a second copy of every file anybody
 * shares and gives the conversation a file nothing can change. Linking writes
 * nothing, works whatever the file weighs, and hands the owner the power to edit
 * it or take it away under a message that has already been read.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { SegmentedControl } from "@polaris/ui";
import { setDriveShareAction } from "./actions";
import type { DriveShare } from "@/lib/chat/drive-share";

export function DriveShareView({ how }: { how: DriveShare }) {
    const [chosen, setChosen] = useState<DriveShare>(how);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const change = async (next: DriveShare) => {
        if (saving || next === chosen) return;
        setSaving(true);
        setError("");
        const was = chosen;
        setChosen(next);
        const result = await runAction(() => setDriveShareAction(next), setError);
        setSaving(false);
        if (!result || result.error) setChosen(was);
    };

    return (
        <div className="flex flex-col gap-2">
            <div>
                <p className="text-sm font-medium">A file sent from Drive</p>
                <p className="text-xs text-muted-foreground">
                    {chosen === "copy"
                        ? "Copied into the conversation, so nothing can change it and nothing can take it away. The instance keeps a second copy of every file anybody shares, and the size limit above applies to it."
                        : "Shared where it already is. Nothing is copied, so any size works and the limit above does not apply - but whoever owns the file can edit it or delete it under a message that has already been read, and the conversation says so on the file."}
                </p>
            </div>
            <SegmentedControl
                className="self-start"
                aria-label="What happens to a file sent from Drive"
                value={chosen}
                onValueChange={(next) => void change(next as DriveShare)}
                options={[
                    { value: "copy", label: "Copied", title: "A copy of its own, in the conversation's store" },
                    { value: "link", label: "Linked", title: "Left where it is, and reached from the message" }
                ]}
            />
            {error && (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}
