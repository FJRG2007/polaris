/**
 * Which kind of input the person last used - a touch, a mouse or pen, or the
 * keyboard - written on `<html data-input>` so CSS can tell a tap from a key.
 *
 * `:focus-visible` alone cannot: a phone's WebView and Chrome on Android match
 * it after focus is moved by script, which is what every sheet and dialog does
 * when it closes (focus goes back to the button that opened it). The chat's "+"
 * then wore the focus ring - a circle around it - until the next tap anywhere.
 * With this, a ring is drawn after a key and never after a finger (tokens.css).
 *
 * Runs inline in the document head, before anything can take focus, the way
 * the chunk-recovery script does - so it is one self-contained function.
 */
export function watchInputModality(): void {
    const root = document.documentElement;
    const set = (kind: string) => {
        if (root.dataset.input !== kind) root.dataset.input = kind;
    };
    window.addEventListener(
        "pointerdown",
        (event) => set(event.pointerType === "touch" || event.pointerType === "pen" ? "touch" : "mouse"),
        { capture: true, passive: true }
    );
    window.addEventListener(
        "keydown",
        (event) => {
            // A modifier alone is a shortcut on its way, not somebody moving around by keyboard.
            if (event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt" && event.key !== "Meta") {
                set("keyboard");
            }
        },
        { capture: true, passive: true }
    );
}

export const INPUT_MODALITY_SCRIPT = `(${watchInputModality.toString()})();`;
