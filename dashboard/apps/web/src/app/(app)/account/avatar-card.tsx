"use client";

/**
 * The pictures on a profile: yours, drawn together, or an organization's.
 *
 * Yours are one card because they are one thing on screen. A face and a banner
 * edited in two boxes, each with its own little preview, is two decisions about
 * a picture nobody has seen: the only question worth answering is whether the
 * two look right together - whether the face sits over a part of the band that
 * is not already busy, whether the colours fight. So the card shows exactly what
 * everybody else will see.
 *
 * And the controls sit on the pictures rather than under them. A row of buttons
 * reading "Replace banner" beside another reading "Replace photo" makes somebody
 * match a label to one of two pictures before pressing anything; pointing at the
 * picture itself cannot be matched to the wrong one. What the pointer uncovers
 * is a menu rather than a single action, because there are three things somebody
 * wants from a picture they have already chosen - move it, swap it, take it away
 * - and only the first is new: how a picture was framed used to be a decision
 * that could be made exactly once, at upload, and getting it wrong meant finding
 * the original file again.
 *
 * Reframing re-cuts the picture Polaris has, which is the cropped one: what was
 * cut off at upload is gone, so this pans and zooms inside what was kept. That
 * is what the operation is for - a face sitting too low in its circle - and it
 * is honest about it, since an option that promised the original back would be
 * promising bytes nobody kept.
 *
 * Choosing a file opens the cropper rather than uploading it: which part of a
 * photograph becomes a face is the uploader's decision, not the middle of the
 * frame's. `components/image-cropper.tsx` also does the resizing and the
 * re-encoding that strips the EXIF block.
 *
 * An organization has a face and no banner, and gets the same handle on it: it
 * appears in a switcher and a list, never as somebody's profile.
 */

import { Avatar, OrgAvatar } from "@/components/avatar";
import { useRef, useState, type ReactNode } from "react";
import { ProfileBanner } from "@/components/profile-banner";
import { avatarUrl, bannerUrl, orgAvatarUrl } from "@/lib/avatar-url";
import { Camera, Crop, Image as ImageIcon, Loader2, Trash2, Upload, type LucideIcon } from "lucide-react";
import {
    BAND_CROP,
    CROP_ACCEPTED,
    FACE_CROP,
    ImageCropDialog,
    TILE_CROP,
    type CropShape
} from "@/components/image-cropper";
import {
    Card,
    CardBody,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    cn
} from "@polaris/ui";

/** One picture, and the three things that can be done to it. */
interface Picture {
    busy: boolean;
    error: string;
    /** The file chooser and the cropper, which have to be rendered somewhere. */
    field: ReactNode;
    /** Pick a new file, then frame it. */
    choose: () => void;
    /** Frame the one that is already there again. */
    reframe: () => void;
    remove: () => void;
}

/**
 * Putting a picture up, moving it, and taking it down, for one endpoint.
 *
 * A hook rather than a component because the profile card draws two of these
 * inside one preview: the parts that differ are the endpoint and the shape, and
 * everything else - the cropper, the formats, the cache dance after a replace,
 * the sentence when it fails - is the same for both.
 */
function usePicture(endpoint: string, pictureUrl: string, shape: CropShape): Picture {
    const input = useRef<HTMLInputElement>(null);
    const [chosen, setChosen] = useState<Blob | null>(null);
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

    const upload = (body: Blob) =>
        run(() => fetch(endpoint, { method: "POST", headers: { "Content-Type": body.type }, body }));

    /**
     * Open the cropper on the picture that is already there.
     *
     * Fetched rather than pointed at: the cropper cuts the picture out of a
     * canvas, so what it needs is the bytes. It takes them as they arrive - a
     * blob is what a file already is, and the name of a file nobody chose is
     * not something to invent.
     */
    const reframe = async () => {
        setError("");
        setBusy(true);
        try {
            const response = await fetch(pictureUrl);
            const blob = response.ok ? await response.blob() : null;
            // Only that there are bytes. What they are is the cropper's
            // question, and it already has an answer for a file it cannot read -
            // whereas refusing anything whose content type did not survive the
            // round trip refuses pictures that are perfectly fine.
            if (!blob || blob.size === 0) {
                setError("Could not open that picture again");
                return;
            }
            setChosen(blob);
        } catch {
            setError("Could not reach the server");
        } finally {
            setBusy(false);
        }
    };

    return {
        busy,
        error,
        choose: () => input.current?.click(),
        reframe: () => void reframe(),
        remove: () => void run(() => fetch(endpoint, { method: "DELETE" })),
        // Both are rendered wherever the handle is. The dialog puts itself on
        // top of the page from there, so where that is does not matter.
        field: (
            <>
                <input
                    ref={input}
                    type="file"
                    accept={CROP_ACCEPTED}
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        // Cleared first, so picking the same file twice after a
                        // failure still counts as a change.
                        event.target.value = "";
                        if (file) setChosen(file);
                    }}
                />
                {chosen ? (
                    <ImageCropDialog
                        file={chosen}
                        shape={shape}
                        busy={busy}
                        onCancel={() => setChosen(null)}
                        onCropped={(body) => {
                            setChosen(null);
                            void upload(body);
                        }}
                    />
                ) : null}
            </>
        )
    };
}

