import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readPluginManifest, type PluginManifest } from "@polaris/core/device-plugins";

/**
 * The rules every plugin in the repository keeps (docs/device-plugins.md,
 * Views): a view shows, it does not ask. A control drawn inside a frame is the
 * browser's own - a native select, checkbox or slider that matches nothing
 * around it and whose list the frame clips - so every control is a declared
 * setting, drawn by Polaris with its own components. And every text a plugin
 * shows is in every language Polaris ships.
 */

const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
const plugins = join(repo, "clients", "device-plugins");
const locales = readdirSync(join(repo, "dashboard/apps/web/messages")).filter((name) => statSync(join(repo, "dashboard/apps/web/messages", name)).isDirectory());

/** A form control in markup, a script that makes one, or a role that stands in for one. */
const CONTROL = [
    /<\s*(select|input|textarea|option|button)\b/i,
    /createElement\(\s*["'`](select|input|textarea|option|button)["'`]/i,
    /\brole\s*=\s*["'](switch|slider|checkbox|combobox|listbox|spinbutton)["']/i,
    /setAttribute\(\s*["']role["']\s*,\s*["'](switch|slider|checkbox|combobox|listbox|spinbutton)["']/i,
    /\bcontenteditable\b/i
];

function filesUnder(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((item) => (item.isDirectory() ? filesUnder(join(dir, item.name)) : [join(dir, item.name)]));
}

function texts(manifest: PluginManifest): { where: string; text: Record<string, string>; }[] {
    const out: { where: string; text: Record<string, string>; }[] = [];
    for (const setting of manifest.settings) {
        out.push({ where: setting.key, text: setting.label });
        if (setting.hint) out.push({ where: `${setting.key} hint`, text: setting.hint });
        if (setting.kind === "choice") for (const option of setting.options) out.push({ where: `${setting.key} ${option.value}`, text: option.label });
    }
    for (const group of manifest.groups) {
        out.push({ where: `group ${group.key}`, text: group.label });
        if (group.hint) out.push({ where: `group ${group.key} hint`, text: group.hint });
    }
    return out;
}

const ids = readdirSync(plugins, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(join(plugins, item.name, "manifest.json")))
    .map((item) => item.name);

describe("device plugins in the repository", () => {
    it("are there to check", () => {
        expect(ids.length).toBeGreaterThan(0);
        expect(locales).toContain("en-US");
    });

    for (const id of ids) {
        const folder = join(plugins, id);
        const manifest = readPluginManifest(JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")));

        it(`${id}: has a manifest the app reads`, () => {
            expect(manifest).not.toBeNull();
        });
        if (!manifest) continue;

        it(`${id}: draws no control of its own in its view`, () => {
            if (!manifest.view) return;
            const viewDir = manifest.view.includes("/") ? manifest.view.slice(0, manifest.view.lastIndexOf("/")) : "";
            const layers = readdirSync(folder, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => join(folder, item.name, viewDir));
            const files = layers.flatMap(filesUnder).filter((file) => /\.(html?|js|mjs|cjs|css)$/i.test(file));
            expect(files.length).toBeGreaterThan(0);
            const found = files.flatMap((file) => {
                const source = readFileSync(file, "utf8");
                return CONTROL.filter((pattern) => pattern.test(source)).map((pattern) => `${file.slice(folder.length + 1)}: ${pattern.exec(source)![0]}`);
            });
            expect(found, "declare these as settings; Polaris draws them").toEqual([]);
        });

        it(`${id}: says every text in every language Polaris ships`, () => {
            const missing = texts(manifest).flatMap(({ where, text }) => locales.filter((locale) => !text[locale]).map((locale) => `${where}: ${locale}`));
            expect(missing).toEqual([]);
        });

        it(`${id}: puts each setting in a group it declares`, () => {
            const groups = new Set(manifest.groups.map((group) => group.key));
            expect(manifest.settings.filter((setting) => setting.group && !groups.has(setting.group)).map((setting) => setting.key)).toEqual([]);
        });
    }
});
