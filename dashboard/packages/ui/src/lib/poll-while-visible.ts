/**
 * Run `read` every `everyMs` while the tab is on screen, and stop while it is
 * hidden: nobody is looking, so nothing is asked. Coming back reads once at
 * once and starts the count again from there, so the read on return is not
 * followed by a tick a moment later. Returns the cleanup for an effect.
 */
export function pollWhileVisible(read: () => void, everyMs: number): () => void {
    const tick = (): void => {
        if (document.visibilityState === "visible") read();
    };
    let timer = window.setInterval(tick, everyMs);
    const onReturn = (): void => {
        if (document.visibilityState !== "visible") return;
        window.clearInterval(timer);
        read();
        timer = window.setInterval(tick, everyMs);
    };
    document.addEventListener("visibilitychange", onReturn);
    return () => {
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", onReturn);
    };
}
