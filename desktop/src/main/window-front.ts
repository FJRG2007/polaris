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
    setAlwaysOnTop(flag: boolean): void;
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
