import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

// The `@/` alias the sources use, which WXT sets up for its own builds and the
// test runner does not know about on its own.
const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

/**
 * Two kinds of test, kept apart on purpose.
 *
 * Most of them exercise one module and stub whatever `browser` it touches by
 * hand. The worker tests import the background entrypoint as it is, which needs
 * WXT's own plugin: it resolves `#imports`, auto-imports `defineBackground`, and
 * turns every `browser` into the in-memory fake the test drives the real message
 * listener against. Applied to everything, that plugin would also swap the
 * `browser` the other tests stub - so it is scoped to the files that need it.
 */
export default defineConfig({
    test: {
        projects: [
            {
                resolve: { alias },
                test: {
                    name: "unit",
                    include: ["test/**/*.test.{ts,tsx}"],
                    exclude: ["test/worker-*.test.ts"]
                }
            },
            {
                plugins: [WxtVitest()],
                resolve: { alias },
                test: { name: "worker", include: ["test/worker-*.test.ts"] }
            }
        ]
    }
});
