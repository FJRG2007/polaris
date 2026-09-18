/**
 * The items a mod adds, read out of the mod's own jar.
 *
 * The picker is a grid of pictures over the 1396 items vanilla ships, and on a
 * modded server that is a list missing everything the operator installed the mods
 * for: SecurityCraft's keycards, Rechiseled's blocks, Comforts' sleeping bags.
 * They could always be typed as ids, which assumed somebody knew that a keycard
 * is `securitycraft:keycard_lv1`, and the slot drew a grey box either way.
 *
 * What the mod ships for its own client is the answer, and it is exact rather
 * than derived:
 *
 * - `assets/<mod>/items/<path>.json` is the item definition the game loads, so
 *   its filename is the registry path: `<mod>:<path>` is an id `/give` accepts.
 *   Mods built before that directory existed (1.21.4) are read from their item
 *   models instead, and from the block models the translations name as blocks.
 * - `assets/<mod>/lang/en_us.json` holds `item.<mod>.<path>` and
 *   `block.<mod>.<path>`, which is the label the game itself shows. Far better
 *   than title-casing the id: `keycard_lv1` is "Level 1 Keycard", which no
 *   amount of capitalising the id produces.
 * - The item definition names a model, the model names a texture, and the texture
 *   is a PNG in the same jar. That chain is followed here rather than guessed at,
 *   because guessing gets a fifth of them: 149 of SecurityCraft's 692 items
 *   have a texture of their own, and 539 of the rest are reinforced versions of
 *   vanilla blocks whose model points straight at a vanilla texture.
 *
 * A texture the jar does not contain is a vanilla one, and Polaris already ships
 * every vanilla picture. So those are recorded as the vanilla texture they name
 * and resolved against the icon set on the other side - which is how a reinforced
 * stone block ends up drawn as stone rather than as a grey box.
 *
 * Reading the running server would be the other way round, and it is the wrong
 * one: `/neoforge dump registry minecraft:item` is authoritative, NeoForge-only,
 * and answers nothing while the server is stopped. A picker that works only on a
 * running server is not the feature.
 *
 * Pure, and over an interface rather than over a zip library, so the whole of it
 * can be asserted against a jar assembled in a test.
 */

import {
    MAX_TEXTURE_SIDE,
    isIconName,
    itemLabel,
    normalizeItemId,
    type ModItem,
    type ModItemIcon
} from "./items";

/** A jar, as much of one as this needs. */
export interface JarFiles {
    /** Every entry in it, folders included. */
    readonly paths: readonly string[];
    /** One entry's bytes, or null when the jar has no such entry. */
    read(path: string): Promise<Uint8Array | null>;
}

/** An item and its picture, as `items` spells both out - one shape between the
 *  jar it is read from, the cache it is kept in, and the panel it is drawn on. */
export type { ModItem, ModItemIcon };

export interface JarItems {
    readonly items: readonly ModItem[];
    /** The pictures the items point at, by the name they point at them with. One
     *  entry per distinct texture: Rechiseled's 3739 items share 660 pictures. */
    readonly icons: ReadonlyMap<string, Uint8Array>;
}

/** What one jar may cost, so a mod nobody here has seen cannot fill a disk or
 *  hold a request open. Generous against what real mods weigh - the largest on
 *  the server this was built for reads 3739 items and 471 KiB of pictures. */
const MAX_ITEMS = 8000;
const MAX_ICONS = 2000;
/** A 16x16 texture is under a kilobyte. Anything past this is a texture atlas or
 *  a mistake, and neither belongs in an inventory slot. */
const MAX_ICON_BYTES = 128 * 1024;

/** How far a model's `parent` chain is followed. Vanilla's own chains are three
 *  deep; past this is a loop somebody wrote by accident. */
const MAX_PARENTS = 6;

/** The faces worth drawing, in the order a slot should prefer them. `layer0` is
 *  every flat item; the rest are the block faces, front first, because a keypad
 *  is recognised by its keypad side and not by the iron block it is made of. */
const FACES: readonly string[] = [
    "layer0",
    "all",
    "texture",
    "front",
    "side",
    "top",
    "end",
    "particle",
    "0",
    "1"
];

/** A resource location, split into the namespace it names and the path in it. An
 *  unqualified one belongs to the game, which is what the game does with it. */
export function splitLocation(id: string): { namespace: string; path: string } {
    const colon = id.indexOf(":");
    return colon === -1
        ? { namespace: "minecraft", path: id }
        : { namespace: id.slice(0, colon), path: id.slice(colon + 1) };
}

/** Whether a resource location is one that can be turned into a path inside a
 *  jar. Checked before every read, because these come out of somebody else's
 *  file and are about to name a file here. */
const LOCATION = /^[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,160}$/;

