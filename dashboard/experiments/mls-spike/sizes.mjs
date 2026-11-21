// Raw, gzip and brotli size of what a browser would download for each library.
import { readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

const files = { "ts-mls (bundle, minified)": ["dist/ts-mls.js"], "OpenMLS (wasm + glue)": ["openmls/pkg/openmls_spike_bg.wasm", "openmls/pkg/openmls_spike.js"] };
for (const [name, paths] of Object.entries(files)) {
    const data = Buffer.concat(paths.map((p) => readFileSync(new URL(p, import.meta.url))));
    const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
    console.log(JSON.stringify({ name, raw: data.length, gzip: gzipSync(data, { level: 9 }).length, brotli: br }));
}
