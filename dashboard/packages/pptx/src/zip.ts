/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

/**
 * pptx package management — open the zip, archive the original by SHA-256, and read
 * parts and .rels.
 *
 * Byte fidelity: PackageArchive holds the original bytes of every entry; on save,
 * unmodified entries are written back byte-for-byte (handled by the patch layer).
 * This module only handles reading and metadata.
 */
import JSZip from "jszip";
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { SlideSize } from "./types";
import { asXmlNode, xmlArray } from "./xml-utils";

const relsParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => name === "Relationship" || name === "sldId" || name === "Override"
});

export interface Relationship {
    id: string;
    type: string;
    target: string;
    targetMode?: string;
}

/**
 * How much of a package this is willing to unpack.
 *
 * `loadAsync` reads the package's index and unpacks nothing; the loop below is
 * what unpacks it, and what would allocate whatever the index describes. Deflate
 * reaches roughly a thousand to one, so a file small enough to accept as a
 * request body can still describe tens of gigabytes of parts - and the process
 * that dies allocating them is the one serving everybody, not the request that
 * asked. A real deck at the size limits its callers apply unpacks to a few
 * hundred megabytes at the very worst, because a deck that size is mostly media
 * and media does not deflate a second time.
 *
 * Both numbers are checked twice over. The declared sizes come first because
 * they are free and reject the file before a single byte is inflated; the
 * running total follows because a declared size is only the author's word for
 * it. An entry that understates itself is caught by JSZip, which compares what
 * it inflated against what was declared - but only after inflating it, so the
 * running total is what stops the entry after that one.
 */
const MOST_ENTRIES = 8192;
const MOST_UNPACKED_BYTES = 384 * 1024 * 1024;

/** The unpacked size an entry declares, off the index JSZip has already read.
 *  Zero when it is not there: an entry that declares no size is left to the
 *  running total rather than trusted. */
function declaredSize(file: JSZip.JSZipObject): number {
    const held = (file as { _data?: { uncompressedSize?: unknown } })._data;
    return typeof held?.uncompressedSize === "number" && held.uncompressedSize > 0
        ? held.uncompressedSize
        : 0;
}

export class PackageArchive {
    private constructor(
        private readonly zip: JSZip,
        /** Original bytes of every entry, keyed by path inside the zip */
        readonly entries: Map<string, Uint8Array>,
        readonly originalHash: string
    ) {}

    static async open(bytes: Uint8Array): Promise<PackageArchive> {
        const originalHash = createHash("sha256").update(bytes).digest("hex");
        const zip = await JSZip.loadAsync(bytes);
        const entries = new Map<string, Uint8Array>();
        const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
        if (names.length > MOST_ENTRIES)
            throw new Error(`pptx: package holds more than ${MOST_ENTRIES} parts`);
        let declared = 0;
        for (const name of names) declared += declaredSize(zip.files[name]);
        if (declared > MOST_UNPACKED_BYTES)
            throw new Error(
                `pptx: package declares more than ${MOST_UNPACKED_BYTES} bytes unpacked`
            );
        let unpacked = 0;
        for (const name of names) {
            const part = await zip.files[name].async("uint8array");
            unpacked += part.byteLength;
            if (unpacked > MOST_UNPACKED_BYTES)
                throw new Error(`pptx: package unpacks to more than ${MOST_UNPACKED_BYTES} bytes`);
            entries.set(name, part);
        }
        return new PackageArchive(zip, entries, originalHash);
    }

    has(path: string): boolean {
        return this.entries.has(path);
    }

    /** Read a part as a UTF-8 string (for XML parts). */
    readText(path: string): string | null {
        const bytes = this.entries.get(path);
        if (!bytes) return null;
        return Buffer.from(bytes).toString("utf8");
    }

    readBytes(path: string): Uint8Array | null {
        return this.entries.get(path) ?? null;
    }

