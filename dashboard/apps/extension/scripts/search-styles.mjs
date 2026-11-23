/**
 * `virtual:search-styles`: the stylesheet the on-page launcher (`launcher-ui`)
 * puts in its shadow root - the dashboard's design tokens and the Tailwind
 * classes of its search panel, built with the UI package's preset, so the panel
 * looks exactly as the dashboard's command palette does. Made for the shadow
 * root (`shadowRoot`): the tokens sit on the host and no size follows the page's
 * own root font size.
 */

import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import preset from "../../../packages/ui/src/tailwind-preset";
import { searchSources, shadowRoot } from "../../../packages/ui/src/search/search-styles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, "..", "..", "..", "packages", "ui", "src");
const ID = "virtual:search-styles";

async function stylesheet() {
    const tokens = readFileSync(join(UI, "styles", "tokens.css"), "utf8");
    const config = {
        presets: [preset],
        future: { hoverOnlyWhenSupported: true },
        content: [...searchSources(UI), join(HERE, "..", "src", "entrypoints", "launcher-ui.tsx").replaceAll("\\", "/")]
    };
    const source = `${tokens}\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`;
    const result = await postcss([tailwindcss(config), shadowRoot()]).process(source, { from: undefined });
    return result.css;
}

/** The Vite plugin serving it as a string module. */
export function searchStyles() {
    return {
        name: "polaris-search-styles",
        resolveId: (id) => (id === ID ? `\0${ID}` : null),
        load: async (id) => (id === `\0${ID}` ? `export default ${JSON.stringify(await stylesheet())};` : null)
    };
}
