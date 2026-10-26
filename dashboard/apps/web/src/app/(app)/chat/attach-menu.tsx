"use client";

/**
 * The composer's one "+" button: every way of adding something to a message
 * that is not typing it - a file, a photo, the camera, a clip, a poll.
 *
 * Upward from the button on anything with a pointer, since the box is at the
 * bottom of the screen. A sheet from the bottom edge on a phone, where a small
 * menu is a hard target and a thumb is already down there.
 *
 * Only what the room allows is listed (`attachItems`); with nothing to list the
 * button is not drawn at all.
 */

import type { ComponentType } from "react";
import type { AttachItem } from "./dictation-logic";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { BarChart3, Camera, Image as ImageIcon, Mic, Paperclip, Plus, Video } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@polaris/ui";
import { useState } from "react";

const ENTRIES: Readonly<
    Record<AttachItem, { icon: ComponentType<{ className?: string }>; label: NamespaceKey<"chat"> }>
> = {
    file: { icon: Paperclip, label: "composer.attachAFile" },
    gallery: { icon: ImageIcon, label: "composer.photoOrVideo" },
    camera: { icon: Camera, label: "composer.camera" },
    clip: { icon: Video, label: "composer.recordAClip" },
    poll: { icon: BarChart3, label: "composer.createAPoll" },
    mic: { icon: Mic, label: "composer.microphoneSettings" }
};

/** The items that add a file, which a box holding all it may hold refuses. */
const FILE_ITEMS: ReadonlySet<AttachItem> = new Set(["file", "gallery", "camera", "clip"]);

export function AttachMenu({
    items,
    disabled,
    full,
    sheet,
    onPick
}: {
    items: readonly AttachItem[];
    disabled: boolean;
    /** No more files fit on this message. */
    full: boolean;
    /** A phone: a bottom sheet rather than a menu. */
    sheet: boolean;
    onPick: (item: AttachItem) => void;
}) {
    const t = useTranslations("chat");
    const [open, setOpen] = useState(false);
    if (items.length === 0) return null;

    const trigger = (
        <button
            type="button"
            disabled={disabled}
            aria-label={t("attachMenu.add")}
            title={t("attachMenu.add")}
            aria-haspopup={sheet ? "dialog" : "menu"}
            onClick={sheet ? () => setOpen(true) : undefined}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
            <Plus className="size-4" />
        </button>
    );

    if (sheet) {
        return (
            <>
                {trigger}
                <Dialog open={open} onOpenChange={setOpen}>
                    <DialogContent
                        aria-describedby={undefined}
                        className="bottom-0 left-0 top-auto w-full max-w-full translate-x-0 translate-y-0 rounded-b-none px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8"
                    >
                        <DialogTitle className="px-3 pb-2">{t("attachMenu.add")}</DialogTitle>
                        <ul className="flex flex-col">
                            {items.map((item) => {
                                const { icon: Icon, label } = ENTRIES[item];
                                return (
                                    <li key={item}>
                                        <button
                                            type="button"
                                            disabled={full && FILE_ITEMS.has(item)}
                                            onClick={() => {
                                                setOpen(false);
                                                onPick(item);
                                            }}
                                            className="flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
                                        >
                                            <Icon className="size-5 shrink-0 text-muted-foreground" />
                                            <span className="min-w-0 truncate">{t(label)}</span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </DialogContent>
                </Dialog>
            </>
        );
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-56">
                {items.map((item) => {
                    const { icon: Icon, label } = ENTRIES[item];
                    return (
                        <DropdownMenuItem
                            key={item}
                            disabled={full && FILE_ITEMS.has(item)}
                            onSelect={() => onPick(item)}
                        >
                            <Icon />
                            {t(label)}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
