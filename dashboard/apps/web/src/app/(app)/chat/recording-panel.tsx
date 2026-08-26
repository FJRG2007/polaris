"use client";

/**
 * What happens to a recording once it has been stopped.
 *
 * It exists because the alternative is the failure everybody has met: a
 * recording that is finished, is definitely somewhere, and cannot be found.
 * Here it is one file and it is in the browser that made it, so this asks the
 * only question worth asking - does it go into the conversation the call
 * belongs to, or onto this machine - and it does not close until one of them
 * has been answered.
 *
 * Sending it into the conversation is the offer that is made first, and for a
 * call started from one it is almost always the right answer: everybody who was
 * in the call is in that conversation, the file goes to the same storage every
 * other attachment does, and it is deleted by the same rules. A meeting that is
 * a room of its own has no conversation to put it in, so there the download is
 * the whole offer and the panel says so.
 *
 * Drawn by the provider that holds the call rather than by the room, because
 * the recording outlives the screen: somebody who pressed record, walked off to
 * a deploy and pressed stop from the bar has to be handed the file where they
 * are standing.
 */

import { useState } from "react";
import { Download, Send } from "lucide-react";
import type { CallRecording } from "./call-recorder";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@polaris/ui";

/** Seconds as a clock reads them. */
function clock(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function megabytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RecordingPanel({
    recording,
    /** The conversation the call belongs to, or empty for a meeting that is a
     *  room of its own. */
    channelId
}: {
    recording: CallRecording;
    channelId: string;
}) {
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");

    const file = recording.file;
    if (!file) return null;

    const send = async () => {
        setSending(true);
        setError("");
        const form = new FormData();
        // A message that is only a file: the route stands an empty body up as a
        // space, and what it stands for is said by the attachment under it.
        form.set("body", "");
        form.append("files", file);
        const response = await fetch(`/api/chat/channels/${channelId}/messages`, {
            method: "POST",
            body: form
        }).catch(() => null);
        setSending(false);
        if (response?.ok) {
            recording.discard();
            return;
        }
        const answer: unknown = await response?.json().catch(() => null);
        setError(
            typeof answer === "object" && answer !== null && "error" in answer
                ? String((answer as { error: unknown }).error)
                : "That could not be sent. Download it instead."
        );
    };

    const save = () => {
        const address = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = address;
        link.download = file.name;
        link.click();
        // Revoked on the next turn rather than immediately: the browser has to
        // have started reading it before the address stops meaning anything.
        setTimeout(() => URL.revokeObjectURL(address), 10_000);
    };

    return (
        <Dialog open onOpenChange={(open) => !open && recording.discard()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Recording ready</DialogTitle>
                    <DialogDescription>
                        {clock(recording.seconds)}, {megabytes(file.size)}.{" "}
                        {channelId
                            ? "Send it to the conversation so everybody who was in the call has it, or keep it here."
                            : "This meeting has no conversation to put it in, so it lives on this machine once you save it."}
                    </DialogDescription>
                </DialogHeader>

                {(error || recording.error) && (
                    <p role="alert" className="text-xs text-danger">
                        {error || recording.error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" onClick={recording.discard} disabled={sending}>
                        Discard
                    </Button>
                    <Button variant="secondary" onClick={save} disabled={sending}>
                        <Download className="size-4" />
                        Download
                    </Button>
                    {channelId && (
                        <Button onClick={send} disabled={sending}>
                            <Send className="size-4" />
                            {sending ? "Sending" : "Send to the conversation"}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
