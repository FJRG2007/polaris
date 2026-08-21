import { defineConfig } from "tsup";

// One file for everything this worker owns, plus the pure Polaris logic it
// shares with the dashboard - bundling that is the point, since the worker
// image has no workspace to resolve it from.
//
// The detection runtime is the exception. It is a native addon: its .node
// binaries cannot be bundled, so it stays an ordinary dependency installed
// beside the built file.
export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    external: ["onnxruntime-node"],
    noExternal: [/@polaris\//],
    clean: true
});