    /**
     * Read a part's relationships file. partPath e.g. 'ppt/slides/slide1.xml' →
     * 'ppt/slides/_rels/slide1.xml.rels'.
     */
    readRels(partPath: string): Map<string, Relationship> {
        const relsPath = relsPathFor(partPath);
        const rels = new Map<string, Relationship>();
        const xml = this.readText(relsPath);
        if (!xml) return rels;
        const doc = asXmlNode(relsParser.parse(xml));
        const list = asXmlNode(doc.Relationships).Relationship;
        for (const r of xmlArray(list)) {
            const id = String(r["@_Id"] ?? "");
            rels.set(id, {
                id,
                type: String(r["@_Type"] ?? ""),
                target: String(r["@_Target"] ?? ""),
                ...(r["@_TargetMode"] != null ? { targetMode: String(r["@_TargetMode"]) } : {})
            });
        }
        return rels;
    }

    /**
     * Read the presentation's slide size and the slide part paths in order.
     */
    readPresentation(): { size: SlideSize; slidePaths: string[] } {
        const presXml = this.readText("ppt/presentation.xml");
        if (!presXml) throw new Error("pptx: missing ppt/presentation.xml");

        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "@_",
            isArray: (name) => name === "p:sldId"
        });
        const pres = asXmlNode(parser.parse(presXml));
        const rootRaw = pres["p:presentation"] ?? pres.presentation;
        if (!rootRaw) throw new Error("pptx: malformed presentation.xml");
        const root = asXmlNode(rootRaw);

        // Slide size
        const szRaw = root["p:sldSz"] ?? root.sldSz;
        const sz = szRaw ? asXmlNode(szRaw) : null;
        const size: SlideSize = {
            cx: sz ? parseInt(String(sz["@_cx"]), 10) : 9144000,
            cy: sz ? parseInt(String(sz["@_cy"]), 10) : 6858000
        };

        // Slide order: presentation.xml.rels maps r:id to slide parts
        const rels = this.readRels("ppt/presentation.xml");
        const sldIdLst = asXmlNode(root["p:sldIdLst"] ?? root.sldIdLst);
        const slidePaths: string[] = [];
        for (const id of xmlArray(sldIdLst["p:sldId"])) {
            const rId = id["@_r:id"] ?? id["@_id"];
            if (!rId) continue;
            const rel = rels.get(String(rId));
            if (!rel) continue;
            slidePaths.push(resolveTarget("ppt/presentation.xml", rel.target));
        }
        return { size, slidePaths };
    }

    /** Resolve a slide's layout / master part paths (via the rels chain). */
    resolveSlideChain(slidePath: string): {
        layoutPath?: string;
        masterPath?: string;
        themePath?: string;
    } {
        const slideRels = this.readRels(slidePath);
        let layoutPath: string | undefined;
        for (const rel of slideRels.values()) {
            if (rel.type.endsWith("/slideLayout")) {
                layoutPath = resolveTarget(slidePath, rel.target);
                break;
            }
        }
        let masterPath: string | undefined;
        let themePath: string | undefined;
        if (layoutPath) {
            const layoutRels = this.readRels(layoutPath);
            for (const rel of layoutRels.values()) {
                if (rel.type.endsWith("/slideMaster")) {
                    masterPath = resolveTarget(layoutPath, rel.target);
                    break;
                }
            }
        }
        if (masterPath) {
            const masterRels = this.readRels(masterPath);
            for (const rel of masterRels.values()) {
                if (rel.type.endsWith("/theme")) {
                    themePath = resolveTarget(masterPath, rel.target);
                    break;
                }
            }
        }
        return { layoutPath, masterPath, themePath };
    }
}

/** 'ppt/slides/slide1.xml' → 'ppt/slides/_rels/slide1.xml.rels' */
export function relsPathFor(partPath: string): string {
    const idx = partPath.lastIndexOf("/");
    const dir = idx >= 0 ? partPath.slice(0, idx) : "";
    const file = idx >= 0 ? partPath.slice(idx + 1) : partPath;
    return `${dir ? dir + "/" : ""}_rels/${file}.rels`;
}

/**
 * Resolve a relative target into an absolute path inside the zip.
 * basePart is the referencing part's path (its directory is the base); target may be
 * something like '../slideLayouts/slideLayout1.xml'.
 */
export function resolveTarget(basePart: string, target: string): string {
    if (target.startsWith("/")) return target.slice(1);
    const baseDir = basePart.slice(0, basePart.lastIndexOf("/"));
    const parts = baseDir.split("/").filter(Boolean);
    for (const seg of target.split("/")) {
        if (seg === "." || seg === "") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
    }
    return parts.join("/");
}
