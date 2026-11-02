"use client";

/** What a group is called, from its header or its row in the list. */

import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { runAction } from "@/lib/run-action";
import * as actions from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    isDirty
} from "@polaris/ui";

export function GroupNameDialog({
    channel,
    open,
    onOpenChange,
    onSaved
}: {
    channel: { id: string; name: string };
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => void;
}) {
    const t = useTranslations("chat");
    const [name, setName] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        if (!open) return;
        setName(channel.name);
        setError("");
    }, [open, channel.name]);

    async function save(): Promise<void> {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => actions.renameGroupAction({ channelId: channel.id, name }),
            setError
        );
        setSaving(false);
        if (!result) return;
        // Closed only once it worked: a dialog that closes on a refusal takes the
        // typed name with it and leaves the reader looking at an unchanged group.
        if (result.error) return setError(result.error);
        onOpenChange(false);
        onSaved();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("channelHeader.nameThisGroup")}</DialogTitle>
                </DialogHeader>
                <Input
                    value={name}
                    autoFocus
                    maxLength={core.MAX_CHAT_CHANNEL_NAME}
                    placeholder={t("channelHeader.leaveItEmptyToGo")}
                    aria-label={t("channelHeader.whatThisGroupIsCalled")}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && isDirty(channel.name, name)) void save();
                    }}
                />
                {error && <p className="text-sm text-danger">{error}</p>}
                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {t("channelHeader.cancel")}
                    </Button>
                    {/* The name it already has is nothing to save. */}
                    <Button
                        size="sm"
                        disabled={saving || !isDirty(channel.name, name)}
                        onClick={() => void save()}
                    >
                        {t("channelHeader.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
