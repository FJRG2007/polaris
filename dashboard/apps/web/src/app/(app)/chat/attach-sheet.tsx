"use client";

/**
 * What the composer's "+" opens on a phone, the way Discord and WhatsApp do it:
 * one sheet from the bottom with every way to add something to the message, each
 * a big tile a thumb finds, instead of a row of small icons beside the box.
 *
 * Camera and Photos go straight to the phone's own camera and gallery - no
 * Polaris dialog in between - and land in the media editor like any other pick.
 * Inside the Polaris phone app the recent photos and videos are right there in a
 * grid to tap (`recent-media.tsx`), as Discord and Signal show them; Photos then
 * stays as the way to everything else in the gallery.
 * Files is the picker Mail uses, so Drive is there too. Poll is offered only
 * where a poll has somewhere to go.
 */

import { RecentMedia } from "./recent-media";
import { phoneMedia } from "@/lib/mobile-media";
import { useMemo, useRef, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { BarChart3, Camera, Images, MapPin, Paperclip } from "lucide-react";

/** What a photo or a video pick asks the phone for. */
const MEDIA = "image/*,video/*";

export function AttachSheet({
    open,
    onOpenChange,
    onMedia,
    onFiles,
    onPoll,
    maxBytes = 0,
    onLocation
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Photos or videos from the camera or the gallery. Absent where no file may be sent. */
    onMedia?: (files: File[]) => void;
    onFiles?: () => void;
    /** Absent where a poll makes no sense. */
    onPoll?: () => void;
    /** The largest file this conversation takes; a larger recent photo cannot be chosen. */
    maxBytes?: number;
    /** Absent where a location has nowhere to go. */
    onLocation?: () => void;
}) {
    const t = useTranslations("chat");
    const camera = useRef<HTMLInputElement>(null);
    const gallery = useRef<HTMLInputElement>(null);
    // The phone app's gallery, read once: null in a browser and in an older app.
    const device = useMemo(() => phoneMedia(), []);

    const take = (input: HTMLInputElement | null) => {
        const files = input?.files ? Array.from(input.files) : [];
        // Cleared, so picking the same photo twice in a row still fires.
        if (input) input.value = "";
        if (files.length > 0) onMedia?.(files);
    };

    // The inputs live outside the dialog: the sheet closes as the phone's
    // picker opens, and an input unmounted with it would drop what comes back.
    return (
        <>
            <input
                ref={camera}
                type="file"
                accept={MEDIA}
                capture="environment"
                className="hidden"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => take(event.currentTarget)}
            />
            <input
                ref={gallery}
                type="file"
                accept={MEDIA}
                multiple
                className="hidden"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => take(event.currentTarget)}
            />
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent phone="sheet" showClose={false} className="flex flex-col gap-4 bg-background">
                    <span aria-hidden className="mx-auto -mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong" />
                    <DialogTitle className="sr-only">{t("attachSheet.title")}</DialogTitle>
                    {device && onMedia && onFiles ? (
                        <RecentMedia
                            media={device}
                            maxBytes={maxBytes}
                            onCamera={() => {
                                onOpenChange(false);
                                camera.current?.click();
                            }}
                            onPick={(files) => {
                                onOpenChange(false);
                                if (files.length > 0) onMedia(files);
                            }}
                        />
                    ) : null}
                    {/* Four to a row, so another way to add something has room beside these. */}
                    <div className="grid grid-cols-4 gap-2">
                        {onMedia && onFiles ? (
                            <>
                                {device ? null : (
                                    <Tile
                                        icon={<Camera className="size-6" />}
                                        label={t("attachSheet.camera")}
                                        onClick={() => {
                                            onOpenChange(false);
                                            camera.current?.click();
                                        }}
                                    />
                                )}
                                <Tile
                                    icon={<Images className="size-6" />}
                                    label={t("attachSheet.photos")}
                                    onClick={() => {
                                        onOpenChange(false);
                                        gallery.current?.click();
                                    }}
                                />
                                <Tile
                                    icon={<Paperclip className="size-6" />}
                                    label={t("attachSheet.files")}
                                    onClick={() => {
                                        onOpenChange(false);
                                        onFiles();
                                    }}
                                />
                            </>
                        ) : null}
                        {onPoll ? (
                            <Tile
                                icon={<BarChart3 className="size-6" />}
                                label={t("attachSheet.poll")}
                                onClick={() => {
                                    onOpenChange(false);
                                    onPoll();
                                }}
                            />
                        ) : null}
                        {onLocation ? (
                            <Tile
                                icon={<MapPin className="size-6" />}
                                label={t("attachSheet.location")}
                                onClick={() => {
                                    onOpenChange(false);
                                    onLocation();
                                }}
                            />
                        ) : null}
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

function Tile({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex min-w-0 flex-col items-center gap-1.5 rounded-xl bg-surface px-1 py-3 text-foreground transition-colors duration-fast active:bg-muted [-webkit-tap-highlight-color:transparent]"
        >
            <span className="shrink-0">{icon}</span>
            <span className="w-full truncate text-center text-xs" title={label}>
                {label}
            </span>
        </button>
    );
}
