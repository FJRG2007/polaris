"use client";

/**
 * The pictures on a profile: yours, drawn together, or an organization's.
 *
 * Yours are one card because they are one thing on screen. A face and a banner
 * edited in two boxes, each with its own little preview, is two decisions about
 * a picture nobody has seen: the only question worth answering is whether the
 * two look right together - whether the face sits over a part of the band that
 * is not already busy, whether the colours fight. So the card shows exactly what
 * everybody else will see, and the buttons for each picture sit under the thing
 * they change.
 *
 * Both are resized and re-encoded here, in the browser, before being sent. It
 * costs nothing, it means a phone photo does not arrive as eight megabytes of
 * something that will be drawn 24 pixels wide, and re-encoding drops the EXIF
 * block - which on a phone photo carries the place and time it was taken, and
 * which nobody setting a profile picture means to publish. The server checks the
 * bytes again regardless: this runs on the uploader's machine, so it is a
 * courtesy rather than a control.
 *
 * An organization has a face and no banner, and keeps the plain card: it appears
 * in a switcher and a list, never as somebody's profile.
 */

import { Button, Card, CardBody } from "@polaris/ui";
import { Loader2, Trash2, Upload } from "lucide-react";
import { Avatar, OrgAvatar } from "@/components/avatar";
import { useRef, useState, type ReactNode } from "react";
import { ProfileBanner } from "@/components/profile-banner";
import { avatarUrl, bannerUrl, orgAvatarUrl } from "@/lib/avatar-url";

/** Big enough for the largest place a face is drawn, small enough to be free. */
const MAX_EDGE = 512;

/** The widest a banner is stored at. Wider than anywhere it is drawn, so it
 *  still looks right on a screen that draws it big, and far short of what a
 *  camera hands you. */
const MAX_BANNER_WIDTH = 1200;

/** How much wider than tall a banner is. The band across a profile, at the
 *  proportions every client that has one settled on. */
const BANNER_RATIO = 3;

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

/**
 * The picture as a band, cropped to the middle of whatever was handed over.
 *
 * Cropped rather than squashed, like the square above: a banner is drawn at one
 * shape wherever it appears, so a tall photograph letterboxed to fit would be
 * drawn stretched anyway. Taking the middle is the crop that is right most
 * often - it is where the thing in a picture usually is.
 */
async function toBand(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    try {
        // The widest band this picture can fill, then the tallest slice of the
        // picture that fits it.
        const width = Math.min(bitmap.width, MAX_BANNER_WIDTH);
        const height = Math.round(width / BANNER_RATIO);
        const sourceHeight = Math.min(bitmap.height, Math.round(bitmap.width / BANNER_RATIO));
        const sourceWidth = Math.round(sourceHeight * BANNER_RATIO);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser cannot resize the image");
        context.drawImage(
            bitmap,
            (bitmap.width - sourceWidth) / 2,
            (bitmap.height - sourceHeight) / 2,
            sourceWidth,
            sourceHeight,
            0,
            0,
            width,
            height
        );
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
        if (!blob) throw new Error("This browser cannot resize the image");
        return blob;
    } finally {
        bitmap.close();
    }
}

/** One picture, and the two things that can be done to it. */
interface Picture {
    busy: boolean;
    error: string;
    /** The file chooser, which has to be rendered somewhere. */
    field: ReactNode;
    /** Open it. */
    choose: () => void;
    remove: () => void;
}

/**
 * Putting a picture up and taking it down, for one endpoint.
 *
 * A hook rather than a component because the profile card draws two of these
 * inside one preview: the parts that differ are the endpoint and the crop, and
 * everything else - the size limit, the formats, the cache dance after a
 * replace, the sentence when it fails - is the same for both.
 */
