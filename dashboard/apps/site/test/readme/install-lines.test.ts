/**
 * The real README, not a fixture: the landing page leads with its install
 * lines, and an edit that moved them out of the parser's reach once published
 * an empty install box. This fails the edit instead of the site.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as site from "../../src/data/builders";

const readme = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../../../../../${name}`, import.meta.url)), "utf8");

describe("the README's install lines", () => {
    it("are both found, pointing at the installers on main", () => {
        const install = site.parseInstallLines(readme("README.md"));
        expect(install.unix).toMatch(/^curl -fsSL https:\/\/raw\.githubusercontent\.com\/\S+\/install\.sh \| sh$/);
        expect(install.windows).toMatch(/^irm https:\/\/raw\.githubusercontent\.com\/\S+\/install\.ps1 \| iex$/);
    });
});
