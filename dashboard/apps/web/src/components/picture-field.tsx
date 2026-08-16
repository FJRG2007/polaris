"use client";

/**
 * Putting a picture on something, in a dialog rather than on a card.
 *
 * The same three steps the profile card takes - resize in the browser, post the
 * bytes, replace what the browser has cached before drawing again - without the
 * card around them, because a space icon is set from a menu and a group photo
 * from its header, and neither of those has room for a panel.
 *
 * The resize is not a nicety. A phone photo arrives as several megabytes of
 * something that will be drawn eighteen pixels wide, and re-encoding drops the
 * EXIF block, which on a phone photo carries where and when it was taken -
 * nobody setting a group picture means to publish that. The server checks the
 * bytes again either way: this runs on the uploader's machine, so it is a
 * courtesy and not a control.
 */

import { Button } from "@polaris/ui";
import { Loader2, Trash2, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

/** Big enough for the largest place one of these is drawn, small enough to be
 *  free. */
const MAX_EDGE = 512;

const ACCEPTED = "image/png,image/jpeg,image/webp,image/gif";

/** A square of at most MAX_EDGE, centred. Cropped rather than squashed: these
 *  are drawn in square boxes, so a letterboxed portrait would be squashed
 *  anyway.
 *
 *  Exported because a picture chosen before the thing it belongs to exists - the
 *  photo on a group being started - is resized here and posted once there is
 *  somewhere to post it to. */
export async function toSquare(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    try {
        const edge = Math.min(bitmap.width, bitmap.height);
        const size = Math.min(edge, MAX_EDGE);
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser cannot resize the image");
        context.drawImage(
            bitmap,
            (bitmap.width - edge) / 2,
            (bitmap.height - edge) / 2,
            edge,
            edge,
            0,
            0,
            size,
            size
        );
        const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/webp", 0.9)
        );
        if (!blob) throw new Error("This browser cannot resize the image");
        return blob;
    } finally {
        bitmap.close();
    }
}

export function PictureField({
    endpoint,
    preview,
    hint,
    onDone
}: {
    /** Where the bytes are posted and deleted. Also what is pulled fresh
     *  afterwards, so the copy the browser is holding is the new one before
     *  anything is drawn from it. */
    endpoint: string;
    preview: ReactNode;
    hint?: string;
    /** Called once the picture has changed and the cached copy has been
     *  replaced. */
    onDone: () => void;
}) {
    const input = useRef<HTMLInputElement>(null);
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

    const upload = async (file: File) => {
        let body: Blob;
        try {
            body = await toSquare(file);
        } catch {
            setError("That file could not be read as an image");
            return;
        }
        await run(() =>
            fetch(endpoint, { method: "POST", headers: { "Content-Type": body.type }, body })
        );
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
                {preview}
                <div className="flex flex-wrap items-center gap-2">
                    <input
                        ref={input}
                        type="file"
                        accept={ACCEPTED}
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            // Cleared first, so picking the same file again
                            // after a failure still counts as a change.
                            event.target.value = "";
                            if (file) void upload(file);
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
        </div>
    );
}
