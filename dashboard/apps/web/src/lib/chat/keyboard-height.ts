/**
 * How tall the phone's keyboard was the last time it was up, so the composer's
 * "+" sheet can open in exactly the space the keyboard leaves, the way Discord
 * and WhatsApp swap one for the other without the input moving.
 *
 * A browser shrinks `visualViewport` under a keyboard that overlays the page; a
 * WebView that resizes for it shrinks `innerHeight` too, so the tallest window
 * seen at this width stands in for the height without one. Remembered for the
 * tab, and absent until a keyboard has actually been seen.
 */

const STORE = "polaris.chat.keyboardHeight";
/** Anything shorter is a toolbar or the address bar sliding, not a keyboard. */
const SMALLEST = 120;
/** Without a measured keyboard, the share of the screen a phone keyboard takes. */
const FALLBACK_SHARE = 0.4;

let tallest = { width: 0, height: 0 };
let last = 0;

function remembered(): number {
    if (last > 0) return last;
    try {
        const stored = Number(sessionStorage.getItem(STORE));
        if (Number.isFinite(stored) && stored >= SMALLEST) last = stored;
    } catch {
        // Storage refused: the fallback share serves.
    }
    return last;
}

/** The keyboard's height from one reading of the window, 0 when none is up. */
export function measureKeyboard(tallestHeight: number, innerHeight: number, visibleHeight: number, visibleTop: number): number {
    const overlaid = innerHeight - visibleHeight - visibleTop;
    const resized = tallestHeight - visibleHeight - visibleTop;
    const height = Math.round(Math.max(overlaid, resized, 0));
    return height >= SMALLEST ? height : 0;
}

/**
 * The sheet's height: the last keyboard's when one was seen, otherwise a share
 * of the screen, and never so tall the conversation above it disappears.
 */
export function sheetHeight(keyboard: number, viewport: number): number {
    const wanted = keyboard >= SMALLEST ? keyboard : viewport * FALLBACK_SHARE;
    return Math.round(Math.min(Math.max(wanted, 220), viewport * 0.6));
}

/** The height the sheet should open at right now. */
export function currentSheetHeight(): number {
    if (typeof window === "undefined") return 0;
    return sheetHeight(remembered(), tallest.height || window.innerHeight);
}

/** Follows the keyboard while mounted; returns the cleanup. */
export function watchKeyboard(): () => void {
    const viewport = typeof window === "undefined" ? null : window.visualViewport;
    if (!viewport) return () => undefined;
    const read = () => {
        // A turned phone is a different screen: what was tallest no longer is.
        if (tallest.width !== window.innerWidth) tallest = { width: window.innerWidth, height: 0 };
        tallest.height = Math.max(tallest.height, window.innerHeight);
        const height = measureKeyboard(tallest.height, window.innerHeight, viewport.height, viewport.offsetTop);
        if (height === 0 || height === last) return;
        last = height;
        try {
            sessionStorage.setItem(STORE, String(height));
        } catch {
            // Kept in memory for this page instead.
        }
    };
    read();
    viewport.addEventListener("resize", read);
    return () => viewport.removeEventListener("resize", read);
}
