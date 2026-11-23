import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Mirrors the `@/*` and `@tv-compat/*` path aliases from tsconfig. The tests cover the pure modules,
 *  so nothing here needs an Electron runtime. */
export default defineConfig({
    resolve: {
        alias: {
            "@tv-compat": fileURLToPath(new URL("../dashboard/packages/core/src/tv-compat", import.meta.url)),
            "@toolchain": fileURLToPath(new URL("../dashboard/packages/core/src/toolchain", import.meta.url)),
            // Shared modules, and the zod they import resolved from this app as
            // the bundle resolves it (build/node-build.mjs).
            "@polaris/core": fileURLToPath(new URL("../dashboard/packages/core/src", import.meta.url)),
            zod: fileURLToPath(new URL("./node_modules/zod", import.meta.url)),
            "@": fileURLToPath(new URL("./src", import.meta.url))
        }
    },
    test: {
        include: ["test/**/*.test.ts"]
    }
});
