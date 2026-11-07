import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Mirrors the `@/*` and `@tv-compat/*` path aliases from tsconfig. The tests cover the pure modules,
 *  so nothing here needs an Electron runtime. */
export default defineConfig({
    resolve: {
        alias: {
            "@tv-compat": fileURLToPath(new URL("../dashboard/packages/core/src/tv-compat", import.meta.url)),
            "@": fileURLToPath(new URL("./src", import.meta.url))
        }
    },
    test: {
        include: ["test/**/*.test.ts"]
    }
});
