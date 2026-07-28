/**
 * PowerPoint (.pptx) parsing. The OOXML package is unzipped in the browser and
 * reduced to a flat, render-ready deck: one absolutely positioned box per shape
 * carrying the text, picture or table it holds. Only what a preview needs is
 * read - geometry, fills, runs, pictures and tables - and placeholders inherit
 * their position from the slide layout and master the way PowerPoint resolves
 * them, so titles and body text land where the author put them. Animations,
 * charts and SmartArt are dropped rather than approximated.
 */

import JSZip from "jszip";

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/** EMU per CSS pixel at 96dpi, and the point -> pixel factor for run sizes. */
const EMU_PER_PX = 9525;
const PX_PER_PT = 96 / 72;

/** Fallback run size (in points) when neither the run nor the master defines one. */
const DEFAULT_SIZE_PT = 18;

/** Default text insets of a shape body, in EMU (ECMA-376 defaults). */
const DEFAULT_INSETS = { top: 45720, right: 91440, bottom: 45720, left: 91440 };

/** Theme color slots addressed by a different name when a shape references them. */
const SCHEME_ALIAS: Record<string, string> = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };

/** Placeholder types that behave like another type for inheritance purposes. */
const PLACEHOLDER_ALIAS: Record<string, string> = { ctrTitle: "title", subTitle: "body" };

const IMAGE_TYPES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    tiff: "image/tiff",
    svg: "image/svg+xml"
};

export interface PptxRun {
    text: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    /** Rendered size in pixels at the deck's natural scale. */
    size: number;
    color?: string;
    font?: string;
}

export interface PptxParagraph {
    runs: PptxRun[];
    align?: "left" | "center" | "right" | "justify";
    /** Indent depth (0-8) and the bullet glyph to render, when the paragraph has one. */
    level: number;
    bullet?: string;
}

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Clockwise rotation in degrees. */
    rotation: number;
}

export interface PptxTextShape extends Box {
    kind: "text";
    paragraphs: PptxParagraph[];
    fill?: string;
    border?: string;
    anchor: "start" | "center" | "end";
    padding: { top: number; right: number; bottom: number; left: number };
}

export interface PptxImageShape extends Box {
    kind: "image";
    src: string;
    alt: string;
}

export interface PptxTableCell {
    paragraphs: PptxParagraph[];
    fill?: string;
    colSpan: number;
    rowSpan: number;
}

export interface PptxTableShape extends Box {
    kind: "table";
    /** Column widths in pixels. */
    columns: number[];
    rows: { height: number; cells: PptxTableCell[] }[];
}

export type PptxShape = PptxTextShape | PptxImageShape | PptxTableShape;

export interface PptxSlide {
    background?: string;
    shapes: PptxShape[];
}

export interface PptxDeck {
    /** Natural slide size in pixels; the viewer scales the whole slide to fit. */
    width: number;
    height: number;
    slides: PptxSlide[];
    /** Frees the object URLs backing the deck's pictures. */
    release: () => void;
}

/** Text defaults a placeholder inherits from its master's text styles. */
interface TextDefaults {
    size: number;
    color?: string;
    bold: boolean;
    align?: PptxParagraph["align"];
}

/** A placeholder's inherited geometry, keyed by index and by type. */
interface PlaceholderMap {
    byIndex: Map<string, Box>;
    byType: Map<string, Box>;
}

/** Group transform used to map a grouped shape's own coordinates onto the slide. */
interface GroupFrame {
    box: Box;
    childOffset: { x: number; y: number };
    childExtent: { width: number; height: number };
}

type Theme = Map<string, string>;

/** First direct child element with the given namespace and local name. */
function child(parent: Element | undefined, ns: string, name: string): Element | undefined {
    if (!parent) return undefined;
    for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
        if (node.namespaceURI === ns && node.localName === name) return node;
    }
    return undefined;
}

/** Every direct child element with the given namespace and local name. */
function childList(parent: Element | undefined, ns: string, name: string): Element[] {
    if (!parent) return [];
    const found: Element[] = [];
    for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
        if (node.namespaceURI === ns && node.localName === name) found.push(node);
    }
    return found;
}

/** Walk a chain of direct children, e.g. path(sp, NS_A, "xfrm", "off"). */
function path(parent: Element | undefined, ns: string, ...names: string[]): Element | undefined {
    let current = parent;
    for (const name of names) current = child(current, ns, name);
    return current;
}

