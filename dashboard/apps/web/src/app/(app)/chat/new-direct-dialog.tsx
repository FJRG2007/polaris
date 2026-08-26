"use client";

/**
 * Starting a direct message.
 *
 * One person makes a two-way conversation and there is only ever one of those
 * with anybody - asking again reopens the one that exists, with its history,
 * rather than a second empty one. More than one makes a group, and asking twice
 * there does make two, because three people can genuinely want two different
 * conversations.
 *
 * Which of the two is a choice made at the top rather than inferred from how
 * many names end up in the box, because the two want opposite things from the
 * same screen. A direct message is one press: picking the person IS the
 * decision, and a confirm button after it asks somebody to agree with what they
 * just did. A group is not finished until the last person is in it, so that one
 * keeps its button.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@polaris/ui";
import { useChat } from "./chat-context";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { chatAvatarUrl } from "@/lib/avatar-url";
import { CROP_ACCEPTED, FACE_CROP, ImageCropDialog } from "@/components/image-cropper";
import { MAX_CHAT_CHANNEL_NAME } from "@polaris/core";
import { ImagePlus, Loader2, MessageSquare, Users } from "lucide-react";
import { openDirectAction, searchPeopleAction } from "./actions";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import {
    Button,
    Dialog,
    Input,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function NewDirectDialog({
    open,
    onOpenChange
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const { viewerId, refresh, may } = useChat();
    const [kind, setKind] = useState<"direct" | "group">("direct");
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [name, setName] = useState("");
    /** Whether the name in the box is theirs or the one put there for them. It
     *  decides both whether adding another person still updates it and whether
     *  anything is sent at all. */
    const [touched, setTouched] = useState(false);
    /** Resized and held until there is a group to put it on. */
    const [picture, setPicture] = useState<Blob | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const file = useRef<HTMLInputElement>(null);
    /** Chosen, and waiting to be framed. Nothing is held until it has been. */
    const [chosen, setChosen] = useState<File | null>(null);

    /** What the group is called if nobody types anything: the people in it, which
     *  is what the rail would show for one with no name. Shown rather than left
     *  blank so it is clear what it will be called, and it is only sent if it was
     *  edited - a group named after its people goes on renaming itself as people
     *  join or leave, and freezing today's list into the name loses that. */
    const fallbackName = picked.map((person) => person.name).join(", ");

    // Written into the box rather than only hinted at, so what it will be called
    // is there to be edited - and it follows the list until somebody edits it,
    // because a name that still said "Ada, Grace" after Alan was added would be
    // one somebody has to notice and fix.
    useEffect(() => {
        if (!touched) setName(fallbackName);
    }, [fallbackName, touched]);

    const open_ = async (userIds: readonly string[]) => {
        if (userIds.length === 0) return;
        setBusy(true);
        setError("");
        const chosen = kind === "group" && name.trim() !== fallbackName ? name.trim() : "";
        const result = await runAction(
            () => openDirectAction({ userIds: [...userIds], name: chosen }),
            setError
        );
        if (result?.error || !result?.id) {
            setBusy(false);
            return;
        }
        // The picture last, because until now there was nothing to hang it on.
        // A group that was made and a picture that did not upload is still the
        // group somebody asked for, so this reports rather than unwinds.
        if (picture) {
            await fetch(chatAvatarUrl("channel", result.id), {
                method: "POST",
                headers: { "Content-Type": picture.type },
                body: picture
            }).catch(() => undefined);
        }
        setBusy(false);
        setPicked([]);
        setName("");
        setPicture(null);
        onOpenChange(false);
        refresh();
        router.push(`/chat/c/${result.id}`);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New message</DialogTitle>
                    <DialogDescription>
                        {may.groups
                            ? "One person, or several for a group."
                            : "Pick who to write to."}
                    </DialogDescription>
                </DialogHeader>

                {/* The choice only exists where a group can be started. An
                    account without that grant gets the screen it can use rather
                    than a tab that refuses. */}
                {may.groups && (
                    <div className="flex gap-1 rounded-md bg-muted p-0.5">
                        {(["direct", "group"] as const).map((option) => (
                            <button
                                key={option}
                                type="button"
                                aria-pressed={kind === option}
                                onClick={() => {
                                    setKind(option);
                                    setPicked([]);
                                    setError("");
                                }}
                                className={cn(
                                    "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
                                    kind === option
                                        ? "bg-card text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {option === "direct" ? (
                                    <MessageSquare className="size-3.5" />
                                ) : (
                                    <Users className="size-3.5" />
                                )}
                                {option === "direct" ? "Direct message" : "Group"}
                            </button>
                        ))}
                    </div>
                )}

                <PeoplePicker
                    search={searchPeopleAction}
                    picked={kind === "group" ? picked : []}
                    onChange={(next) => {
                        if (kind === "group") {
                            setPicked(next);
                            return;
                        }
                        // One press. Whoever was just chosen is the whole
                        // decision, so the conversation opens on the spot.
                        const person = next.at(-1);
                        if (person) void open_([person.id]);
                    }}
                    // Messaging yourself is not what anybody means by this, and
                    // the room it would open has nobody else in it.
                    exclude={[viewerId]}
                    label="Who to message"
                />

                {/* Only once there is a group to name. Both of these are the
                    things a group looks like, and both are easier to settle now
                    than to come back for from a menu - but neither is required,
                    which is why the name arrives filled in with what it would be
                    called anyway. */}
                {kind === "group" && picked.length > 0 && (
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => file.current?.click()}
                            className="relative size-12 shrink-0 overflow-hidden rounded-full border border-border bg-muted text-muted-foreground transition-colors hover:border-primary"
                            aria-label={picture ? "Change the group picture" : "Add a group picture"}
                            title={picture ? "Change the group picture" : "Add a group picture"}
                        >
                            {preview ? (
                                <img src={preview} alt="" className="size-full object-cover" />
                            ) : (
                                <ImagePlus className="mx-auto size-5" />
                            )}
                        </button>
                        <input
                            ref={file}
                            type="file"
                            accept={CROP_ACCEPTED}
                            className="hidden"
                            onChange={(event) => {
                                const picked = event.target.files?.[0];
                                event.target.value = "";
                                if (picked) setChosen(picked);
                            }}
                        />
                        <Input
                            value={name}
                            maxLength={MAX_CHAT_CHANNEL_NAME}
                            aria-label="What this group is called"
                            placeholder={fallbackName}
                            onChange={(event) => {
                                setTouched(true);
                                setName(event.target.value);
                            }}
                        />
                    </div>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                {/* Framed before it is held, like every other picture. It
                    drops the EXIF block a phone photo carries, and nobody
                    setting a group photo means to publish where it was taken. */}
                {chosen ? (
                    <ImageCropDialog
                        file={chosen}
                        shape={FACE_CROP}
                        onCancel={() => setChosen(null)}
                        onCropped={(square) => {
                            setChosen(null);
                            setPicture(square);
                            setPreview((was) => {
                                if (was) URL.revokeObjectURL(was);
                                return URL.createObjectURL(square);
                            });
                        }}
                    />
                ) : null}

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    {kind === "group" && (
                        <Button
                            size="sm"
                            disabled={busy || picked.length === 0}
                            onClick={() => void open_(picked.map((person) => person.id))}
                        >
                            {busy && <Loader2 className="size-4 animate-spin" />}
                            Start group
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
