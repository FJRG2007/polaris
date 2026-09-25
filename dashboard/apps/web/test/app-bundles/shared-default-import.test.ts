/**
 * A default import in an app's browser half gets the page's real export.
 *
 * The bundle reads every shared module through `require`, so what decides a
 * default import is esbuild's own interop over the object the dashboard hands
 * back. Handed an ES namespace with no `__esModule` mark, it took the whole
 * namespace as the default: `import Image from "next/image"` became
 * `{ default, getImageProps }`, and React refused it with error 130 on every
 * game server's Appearance panel.
 *
 * Proved against esbuild's actual interop rather than a copy of it: each case
 * is bundled the way the app bundler bundles a shared import, and run.
 */

import { build } from "esbuild";
import { createElement, forwardRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { asCommonJs } from "@/components/app-bundles/runtime";

const SLOT = Symbol.for("polaris.test-shared");
/** Each bundle is imported from its own address: the same source twice is one
 *  module to the loader, evaluated once. */
let run = 0;

/** What a bundle's `import thing from "shared"` evaluates to, given what the
 *  dashboard hands it for "shared". `node` is an importer esbuild reads the way
 *  Node does - an app's own source, which is an ES module package - where the
 *  interop is `__toESM(mod, 1)` and the `__esModule` mark is not consulted. */
async function defaultImportOf(
    provided: object,
    node = false,
    contents = 'import thing from "shared"; export default thing;'
): Promise<unknown> {
    const out = await build({
        stdin: {
            contents,
            loader: "js",
            ...(node ? { sourcefile: "screen.mjs" } : {})
        },
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        plugins: [
            {
                name: "shared",
                setup(plugin) {
                    plugin.onResolve({ filter: /^shared$/ }, (args) => ({
                        path: args.path,
                        namespace: "shared"
                    }));
                    plugin.onLoad({ filter: /.*/, namespace: "shared" }, () => ({
                        contents: `module.exports = globalThis[Symbol.for("polaris.test-shared")];`,
                        loader: "js"
                    }));
                }
            }
        ]
    });
    (globalThis as Record<symbol, unknown>)[SLOT] = provided;
    run += 1;
    const source = `${out.outputFiles[0]!.text}\n// ${run}`;
    const module = (await import(`data:text/javascript,${encodeURIComponent(source)}`)) as {
        default: unknown;
    };
    return module.default;
}

/** An ES module namespace, the shape the page's bundler hands over for an ES
 *  module such as Next's browser build of `next/image`. */
function namespace(members: Record<string, unknown>): object {
    return Object.freeze(
        Object.assign(Object.create(null), members, { [Symbol.toStringTag]: "Module" })
    );
}

function Image() {
    return null;
}
function getImageProps() {
    return {};
}

describe("a default import from the dashboard", () => {
    it("is the component, when the module is an ES namespace", async () => {
        // What used to happen: the namespace itself, which React cannot draw.
        expect(await defaultImportOf(namespace({ default: Image, getImageProps }))).not.toBe(Image);

        expect(
            await defaultImportOf(asCommonJs(namespace({ default: Image, getImageProps })))
        ).toBe(Image);
    });

    it("is the component, when a CommonJS module was read as a namespace", async () => {
        const exports = { __esModule: true, default: Image, getImageProps };
        expect(await defaultImportOf(asCommonJs({ default: exports, getImageProps }))).toBe(Image);
    });

    it("is the function, when the module is one with its exports on it", async () => {
        // How Next ships `next/link`: the component, carrying its own exports.
        function Link() {
            return null;
        }
        Object.defineProperty(Link, "__esModule", { value: true });
        Object.assign(Link, { default: Link });
        expect(await defaultImportOf(asCommonJs(Link))).toBe(Link);
    });

    it("is the module, when it has no default of its own", async () => {
        const ui = namespace({ Button: Image });
        const found = (await defaultImportOf(asCommonJs(ui))) as { Button: unknown };
        expect(found.Button).toBe(Image);
    });

    it("is drawable when the app reads it the way Node does", async () => {
        // `next/link` as the page hands it over, read from an app's screen.
        function Link(props: { href: string; children?: string }) {
            return createElement("a", { href: props.href }, props.children);
        }
        function useLinkStatus() {
            return { pending: false };
        }
        const provided = asCommonJs(namespace({ default: Link, useLinkStatus }));

        // What used to happen: the module itself, which React cannot draw.
        expect(await defaultImportOf(namespace({ default: Link, useLinkStatus }), true)).not.toBe(
            Link
        );

        const imported = await defaultImportOf(provided, true);
        expect(typeof imported).toBe("function");
        expect(
            renderToStaticMarkup(createElement(imported as typeof Link, { href: "/x" }, "go"))
        ).toBe('<a href="/x">go</a>');
        // And read the other way, it is the component itself.
        expect(await defaultImportOf(provided)).toBe(Link);
    });

    it("keeps a named import beside it when read the way Node does", async () => {
        function Link() {
            return null;
        }
        function useLinkStatus() {
            return { pending: false };
        }
        const named = await defaultImportOf(
            asCommonJs(namespace({ default: Link, useLinkStatus })),
            true,
            'import { useLinkStatus } from "shared"; export default useLinkStatus;'
        );
        expect(named).toBe(useLinkStatus);
    });

    it("draws a forwardRef default read the way Node does", async () => {
        const Picture = forwardRef<HTMLImageElement, { alt: string }>((props, ref) =>
            createElement("img", { alt: props.alt, ref })
        );
        const imported = await defaultImportOf(asCommonJs(namespace({ default: Picture })), true);
        expect(renderToStaticMarkup(createElement(imported as typeof Picture, { alt: "a" }))).toBe(
            '<img alt="a"/>'
        );
    });

    it("keeps every named export", () => {
        const shaped = asCommonJs(namespace({ default: Image, getImageProps })) as Record<
            string,
            unknown
        >;
        expect(shaped.getImageProps).toBe(getImageProps);
        expect(shaped.__esModule).toBe(true);
    });
});
