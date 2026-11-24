import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { judgeViewCall, readViewUrl, resolveViewFile, viewContentType, VIEW_CSP } from "@/main/addons/view";

const root = resolve("/addons/packages/hercules-stream100/0.2.0");

describe("an add-on view's address", () => {
    it("names the add-on and the file", () => {
        expect(readViewUrl("polaris-addon://hercules-stream100/view/index.html")).toEqual({ id: "hercules-stream100", path: "view/index.html" });
        expect(readViewUrl("polaris-addon://hercules-stream100/view/a%20b.css")).toEqual({ id: "hercules-stream100", path: "view/a b.css" });
    });

    it("is refused for another scheme, a bad id, no file, or a broken escape", () => {
        expect(readViewUrl("https://hercules-stream100/view/index.html")).toBeNull();
        expect(readViewUrl("polaris-addon://Bad_Id/index.html")).toBeNull();
        expect(readViewUrl("polaris-addon://hercules-stream100/")).toBeNull();
        expect(readViewUrl("polaris-addon://hercules-stream100/%E0%A4%A")).toBeNull();
        expect(readViewUrl("not a url")).toBeNull();
    });
});

describe("the files a view may load", () => {
    it("serves files in the view's own folder", () => {
        expect(resolveViewFile(root, "view/index.html", "index.html")).toBe(join(root, "view", "index.html"));
        expect(resolveViewFile(root, "view/index.html", "parts/knobs.js")).toBe(join(root, "view", "parts", "knobs.js"));
    });

    it("never a file outside it, an absolute path, or a type it does not serve", () => {
        expect(resolveViewFile(root, "view/index.html", "../main.cjs")).toBeNull();
        expect(resolveViewFile(root, "view/index.html", "../../../../secret.json")).toBeNull();
        expect(resolveViewFile(root, "view/index.html", "parts/../../manifest.json")).toBeNull();
        expect(resolveViewFile(root, "view/index.html", resolve("/etc/passwd.json"))).toBeNull();
        expect(resolveViewFile(root, "view/index.html", "native.node")).toBeNull();
        expect(resolveViewFile(root, "view/index.html", "main.cjs")).toBeNull();
        expect(resolveViewFile(root, "view/index.html", "a\0.js")).toBeNull();
    });

    it("types what it serves and reaches no network", () => {
        expect(viewContentType("index.HTML")).toBe("text/html; charset=utf-8");
        expect(viewContentType("x.exe")).toBeNull();
        expect(VIEW_CSP).toContain("default-src 'none'");
        expect(VIEW_CSP).not.toMatch(/connect-src|https?:/);
    });
});

describe("a call from a view", () => {
    it("may set one of its settings, with a value of a settings shape", () => {
        expect(judgeViewCall([], "settings.set", { key: "knob1", value: "music" })).toEqual({ ok: true, kind: "set", key: "knob1", value: "music" });
        expect(judgeViewCall([], "settings.set", { key: "knob1", value: { nested: true } })).toEqual({ ok: false, error: "bad-params" });
    });

    it("is judged like its process's own call otherwise", () => {
        expect(judgeViewCall([], "polaris.action", { action: "call.mic" })).toEqual({ ok: false, error: "permission" });
        expect(judgeViewCall(["polaris-actions"], "polaris.action", { action: "call.mic" })).toEqual({ ok: true, kind: "call", method: "polaris.action", params: { action: "call.mic" } });
        expect(judgeViewCall(["polaris-actions"], "polaris.action", { action: "sound.play" })).toEqual({ ok: false, error: "bad-params" });
        expect(judgeViewCall(["polaris-actions"], "fs.read", {})).toEqual({ ok: false, error: "unknown-method" });
    });
});
