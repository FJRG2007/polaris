"use client";

/**
 * Adding a channel to a space.
 *
 * The name is normalized as it is typed, with the stored form shown underneath,
 * because "Release Planning" becoming `release-planning` is a surprise the first
 * time and an annoyance every time after. Showing it removes both: what you see
 * is what the channel will be called.
 */

import * as core from "@polaris/core";
import { useChat } from "./chat-context";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Hash, Loader2, Volume2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { createChannelAction } from "./actions";
import type { ChatSpaceView } from "@/lib/chat/chat-service";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Switch
} from "@polaris/ui";

export function NewChannelDialog({
    space,
    categoryId = null,
    onOpenChange
}: {
    /** The space it goes in. Null closes the dialog - one prop rather than a
     *  boolean beside it, so the two cannot disagree. */
    space: ChatSpaceView | null;
    /** The heading it goes under, when the dialog was opened from one. */
    categoryId?: string | null;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const { refresh } = useChat();
    const [name, setName] = useState("");
    const [topic, setTopic] = useState("");
    const [kind, setKind] = useState<core.ChatSpaceChannelKind>("text");
    const [privateChannel, setPrivateChannel] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const stored = useMemo(() => core.normalizeChannelName(name), [name]);

    const create = async () => {
        if (!space) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () =>
                createChannelAction({
                    spaceId: space.id,
                    name,
                    topic,
                    kind,
                    categoryId,
                    private: privateChannel
                }),
            setError
        );
        setBusy(false);
        if (result?.error || !result?.id) return;
        setName("");
        setTopic("");
        setKind("text");
        setPrivateChannel(false);
        onOpenChange(false);
        refresh();
        router.push(`/chat/c/${result.id}`);
    };

    return (
        <Dialog open={space !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New channel</DialogTitle>
                    <DialogDescription>In {space?.name ?? "this space"}.</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <SegmentedControl
                        aria-label="What kind of channel"
                        value={kind}
                        onValueChange={setKind}
                        options={[
                            {
                                value: "text",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <Hash className="size-3.5" />
                                        Text
                                    </span>
                                ),
                                title: "A conversation people read back"
                            },
                            {
                                value: "voice",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <Volume2 className="size-3.5" />
                                        Voice
                                    </span>
                                ),
                                title: "A room people walk into and talk in"
                            }
                        ]}
                    />

                    <div className="flex flex-col gap-1">
                        <Input
                            value={name}
                            autoFocus
                            aria-label="Channel name"
                            placeholder="release-planning"
                            maxLength={80}
                            onChange={(event) => setName(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && stored && !busy) void create();
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
                        maxLength={200}
                        onChange={(event) => setTopic(event.target.value)}
                    />

                    {kind === "voice" && (
                        <p className="text-xs text-muted-foreground">
                            A voice channel has no messages in it. Opening one puts you in the
                            call that is already there, and the rail shows who else is.
                        </p>
                    )}

                    <label className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                        <Switch checked={privateChannel} onChange={setPrivateChannel} />
                        <span className="flex flex-col gap-0.5">
                            <span className="text-sm font-medium">Private</span>
                            <span className="text-xs text-muted-foreground">
                                Only the people added to it can see it, even inside this space.
                            </span>
                        </span>
                    </label>

                    {error && (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button size="sm" disabled={busy || !stored} onClick={() => void create()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Create {kind === "voice" ? "voice channel" : "channel"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