/**
 * The editing handle that sits on a picture.
 *
 * The whole picture is the button, and it shows nothing until the pointer is
 * over it: a preview whose job is to show what everybody else sees cannot spend
 * its life under a dark sheet. That leaves the two readers a hover never
 * reaches, and both are answered here rather than left to the idiom - a
 * keyboard, which uncovers it on focus, and a touch screen, where there is no
 * hover at all.
 *
 * Which is why the handle is two things rather than one. The sheet that dims the
 * picture belongs to hovering it - it is the thing that says the whole picture
 * is pressable, and it costs the picture its colours while it is up. The chip in
 * the middle is the handle itself, and on a screen with no pointer it is simply
 * always there: a phone gets the button it can press without the preview it came
 * to look at being dimmed for the rest of its life.
 */
function PictureEditor({
    label,
    icon: Icon,
    picture,
    exists,
    round,
    className
}: {
    /** What this picture is, in the sentence a screen reader reads out. */
    label: string;
    icon: LucideIcon;
    picture: Picture;
    /** Whether there is a picture of their own here, which is what decides
     *  whether there is anything to reframe or to take away. */
    exists: boolean;
    round: boolean;
    className?: string;
}) {
    return (
        <>
            {picture.field}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={`Edit ${label}`}
                        title={`Edit ${label}`}
                        disabled={picture.busy}
                        className={cn(
                            "group/handle absolute inset-0 flex items-center justify-center",
                            round && "rounded-full",
                            className
                        )}
                    >
                        <span
                            aria-hidden
                            className={cn(
                                "absolute inset-0 bg-black/50 opacity-0 transition-opacity duration-fast",
                                "group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100 group-data-[state=open]/handle:opacity-100",
                                round && "rounded-full",
                                className
                            )}
                        />
                        <span
                            className={cn(
                                "relative flex size-8 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-fast",
                                "group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100 group-data-[state=open]/handle:opacity-100",
                                // Nothing here can hover, so the chip is the only
                                // sign there is anything to press.
                                "[@media(hover:none)]:opacity-100",
                                // Mid-upload the spinner is the only thing saying
                                // that anything is happening.
                                picture.busy && "opacity-100"
                            )}
                        >
                            {picture.busy ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <Icon className="size-4" />
                            )}
                        </span>
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[9rem]">
                    {exists && (
                        <DropdownMenuItem onSelect={picture.reframe}>
                            <Crop />
                            Reframe
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={picture.choose}>
                        <Upload />
                        {exists ? "Replace" : `Upload ${label}`}
                    </DropdownMenuItem>
                    {exists && (
                        <DropdownMenuItem variant="danger" onSelect={picture.remove}>
                            <Trash2 />
                            Remove
                        </DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
        </>
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
    const photo = usePicture("/api/avatar", avatarUrl(userId), FACE_CROP);
    const banner = usePicture("/api/banner", bannerUrl(userId), BAND_CROP);
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
                    <div className="relative">
                        <ProfileBanner person={{ id: userId, name }} className="h-24" />
                        <PictureEditor
                            label="banner"
                            icon={ImageIcon}
                            picture={banner}
                            exists={hasBanner}
                            round={false}
                        />
                    </div>
                    <div className="flex flex-col gap-3 px-4 pb-4">
                        {/* Positioned, so the handle can be laid over the face -
                            and so the face keeps sitting over the band it
                            overlaps rather than being painted under it. */}
                        <div className="relative -mt-8 w-fit">
                            <Avatar
                                person={{ id: userId, name }}
                                size={72}
                                status={false}
                                className="ring-[3px] ring-card"
                            />
                            <PictureEditor
                                label="photo"
                                icon={Camera}
                                picture={photo}
                                exists={hasPhoto}
                                round
                            />
                        </div>
                        <p className="truncate text-sm font-medium" title={name}>{name}</p>
                    </div>
                </div>

                {error && <p className="text-sm text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}

/** An organization's face. One picture, and the same handle on it. */
export function OrgPhotoCard({ orgId, name, hasPhoto }: { orgId: string; name: string; hasPhoto: boolean }) {
    const photo = usePicture(`/api/avatar/org/${orgId}`, orgAvatarUrl(orgId), TILE_CROP);

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
                <div className="relative w-fit">
                    <OrgAvatar org={{ id: orgId, name }} size={64} />
                    <PictureEditor
                        label="photo"
                        icon={Camera}
                        picture={photo}
                        exists={hasPhoto}
                        round={false}
                        className="rounded-md"
                    />
                </div>
                {photo.error && <p className="text-sm text-danger">{photo.error}</p>}
            </CardBody>
        </Card>
    );
}
