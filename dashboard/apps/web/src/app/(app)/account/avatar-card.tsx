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

import { BLANK_AVATAR_ETAG } from "@/lib/avatar-blank";
import { Avatar, OrgAvatar } from "@/components/avatar";
import { useRef, useState, type ReactNode } from "react";
import { ProfileBanner } from "@/components/profile-banner";
import { avatarUrl, bannerUrl, orgAvatarUrl, orgBannerUrl } from "@/lib/avatar-url";
import {
    Camera,
    Crop,
    Image as ImageIcon,
    Loader2,
    Trash2,
    Upload,
    type LucideIcon
} from "lucide-react";
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
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
    Dialog,
    DialogContent,
    DialogTitle,
    cn
} from "@polaris/ui";

/**
 * Whether these bytes are a moving picture.
 *
 * Only GIF today. Animated WebP exists and is not detectable from the type - the
 * still and the moving one are both `image/webp`, and telling them apart means
 * reading the chunks - so a WebP is framed like any other picture, which is what
 * it was before this and is right for the still ones almost all of them are.
 */
function animated(type: string): boolean {
    return type === "image/gif";
}

/** One picture, and the three things that can be done to it. */
interface Picture {
    /** Something is happening to it, which the handle says with a spinner. */
    busy: boolean;
    /** Bytes are on their way to the server, or a removal is - which is the
     *  only state that has to stop a second one being started. Fetching the
     *  picture back to reframe it does not: taking the handle away underneath
     *  somebody mid-gesture costs them their place on the page. */
    sending: boolean;
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
    const [sending, setSending] = useState(false);
    const [opening, setOpening] = useState(false);
    const [error, setError] = useState("");

    const run = async (work: () => Promise<Response>) => {
        setSending(true);
        setError("");
        try {
            const response = await work();
            if (!response.ok) {
                setError((await response.text()) || "Could not save that");
                setSending(false);
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
            setSending(false);
        }
    };

    const upload = (body: Blob) =>
        run(() =>
            fetch(endpoint, { method: "POST", headers: { "Content-Type": body.type }, body })
        );

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
        setOpening(true);
        try {
            const response = await fetch(pictureUrl);
            // Every picture route answers "I have nothing to serve" with a
            // transparent pixel and a 200 rather than an error, because the
            // initials underneath are what the screen wants and a browser
            // complains about the honest reply - see lib/avatar-blank. It is the
            // answer a picture whose bytes did not arrive gets too: a storage
            // target that moved, a NAS not answering this second. Framing that
            // would cut a one-pixel picture out of it and post it over the one
            // the account still has, so the pixel is refused by the tag it
            // carries before its bytes are ever read.
            const blank = response.headers.get("etag") === BLANK_AVATAR_ETAG;
            const blob = response.ok && !blank ? await response.blob() : null;
            // Beyond that, only that there are bytes. What they are is the
            // cropper's question, and it already has an answer for a file it
            // cannot read - whereas refusing anything whose content type did not
            // survive the round trip refuses pictures that are perfectly fine.
            if (!blob || blob.size === 0) {
                setError("Could not open that picture again");
                return;
            }
            // The same reason as above, said at the point somebody would find
            // out the hard way: reframing this would replace a moving picture
            // with one still frame of itself.
            if (animated(blob.type)) {
                setError("A moving picture cannot be reframed - replace it to change how it sits");
                return;
            }
            setChosen(blob);
        } catch {
            setError("Could not reach the server");
        } finally {
            setOpening(false);
        }
    };

