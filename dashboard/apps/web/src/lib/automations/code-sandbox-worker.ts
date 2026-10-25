/**
 * The source of the thread a Code step runs on. It is this constant, written
 * here - never the person's code, which only ever reaches QuickJS as a string
 * to evaluate inside the WebAssembly engine.
 *
 * It is a string rather than a file because a worker file is a path the
 * server bundle cannot follow; the two packages it loads are resolved by the
 * host and handed in as absolute paths.
 *
 * The thread sends back strings and numbers only: `ready` once the engine is
 * up (the host's hard deadline starts then), and one answer - the result as
 * JSON the engine itself serialized, or the error the code threw.
 */

export const CODE_WORKER_SOURCE = String.raw`"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const quickjs = require(workerData.core);
const loaded = require(workerData.variant);
const variant = loaded.default || loaded;
const logs = [];
const PRELUDE = [
    "\"use strict\";",
    "globalThis.items = JSON.parse(globalThis.__input);",
    "delete globalThis.__input;",
    "Object.freeze(globalThis.items);",
    "globalThis.$input = Object.freeze({",
    "    all: () => globalThis.items,",
    "    first: () => globalThis.items[0],",
    "    last: () => globalThis.items[globalThis.items.length - 1]",
    "});"
].join("\n");
const SERIALIZE = "(() => { const value = globalThis.__result; if (value === undefined) return undefined; return JSON.stringify(Array.isArray(value) ? value : [value]); })()";

function describe(vm, handle) {
    const dumped = vm.dump(handle);
    handle.dispose();
    if (dumped && typeof dumped === "object")
        return {
            name: typeof dumped.name === "string" ? dumped.name : "",
            message: typeof dumped.message === "string" ? dumped.message : "",
            stack: typeof dumped.stack === "string" ? dumped.stack : ""
        };
    return { name: "", message: String(dumped), stack: "" };
}

(async () => {
    let vm = null;
    let deadline = Infinity;
    const threw = (vm, handle) => ({ type: "threw", error: describe(vm, handle), interrupted: Date.now() >= deadline });
    let answer;
    try {
        const engine = await quickjs.newQuickJSWASMModuleFromVariant(variant);
        const runtime = engine.newRuntime();
        runtime.setMemoryLimit(workerData.memoryBytes);
        runtime.setMaxStackSize(workerData.stackBytes);
        vm = runtime.newContext();
        const consoleObject = vm.newObject();
        for (const level of ["log", "info", "warn", "error", "debug"]) {
            const fn = vm.newFunction(level, (...args) => {
                if (logs.length >= workerData.logLines) return;
                const parts = args.map((arg) => {
                    if (vm.typeof(arg) === "string") return vm.getString(arg);
                    const dumped = vm.dump(arg);
                    try {
                        const text = JSON.stringify(dumped);
                        return text === undefined ? String(dumped) : text;
                    } catch {
                        return String(dumped);
                    }
                });
                const line = parts.join(" ").slice(0, workerData.logLength);
                logs.push(level === "log" || level === "info" ? line : level + ": " + line);
            });
            vm.setProp(consoleObject, level, fn);
            fn.dispose();
        }
        vm.setProp(vm.global, "console", consoleObject);
        consoleObject.dispose();
        const input = vm.newString(workerData.input);
        vm.setProp(vm.global, "__input", input);
        input.dispose();
        parentPort.postMessage({ type: "ready" });
        deadline = Date.now() + workerData.timeMs;
        runtime.setInterruptHandler(quickjs.shouldInterruptAfterDeadline(deadline));
        answer = (() => {
            const prelude = vm.evalCode(PRELUDE, "prelude.js");
            if (prelude.error) return threw(vm, prelude.error);
            prelude.value.dispose();
            const evaluated = vm.evalCode(workerData.code, workerData.file, { strict: true });
            if (evaluated.error) return threw(vm, evaluated.error);
            const promise = evaluated.value;
            const jobs = runtime.executePendingJobs(-1);
            if (jobs.error) {
                promise.dispose();
                return threw(vm, jobs.error);
            }
            const state = vm.getPromiseState(promise);
            promise.dispose();
            if (state.type === "pending") return { type: "pending" };
            if (state.type === "rejected") return threw(vm, state.error);
            vm.setProp(vm.global, "__result", state.value);
            state.value.dispose();
            const serialized = vm.evalCode(SERIALIZE, "result.js");
            if (serialized.error) return threw(vm, serialized.error);
            const text = vm.typeof(serialized.value) === "string" ? vm.getString(serialized.value) : null;
            serialized.value.dispose();
            return { type: "done", text };
        })();
    } catch (caught) {
        answer = {
            type: "crashed",
            message: String((caught && caught.message) || caught),
            interrupted: Date.now() >= deadline
        };
    }
    parentPort.postMessage({ ...answer, logs });
})();
`;
