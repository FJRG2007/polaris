"use client";

/**
 * What the composer's "+" opens on a phone, the way Discord and WhatsApp do it:
 * a panel under the box with every way to add something to the message, each a
 * big tile a thumb finds, instead of a row of small icons beside the box.
 *
 * It takes the keyboard's place rather than covering anything: as tall as the
 * keyboard last was (`lib/chat/keyboard-height.ts`), in the page's flow under
 * the composer, so the input stays where it was and the conversation moves up.
 * Tapping the text field again puts the keyboard back in its place.
 *
 * Camera and Photos go straight to the phone's own camera and gallery - no
 * Polaris dialog in between - and land in the media editor like any other pick.
 * Inside the Polaris phone app the recent photos and videos are right there in a
 * grid to tap (`recent-media.tsx`), as Discord and Signal show them: a tap puts
 * the photo on the message being written, which goes with the composer's own
 * Send. Photos then stays as the way to everything else in the gallery.
 * Files is the picker Mail uses, so Drive is there too. Poll is offered only
 * where a poll has somewhere to go.
 *
 * Each way in wears its own colour, a filled circle with a white glyph, as
 * WhatsApp's attach sheet does: after a day the thumb goes to the colour
 * before the eye reads the word. Solid fills read the same on a light and a
 * dark sheet, so one colour serves both themes.
 */

import { RecentMedia } from "./recent-media";
import { phoneMedia } from "@/lib/mobile-media";
import { cn } from "@polaris/ui";
import { currentSheetHeight } from "@/lib/chat/keyboard-height";
import { useMemo, useRef, type ReactNode } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { BarChart3, Camera, Images, MapPin, Paperclip } from "lucide-react";

/** What a photo or a video pick asks the phone for. */
const MEDIA = "image/*,video/*";

export function AttachSheet({
    open,
    onOpenChange,
    onMedia,
    onAttach,
    onDetach,
    attached = [],
    onFiles,
    onPoll,
    maxBytes = 0,
    onLocation
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Photos or videos from the camera or the gallery. Absent where no file may be sent. */
    onMedia?: (files: File[]) => void;
    /** A recent photo tapped in the grid: straight onto the message being written. */
    onAttach?: (files: File[]) => void;
    /** A recent photo tapped again: off the message. */
    onDetach?: (file: File) => void;
    /** What the message carries now, so the grid marks what is already on it. */
    attached?: readonly File[];
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
    // Read as it opens: the keyboard it replaces is the one just put away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const height = useMemo(() => currentSheetHeight(), [open]);

    const take = (input: HTMLInputElement | null) => {
        const files = input?.files ? Array.from(input.files) : [];
        // Cleared, so picking the same photo twice in a row still fires.
        if (input) input.value = "";
        if (files.length > 0) onMedia?.(files);
    };

    // The inputs live outside the panel: it closes as the phone's picker
    // opens, and an input unmounted with it would drop what comes back.
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
            {open ? (
                <section
                    aria-label={t("attachSheet.title")}
                    data-attach-sheet=""
                    style={{ height }}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") onOpenChange(false);
                    }}
                    className="mt-2 flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain"
                >
                    {device && onMedia && onFiles ? (
                        <RecentMedia
                            media={device}
                            maxBytes={maxBytes}
                            attached={attached}
                            onCamera={() => {
                                onOpenChange(false);
                                camera.current?.click();
                            }}
                            onAttach={(files) => (onAttach ?? onMedia)(files)}
                            onDetach={(file) => onDetach?.(file)}
                        />
                    ) : null}
                    {/* Four to a row, so another way to add something has room beside these. */}
                    <div className="grid shrink-0 grid-cols-4 gap-2">
                        {onMedia && onFiles ? (
                            <>
                                {device ? null : (
                                    <Tile
                                        icon={<Camera className="size-6 shrink-0" />}
                                        label={t("attachSheet.camera")}
                                        tone="bg-rose-500"
                                        onClick={() => {
                                            onOpenChange(false);
                                            camera.current?.click();
                                        }}
                                    />
                                )}
                                <Tile
                                    icon={<Images className="size-6 shrink-0" />}
                                    label={t("attachSheet.photos")}
                                    tone="bg-violet-500"
                                    onClick={() => {
                                        onOpenChange(false);
                                        gallery.current?.click();
                                    }}
                                />
                                <Tile
                                    icon={<Paperclip className="size-6 shrink-0" />}
                                    label={t("attachSheet.files")}
                                    tone="bg-indigo-500"
                                    onClick={() => {
                                        onOpenChange(false);
                                        onFiles();
                                    }}
                                />
                            </>
                        ) : null}
                        {onPoll ? (
                            <Tile
                                icon={<BarChart3 className="size-6 shrink-0" />}
                                label={t("attachSheet.poll")}
                                tone="bg-amber-500"
                                onClick={() => {
                                    onOpenChange(false);
                                    onPoll();
                                }}
                            />
                        ) : null}
                        {onLocation ? (
                            <Tile
                                icon={<MapPin className="size-6 shrink-0" />}
                                label={t("attachSheet.location")}
                                tone="bg-emerald-500"
                                onClick={() => {
                                    onOpenChange(false);
                                    onLocation();
                                }}
                            />
                        ) : null}
                    </div>
                </section>
            ) : null}
        </>
    );
}

function Tile({ icon, label, tone, onClick }: { icon: ReactNode; label: string; tone: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group flex min-w-0 flex-col items-center gap-1.5 rounded-xl px-1 py-2 text-foreground [-webkit-tap-highlight-color:transparent]"
        >
            <span
                className={cn(
                    "grid size-14 shrink-0 place-items-center rounded-full text-white shadow-sm transition-transform duration-fast group-active:scale-95",
                    tone
                )}
            >
                {icon}
            </span>
            <span className="w-full truncate text-center text-xs" title={label}>
                {label}
            </span>
        </button>
    );
}
