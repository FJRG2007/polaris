/**
 * Doing what a reader would do before the picture: opening the panel that is
 * worth showing. Buttons are found by the words on them, read from the same
 * catalog the screen was drawn with, so a scene never depends on markup.
 */

import enUS from "@/../messages/en-US";
import esES from "@/../messages/es-ES";
import type { SceneLocale } from "./scene";

/** The text `namespace.key` reads as in `locale`. */
export function label(locale: SceneLocale, path: string): string {
    const catalog = (locale === "es-ES" ? esES : enUS) as unknown as Record<string, unknown>;
    const found = path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
    if (typeof found !== "string") throw new Error(`no text at ${path}`);
    return found;
}

/** Click the first visible button whose text, or accessible name, is `text`. */
export function press(text: string): void {
    const wanted = text.trim();
    const found = [...document.querySelectorAll<HTMLElement>("button, [role=button], [role=tab], a")].find(
        (element) =>
            (element.textContent?.trim() === wanted || element.getAttribute("aria-label") === wanted) &&
            element.offsetParent !== null
    );
    if (!found) throw new Error(`no button reads "${wanted}"`);
    found.click();
}

/**
 * Open the menu whose trigger reads `text`. A menu opens on the pointer going
 * down rather than on a click, which is what a hand does, so that is what this
 * sends.
 */
export function openMenu(text: string): void {
    const found = [...document.querySelectorAll<HTMLElement>("[aria-haspopup=menu]")].find(
        (element) => element.textContent?.trim() === text.trim() && element.offsetParent !== null
    );
    if (!found) throw new Error(`no menu opens from "${text}"`);
    found.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
}