/** Attribute as a number, or `fallback` when absent or unparseable. */
function attrNumber(element: Element | undefined, name: string, fallback: number): number {
    const raw = element?.getAttribute(name);
    if (raw === null || raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

/** OOXML booleans are "1"/"true"/"0"/"false"; absent means "inherit", i.e. false here. */
function attrFlag(element: Element | undefined, name: string): boolean {
    const raw = element?.getAttribute(name);
    return raw === "1" || raw === "true";
}

function emuToPx(value: number): number {
    return value / EMU_PER_PX;
}

/** Parse a package part as XML, or undefined when it is missing or malformed. */
async function xmlOf(zip: JSZip, part: string): Promise<Element | undefined> {
    const entry = zip.file(part);
    if (!entry) return undefined;
    const document = new DOMParser().parseFromString(await entry.async("string"), "application/xml");
    if (document.getElementsByTagName("parsererror").length > 0) return undefined;
    return document.documentElement;
}

/** Resolve a relationship target ("../media/x.png") against its part's folder. */
function resolveTarget(folder: string, target: string): string {
    if (target.startsWith("/")) return target.slice(1);
    const segments = folder ? folder.split("/") : [];
    for (const segment of target.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") segments.pop();
        else segments.push(segment);
    }
    return segments.join("/");
}

/** Relationship id -> package-absolute target for one part. */
async function relsOf(zip: JSZip, part: string): Promise<Map<string, string>> {
    const slash = part.lastIndexOf("/");
    const folder = slash < 0 ? "" : part.slice(0, slash);
    const root = await xmlOf(zip, `${folder}/_rels/${part.slice(slash + 1)}.rels`);
    const map = new Map<string, string>();
    for (const rel of childList(root, NS_REL, "Relationship")) {
        const id = rel.getAttribute("Id");
        const target = rel.getAttribute("Target");
        if (!id || !target || rel.getAttribute("TargetMode") === "External") continue;
        map.set(id, resolveTarget(folder, target));
    }
    return map;
}

/** First related part whose path sits in the given package folder. */
function relatedPart(rels: Map<string, string>, folder: string): string | undefined {
    for (const target of rels.values()) {
        if (target.includes(`${folder}/`)) return target;
    }
    return undefined;
}

/** The master's color scheme, flattened to slot -> hex digits. */
async function themeOf(zip: JSZip, masterPart: string | undefined): Promise<Theme> {
    const theme: Theme = new Map();
    if (!masterPart) return theme;
    const themePart = relatedPart(await relsOf(zip, masterPart), "theme");
    const scheme = path(themePart ? await xmlOf(zip, themePart) : undefined, NS_A, "themeElements", "clrScheme");
    for (let node = scheme?.firstElementChild; node; node = node.nextElementSibling) {
        const value =
            child(node, NS_A, "srgbClr")?.getAttribute("val") ??
            child(node, NS_A, "sysClr")?.getAttribute("lastClr");
        if (value) theme.set(node.localName, value);
    }
    return theme;
}

/** Resolve a color container (srgbClr/sysClr/schemeClr) to a CSS color. */
function colorValue(container: Element | undefined, theme: Theme): string | undefined {
    if (!container) return undefined;
    const srgb = child(container, NS_A, "srgbClr")?.getAttribute("val");
    if (srgb) return `#${srgb}`;
    const system = child(container, NS_A, "sysClr")?.getAttribute("lastClr");
    if (system) return `#${system}`;
    const scheme = child(container, NS_A, "schemeClr")?.getAttribute("val");
    const slot = scheme ? theme.get(SCHEME_ALIAS[scheme] ?? scheme) : undefined;
    return slot ? `#${slot}` : undefined;
}

/** Solid fill of a properties element, ignoring gradients and patterns. */
function solidFill(holder: Element | undefined, theme: Theme): string | undefined {
    return colorValue(child(holder, NS_A, "solidFill"), theme);
}

/** Outline of a shape as a CSS border, when it has a solid one. */
function borderOf(spPr: Element | undefined, theme: Theme): string | undefined {
    const line = child(spPr, NS_A, "ln");
    if (!line || child(line, NS_A, "noFill")) return undefined;
    const color = solidFill(line, theme);
    if (!color) return undefined;
    const width = Math.max(emuToPx(attrNumber(line, "w", 9525)), 1);
    return `${width}px solid ${color}`;
}

/** Geometry of a shape, or undefined when it inherits it from a placeholder. */
function boxOf(spPr: Element | undefined): Box | undefined {
    const xfrm = child(spPr, NS_A, "xfrm");
    const offset = child(xfrm, NS_A, "off");
    const extent = child(xfrm, NS_A, "ext");
    if (!offset || !extent) return undefined;
    return {
        x: emuToPx(attrNumber(offset, "x", 0)),
        y: emuToPx(attrNumber(offset, "y", 0)),
        width: emuToPx(attrNumber(extent, "cx", 0)),
        height: emuToPx(attrNumber(extent, "cy", 0)),
        rotation: attrNumber(xfrm, "rot", 0) / 60000
    };
}

/** Map a grouped shape's box through the transform of the group that holds it. */
function throughGroup(box: Box, group: GroupFrame): Box {
    const scaleX = group.childExtent.width ? group.box.width / group.childExtent.width : 1;
    const scaleY = group.childExtent.height ? group.box.height / group.childExtent.height : 1;
    return {
        x: group.box.x + (box.x - group.childOffset.x) * scaleX,
        y: group.box.y + (box.y - group.childOffset.y) * scaleY,
        width: box.width * scaleX,
        height: box.height * scaleY,
        rotation: box.rotation + group.box.rotation
    };
}

/** The placeholder descriptor of a shape, normalized to its inheritance key. */
function placeholderOf(shape: Element): { type: string; index: string | null } | undefined {
    const ph = path(shape, NS_P, "nvSpPr", "nvPr", "ph");
    if (!ph) return undefined;
    const type = ph.getAttribute("type") ?? "body";
    return { type: PLACEHOLDER_ALIAS[type] ?? type, index: ph.getAttribute("idx") };
}

/** Index the placeholder geometry a layout or master offers to the slides using it. */
function placeholderMap(root: Element | undefined): PlaceholderMap {
    const map: PlaceholderMap = { byIndex: new Map(), byType: new Map() };
    const tree = path(root, NS_P, "cSld", "spTree");
    for (const shape of childList(tree, NS_P, "sp")) {
        const placeholder = placeholderOf(shape);
        const box = boxOf(child(shape, NS_P, "spPr"));
        if (!placeholder || !box) continue;
        if (placeholder.index !== null && !map.byIndex.has(placeholder.index)) {
            map.byIndex.set(placeholder.index, box);
        }
        if (!map.byType.has(placeholder.type)) map.byType.set(placeholder.type, box);
    }
    return map;
}

/** Geometry a placeholder inherits, layout first and master as the fallback. */
function inheritedBox(
    placeholder: { type: string; index: string | null },
    sources: PlaceholderMap[]
): Box | undefined {
    for (const source of sources) {
        const byIndex = placeholder.index === null ? undefined : source.byIndex.get(placeholder.index);
        if (byIndex) return byIndex;
        const byType = source.byType.get(placeholder.type);
        if (byType) return byType;
    }
    return undefined;
}

/** Master text style that governs a placeholder type. */
function styleNameFor(type: string | undefined): string {
    if (type === "title") return "titleStyle";
    if (type === undefined || type === "body") return "bodyStyle";
    return "otherStyle";
}

/** Run defaults a paragraph inherits from the master's text styles at its level. */
function defaultsOf(
    master: Element | undefined,
    theme: Theme,
    type: string | undefined,
    level: number
): TextDefaults {
    const style = path(master, NS_P, "txStyles", styleNameFor(type));
    const levelProps = child(style, NS_A, `lvl${level + 1}pPr`) ?? child(style, NS_A, "lvl1pPr");
    const runProps = child(levelProps, NS_A, "defRPr");
    return {
        size: attrNumber(runProps, "sz", DEFAULT_SIZE_PT * 100) / 100,
        color: solidFill(runProps, theme),
        bold: attrFlag(runProps, "b"),
        align: alignOf(levelProps)
    };
}

function alignOf(properties: Element | undefined): PptxParagraph["align"] {
    switch (properties?.getAttribute("algn")) {
        case "ctr":
            return "center";
        case "r":
            return "right";
        case "just":
        case "dist":
            return "justify";
        case "l":
            return "left";
        default:
            return undefined;
    }
}

/** Bullet glyph for a paragraph, or undefined when it renders without one. */
function bulletOf(properties: Element | undefined, position: number): string | undefined {
    if (!properties || child(properties, NS_A, "buNone")) return undefined;
    const character = child(properties, NS_A, "buChar")?.getAttribute("char");
    if (character) return character;
    const autoNumber = child(properties, NS_A, "buAutoNum");
    if (autoNumber) return `${attrNumber(autoNumber, "startAt", 1) + position}.`;
    return undefined;
}

/** Text of a run, including the literal value a field (slide number, date) carries. */
function runText(run: Element): string {
    return childList(run, NS_A, "t")
        .map((node) => node.textContent ?? "")
        .join("");
}

/**
 * Flatten a text body into paragraphs of styled runs.
 * @param defaultsAt - Inherited run defaults for an indent level, since the
 *  master styles a level-two bullet differently from a level-one one.
 */
function paragraphsOf(
    txBody: Element | undefined,
    theme: Theme,
    defaultsAt: (level: number) => TextDefaults
): PptxParagraph[] {
    const paragraphs: PptxParagraph[] = [];
    const bulletCounters = new Map<number, number>();
    for (const node of childList(txBody, NS_A, "p")) {
        const paragraphProps = child(node, NS_A, "pPr");
        const level = attrNumber(paragraphProps, "lvl", 0);
        const defaults = defaultsAt(level);
        const position = bulletCounters.get(level) ?? 0;
        bulletCounters.set(level, position + 1);
        const paragraphDefaults = child(paragraphProps, NS_A, "defRPr");
        const runs: PptxRun[] = [];
        for (let item = node.firstElementChild; item; item = item.nextElementSibling) {
            if (item.namespaceURI !== NS_A) continue;
            if (item.localName === "br") {
                runs.push({ text: "\n", bold: false, italic: false, underline: false, size: 0 });
                continue;
            }
            if (item.localName !== "r" && item.localName !== "fld") continue;
            const text = runText(item);
            if (!text) continue;
            const runProps = child(item, NS_A, "rPr") ?? paragraphDefaults;
            runs.push({
                text,
                bold: runProps?.hasAttribute("b") ? attrFlag(runProps, "b") : defaults.bold,
                italic: attrFlag(runProps, "i"),
                underline: (runProps?.getAttribute("u") ?? "none") !== "none",
                size: (attrNumber(runProps, "sz", defaults.size * 100) / 100) * PX_PER_PT,
                color: solidFill(runProps, theme) ?? defaults.color,
                font: child(runProps, NS_A, "latin")?.getAttribute("typeface") ?? undefined
            });
        }
        if (runs.length === 0) continue;
        paragraphs.push({
            runs,
            level,
            align: alignOf(paragraphProps) ?? defaults.align,
            bullet: bulletOf(paragraphProps, position)
        });
    }
    return paragraphs;
}

/**
 * Factor PowerPoint applies to a shape's runs to make them fit its box. It bakes
 * the shrink into the stored layout, so ignoring it renders text too large and
 * spilling out of the box the author sized around it.
 */
function autofitScale(txBody: Element | undefined): number {
    const fit = child(child(txBody, NS_A, "bodyPr"), NS_A, "normAutofit");
    return fit ? attrNumber(fit, "fontScale", 100000) / 100000 : 1;
}

/** Apply an autofit factor to every run of a text body. */
function scaleRuns(paragraphs: PptxParagraph[], scale: number): PptxParagraph[] {
    if (scale === 1) return paragraphs;
    return paragraphs.map((paragraph) => ({
        ...paragraph,
        runs: paragraph.runs.map((run) => ({ ...run, size: run.size * scale }))
    }));
}

/** Vertical anchor and insets of a shape's text body. */
function bodyLayout(txBody: Element | undefined): Pick<PptxTextShape, "anchor" | "padding"> {
    const bodyPr = child(txBody, NS_A, "bodyPr");
    const anchor = bodyPr?.getAttribute("anchor");
    return {
        anchor: anchor === "ctr" ? "center" : anchor === "b" ? "end" : "start",
        padding: {
            top: emuToPx(attrNumber(bodyPr, "tIns", DEFAULT_INSETS.top)),
            right: emuToPx(attrNumber(bodyPr, "rIns", DEFAULT_INSETS.right)),
            bottom: emuToPx(attrNumber(bodyPr, "bIns", DEFAULT_INSETS.bottom)),
            left: emuToPx(attrNumber(bodyPr, "lIns", DEFAULT_INSETS.left))
        }
    };
}

/** Everything one slide needs from its layout, master and theme. */
interface SlideContext {
    zip: JSZip;
    theme: Theme;
    master: Element | undefined;
    placeholders: PlaceholderMap[];
    rels: Map<string, string>;
    /** Media part -> object URL, shared across the whole deck. */
    media: Map<string, string>;
}

/** Object URL for an embedded picture, or undefined for formats browsers cannot show. */
async function pictureUrl(context: SlideContext, relationshipId: string | null): Promise<string | undefined> {
    const part = relationshipId ? context.rels.get(relationshipId) : undefined;
    if (!part) return undefined;
    const cached = context.media.get(part);
    if (cached) return cached;
    const type = IMAGE_TYPES[part.slice(part.lastIndexOf(".") + 1).toLowerCase()];
    const entry = context.zip.file(part);
    if (!type || !entry) return undefined;
    const url = URL.createObjectURL(new Blob([await entry.async("arraybuffer")], { type }));
    context.media.set(part, url);
    return url;
}

/** Read a table out of a graphic frame. */
function tableOf(frame: Element, box: Box, theme: Theme): PptxTableShape | undefined {
    const table = path(frame, NS_A, "graphic", "graphicData", "tbl");
    if (!table) return undefined;
    const columns = childList(child(table, NS_A, "tblGrid"), NS_A, "gridCol").map((column) =>
        emuToPx(attrNumber(column, "w", 0))
    );
    const defaults = (): TextDefaults => ({ size: DEFAULT_SIZE_PT, bold: false });
    const rows = childList(table, NS_A, "tr").map((row) => ({
        height: emuToPx(attrNumber(row, "h", 0)),
        cells: childList(row, NS_A, "tc")
            .filter((cell) => !attrFlag(cell, "hMerge") && !attrFlag(cell, "vMerge"))
            .map((cell) => ({
                paragraphs: paragraphsOf(child(cell, NS_A, "txBody"), theme, defaults),
                fill: solidFill(child(cell, NS_A, "tcPr"), theme),
                colSpan: attrNumber(cell, "gridSpan", 1),
                rowSpan: attrNumber(cell, "rowSpan", 1)
            }))
    }));
    if (rows.length === 0) return undefined;
    return { kind: "table", ...box, columns, rows };
}

/**
 * Walk a shape tree into flat, positioned shapes. Groups recurse through their
 * own transform so grouped content keeps the position the author gave it.
 */
async function shapesOf(tree: Element | undefined, context: SlideContext, group?: GroupFrame): Promise<PptxShape[]> {
    if (!tree) return [];
    const shapes: PptxShape[] = [];
    const place = (box: Box | undefined): Box | undefined =>
        box && group ? throughGroup(box, group) : box;

    for (let node = tree.firstElementChild; node; node = node.nextElementSibling) {
        if (node.namespaceURI !== NS_P) continue;

        if (node.localName === "sp" || node.localName === "cxnSp") {
            const spPr = child(node, NS_P, "spPr");
            const placeholder = node.localName === "sp" ? placeholderOf(node) : undefined;
            const own = boxOf(spPr) ?? (placeholder ? inheritedBox(placeholder, context.placeholders) : undefined);
            const box = place(own);
            if (!box) continue;
            const txBody = child(node, NS_P, "txBody");
            const fill = solidFill(spPr, context.theme);
            const border = borderOf(spPr, context.theme);
            const paragraphs = scaleRuns(
                paragraphsOf(txBody, context.theme, (level) =>
                    defaultsOf(context.master, context.theme, placeholder?.type, level)
                ),
                autofitScale(txBody)
            );
            if (paragraphs.length === 0 && !fill && !border) continue;
            shapes.push({ kind: "text", ...box, ...bodyLayout(txBody), paragraphs, fill, border });
            continue;
        }

        if (node.localName === "pic") {
            const box = place(boxOf(child(node, NS_P, "spPr")));
            const blip = child(node, NS_P, "blipFill");
            const source = await pictureUrl(context, child(blip, NS_A, "blip")?.getAttributeNS(NS_R, "embed") ?? null);
            if (!box || !source) continue;
            const name = path(node, NS_P, "nvPicPr", "cNvPr")?.getAttribute("descr");
            shapes.push({ kind: "image", ...box, src: source, alt: name ?? "" });
            continue;
        }

        if (node.localName === "graphicFrame") {
            const xfrm = child(node, NS_P, "xfrm");
            const offset = child(xfrm, NS_A, "off");
            const extent = child(xfrm, NS_A, "ext");
            if (!offset || !extent) continue;
            const box = place({
                x: emuToPx(attrNumber(offset, "x", 0)),
                y: emuToPx(attrNumber(offset, "y", 0)),
                width: emuToPx(attrNumber(extent, "cx", 0)),
                height: emuToPx(attrNumber(extent, "cy", 0)),
                rotation: 0
            });
            const table = box ? tableOf(node, box, context.theme) : undefined;
            if (table) shapes.push(table);
            continue;
        }

        if (node.localName === "grpSp") {
            const xfrm = path(node, NS_P, "grpSpPr", "xfrm");
            const offset = child(xfrm, NS_A, "off");
            const extent = child(xfrm, NS_A, "ext");
            const childOffset = child(xfrm, NS_A, "chOff");
            const childExtent = child(xfrm, NS_A, "chExt");
            if (!offset || !extent) continue;
            const own: Box = {
                x: emuToPx(attrNumber(offset, "x", 0)),
                y: emuToPx(attrNumber(offset, "y", 0)),
                width: emuToPx(attrNumber(extent, "cx", 0)),
                height: emuToPx(attrNumber(extent, "cy", 0)),
                rotation: attrNumber(xfrm, "rot", 0) / 60000
            };
            const frame: GroupFrame = {
                box: place(own) ?? own,
                childOffset: {
                    x: emuToPx(attrNumber(childOffset, "x", 0)),
                    y: emuToPx(attrNumber(childOffset, "y", 0))
                },
                childExtent: {
                    width: emuToPx(attrNumber(childExtent, "cx", 0)) || own.width,
                    height: emuToPx(attrNumber(childExtent, "cy", 0)) || own.height
                }
            };
            shapes.push(...(await shapesOf(node, context, frame)));
        }
    }
    return shapes;
}

/** Solid slide background, taken from the slide, then its layout, then the master. */
function backgroundOf(roots: (Element | undefined)[], theme: Theme): string | undefined {
    for (const root of roots) {
        const background = path(root, NS_P, "cSld", "bg");
        const fill = solidFill(child(background, NS_P, "bgPr"), theme);
        if (fill) return fill;
    }
    return undefined;
}

/**
 * Parse a .pptx package into a render-ready deck.
 * @param buffer - Raw bytes of the .pptx file.
 * @returns The deck, whose `release` must be called to free picture object URLs.
 * @throws When the package is not a readable presentation.
 */
export async function parsePptx(buffer: ArrayBuffer): Promise<PptxDeck> {
    const zip = await JSZip.loadAsync(buffer);
    const presentation = await xmlOf(zip, "ppt/presentation.xml");
    if (!presentation) throw new Error("not a presentation");

    const size = child(presentation, NS_P, "sldSz");
    const width = emuToPx(attrNumber(size, "cx", 12192000));
    const height = emuToPx(attrNumber(size, "cy", 6858000));
    const presentationRels = await relsOf(zip, "ppt/presentation.xml");
    const media = new Map<string, string>();

    const parts: string[] = [];
    for (const entry of childList(child(presentation, NS_P, "sldIdLst"), NS_P, "sldId")) {
        const part = presentationRels.get(entry.getAttributeNS(NS_R, "id") ?? "");
        if (part) parts.push(part);
    }

    const layouts = new Map<string, { root: Element | undefined; master: string | undefined }>();
    const masters = new Map<string, { root: Element | undefined; theme: Theme }>();
    const slides: PptxSlide[] = [];

    for (const part of parts) {
        const rels = await relsOf(zip, part);
        const layoutPart = relatedPart(rels, "slideLayouts");
        if (layoutPart && !layouts.has(layoutPart)) {
            const layoutRels = await relsOf(zip, layoutPart);
            layouts.set(layoutPart, {
                root: await xmlOf(zip, layoutPart),
                master: relatedPart(layoutRels, "slideMasters")
            });
        }
        const layout = layoutPart ? layouts.get(layoutPart) : undefined;
        const masterPart = layout?.master;
        if (masterPart && !masters.has(masterPart)) {
            masters.set(masterPart, {
                root: await xmlOf(zip, masterPart),
                theme: await themeOf(zip, masterPart)
            });
        }
        const master = masterPart ? masters.get(masterPart) : undefined;
        const theme = master?.theme ?? new Map();
        const root = await xmlOf(zip, part);
        const context: SlideContext = {
            zip,
            theme,
            media,
            rels,
            master: master?.root,
            placeholders: [placeholderMap(layout?.root), placeholderMap(master?.root)]
        };
        slides.push({
            background: backgroundOf([root, layout?.root, master?.root], theme),
            shapes: await shapesOf(path(root, NS_P, "cSld", "spTree"), context)
        });
    }

    if (slides.length === 0) throw new Error("no slides");
    return {
        width,
        height,
        slides,
        release: () => {
            for (const url of media.values()) URL.revokeObjectURL(url);
            media.clear();
        }
    };
}
