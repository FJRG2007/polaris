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
import { useTranslations } from "@/components/i18n/i18n-provider";
import { SegmentedControl } from "@polaris/ui";
import { setDriveShareAction } from "./actions";
import type { DriveShare } from "@/lib/chat/drive-share";

export function DriveShareView({ how }: { how: DriveShare }) {
    const t = useTranslations("admin");
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
                <p className="text-sm font-medium">{t("chat.driveShare.title")}</p>
                <p className="text-xs text-muted-foreground">
                    {chosen === "copy"
                        ? t("chat.driveShare.copy.hint")
                        : t("chat.driveShare.link.hint")}
                </p>
            </div>
            <SegmentedControl
                className="self-start"
                aria-label={t("chat.driveShare.picker")}
                value={chosen}
                onValueChange={(next) => void change(next as DriveShare)}
                options={[
                    { value: "copy", label: t("chat.driveShare.copy.label"), title: t("chat.driveShare.copy.title") },
                    { value: "link", label: t("chat.driveShare.link.label"), title: t("chat.driveShare.link.title") }
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
