import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Mirrors the `@/*` path alias from tsconfig so tests can import app modules. */
export default defineConfig({
    resolve: {
        alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
    },
    // The app's tsconfig leaves JSX to Next's own compiler, which vitest is not.
    // Transforming it here is what lets a component be rendered to markup and
    // asserted on, rather than only its data being tested.
    oxc: { jsx: { runtime: "automatic" } }
});
