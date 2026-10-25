/**
 * A bundle small enough to build in a test: a manifest and a server half whose
 * extension says which build it is, so a test can tell which one is loaded.
 */

import JSZip from "jszip";
import { createHash } from "node:crypto";

export interface TinyBundle {
    readonly bytes: Buffer;
    readonly digest: string;
    readonly size: number;
}

export async function tinyBundle(
    id: string,
    options: {
        readonly label?: string;
        readonly hostApi?: string | null;
        readonly format?: number;
        readonly version?: string;
        /** Server code that throws when evaluated: a bundle that cannot start. */
        readonly broken?: boolean;
    } = {}
): Promise<TinyBundle> {
    const label = options.label ?? "one";
    const zip = new JSZip();
    zip.file(
        "manifest.json",
        JSON.stringify({
            format: options.format ?? 1,
            id,
            package: `@polaris-app/${id}`,
            version: options.version ?? "0.1.0",
            build: "",
            ...(options.hostApi === null ? {} : { hostApi: options.hostApi ?? "1.0" }),
            server: "server/index.cjs",
            routes: [],
            actions: {},
            client: {},
            shared: { server: [], client: [] }
        })
    );
    zip.file(
        "server/index.cjs",
        options.broken
            ? `throw new Error("broken ${label}");`
            : `module.exports = { extension: { id: ${JSON.stringify(id)}, label: ${JSON.stringify(label)} }, routes: {}, actions: {} };`
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    return {
        bytes,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size: bytes.length
    };
}
