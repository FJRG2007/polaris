"use client";

/**
 * A photo card: yours, or an organization's.
 *
 * The picture is resized and re-encoded here, in the browser, before it is sent.
 * It costs nothing, it means a phone photo does not arrive as eight megabytes of
 * something that will be drawn 24 pixels wide, and re-encoding drops the EXIF
 * block - which on a phone photo carries the place and time it was taken, and
 * which nobody setting a profile picture means to publish. The server checks the
 * bytes again regardless: this runs on the uploader's machine, so it is a
 * courtesy rather than a control.
 *
 * One component for both because everything that matters is the same - the size
 * limit, the formats, the crop, the cache dance after a replace. Only the
 * endpoint, the face being drawn and the sentence under the heading differ.
 */

import { Button, Card, CardBody } from "@polaris/ui";
import { Loader2, Trash2, Upload } from "lucide-react";
import { Avatar, OrgAvatar } from "@/components/avatar";
import { useRef, useState, type ReactNode } from "react";
import { avatarUrl, orgAvatarUrl } from "@/lib/avatar-url";

/** Big enough for the largest place a face is drawn, small enough to be free. */
const MAX_EDGE = 512;

const ACCEPTED = "image/png,image/jpeg,image/webp,image/gif";

/**
 * The picture as a square of at most MAX_EDGE, centred on the middle.
 *
 * Cropped rather than squashed: every face in Polaris is drawn in a square box,
 * so a portrait that was letterboxed to fit would be drawn squashed anyway.
 */
async function toSquare(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    try {
        const edge = Math.min(bitmap.width, bitmap.height);
        const size = Math.min(edge, MAX_EDGE);
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser cannot resize the image");
        context.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, size, size);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
        if (!blob) throw new Error("This browser cannot resize the image");
        return blob;
    } finally {
        bitmap.close();
    }
}

function PhotoCard({
    title,
    hint,
    preview,
    endpoint,
    pictureUrl,
    hasPhoto
}: {
    title: string;
    hint: string;
    preview: ReactNode;
    /** Where the bytes are posted and deleted. */
    endpoint: string;
    /** The URL the picture is served from, so a replacement can be pulled into
     *  the browser's cache before the page is drawn again from it. */
    pictureUrl: string;
    hasPhoto: boolean;
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
            // The face is drawn on this page, in the header, and in whatever list
            // is behind it. They all point at the one URL, which the browser was
            // told it could keep for five minutes - so the cached copy is
            // replaced first, and then the page is drawn again from it. Anything
            // less and you change the photo and nothing appears to happen except
            // here.
            await fetch(pictureUrl, { cache: "reload" }).catch(() => undefined);
            window.location.reload();
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
        await run(() => fetch(endpoint, { method: "POST", headers: { "Content-Type": body.type }, body }));
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">{title}</h2>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                </div>
                <div className="flex items-center gap-4">
                    {preview}
                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            ref={input}
                            type="file"
                            accept={ACCEPTED}
                            className="hidden"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                // Cleared first, so picking the same file twice
                                // after a failure still counts as a change.
                                event.target.value = "";
                                if (file) void upload(file);
                            }}
                        />
                        <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
                            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                            {hasPhoto ? "Replace" : "Upload"}
                        </Button>
                        {hasPhoto && (
                            <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void run(() => fetch(endpoint, { method: "DELETE" }))}
                            >
                                <Trash2 className="size-4" />
                                Remove
                            </Button>
                        )}
                    </div>
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}

export function AvatarCard({ userId, name, hasPhoto }: { userId: string; name: string; hasPhoto: boolean }) {
    return (
        <PhotoCard
            title="Photo"
            hint="Shown wherever your name appears. Without one, Polaris uses the picture your email address has on Gravatar, and your initials if it has none."
            preview={<Avatar person={{ id: userId, name }} size={64} />}
            endpoint="/api/avatar"
            pictureUrl={avatarUrl(userId)}
            hasPhoto={hasPhoto}
        />
    );
}

export function OrgPhotoCard({ orgId, name, hasPhoto }: { orgId: string; name: string; hasPhoto: boolean }) {
    return (
        <PhotoCard
            title="Photo"
            hint="Shown wherever this organization appears - the switcher, its people's rosters, and any list it is in. Without one, Polaris draws its initials."
            preview={<OrgAvatar org={{ id: orgId, name }} size={64} />}
            endpoint={`/api/avatar/org/${orgId}`}
            pictureUrl={orgAvatarUrl(orgId)}
            hasPhoto={hasPhoto}
        />
    );
}
