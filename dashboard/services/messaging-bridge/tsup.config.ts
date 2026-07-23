import { defineConfig } from "tsup";

// Bundle the bridge and its workspace/npm dependencies into one self-contained
// file so the runtime image is just node + dist/index.js. Node built-ins stay
// external; @polaris/* and zod are inlined.
export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    clean: true,
    noExternal: [/@polaris\//, "zod"]
});
