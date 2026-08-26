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
    oxc: { jsx: { runtime: "automatic" } },
    test: {
        /**
         * Well past the default five seconds, because on a suite this size the
         * default was not measuring the test.
         *
         * Five hundred files run at once, and the first test in a file pays for
         * transforming and importing everything that file reaches - for the chat
         * rules that is most of the messaging code. On its own the test takes
         * milliseconds; with every core busy running the other four hundred and
         * ninety-nine, that one import crosses five seconds and the test is
         * failed for it. Which file it happened to was different on every run,
         * and none of them ever failed alone: the signature of a deadline that is
         * timing the machine rather than the code.
         *
         * A test that genuinely hangs still fails. It just fails on evidence.
         */
        testTimeout: 30_000,
        hookTimeout: 30_000
    }
});
