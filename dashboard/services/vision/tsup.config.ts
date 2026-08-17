import { defineConfig } from "tsup";

// One self-contained file, so the runtime image is ffmpeg, node, and this. The
// worker has no npm dependencies at all - it spawns ffmpeg and speaks HTTP - so
// there is nothing to inline beyond its own source.
export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    clean: true
});
