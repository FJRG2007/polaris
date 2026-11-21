"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useGameText } from "../game-text";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@polaris/ui";

/** Restoring is not a delete, so it does not borrow the delete dialog: nothing is
 *  destroyed by it, and saying so is what stops it reading as one. */
export function RestoreDialog({
    serverName,
    pending,
    onClose,
    onConfirm
}: {
    serverName: string;
    pending: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const t = useGameText("minecraft");
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <RotateCcw className="size-4" /> {t("world.restoreThisBackup")}
                    </DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-muted-foreground">
                        {t("world.restoreBody", { name: serverName })}
                    </p>
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            {t("world.cancel")}
                        </Button>
                        <Button onClick={onConfirm} disabled={pending}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {t("world.restore")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
