/**
 * The Code step's sandbox.
 *
 * Pinned: the code sees the language and its items and nothing of this
 * process - no globals of Node, no module loading, no network - and it cannot
 * reach this process's objects or prototypes; a loop, a memory blow-up or an
 * oversized answer ends the run with the reason, never this process; ordinary
 * filters, maps and sums give their items back.
 */

import { describe, expect, it } from "vitest";
import { runCode, type CodeResult } from "@/lib/automations/code-sandbox";

const ITEMS = [
    { name: "a", price: 3 },
    { name: "b", price: 12 },
    { name: "c", price: 7 }
];

function ok(result: CodeResult): unknown[] {
    if (!result.ok) throw new Error(`expected ok, got ${result.kind}: ${result.message}`);
    return result.items;
}

describe("Code step sandbox: transforms", () => {
    it("filters, maps and aggregates", async () => {
        expect(ok(await runCode("return items.filter((item) => item.price > 5);", ITEMS))).toEqual([
            ITEMS[1],
            ITEMS[2]
        ]);
        expect(
            ok(
                await runCode(
                    "return items.map((item) => ({ ...item, double: item.price * 2 }));",
                    ITEMS
                )
            )
        ).toEqual(ITEMS.map((item) => ({ ...item, double: item.price * 2 })));
        expect(
            ok(
                await runCode(
                    "return { total: items.reduce((sum, item) => sum + item.price, 0), count: items.length };",
                    ITEMS
                )
            )
        ).toEqual([{ total: 22, count: 3 }]);
    });

    it("offers $input, await and console.log", async () => {
        const result = await runCode(
            "console.log('seen', items.length, { a: 1 });\nconst first = await Promise.resolve($input.first());\nreturn [first];",
            ITEMS
        );
        expect(ok(result)).toEqual([ITEMS[0]]);
        expect(result.logs).toEqual(['seen 3 {"a":1}']);
    });

    it("does not let the code change the items it was given", async () => {
        const result = await runCode("items.push(1); return items;", ITEMS);
        expect(result.ok).toBe(false);
    });

    it("asks for a return value and caps the log", async () => {
        const nothing = await runCode("const x = 1;", ITEMS);
        expect(nothing.ok).toBe(false);
        const chatty = await runCode(
            "for (let i = 0; i < 500; i++) console.log(i); return [];",
            []
        );
        expect(chatty.logs.length).toBe(100);
    });
});

describe("Code step sandbox: errors", () => {
    it("names the line of a thrown error", async () => {
        const result = await runCode(
            "const a = 1;\nconst b = 2;\nthrow new Error('broken here');",
            []
        );
        expect(result).toMatchObject({ ok: false, kind: "runtime", line: 3 });
        if (!result.ok) expect(result.message).toContain("broken here");
    });

    it("names the line of a reference error and a syntax error", async () => {
        const missing = await runCode("const a = 1;\nreturn nope.value;", []);
        expect(missing).toMatchObject({ ok: false, kind: "runtime", line: 2 });
        const syntax = await runCode("const a = 1;\nconst = ;", []);
        expect(syntax).toMatchObject({ ok: false, kind: "syntax", line: 2 });
    });
});

