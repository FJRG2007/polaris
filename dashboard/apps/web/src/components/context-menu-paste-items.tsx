"use client";

import { ClipboardPaste, ClipboardType } from "lucide-react";
import type { MenuPaste } from "@/lib/context-menu/use-menu-paste";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DropdownMenuItem, DropdownMenuLabel, MenuShortcut } from "@polaris/ui";

/**
 * Paste, and Paste as plain text in a rich field. Where the clipboard can never
 * be read from here, drawn disabled with what to press instead.
 */
export function PasteItems({
    menuPaste,
    rich,
    onPaste
}: {
    menuPaste: MenuPaste;
    rich: boolean;
    onPaste: (plain: boolean) => void;
}) {
    const t = useTranslations("common");
    const blocked = menuPaste.blockedHint;
    return (
        <>
            <DropdownMenuItem disabled={!!blocked} onSelect={() => onPaste(false)}>
                <ClipboardPaste />
                {t("selectionMenu.paste")}
                <MenuShortcut keys="Mod+V" />
            </DropdownMenuItem>
            {rich ? (
                <DropdownMenuItem disabled={!!blocked} onSelect={() => onPaste(true)}>
                    <ClipboardType />
                    {t("contextMenu.pastePlain")}
                    <MenuShortcut keys="Mod+Shift+V" />
                </DropdownMenuItem>
            ) : null}
            {blocked ? (
                <DropdownMenuLabel className="text-xs font-normal normal-case tracking-normal text-muted-foreground">
                    {blocked}
                </DropdownMenuLabel>
            ) : null}
        </>
    );
}
