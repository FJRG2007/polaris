"use client";

/**
 * Setting the picture on a space or a conversation.
 *
 * One dialog for both, because they are the same act on two things that are
 * drawn the same way. What differs is which one it is pointed at and the
 * sentence under the control.
 *
 * The preview is the real component, so somebody sees the thing they are about
 * to change rather than a generic frame - including the faces a group falls back
 * to, which is what most groups will keep.
 */

import { chatAvatarUrl } from "@/lib/avatar-url";
import { ChatAvatar } from "@/components/chat-avatar";
import type { AvatarPerson } from "@/components/avatar";
import { PictureField } from "@/components/picture-field";
import { FACE_CROP, TILE_CROP } from "@/components/image-cropper";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function ChatPictureDialog({
    open,
    onOpenChange,
    kind,
    id,
    name,
    members = [],
    color,
    onChanged
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    kind: "space" | "channel";
    id: string;
    name: string;
    members?: readonly AvatarPerson[];
    color?: string | null;
    onChanged: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{kind === "space" ? "Space picture" : "Group picture"}</DialogTitle>
                    <DialogDescription>
                        {kind === "space"
                            ? "Shown in the column on the left, in place of the initials."
                            : "Shown wherever this conversation appears. Without one, the faces of the people in it."}
                    </DialogDescription>
                </DialogHeader>

                <PictureField
                    endpoint={chatAvatarUrl(kind, id)}
                    shape={kind === "space" ? TILE_CROP : FACE_CROP}
                    hint="PNG, JPEG, WebP or GIF. You choose which part of it is used."
                    preview={
                        <ChatAvatar
                            kind={kind}
                            id={id}
                            name={name}
                            members={members}
                            color={color}
                            square={kind === "space"}
                            size={64}
                        />
                    }
                    onDone={() => {
                        onOpenChange(false);
                        onChanged();
                    }}
                />
            </DialogContent>
        </Dialog>
    );
}
