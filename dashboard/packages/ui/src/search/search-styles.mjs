/**
 * What a surface outside the dashboard needs to build the search panel's
 * stylesheet itself - the desktop app's search window and the extension's
 * search over a page - so it comes out of the same tokens and the same Tailwind
 * classes as the dashboard's. Plain ESM with no imports: each caller brings its
 * own Tailwind and PostCSS (the desktop app installs its own, apart from the
 * dashboard's).
 */

import { join } from "node:path";

/** The sources the panel's classes are written in, for Tailwind's `content`. */
export function searchSources(uiSrc) {
    return [
        join(uiSrc, "search", "search-panel.tsx"),
        join(uiSrc, "components", "dialog-surface.ts"),
        join(uiSrc, "components", "input.tsx")
    ].map((file) => file.replaceAll("\\", "/"));
}

const ROOT_CLASS = /:root((?:\.[\w-]+|\[[^\]]+\])+)/g;
const REM = /(-?\d*\.?\d+)rem\b/g;

/**
 * A PostCSS plugin that makes the stylesheet work inside a shadow root on
 * somebody else's page: the tokens set on `:root` go on the host instead
 * (`:root.light` becomes `:host(.light)`), what `html` and `body` set (the face,
 * the colour, the line height) goes on the element marked `data-search-root`
 * inside it - the host itself is reset with `all: initial`, so nothing the page
 * sets on it is inherited - and every `rem` becomes
 * pixels, since a rem is the page's own root size and a page is free to make it
 * anything.
 */
export function shadowRoot() {
    return {
        postcssPlugin: "polaris-shadow-root",
        Rule(rule) {
            if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
            rule.selectors = rule.selectors.map((selector) =>
                selector === "body" || selector === "html"
                    ? "[data-search-root]"
                    : selector.replace(ROOT_CLASS, ":host($1)").replaceAll(":root", ":host")
            );
        },
        Declaration(declaration) {
            if (declaration.value.includes("rem")) {
                declaration.value = declaration.value.replace(REM, (_, number) => `${Number(number) * 16}px`);
            }
        }
    };
}
shadowRoot.postcss = true;
