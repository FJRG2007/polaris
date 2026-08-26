"use client";

/**
 * Putting a picture on something, in a dialog rather than on a card.
 *
 * The same three steps the profile card takes - frame it, post the bytes,
 * replace what the browser has cached before drawing again - without the card
 * around them, because a space icon is set from a menu and a group photo from
 * its header, and neither of those has room for a panel.
 *
 * Choosing a file opens the cropper (`components/image-cropper.tsx`), which is
 * also where the resize and the re-encode happen. The resize is not a nicety: a
 * phone photo arrives as several megabytes of something that will be drawn
 * eighteen pixels wide, and re-encoding drops the EXIF block, which on a phone
 * photo carries where and when it was taken - nobody setting a group picture
 * means to publish that. The server checks the bytes again either way: this runs
 * on the uploader's machine, so it is a courtesy and not a control.
 */

import { Button } from "@polaris/ui";
import { Loader2, Trash2, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { CROP_ACCEPTED, ImageCropDialog, TILE_CROP, type CropShape } from "@/components/image-cropper";

export function PictureField({
    endpoint,
    preview,
    hint,
    shape = TILE_CROP,
    onDone
}: {
    /** Where the bytes are posted and deleted. Also what is pulled fresh
     *  afterwards, so the copy the browser is holding is the new one before
     *  anything is drawn from it. */
    endpoint: string;
    preview: ReactNode;
    hint?: string;
    /** The shape it will be drawn at, which is the shape it is framed in.
     *  A square tile unless the caller says otherwise. */
    shape?: CropShape;
    /** Called once the picture has changed and the cached copy has been
     *  replaced. */
    onDone: () => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const [chosen, setChosen] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const run = async (work: () => Promise<Response>) => {
        setBusy(true);
        setError("");
        try {
            const response = await work();
            if (!response.ok) {
                setError((await response.text()) || "Could not save that");
                setBusy(false);
                return;
            }
            // Every screen drawing this points at the one URL. Replacing what
            // the browser has before redrawing is the difference between the
            // picture changing everywhere and it changing nowhere but here.
            await fetch(endpoint, { cache: "reload" }).catch(() => undefined);
            setBusy(false);
            onDone();
        } catch {
            setError("Could not reach the server");
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
                {preview}
                <div className="flex flex-wrap items-center gap-2">
                    <input
                        ref={input}
                        type="file"
                        accept={CROP_ACCEPTED}
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            // Cleared first, so picking the same file again
                            // after a failure still counts as a change.
                            event.target.value = "";
                            if (file) setChosen(file);
                        }}
                    />
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => input.current?.click()}
                    >
                        {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Upload className="size-4" />
                        )}
                        Upload
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void run(() => fetch(endpoint, { method: "DELETE" }))}
                    >
                        <Trash2 className="size-4" />
                        Remove
                    </Button>
                </div>
            </div>
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
            {error && (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            )}
            {chosen ? (
                <ImageCropDialog
                    file={chosen}
                    shape={shape}
                    busy={busy}
                    onCancel={() => setChosen(null)}
                    onCropped={(body) => {
                        setChosen(null);
                        void run(() =>
                            fetch(endpoint, {
                                method: "POST",
                                headers: { "Content-Type": body.type },
                                body
                            })
                        );
                    }}
                />
            ) : null}
        </div>
    );
}
