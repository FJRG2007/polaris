// Injected into the main-process bundle (build/node-build.mjs): the bundle's own
// file URL, standing in for `import.meta.url`, which CommonJS does not have.
export const import_meta_url = require("node:url").pathToFileURL(__filename).href;
