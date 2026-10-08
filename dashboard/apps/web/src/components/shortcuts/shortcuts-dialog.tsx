"use client";

/**
 * What an app's `?` opens: its shortcuts, in the same boxes and with the same
 * controls as the account page, so moving a key from inside an app is the same
 * act as moving it from Settings.
 */

import type { ReactNode } from "react";
import type * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ShortcutSettings } from "@/components/shortcuts/shortcut-settings";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function ShortcutsDialog({
    app,
    open,
    onOpenChange,
    note
}: {
    app: core.ShortcutApp;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Said above the list - an app whose keys are switched off says so here. */
    note?: ReactNode;
}) {
    const t = useTranslations("shortcuts");
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[min(60rem,95vw)] max-w-[min(60rem,95vw)]">
                <DialogHeader className="pr-10">
                    <DialogTitle>{t("title")}</DialogTitle>
                    <DialogDescription>{t("description")}</DialogDescription>
                </DialogHeader>
                {note}
                {open ? <ShortcutSettings app={app} /> : null}
            </DialogContent>
        </Dialog>
    );
}
