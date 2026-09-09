/**
 * Which way round the page is, for the code that cannot ask CSS.
 *
 * Almost nothing needs this: a colour comes from a token and follows the theme
 * on its own. What cannot is anything that draws outside the stylesheet - a
 * canvas, an embedded editor with a palette of its own, a library that takes the
 * word "dark" as a parameter. Those have to be told, and this is what tells
 * them.
 *
 * Read off the class on the root, which is where Polaris keeps the theme: dark
 * is the default and carries no class at all, `.light` flips it, and `.system`
 * follows the browser. Components that looked for a `data-theme` attribute
 * instead - and three of them did - got null on every page and settled on light,
 * which on the default theme is exactly backwards.
 */

/**
 * Whether the page is dark right now.
 *
 * Read off the class on the root, which is where Polaris keeps it: dark is the
 * default and carries no class at all, `.light` flips it, and `.system` follows
 * the browser. There is no attribute to read - components that looked for one
 * got null on every page and quietly concluded "light", which on the default
 * theme is exactly backwards.
 */
export function pageIsDark(): boolean {
    if (typeof document === "undefined") return true;
    const classes = document.documentElement.classList;
    if (classes.contains("light")) return false;
    if (classes.contains("system"))
        return window.matchMedia?.("(prefers-color-scheme: dark)").matches !== false;
    return true;
}

/** Call `onChange` whenever the page's theme moves, and answer with the way to
 *  stop listening. Both sources: somebody choosing a theme here, which rewrites
 *  the class, and the system changing under a browser set to follow it.
 *
 *  **It reports a change, not a mutation, and the difference is the whole
 *  function.** What is watched is the class attribute of the root, which several
 *  things write for reasons that have nothing to do with the theme - and one of
 *  the listeners is an embedded editor whose own dark mode writes a class onto
 *  that same element. Told about every mutation, that listener answers each one
 *  with a write, which is another mutation: an unbounded synchronous loop, and a
 *  browser that stops responding rather than reporting anything. So the last
 *  answer is kept and `onChange` runs only when this one differs, which makes a
 *  listener that writes to the page safe by construction instead of by
 *  everybody who writes one remembering. */
export function watchPageTheme(onChange: (dark: boolean) => void): () => void {
    if (typeof document === "undefined") return () => undefined;
    let last = pageIsDark();
    const tell = (): void => {
        const dark = pageIsDark();
        if (dark === last) return;
        last = dark;
        onChange(dark);
    };
    const observer = new MutationObserver(tell);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", tell);
    return () => {
        observer.disconnect();
        media?.removeEventListener("change", tell);
    };
}
