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
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Download, Send } from "lucide-react";
import type { CallRecording } from "./call-recorder";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

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
    const t = useTranslations("chat");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");

    const file = recording.file;
    // A recording that failed before it wrote anything. Said here, where the
    // finished one would have been offered, because otherwise the record button
    // simply goes back to how it was and nobody knows why there is no file.
    if (!file && recording.error && !recording.running) {
        return (
            <Dialog open onOpenChange={(open) => !open && recording.discard()}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("recording.notRecorded")}</DialogTitle>
                        <DialogDescription>
                            {t(`recording.errors.${recording.error}`)}{" "}
                            {t("recording.notRecordedWhy")}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button onClick={recording.discard}>{t("recording.close")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        );
    }
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
                    <DialogTitle>{t("recording.recordingReady")}</DialogTitle>
                    <DialogDescription>
                        {clock(recording.seconds)}, {megabytes(file.size)}.{" "}
                        {channelId
                            ? t("recording.sendItToTheConversation")
                            : t("recording.thisMeetingHasNoConversation")}
                    </DialogDescription>
                </DialogHeader>

                {(error || recording.error) && (
                    <p role="alert" className="text-xs text-danger">
                        {error || (recording.error && t(`recording.errors.${recording.error}`))}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" onClick={recording.discard} disabled={sending}>
                        {t("recording.discard")}
                    </Button>
                    <Button variant="secondary" onClick={save} disabled={sending}>
                        <Download className="size-4" />
                        {t("recording.download")}
                    </Button>
                    {channelId && (
                        <Button onClick={send} disabled={sending}>
                            <Send className="size-4" />
                            {sending
                                ? t("recording.sending")
                                : t("recording.sendToTheConversation")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
