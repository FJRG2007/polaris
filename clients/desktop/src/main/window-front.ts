/**
 * Keeping a window the person asked for in front of them.
 *
 * Windows only lets the process that owns the screen bring a window forward.
 * A window shown by any other process opens behind the one in front, so the
 * app looks as if it never opened (BUG-0005, docs/bugs). Two moments lost it:
 * the installer's first run, started by a process that does not own the
 * screen, and the servers window closing before Polaris was shown, which
 * handed the screen to whatever was behind.
 */

/** What lifting needs of a window, so the tests can hand in a stand-in. */
export interface Liftable {
    show(): void;
    focus(): void;
    setAlwaysOnTop(flag: boolean, level?: "pop-up-menu"): void;
}

/** What waiting for a window to be on screen needs of it. */
export interface Showable {
    isDestroyed(): boolean;
    isVisible(): boolean;
    once(event: "show", listener: () => void): unknown;
}

/** Whether this start is the installer's first run on Windows. */
export function launchedByInstaller(platform: NodeJS.Platform, argv: readonly string[]): boolean {
    return platform === "win32" && argv.includes("--squirrel-firstrun");
}

/** Shows a window; when `lift` is set, the first one is put above everything once. */
export function createPresenter(lift: boolean): (window: Liftable) => void {
    let pending = lift;
    return (window) => {
        window.show();
        if (!pending) return;
        pending = false;
        window.setAlwaysOnTop(true);
        window.focus();
        window.setAlwaysOnTop(false);
    };
}

/**
 * Close the window being replaced once `next` is on screen, never before: the
 * app keeps a window in front the whole time, so it never looks closed and
 * the screen stays this app's to give.
 */
export function closeOnceShown(next: Showable | null, close: () => void): void {
    if (next && !next.isDestroyed() && !next.isVisible()) next.once("show", close);
    else close();
}

/** What taking the keyboard needs of a window, so the tests can hand in a stand-in. */
export interface Focusable extends Liftable {
    isFocused(): boolean;
    minimize(): void;
    restore(): void;
    readonly webContents: { focus(): void; };
}

/**
 * Show a window and give it the keyboard, for a window brought up from a key
 * held system-wide (the launcher). Windows' foreground lock lets a process
 * that is not in front raise a window without activating it: it is drawn on
 * top, but the keys still go to the app behind. Each step is tried only when
 * the one before left the window without focus, in the order Electron's own
 * reports settled on (electron/electron#2867): show and focus; then a topmost
 * flip, which Windows treats as the window being brought forward; then a
 * minimize and restore, which activates it. Last, the page itself is focused -
 * a window kept hidden and shown again is active with its page still blurred
 * unless that is asked for, the way Flow Launcher activates its window and
 * then focuses its query box.
 */
export function takeFocus(window: Focusable, platform: NodeJS.Platform, level?: "pop-up-menu"): void {
    window.show();
    window.focus();
    if (platform === "win32" && !window.isFocused()) {
        window.setAlwaysOnTop(false);
        window.setAlwaysOnTop(true, level);
        window.focus();
    }
    if (platform === "win32" && !window.isFocused()) {
        window.minimize();
        window.restore();
        window.focus();
    }
    window.webContents.focus();
}
