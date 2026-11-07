"use client";

/**
 * The one thing left to do on the TV while the install waits on it: turn on
 * debugging through that TV's own menus, or accept its prompt. The menus come
 * from the TV checker's data (core `tv-compat/debugging.json`), sent by the
 * desktop app for the TV it found or read here for the platform the checker
 * answered, so the dialog and the desktop window say the same thing.
 */

import type { DesktopTvWaiting } from "@/lib/desktop-bridge";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** A platform's menus, as both the desktop app and core's `debuggingFor()` give them. */
export type TvMenus = Omit<DesktopTvWaiting, "step">;

/** Wireless debugging only turns on with a pairing code, which the app cannot type in yet. */
const PAIRING_SWITCH = "Wireless debugging";

export function TvWaitingNote({
    menus,
    step,
    waiting
}: {
    menus: TvMenus;
    step: DesktopTvWaiting["step"];
    /** Whether the app is polling the TV now, rather than this being read before Install. */
    waiting: boolean;
}) {
    const t = useTranslations("account");
    if (step === "prompt") {
        return (
            <p role="status" className="text-sm">
                {t("downloads.tv.dialog.waiting.prompt")}
            </p>
        );
    }
    const switches =
        menus.switches.length > 1
            ? t("downloads.tv.dialog.waiting.list", {
                  items: menus.switches.slice(0, -1).join(", "),
                  last: menus.switches.at(-1) ?? ""
              })
            : (menus.switches[0] ?? "");
    return (
        <div role="status" className="flex min-w-0 flex-col gap-1">
            <p className="text-sm break-words">
                {t(
                    waiting
                        ? "downloads.tv.dialog.waiting.debugging"
                        : "downloads.tv.dialog.waiting.before",
                    {
                        about: menus.about,
                        press: menus.press,
                        presses: menus.presses,
                        developer: menus.developer,
                        switches
                    }
                )}
            </p>
            {waiting ? (
                <p className="text-xs text-muted-foreground">
                    {t("downloads.tv.dialog.waiting.carriesOn")}
                </p>
            ) : null}
            {menus.switches.includes(PAIRING_SWITCH) ? (
                <p className="text-xs text-muted-foreground">
                    {t("downloads.tv.dialog.waiting.pairing")}
                </p>
            ) : null}
        </div>
    );
}
