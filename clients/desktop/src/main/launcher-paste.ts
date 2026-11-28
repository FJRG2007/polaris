/**
 * "Paste to active app" for the launcher's Quick AI answer, as Raycast's
 * primary action is (https://manual.raycast.com/ai/quick-ai): the text goes on
 * the clipboard and the system's paste keys are pressed once the launcher has
 * handed focus back to the program that was in front.
 *
 * - Windows: Ctrl+V through `keybd_event`, the same shell the device buttons'
 *   hotkeys use (`game-detect.ts`).
 * - macOS: Cmd+V through System Events, which needs the Accessibility
 *   permission; refused without it, and the text stays on the clipboard.
 * - Linux: `xdotool` when it is installed (X11); otherwise the text stays on
 *   the clipboard.
 *
 * False whenever the keys could not be pressed, so the page can say "copied
 * instead" - the clipboard holds the text either way.
 */

import { execFile } from "node:child_process";
import { sharedWindowsLister } from "./game-detect";

/** Longest text pasted: what one Quick AI answer may be. */
export const PASTE_MAX = 20_000;
/** How long the program behind gets to take the focus back before the keys are pressed. */
export const FOCUS_BACK_MS = 180;

const VK_CONTROL = 0x11;
const VK_V = 0x56;

function run(file: string, args: readonly string[]): Promise<boolean> {
    return new Promise((done) => {
        execFile(file, [...args], { windowsHide: true, timeout: 5_000 }, (failed) => done(!failed));
    });
}

/** Press the system's paste keys in the program in front. */
export function pressPaste(platform: NodeJS.Platform = process.platform): Promise<boolean> {
    if (platform === "win32") return sharedWindowsLister().sendKeys([VK_CONTROL, VK_V]).catch(() => false);
    if (platform === "darwin") return run("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
    if (platform === "linux") return run("xdotool", ["key", "--clearmodifiers", "ctrl+v"]);
    return Promise.resolve(false);
}