function usePicture(endpoint: string, pictureUrl: string, shape: "square" | "band"): Picture {
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
            // The picture is drawn on this page, in the header, and in whatever
            // list is behind it. They all point at the one URL, which the browser
            // was told it could keep - so the cached copy is replaced first, and
            // then the page is drawn again from it. Anything less and you change
            // the photo and nothing appears to happen except here.
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
            body = shape === "band" ? await toBand(file) : await toSquare(file);
        } catch {
            setError("That file could not be read as an image");
            return;
        }
        await run(() => fetch(endpoint, { method: "POST", headers: { "Content-Type": body.type }, body }));
    };

    return {
        busy,
        error,
        choose: () => input.current?.click(),
        remove: () => void run(() => fetch(endpoint, { method: "DELETE" })),
        field: (
            <input
                ref={input}
                type="file"
                accept={ACCEPTED}
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    // Cleared first, so picking the same file twice after a
                    // failure still counts as a change.
                    event.target.value = "";
                    if (file) void upload(file);
                }}
            />
        )
    };
}

/** The pair of buttons under a picture. */
function PictureActions({ label, picture, exists }: { label: string; picture: Picture; exists: boolean }) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            {picture.field}
            <Button variant="secondary" size="sm" disabled={picture.busy} onClick={picture.choose}>
                {picture.busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {exists ? `Replace ${label}` : `Upload ${label}`}
            </Button>
            {exists && (
                <Button variant="ghost" size="sm" disabled={picture.busy} onClick={picture.remove}>
                    <Trash2 className="size-4" />
                    Remove
                </Button>
            )}
        </div>
    );
}

/**
 * Your face and your banner, drawn the way everybody else sees them.
 *
 * The preview is the profile itself rather than a picture of one: the same band,
 * the same face cut out of its lower edge, at the same proportions. Anything
 * else is a preview of a preview, and the thing it leaves out - how the two look
 * together - is the only thing worth looking at before saving.
 */
export function ProfilePicturesCard({
    userId,
    name,
    hasPhoto,
    hasBanner
}: {
    userId: string;
    name: string;
    hasPhoto: boolean;
    hasBanner: boolean;
}) {
    const photo = usePicture("/api/avatar", avatarUrl(userId), "square");
    const banner = usePicture("/api/banner", bannerUrl(userId), "band");
    const error = photo.error || banner.error;

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div>
                    <h2 className="text-sm font-medium">Photo and banner</h2>
                    <p className="text-xs text-muted-foreground">
                        How your profile looks to everybody else. Without a photo, Polaris uses the
                        picture your email address has on Gravatar and your initials if it has none;
                        without a banner, a colour taken from your photo.
                    </p>
                </div>

                <div className="overflow-hidden rounded-lg border border-border">
                    <ProfileBanner person={{ id: userId, name }} className="h-24" />
                    <div className="flex flex-col gap-3 px-4 pb-4">
                        <div className="-mt-8">
                            <Avatar
                                person={{ id: userId, name }}
                                size={72}
                                status={false}
                                className="ring-[3px] ring-card"
                            />
                        </div>
                        <p className="truncate text-sm font-medium" title={name}>{name}</p>
                    </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                    <PictureActions label="photo" picture={photo} exists={hasPhoto} />
                    <PictureActions label="banner" picture={banner} exists={hasBanner} />
                </div>

                {error && <p className="text-sm text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}

/** An organization's face. One picture, so one button beside it. */
export function OrgPhotoCard({ orgId, name, hasPhoto }: { orgId: string; name: string; hasPhoto: boolean }) {
    const photo = usePicture(`/api/avatar/org/${orgId}`, orgAvatarUrl(orgId), "square");

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">Photo</h2>
                    <p className="text-xs text-muted-foreground">
                        Shown wherever this organization appears - the switcher, its people&apos;s
                        rosters, and any list it is in. Without one, Polaris draws its initials.
                    </p>
                </div>
                <div className="flex items-center gap-4">
                    <OrgAvatar org={{ id: orgId, name }} size={64} />
                    <PictureActions label="photo" picture={photo} exists={hasPhoto} />
                </div>
                {photo.error && <p className="text-sm text-danger">{photo.error}</p>}
            </CardBody>
        </Card>
    );
}