describe("Code step sandbox: escape attempts", () => {
    const probes: [string, string][] = [
        ["process", "return [typeof process];"],
        ["require", "return [typeof require];"],
        ["module", "return [typeof module, typeof exports, typeof __dirname];"],
        ["fetch", "return [typeof fetch, typeof XMLHttpRequest, typeof WebSocket];"],
        [
            "timers",
            "return [typeof setTimeout, typeof setInterval, typeof queueMicrotask === 'function' ? 'x' : 'undefined'];"
        ],
        ["Buffer", "return [typeof Buffer, typeof globalThis.Deno, typeof globalThis.Bun];"],
        ["std/os", "return [typeof std, typeof os, typeof scriptArgs];"]
    ];
    it.each(probes)("has no %s", async (_, code) => {
        const values = ok(await runCode(code, []));
        for (const value of values) expect(value).toBe("undefined");
    });

    it("sees nothing but the language on globalThis", async () => {
        const names = ok(
            await runCode("return Object.getOwnPropertyNames(globalThis);", [])
        ) as string[];
        expect(names).not.toContain("process");
        expect(names).not.toContain("require");
        expect(names).not.toContain("fetch");
        expect(names.filter((name) => /env|secret|prisma/i.test(name))).toEqual([]);
    });

    it("cannot reach the host through constructor chains", async () => {
        const code = `
            const F = (() => {}).constructor;
            const G = Object.getPrototypeOf(async function () {}).constructor;
            const p1 = F("return typeof process")();
            const p2 = await G("return typeof require")();
            const p3 = items.constructor.constructor("return typeof globalThis.process")();
            const p4 = $input.all.constructor("return this")() === globalThis;
            return [p1, p2, p3, p4];`;
        expect(ok(await runCode(code, [{ a: 1 }]))).toEqual([
            "undefined",
            "undefined",
            "undefined",
            true
        ]);
    });

    it("cannot import or load a module", async () => {
        const dynamic = await runCode("const fs = await import('fs'); return [typeof fs];", []);
        expect(dynamic.ok).toBe(false);
        const staticImport = await runCode("import fs from 'fs';\nreturn [];", []);
        expect(staticImport).toMatchObject({ ok: false, kind: "syntax" });
    });

    it("does not pollute this process's prototypes", async () => {
        const result = await runCode(
            "Object.prototype.polluted = 'yes'; Array.prototype.polluted = 'yes'; return [{ a: 1 }];",
            []
        );
        expect(ok(result)).toEqual([{ a: 1 }]);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("refuses an item carrying __proto__", async () => {
        const result = await runCode(
            'return [JSON.parse(\'{"__proto__": {"polluted": "yes"}}\')];',
            []
        );
        expect(result).toMatchObject({ ok: false, kind: "output" });
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("runs no toJSON or getter on this side", async () => {
        let touched = false;
        const original = JSON.parse;
        const result = await runCode(
            "return [{ get secret() { return 'x'; }, toJSON() { return { replaced: true }; } }];",
            []
        );
        touched = JSON.parse !== original;
        expect(ok(result)).toEqual([{ replaced: true }]);
        expect(touched).toBe(false);
    });

    it("does not keep state between runs", async () => {
        await runCode("globalThis.leftOver = 42; return [];", []);
        expect(ok(await runCode("return [typeof globalThis.leftOver];", []))).toEqual([
            "undefined"
        ]);
    });
});

describe("Code step sandbox: limits", () => {
    it("ends an endless loop at the time limit", async () => {
        const started = Date.now();
        const result = await runCode("while (true) {}", [], {
            timeMs: 200,
            memoryBytes: 32 * 1024 * 1024,
            outputBytes: 64 * 1024
        });
        expect(result).toMatchObject({ ok: false, kind: "timeout" });
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("ends an endless promise chain at the time limit", async () => {
        const result = await runCode(
            "const spin = () => Promise.resolve().then(spin); await spin();",
            [],
            {
                timeMs: 200,
                memoryBytes: 32 * 1024 * 1024,
                outputBytes: 64 * 1024
            }
        );
        expect(result.ok).toBe(false);
    });

    it("ends a memory blow-up", async () => {
        const started = Date.now();
        const result = await runCode(
            "const list = []; while (true) list.push('x'.repeat(1024 * 1024));",
            []
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(["memory", "timeout"]).toContain(result.kind);
        // The thread is killed at the time limit even while the engine is stuck failing to allocate.
        expect(Date.now() - started).toBeLessThan(3_000);
    });

    it("ends runaway recursion", async () => {
        const result = await runCode("const f = () => f(); f();", []);
        expect(result).toMatchObject({ ok: false, kind: "memory" });
    });

    it("refuses an output over the step's ceiling", async () => {
        const result = await runCode("return ['x'.repeat(200 * 1024)];", []);
        expect(result).toMatchObject({ ok: false, kind: "output" });
    });

    it("refuses input that is not JSON", async () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(await runCode("return items;", [circular])).toMatchObject({
            ok: false,
            kind: "input"
        });
    });
});

describe("Code step sandbox: load", () => {
    it("runs many at once in turns, each with its own answer", async () => {
        const results = await Promise.all(
            Array.from({ length: 12 }, (_, index) => runCode(`return [${index}];`, []))
        );
        expect(results.map(ok)).toEqual(Array.from({ length: 12 }, (_, index) => [index]));
    });
});