    return {
        busy: sending || opening,
        sending,
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
                        if (!file) return;
                        // A moving picture does not go through the cropper.
                        // Framing happens on a canvas, and a canvas holds one
                        // frame: an animated banner put through it would arrive
                        // as its first frame, still, with nothing on screen
                        // saying why. So it is sent as it is - the band is
                        // already the shape of a banner, and the face is already
                        // cut to a circle by the page rather than by the bytes.
                        if (animated(file.type)) {
                            void upload(file);
                            return;
                        }
                        setChosen(file);
                    }}
                />
                {chosen ? (
                    <ImageCropDialog
                        file={chosen}
                        shape={shape}
                        busy={sending}
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

/** The corners the handle is cut to, which are the corners of the picture it is
 *  laid over: a circle for a face, the card radius for an organization's tile,
 *  and nothing at all for a band that runs to the edges. */
const HANDLE_RADIUS = {
    full: "rounded-full",
    md: "rounded-md",
    none: ""
} as const;

/**
 * What can be done to one picture, declared once.
 *
 * Rendered two ways from this one list - as rows in a dialog and as lines in a
 * right-click menu - so the two can never come to offer different things. Which
 * of them exist depends only on whether there is a picture: nothing to reframe
 * and nothing to remove until there is one.
 */
interface PictureAction {
    readonly label: string;
    readonly note: string;
    readonly Icon: LucideIcon;
    readonly onSelect: () => void;
    readonly danger?: boolean;
}

function actionsFor(label: string, picture: Picture, exists: boolean): PictureAction[] {
    return [
        ...(exists
            ? [
                  {
                      label: "Reframe",
                      note: "Move and scale what is already there",
                      Icon: Crop,
                      onSelect: picture.reframe
                  }
              ]
            : []),
        {
            label: exists ? "Replace" : `Upload ${label}`,
            // Said here because it is where somebody decides which file to
            // reach for, which is the only moment the answer is useful.
            note: "Choose a picture from this device - a GIF keeps moving",
            Icon: Upload,
            onSelect: picture.choose
        },
        ...(exists
            ? [
                  {
                      label: "Remove",
                      note: `Go back to the default ${label}`,
                      Icon: Trash2,
                      onSelect: picture.remove,
                      danger: true
                  }
              ]
            : [])
    ];
}

/**
 * The editing handle that sits on a picture.
 *
 * Pressing the picture opens a dialog; right-clicking it opens the menu. That is
 * the way round every client that does this has settled on, and it was the wrong
 * way round here: a left-click - the ordinary press, the one somebody makes
 * without deciding to - dropped a small menu out of the corner of the picture,
 * which is the shape of a thing you asked for on purpose. The dialog is what an
 * ordinary press deserves: it names the picture, it gives each choice a line
 * saying what it does, and its rows are big enough to hit on a phone, where a
 * menu hanging off a 72-pixel circle is not.
 *
 * The menu is still there for the press that means "just the options", and both
 * are built from one list of actions so they cannot drift.
 *
 * The whole picture is the button, and over a picture that is there it shows
 * nothing until the pointer is: a preview whose job is to show what everybody
 * else sees cannot spend its life under a dark sheet. That leaves the readers a
 * hover never reaches, and they are answered here rather than left to the idiom
 * - a keyboard, which uncovers it on focus; a touch screen, where there is no
 * hover at all; and an account that has put nothing up yet, where there is no
 * preview to protect and the chip is the only thing saying that the initials
 * behind it can be changed.
 *
 * Which is why the handle is two things rather than one. The sheet that dims the
 * picture belongs to hovering it - it is the thing that says the whole picture
 * is pressable, and it costs the picture its colours while it is up. The chip in
 * the middle is the handle itself, and wherever the sheet would be a permanent
 * tax the chip is simply always there: a phone, and an empty profile, get the
 * button they can press without anything being dimmed for the rest of its life.
 *
 * The corners are a prop of their own rather than a class the caller passes in,
 * because both of those elements are cut to them: a caller reaching for
 * `className` would be laying its positioning over the sheet as well.
 */
function PictureEditor({
    label,
    icon: Icon,
    picture,
    exists,
    radius
}: {
    /** What this picture is, in the sentence a screen reader reads out. */
    label: string;
    icon: LucideIcon;
    picture: Picture;
    /** Whether there is a picture of their own here, which is what decides
     *  whether there is anything to reframe or to take away. */
    exists: boolean;
    radius: keyof typeof HANDLE_RADIUS;
}) {
    const [open, setOpen] = useState(false);
    const actions = actionsFor(label, picture, exists);

    /** Chosen from the dialog: it goes, then the work starts. A dialog left
     *  standing over a file picker is one somebody has to dismiss before they
     *  can see what they picked. */
    const run = (action: PictureAction) => {
        setOpen(false);
        action.onSelect();
    };

    return (
        <>
            {picture.field}
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={`Edit ${label}`}
                        title={`Edit ${label}`}
                        disabled={picture.sending}
                        // The sheet and the chip used to read the menu's own open
                        // state off this button. The dialog is not attached to
                        // it, so it says so itself.
                        data-open={open ? "" : undefined}
                        onClick={() => setOpen(true)}
                        className={cn(
                            "group/handle absolute inset-0 flex items-center justify-center",
                            HANDLE_RADIUS[radius]
                        )}
                    >
                        <span
                            aria-hidden
                            className={cn(
                                "absolute inset-0 bg-black/50 opacity-0 transition-opacity duration-fast",
                                "group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100 group-data-[open]/handle:opacity-100",
                                HANDLE_RADIUS[radius]
                            )}
                        />
                        <span
                            className={cn(
                                "relative flex size-8 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-fast",
                                "group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100 group-data-[open]/handle:opacity-100",
                                // Nothing here can hover, so the chip is the only
                                // sign there is anything to press.
                                "[@media(hover:none)]:opacity-100",
                                // Nor is there a preview to keep clear on a
                                // profile with nothing on it yet: behind the chip
                                // are initials over a tint, and hiding the only
                                // way to change them leaves somebody to guess
                                // that a circle of letters is a button.
                                !exists && "opacity-100",
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
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-[9rem]">
                    {actions.map((action) => (
                        <ContextMenuItem
                            key={action.label}
                            variant={action.danger ? "danger" : "default"}
                            onSelect={action.onSelect}
                        >
                            <action.Icon className="size-3.5" />
                            {action.label}
                        </ContextMenuItem>
                    ))}
                </ContextMenuContent>
            </ContextMenu>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-xs">
                    <DialogTitle className="capitalize">{label}</DialogTitle>
                    <div className="flex flex-col gap-1">
                        {actions.map((action) => (
                            <button
                                key={action.label}
                                type="button"
                                onClick={() => run(action)}
                                className={cn(
                                    "flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted",
                                    action.danger && "text-danger hover:bg-danger/10"
                                )}
                            >
                                <action.Icon className="size-4 shrink-0" />
                                <span className="flex min-w-0 flex-col">
                                    <span className="text-sm font-medium">{action.label}</span>
                                    <span
                                        className={cn(
                                            "text-xs",
                                            action.danger ? "text-danger/80" : "text-muted-foreground"
                                        )}
                                    >
                                        {action.note}
                                    </span>
                                </span>
                            </button>
                        ))}
                    </div>
                </DialogContent>
            </Dialog>
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
                            radius="none"
                        />
                    </div>
                    <div className="flex flex-col gap-3 px-4 pb-4">
                        {/* Positioned, so the handle can be laid over the face -
                            and so the face keeps sitting over the band it
                            overlaps rather than being painted under it. */}
                        {/* A flex box, so it is exactly the size of the face.
                            Left as a block it takes the line box of the image
                            inside it, which is a few pixels taller than the
                            circle - and the round handle laid over `inset-0`
                            then draws as an ellipse hanging below it. */}
                        <div className="relative -mt-8 flex w-fit">
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
                                radius="full"
                            />
                        </div>
                        <p className="truncate text-sm font-medium" title={name}>
                            {name}
                        </p>
                    </div>
                </div>

                {error && <p className="text-sm text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}

/**
 * An organization's mark and its banner, drawn the way everybody else sees them.
 *
 * The same card as a person's, deliberately and down to the layout: the preview
 * is the organization's own page rather than a picture of one, the band is the
 * band, the mark is cut out of its lower edge, and each picture carries the
 * handle that replaces, reframes or removes it. An organization is a profile
 * here - it has a page at `/o/<slug>` that anybody can be sent to - so a settings
 * screen that offered one small square while a person got a page to design would
 * be two products in one application.
 *
 * The only difference is the shape the mark is cut to. A square is what tells a
 * group from a person before either name is read, and it is the shape the mark
 * has in every list, so it is the shape it is cropped and previewed at.
 */
export function OrgPicturesCard({
    orgId,
    name,
    hasPhoto,
    hasBanner
}: {
    orgId: string;
    name: string;
    hasPhoto: boolean;
    hasBanner: boolean;
}) {
    const photo = usePicture(`/api/avatar/org/${orgId}`, orgAvatarUrl(orgId), TILE_CROP);
    const banner = usePicture(`/api/banner/org/${orgId}`, orgBannerUrl(orgId), BAND_CROP);
    const error = photo.error || banner.error;

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div>
                    <h2 className="text-sm font-medium">Photo and banner</h2>
                    <p className="text-xs text-muted-foreground">
                        How this organization looks wherever it appears - the switcher, its
                        people&apos;s rosters, and its own page. Without a photo, Polaris draws its
                        initials; without a banner, a colour taken from the photo.
                    </p>
                </div>

                <div className="overflow-hidden rounded-lg border border-border">
                    <div className="relative">
                        <ProfileBanner person={{ id: orgId, name }} kind="org" className="h-24" />
                        <PictureEditor
                            label="banner"
                            icon={ImageIcon}
                            picture={banner}
                            exists={hasBanner}
                            radius="none"
                        />
                    </div>
                    <div className="flex flex-col gap-3 px-4 pb-4">
                        {/* Positioned, so the handle can be laid over the mark -
                            and so the mark keeps sitting over the band it
                            overlaps rather than being painted under it. */}
                        {/* A flex box, so it is exactly the size of the face.
                            Left as a block it takes the line box of the image
                            inside it, which is a few pixels taller than the
                            circle - and the round handle laid over `inset-0`
                            then draws as an ellipse hanging below it. */}
                        <div className="relative -mt-8 flex w-fit">
                            <OrgAvatar
                                org={{ id: orgId, name }}
                                size={72}
                                className="ring-[3px] ring-card"
                            />
                            <PictureEditor
                                label="photo"
                                icon={Camera}
                                picture={photo}
                                exists={hasPhoto}
                                radius="md"
                            />
                        </div>
                        <p className="truncate text-sm font-medium" title={name}>
                            {name}
                        </p>
                    </div>
                </div>

                {error && <p className="text-sm text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}
