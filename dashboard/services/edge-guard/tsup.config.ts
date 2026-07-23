import { defineConfig } from "tsup";

// Bundle the guard and its workspace/npm dependencies into one self-contained file
// so the runtime image is just node + dist/index.js - a minimal, reliable sentinel
// with no node_modules to resolve at boot. Node built-ins stay external.
export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    clean: true,
    noExternal: [/@polaris\//, "ipaddr.js", "zod"]
});
