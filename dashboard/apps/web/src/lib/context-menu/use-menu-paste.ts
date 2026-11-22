"use client";

/**
 * Paste for Polaris's own menus, as a hook: whether a Paste row can work here,
 * and the press itself, which says on screen why nothing was pasted instead of
 * doing nothing. Every menu with a Paste row uses this; the work is
 * `pasteFromClipboard` (`lib/context-menu/editing.ts`).
 */

import { desktopBridge } from "@/lib/desktop-bridge";
import * as editing from "@/lib/context-menu/editing";
import { useCallback, useEffect, useState } from "react";
import * as contextMenu from "@/lib/context-menu/target";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** "available" also covers a browser that can only be asked by trying. */
export type PasteAvailability = "available" | "blocked";

/**
 * Whether the clipboard can be read from a menu at all: blocked only when this
 * browser has no clipboard API (a plain-http address, an old browser) or the
 * person refused it for good, and there is no desktop app to ask instead.
 */
export function usePasteAvailability(): PasteAvailability {
    const [availability, setAvailability] = useState<PasteAvailability>("available");
    useEffect(() => {
        if (desktopBridge()?.editing) return;
        if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
            setAvailability("blocked");
            return;
        }
        let status: PermissionStatus | null = null;
        const read = () => status && setAvailability(status.state === "denied" ? "blocked" : "available");
        navigator.permissions
            ?.query({ name: "clipboard-read" as PermissionName })
            .then((answer) => {
                status = answer;
                read();
                answer.addEventListener("change", read);
            })
            .catch(() => undefined);
        return () => status?.removeEventListener("change", read);
    }, []);
    return availability;
}

export interface MenuPaste {
    readonly availability: PasteAvailability;
    /** Why Paste cannot work here and what to press instead, for a disabled row; null when it can. */
    readonly blockedHint: string | null;
    /** Pastes into `field` as Ctrl+V would, with a notice for anything but a paste that happened. */
    readonly paste: (field: Element, options?: editing.MenuPasteOptions) => Promise<editing.MenuPasteOutcome>;
    /** The pictures on the clipboard, for a surface that uploads what Ctrl+V pastes; null, with a notice, for none. */
    readonly pictures: () => Promise<readonly File[] | null>;
}

export function useMenuPaste(notify: (title: string) => void = contextMenu.contextMenuNotice): MenuPaste {
    const t = useTranslations("common");
    const availability = usePasteAvailability();
    const paste = useCallback(
        async (field: Element, options?: editing.MenuPasteOptions) => {
            const outcome = await editing.pasteFromClipboard(field, options);
            const surface = desktopBridge() ? "app" : "browser";
            const keys = editing.pasteKeys();
            if (outcome === "denied" || outcome === "unsupported") notify(t("contextMenu.pasteRefused", { surface, keys }));
            else if (outcome === "empty") notify(t("contextMenu.pasteEmpty"));
            else if (outcome === "no-text") notify(t("contextMenu.pasteNoText"));
            return outcome;
        },
        [notify, t]
    );
    const pictures = useCallback(async () => {
        const read = await editing.readClipboard();
        if (!read.ok) {
            const surface = desktopBridge() ? "app" : "browser";
            notify(t("contextMenu.pasteRefused", { surface, keys: editing.pasteKeys() }));
            return null;
        }
        if (read.contents.files.length > 0) return read.contents.files;
        notify(t("contextMenu.pasteNoPicture"));
        return null;
    }, [notify, t]);
    const blockedHint = availability === "blocked" ? t("contextMenu.pasteBlocked", { keys: editing.pasteKeys() }) : null;
    return { availability, blockedHint, paste, pictures };
}
