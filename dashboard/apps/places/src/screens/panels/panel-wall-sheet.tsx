"use client";

/**
 * The full-screen sheet a wall card opens: everything a device or a room has
 * beyond the card's one press. A card never scrolls; this is where the rest
 * lives, the way a Home Assistant tile opens its more-info dialog and a Google
 * Home favourite opens its controller on a long press.
 */

import { X } from "lucide-react";
import { usePlacesT } from "../use-places-t";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@polaris/ui";

export function WallSheet({
    open,
    title,
    description,
    onClose,
    children
}: {
    open: boolean;
    title: string;
    description?: string;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const t = usePlacesT();
    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent
                showClose={false}
                className="left-0 top-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-5 rounded-none border-0 p-4 sm:p-6"
            >
                <div className="flex min-w-0 items-center gap-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                        <DialogTitle className="truncate text-2xl font-semibold" title={title}>
                            {title}
                        </DialogTitle>
                        {description ? (
                            <DialogDescription className="truncate text-lg">
                                {description}
                            </DialogDescription>
                        ) : null}
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        aria-label={t("panelWall.close")}
                        title={t("panelWall.close")}
                        onClick={onClose}
                        className="size-14 shrink-0 p-0"
                    >
                        <X className="size-7" />
                    </Button>
                </div>
                <div className="min-h-0 flex-1 text-lg">{children}</div>
            </DialogContent>
        </Dialog>
    );
}
