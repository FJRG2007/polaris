import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The `@/` alias the sources use, which WXT sets up for its own builds and the
// test runner does not know about on its own.
export default defineConfig({
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }
});
