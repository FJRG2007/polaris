/**
 * Build each game's page into `.assets/<game>`, for the bundler to ship with the
 * app (`polaris.assets` in package.json) and the dashboard to serve from
 * `/api/app-bundles/arcade/<version>/assets/<game>/`.
 *
 * A page is its `index.html` plus files named by the hash of what is in them
 * (`<name>-<16 hex>.<ext>`), so they can be cached for good and an update never
 * mixes an old file with a new page:
 *
 *   - the game's code, one minified ES module with three.js inside it (the
 *     version pinned in package.json - the build stops on any other),
 *   - its stylesheet, with the dashboard's own IBM Plex Sans in place of web fonts,
 *   - the city data, gzip-compressed (the page decompresses it itself, so it
 *     arrives small whatever sits in front of the dashboard).
 *
 * Nothing on the page may reach another server: the build fails on any http(s)
 * address in what it writes, except the XML namespaces SVG and the DOM name,
 * which are identifiers that are never fetched.
 *
 * Run by the bundler (`polaris.prepare`), or by hand: `node scripts/build-games.mjs`.
 */

import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build, transform } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const staged = join(app, ".assets");
const fonts = join(app, "..", "web", "src", "fonts");

const THREE = JSON.parse(readFileSync(join(app, "package.json"), "utf8")).dependencies.three;
const NAMESPACES = new Set([
    "http://www.w3.org/2000/svg",
    "http://www.w3.org/1999/xhtml",
    "http://www.w3.org/1999/xlink"
]);
const FACES = [
    ["IBMPlexSans-Regular.woff2", 400],
    ["IBMPlexSans-Medium.woff2", 500],
    ["IBMPlexSans-SemiBold.woff2", 600],
    ["IBMPlexSans-Bold.woff2", 700]
];

/** `name-<16 hex>.ext`, from the bytes the file holds. */
function hashed(name, ext, bytes) {
    return `${name}-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ext}`;
}

/** Every three.js file in the bundle came from the pinned version, and only from it. */
function checkThree(inputs) {
    const roots = new Set(
        Object.keys(inputs)
            .map((file) => file.match(/^(.*node_modules\/three)\//)?.[1])
            .filter(Boolean)
    );
    if (roots.size !== 1) throw new Error(`three.js bundled from ${roots.size} places`);
    const [root] = roots;
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (version !== THREE) throw new Error(`three ${version} bundled, ${THREE} pinned (${root})`);
}

function checkOffline(file, text) {
    const urls = [...text.matchAll(/https?:\/\/[^\s"'`)<>\\]*/g)].map((match) => match[0]);
    const foreign = urls.filter((url) => !NAMESPACES.has(url));
    if (foreign.length > 0) {
        throw new Error(`${file} names another server: ${[...new Set(foreign)].join(", ")}`);
    }
}

/**
 * three.js carries a few addresses in its text - an issue linked from an error
 * message, the page a shader was adapted from - that nothing fetches. They are
 * dropped from its files as they are bundled. The game's own files are not
 * rewritten: an address in them fails the build in `checkOffline`.
 */
const dropThreeLinks = {
    name: "drop-three-links",
    setup(build) {
        build.onLoad({ filter: /[\\/]node_modules[\\/]three[\\/].*\.js$/ }, (args) => ({
            contents: readFileSync(args.path, "utf8").replace(
                /https?:\/\/(?!www\.w3\.org\/)[^\s"'`)<>\\]+/g,
                ""
            ),
            loader: "js"
        }));
    }
};

async function buildNewYork() {
    const source = join(app, "game", "new-york");
    const target = join(staged, "new-york");
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    const files = new Map();
    const write = (name, bytes) => {
        files.set(name, bytes);
        writeFileSync(join(target, name), bytes);
    };

    const entry = join(source, "engine", "main.js");
    const bundled = await build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        target: "es2022",
        minify: true,
        legalComments: "eof",
        charset: "utf8",
        write: false,
        metafile: true,
        plugins: [dropThreeLinks],
        logLevel: "silent"
    });
    checkThree(bundled.metafile.inputs);
    const game = hashed("game", "js", bundled.outputFiles[0].contents);
    write(game, bundled.outputFiles[0].contents);

    let faces = "";
    for (const [file, weight] of FACES) {
        const bytes = readFileSync(join(fonts, file));
        const name = hashed(file.replace(/\.woff2$/, "").toLowerCase(), "woff2", bytes);
        write(name, bytes);
        faces += `@font-face{font-family:"IBM Plex Sans";font-style:normal;font-weight:${weight};font-display:swap;src:url("./${name}") format("woff2")}`;
    }
    const css = await transform(faces + readFileSync(join(source, "style.css"), "utf8"), {
        loader: "css",
        minify: true,
        legalComments: "none"
    });
    const style = hashed("style", "css", css.code);
    write(style, css.code);

    const geoBytes = gzipSync(readFileSync(join(source, "data", "geo.bin")), { level: 9 });
    const geo = hashed("geo", "bin", geoBytes);
    write(geo, geoBytes);

    const template = readFileSync(join(source, "index.html"), "utf8");
    for (const placeholder of ["GAME_FILE", "STYLE_FILE", "GEO_FILE"]) {
        if (!template.includes(`./${placeholder}"`))
            throw new Error(`index.html lost ${placeholder}`);
    }
    const page = template
        .replace('./GAME_FILE"', `./${game}"`)
        .replace('./STYLE_FILE"', `./${style}"`)
        .replace('./GEO_FILE"', `./${geo}" data-bytes="${geoBytes.length}"`);
    write("index.html", page);

    for (const [name, bytes] of files) {
        if (/\.(js|css|html)$/.test(name)) checkOffline(name, Buffer.from(bytes).toString("utf8"));
    }
    return [...files].map(([name, bytes]) => `${name} ${bytes.length}`);
}

const built = await buildNewYork();
console.log(`Built new-york in ${join(staged, "new-york")}:\n  ${built.join("\n  ")}`);