function locationPath(id: string, folder: string, extension: string): string | null {
    const qualified = id.includes(":") ? id : `minecraft:${id}`;
    if (!LOCATION.test(qualified) || qualified.includes("..")) return null;
    const { namespace, path } = splitLocation(qualified);
    return `assets/${namespace}/${folder}/${path}.${extension}`;
}

/**
 * The model an item definition points at.
 *
 * An item definition is a small tree rather than one field: a block mine is a
 * `minecraft:composite` of the ore's model and an overlay, a suspicious block is
 * a `minecraft:select` over its dig stages. Every one of those still names models,
 * so the first one in the tree is taken - which for a composite is the thing
 * itself rather than the overlay drawn on top of it.
 */
export function firstModelId(node: unknown, depth = 0): string | null {
    if (depth > 8 || node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = firstModelId(child, depth + 1);
            if (found !== null) return found;
        }
        return null;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.model === "string") return record.model;
    for (const value of Object.values(record)) {
        const found = firstModelId(value, depth + 1);
        if (found !== null) return found;
    }
    return null;
}

/** The texture a set of model faces is best drawn as, or null when they are all
 *  references to faces that were never given a texture. */
export function pickTexture(textures: Record<string, unknown>): string | null {
    const named = (value: unknown): value is string =>
        typeof value === "string" && value.length > 0 && !value.startsWith("#");
    for (const face of FACES) if (named(textures[face])) return textures[face];
    return Object.values(textures).find(named) ?? null;
}

/**
 * The size of a PNG, from its header, without decoding it.
 *
 * The panel needs it because a mod texture is not always a square: Rechiseled
 * ships 80x16 strips and SecurityCraft's animated ones are 16x32. Drawn whole in
 * a slot those are a smear, so the panel is told the real size and shows the
 * first square of it.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
    const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 24 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width === 0 || height === 0 || width > MAX_TEXTURE_SIDE || height > MAX_TEXTURE_SIDE) {
        return null;
    }
    return { width, height };
}

/**
 * What a picture is filed under.
 *
 * The texture's own location with the separators flattened, so it is one path
 * segment and stays recognisable in a cache folder somebody opens. Null for
 * anything that would not be a plain filename - these names end up in a URL and
 * then in a path, and the route that serves them checks the same shape again.
 */
export function iconNameFor(texture: string): string | null {
    const qualified = texture.includes(":") ? texture : `minecraft:${texture}`;
    if (!LOCATION.test(qualified) || qualified.includes("..")) return null;
    const { namespace, path } = splitLocation(qualified);
    const name = `${namespace}.${path.replace(/\//g, ".")}`;
    return isIconName(name) ? name : null;
}

/** A label as it is worth putting on a tile: one line, bounded, and never empty.
 *  It is somebody else's file, so it is trimmed to a sentence rather than trusted
 *  to be one. */
function readableLabel(raw: unknown, path: string): string {
    if (typeof raw !== "string") return itemLabel(path);
    const text = raw
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
    return text.length > 0 ? text : itemLabel(path);
}

/**
 * Everything one jar adds.
 *
 * A jar that adds no items - a data pack, a library, a mod that only changes how
 * the game behaves - reads as no items rather than as a failure. Three of the six
 * mods on the server this was built for are exactly that.
 */
