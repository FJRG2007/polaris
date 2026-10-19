/**
 * The failures that mean "this tab is running yesterday's build".
 *
 * A deploy replaces the JavaScript, the CSS chunks and the ids Next mints for
 * server actions. A tab that was already open keeps the old ones, so the next
 * thing it asks for is answered by a server that has never heard of it:
 * `Server Action "60b910..." was not found on the server`, or a chunk that 404s.
 *
 * None of it is a bug in the page, and none of it can be retried away - the id
 * the browser is holding does not exist any more, so pressing Try again produces
 * the identical failure forever. The only cure is fetching the new build, which
 * is a reload, and it is one the page can do by itself.
 *
 * Pure and client-safe on purpose: the error boundaries import it, and they run
 * in the browser.
 */

/** What Next and the bundler say when the build underneath has moved on. */
const STALE_BUILD_PATTERNS: readonly RegExp[] = [
    // A server action id from a build that is no longer deployed.
    /server action .*(?:was not found|not found on the server)/i,
    /failed to find server action/i,
    // A code-split chunk that was replaced. Webpack and Turbopack word it
    // differently, and a stylesheet fails differently again.
    /loading chunk [\w-]+ failed/i,
    /loading css chunk/i,
    /(?:error|failed to fetch) .*dynamically imported module/i
];

/**
 * Whether this failure is the old-build one.
 *
 * Deliberately narrow. Reloading is not free - it costs whatever was typed into
 * the page - so anything that might be a real fault in the code has to reach the
 * boundary and be read, not be answered with a refresh that hides it.
 */
export function isStaleBuildError(error: { name?: string; message?: string } | null | undefined): boolean {
    if (!error) return false;
    if (error.name === "ChunkLoadError") return true;
    const message = error.message ?? "";
    return STALE_BUILD_PATTERNS.some((pattern) => pattern.test(message));
}

/** Where the tab remembers that it has already tried this. Session storage, so it
 *  survives the reload it is guarding and dies with the tab. */
const RELOADED_KEY = "polaris.staleBuildReloadedAt";

/** How long a reload counts as "just tried". Long enough to cover the reload and
 *  the render after it, short enough that a genuine second deploy an hour later
 *  is still recovered from by itself. */
const RELOAD_COOLDOWN_MS = 30_000;

/**
 * Reload once to pick up the new build, and report whether it was done.
 *
 * False means the tab has already reloaded for this and the failure survived it -
 * which is no longer "an old tab" but something the reader has to be told about,
 * so the boundary stops and shows it rather than reloading in a loop.
 */
export function reloadForNewBuild(): boolean {
    try {
        const last = Number(window.sessionStorage.getItem(RELOADED_KEY) ?? "0");
        if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) return false;
        window.sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
    } catch {
        // Storage can be denied outright. Without somewhere to remember the
        // attempt there is no way to guarantee this does not loop, so the tab is
        // left showing the message instead.
        return false;
    }
    window.location.reload();
    return true;
}

/**
 * Reload a page whose own scripts never arrived.
 *
 * Everything above runs inside React, and so does every error boundary - which
 * is exactly what is missing when a script the page was served with fails to
 * load. While an update rolls over, both dashboards answer and the edge sends
 * each request to either of them: the page can come from the new build and one
 * of its chunks from the old container, which has never had it. The page then
 * stays as the server drew it - labels, menus, and a skeleton for every value -
 * with nothing running to fetch them, until somebody reloads by hand.
 *
 * So this is not a component. It is rendered into the document's head as a
 * plain script, listens for a `/_next/static` script or stylesheet failing to
 * load, and reloads after a pause long enough for the rollover to finish. Only
 * while the document is still loading: a chunk that fails after that belongs to
 * a page that is up and may have something typed into it, and the banner in
 * `new-build` offers that reload instead of doing it.
 *
 * Bounded by its own count in session storage, so a build that is genuinely
 * missing a file is a page that stops trying, not a page that reloads forever.
 * Written in plain ES5 with no outside references, because it is serialised
 * with `toString` - see `CHUNK_RECOVERY_SCRIPT`.
 */
export function recoverMissingChunks(): void {
    var KEY = "polaris.chunkRecovery";
    var WINDOW_MS = 120000;
    var MAX_RELOADS = 3;
    var DELAY_MS = 1500;
    var scheduled = false;
    window.addEventListener(
        "error",
        function (event) {
            var element = event.target as (Element & { src?: string; href?: string }) | null;
            if (scheduled || document.readyState === "complete" || !element) return;
            if (element.tagName !== "SCRIPT" && element.tagName !== "LINK") return;
            var url = element.src || element.href || "";
            if (url.indexOf("/_next/static/") === -1) return;
            var now = Date.now();
            var recent: number[];
            try {
                var stored = JSON.parse(window.sessionStorage.getItem(KEY) || "[]");
                recent = (Array.isArray(stored) ? stored : []).filter(function (at: unknown) {
                    return typeof at === "number" && now - at < WINDOW_MS;
                });
                if (recent.length >= MAX_RELOADS) return;
                recent.push(now);
                window.sessionStorage.setItem(KEY, JSON.stringify(recent));
            } catch {
                // Nowhere to count the attempts means no guarantee this stops.
                return;
            }
            scheduled = true;
            setTimeout(function () {
                window.location.reload();
            }, DELAY_MS);
        },
        // Load failures do not bubble; only a listener in the capture phase sees
        // the element that failed.
        true
    );
}

/** `recoverMissingChunks` as the source of an inline script. */
export const CHUNK_RECOVERY_SCRIPT = `(${recoverMissingChunks.toString()})();`;
