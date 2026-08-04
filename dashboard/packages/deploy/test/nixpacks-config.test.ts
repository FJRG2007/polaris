/**
 * The nixpacks.toml Polaris writes into a build context.
 *
 * Two properties matter. A section that is absent hands the phase back to
 * nixpacks' own detection, so "no override" must mean "no section" rather than an
 * empty one - an empty `cmds` would blank the phase instead of leaving it alone.
 * And the commands are typed by a user, so a quote in one must not be able to end
 * the TOML string and start something else.
 */

import { describe, expect, it } from "vitest";
import { nixpacksConfig } from "../src/nixpacks.js";

describe("nixpacksConfig", () => {
    it("writes nothing at all when there is nothing to override", () => {
        expect(nixpacksConfig({})).toBeNull();
        expect(nixpacksConfig({ install: null, build: null, start: null, packages: [] })).toBeNull();
    });

    it("carries build environment without touching a single phase", () => {
        // The only thing here that is safe for a stack Polaris has not recognized:
        // it adds names, where a phase would replace what the provider worked out.
        const rendered = nixpacksConfig({ variables: { PNPM_CONFIG_MINIMUM_RELEASE_AGE: "0" } }) ?? "";
        expect(rendered).toContain('[variables]\nPNPM_CONFIG_MINIMUM_RELEASE_AGE = "0"');
        expect(rendered).not.toContain("[phases.");
        expect(rendered).not.toContain("[start]");
    });

    it("writes only the phases it was given", () => {
        const rendered = nixpacksConfig({ start: "next start" }) ?? "";
        expect(rendered).toContain('[start]\ncmd = "next start"');
        expect(rendered).not.toContain("[phases.install]");
        expect(rendered).not.toContain("[phases.build]");
    });

    it("writes each phase in the order nixpacks runs them", () => {
        const rendered = nixpacksConfig({
            packages: ["caddy"],
            install: "pnpm install --frozen-lockfile",
            build: "pnpm --filter web run build",
            start: "caddy file-server --root dist"
        }) ?? "";
        const order = ["[phases.setup]", "[phases.install]", "[phases.build]", "[start]"].map((section) =>
            rendered.indexOf(section)
        );
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(order.every((at) => at >= 0)).toBe(true);
    });

    it("adds to the setup packages instead of replacing them", () => {
        // A bare list here replaces the provider's, which for this phase means
        // throwing away the language runtime and shipping an image that holds a
        // static file server and no Node at all.
        expect(nixpacksConfig({ packages: ["caddy"] })).toContain('nixPkgs = ["...", "caddy"]');
    });

    it("escapes a command that would otherwise end the string", () => {
        const rendered = nixpacksConfig({ start: 'node -e "console.log(1)"' }) ?? "";
        expect(rendered).toContain('cmd = "node -e \\"console.log(1)\\""');
        // One opening and one closing quote on the value, not three.
        expect(rendered.split("\n").find((line) => line.startsWith("cmd = "))?.match(/(?<!\\)"/g)).toHaveLength(2);
    });

    it("escapes a backslash, so a Windows-looking path does not become an escape", () => {
        expect(nixpacksConfig({ build: "a\\b" })).toContain('cmds = ["a\\\\b"]');
    });

    it("ends with exactly one newline", () => {
        const rendered = nixpacksConfig({ start: "node ." }) ?? "";
        expect(rendered.endsWith("\n")).toBe(true);
        expect(rendered.endsWith("\n\n")).toBe(false);
    });

    it("says in the file itself that Polaris wrote it", () => {
        expect(nixpacksConfig({ start: "node ." })).toContain("# Written by Polaris");
    });
});