export async function readJarItems(jar: JarFiles): Promise<JarItems> {
    const paths = new Set(jar.paths);
    const texts = new Map<string, unknown>();

    const json = async (path: string): Promise<unknown> => {
        if (texts.has(path)) return texts.get(path);
        let parsed: unknown = null;
        if (paths.has(path)) {
            const bytes = await jar.read(path);
            try {
                parsed = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
            } catch {
                // A malformed asset is one item without a picture, not a jar that
                // cannot be read.
                parsed = null;
            }
        }
        texts.set(path, parsed);
        return parsed;
    };

    /** A model's faces, its parents' faces underneath its own. */
    const facesOf = async (modelId: string, depth = 0): Promise<Record<string, unknown>> => {
        if (depth > MAX_PARENTS) return {};
        const path = locationPath(modelId, "models", "json");
        const model = path ? await json(path) : null;
        if (model === null || typeof model !== "object") return {};
        const record = model as Record<string, unknown>;
        const inherited =
            typeof record.parent === "string" ? await facesOf(record.parent, depth + 1) : {};
        const own =
            record.textures !== null && typeof record.textures === "object"
                ? (record.textures as Record<string, unknown>)
                : {};
        return { ...inherited, ...own };
    };

    const items: ModItem[] = [];
    const icons = new Map<string, Uint8Array>();

    for (const namespace of namespacesIn(paths)) {
        const lang = await json(`assets/${namespace}/lang/en_us.json`);
        const words =
            lang !== null && typeof lang === "object" ? (lang as Record<string, unknown>) : {};

        for (const path of itemPathsIn(paths, namespace, words)) {
            if (items.length >= MAX_ITEMS) break;
            const id = normalizeItemId(`${namespace}:${path}`);
            if (id === null) continue;
            // The translation key writes a path's separators as dots, which is
            // only ever visible on the handful of mods that nest their items.
            const key = path.replace(/\//g, ".");
            const label = readableLabel(
                words[`item.${namespace}.${key}`] ?? words[`block.${namespace}.${key}`],
                path
            );
            items.push({
                id,
                label,
                icon: await iconFor(namespace, path, { json, facesOf, paths, jar, icons })
            });
        }
    }

    return { items, icons };
}

/** The picture for one item, kept in `icons` when it is one the jar carries. */
async function iconFor(
    namespace: string,
    path: string,
    context: {
        json: (path: string) => Promise<unknown>;
        facesOf: (modelId: string) => Promise<Record<string, unknown>>;
        paths: ReadonlySet<string>;
        jar: JarFiles;
        icons: Map<string, Uint8Array>;
    }
): Promise<ModItemIcon | null> {
    const { json, facesOf, paths, jar, icons } = context;
    const definition = await json(`assets/${namespace}/items/${path}.json`);
    // The item definition first, then the models an older mod is read by: a block
    // is drawn by its block model, and only flat items have one under `item/`.
    const modelId =
        (definition === null ? null : firstModelId(definition)) ??
        (paths.has(`assets/${namespace}/models/item/${path}.json`)
            ? `${namespace}:item/${path}`
            : paths.has(`assets/${namespace}/models/block/${path}.json`)
              ? `${namespace}:block/${path}`
              : null);
    if (modelId === null) return null;

    const texture = pickTexture(await facesOf(modelId));
    if (texture !== null) {
        const file = locationPath(texture, "textures", "png");
        if (file !== null && paths.has(file)) {
            const name = iconNameFor(texture);
            const kept = name === null ? null : await keep(name, file, jar, icons);
            if (name !== null && kept !== null) {
                return { kind: "mod", name, width: kept.width, height: kept.height };
            }
        }
        // A texture the jar does not carry is a vanilla one, which Polaris
        // already ships a picture of.
        const { namespace: other, path: texturePath } = splitLocation(texture);
        if (other === "minecraft") return { kind: "vanilla", texture: texturePath };
        return null;
    }

    // No textures at all means the model itself is vanilla and was never in this
    // jar to read - every block mine is `minecraft:block/<the ore>`.
    const model = splitLocation(modelId);
    return model.namespace === "minecraft" ? { kind: "vanilla", texture: model.path } : null;
}

/** Keep one picture, once, and report its size. Null for anything that is not a
 *  PNG a slot can draw. */
async function keep(
    name: string,
    file: string,
    jar: JarFiles,
    icons: Map<string, Uint8Array>
): Promise<{ width: number; height: number } | null> {
    const held = icons.get(name);
    if (held) return pngSize(held);
    if (icons.size >= MAX_ICONS) return null;
    const bytes = await jar.read(file);
    if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) return null;
    const size = pngSize(bytes);
    if (size === null) return null;
    icons.set(name, bytes);
    return size;
}

/** The mods a jar carries assets for. Its own, not the game's: a mod that adds a
 *  texture under `assets/minecraft` is replacing one of the game's rather than
 *  adding an item. */
function namespacesIn(paths: ReadonlySet<string>): string[] {
    const found = new Set<string>();
    for (const path of paths) {
        const parts = path.split("/");
        if (parts[0] !== "assets" || parts.length < 3) continue;
        const namespace = parts[1] ?? "";
        if (namespace.length > 0 && namespace !== "minecraft") found.add(namespace);
    }
    return [...found].sort();
}

/**
 * The registry paths one mod's assets name.
 *
 * The item definitions when the jar has them, because a filename in that folder
 * is a registered item and nothing else is. Only when it has none - a mod built
 * before 1.21.4 - are the models read instead: every item model, and every block
 * model the translations carry a `block.` label for. The translations only ever
 * confirm a path a model file already named, so a key like
 * `item.<mod>.<path>.tooltip` is never taken for an item.
 */
function itemPathsIn(
    paths: ReadonlySet<string>,
    namespace: string,
    words: Record<string, unknown>
): string[] {
    const namesIn = (folder: string): string[] => {
        const root = `assets/${namespace}/${folder}/`;
        return [...paths]
            .filter((path) => path.startsWith(root) && path.endsWith(".json"))
            .map((path) => path.slice(root.length, -".json".length));
    };
    const defined = namesIn("items").sort();
    if (defined.length > 0) return defined;

    const named = new Set(namesIn("models/item"));
    for (const path of namesIn("models/block")) {
        if (words[`block.${namespace}.${path.replace(/\//g, ".")}`] !== undefined) named.add(path);
    }
    return [...named].filter((path) => !path.includes(".")).sort();
}
