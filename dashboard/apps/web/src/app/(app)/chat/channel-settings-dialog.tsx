"use client";

/**
 * What an administrator can change about a channel, reached by right-clicking it
 * in the list.
 *
 * The same three things the header offers - the name, what it is for, and
 * whether it is still open - plus deleting it, gathered in one place so a space
 * can be tidied without opening every channel in it first. That is the whole
 * point of a right-click on a rail: acting on a room you are not standing in.
 *
 * The name is normalized as it is typed, with the stored form shown underneath,
 * for the reason the new-channel dialog gives: "Release Planning" becoming
 * `release-planning` is a surprise once and an annoyance every time after.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { useChat } from "./chat-context";
import { useRouter } from "next/navigation";
import { Hash, Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useEffect, useMemo, useState } from "react";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

export function ChannelSettingsDialog({
    channel,
    onOpenChange
}: {
    /** The channel being edited. Null closes it - one prop rather than a boolean
     *  beside it, so the two cannot disagree. */
    channel: ChatChannelView | null;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const { refresh } = useChat();
    const [name, setName] = useState("");
    const [topic, setTopic] = useState("");
    const [slowmode, setSlowmode] = useState(0);
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [error, setError] = useState("");

    // Reset each time a different channel is opened, so the dialog never shows
    // the last one's name for a frame.
    useEffect(() => {
        if (!channel) return;
        setName(channel.name);
        setTopic(channel.topic ?? "");
        setSlowmode(channel.slowmode);
        setError("");
    }, [channel]);

    const stored = useMemo(() => core.normalizeChannelName(name), [name]);
    const dirty =
        channel !== null &&
        (stored !== channel.name || topic !== (channel.topic ?? "") || slowmode !== channel.slowmode);

    const save = async () => {
        if (!channel) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () => actions.updateChannelAction({ channelId: channel.id, name, topic, slowmode }),
            setError
        );
        setBusy(false);
        if (!result || result.error) return;
        onOpenChange(false);
        refresh();
    };

    return (
        <>
            <Dialog open={channel !== null} onOpenChange={onOpenChange}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Channel settings</DialogTitle>
                        <DialogDescription>
                            {channel?.archived
                                ? "This channel is archived. It is still readable and nothing new can be said in it."
                                : "What it is called and what it is for."}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <Input
                                value={name}
                                autoFocus
                                aria-label="Channel name"
                                maxLength={80}
                                onChange={(event) => setName(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && stored && !busy) void save();
                                }}
                            />
                            {stored && stored !== name && (
                                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <Hash className="size-3" />
                                    {stored}
                                </p>
                            )}
                        </div>

                        <Input
                            value={topic}
                            aria-label="What it is for"
                            placeholder="What it is for (optional)"
                            maxLength={core.MAX_CHAT_TOPIC}
                            onChange={(event) => setTopic(event.target.value)}
                        />

                        {/* How long between messages. A room stopping a hundred
                            people talking over each other, which is a different
                            thing from the instance's own limit on how fast
                            anything may be sent - that one exists to stop a
                            script. Whoever moderates the room is not held by
                            it. */}
                        <label className="flex flex-col gap-1">
                            <span className="text-[0.75rem] font-medium text-muted-foreground">
                                Wait between messages
                            </span>
                            <Select
                                value={String(slowmode)}
                                onValueChange={(value) => setSlowmode(Number(value))}
                                aria-label="Wait between messages"
                                options={core.CHAT_SLOWMODE_STEPS.map((seconds) => ({
                                    value: String(seconds),
                                    label: seconds === 0 ? "Off" : core.slowmodeSpoken(seconds)
                                }))}
                            />
                        </label>

                        {error && (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        )}
                    </div>

                    <DialogFooter className="sm:justify-between">
                        {/* Archiving keeps what was said and deleting does not,
                            so the two are offered together rather than one being
                            found only after the other has been used. */}
                        <span className="flex items-center gap-2">
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy || !channel}
                                onClick={async () => {
                                    if (!channel) return;
                                    await runAction(
                                        () =>
                                            actions.updateChannelAction({
                                                channelId: channel.id,
                                                archived: !channel.archived
                                            }),
                                        setError
                                    );
                                    onOpenChange(false);
                                    refresh();
                                }}
                            >
                                {channel?.archived ? "Reopen" : "Archive"}
                            </Button>
                            <Button
                                size="sm"
                                variant="danger"
                                disabled={busy}
                                onClick={() => setConfirmDelete(true)}
                            >
                                Delete
                            </Button>
                        </span>
                        <span className="flex items-center gap-2">
                            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button
                                size="sm"
                                disabled={busy || !stored || !dirty}
                                onClick={() => void save()}
                            >
                                {busy && <Loader2 className="size-4 animate-spin" />}
                                Save
                            </Button>
                        </span>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmDeleteDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                name={channel?.name ?? ""}
                kind="channel"
                description="Every message in it goes with it. Archiving keeps them readable instead."
                confirmLabel="Delete channel"
                onConfirm={async () => {
                    if (!channel) return;
                    await runAction(() => actions.deleteChannelAction(channel.id), setError);
                    setConfirmDelete(false);
                    onOpenChange(false);
                    refresh();
                    router.push("/chat");
                }}
            />
        </>
    );
}
