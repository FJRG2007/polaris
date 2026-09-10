import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Mirrors the `@/*` path alias from tsconfig. The tests cover the pure modules,
 *  so nothing here needs an Electron runtime. */
export default defineConfig({
    resolve: {
        alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
    },
    test: {
        include: ["test/**/*.test.ts"]
    }
});
