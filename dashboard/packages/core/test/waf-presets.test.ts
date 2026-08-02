import { describe, expect, it } from "vitest";
import { evaluateWafRules } from "../src/waf-rules.js";
import { decodeGuardRule, encodeGuardRule } from "../src/waf.js";
import {
    applicationDefaultWafPresets,
    expandWafPresets,
    instanceDefaultWafPresets,
    isWafPresetId,
    wafPreset,
    WAF_PRESETS
} from "../src/waf-presets.js";

/** Run a request through a pack the way the guard does, and report the verdict. */
function verdict(presetIds: string[], facts: Parameters<typeof evaluateWafRules>[1]) {
    return evaluateWafRules(expandWafPresets(presetIds), facts);
}

const BROWSER =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

describe("rule packs", () => {
    it("names every pack uniquely and gives each one at least one rule", () => {
        const ids = WAF_PRESETS.map((preset) => preset.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const preset of WAF_PRESETS) {
            expect(preset.rules.length).toBeGreaterThan(0);
            for (const rule of preset.rules) expect(rule.conditions.length).toBeGreaterThan(0);
        }
    });

    it("resolves an id and rejects one it does not ship", () => {
        expect(wafPreset("scanners")?.label).toBe("Vulnerability scanners");
        expect(wafPreset("nope")).toBeUndefined();
        expect(isWafPresetId("dotfiles")).toBe(true);
        expect(isWafPresetId("nope")).toBe(false);
    });

    it("expands in pack order regardless of how the ids were stored", () => {
        const forward = expandWafPresets(["scanners", "ai-crawlers"]);
        const reversed = expandWafPresets(["ai-crawlers", "scanners"]);
        expect(reversed).toEqual(forward);
    });

    it("skips an id from a newer build instead of enforcing nothing", () => {
        const rules = expandWafPresets(["scanners", "pack-from-the-future"]);
        expect(rules).toEqual(expandWafPresets(["scanners"]));
        expect(rules.length).toBeGreaterThan(0);
    });
});

describe("scanners", () => {
    it.each(["sqlmap/1.7", "Mozilla/5.0 zgrab/0.x", "masscan", "CensysInspect/1.1", "BitSightBot/2.0"])(
        "blocks %s",
        (userAgent) => {
            expect(verdict(["scanners"], { userAgent, path: "/" })?.action).toBe("block");
        }
    );

    it("matches case-insensitively", () => {
        expect(verdict(["scanners"], { userAgent: "SQLMap/1.7", path: "/" })?.action).toBe("block");
    });

    it("leaves a real browser alone", () => {
        expect(verdict(["scanners"], { userAgent: BROWSER, path: "/" })).toBeNull();
    });

    it("blocks the bare 'open' agent without blocking OpenBSD's browser", () => {
        expect(verdict(["scanners"], { userAgent: "open", path: "/" })?.action).toBe("block");
        expect(
            verdict(["scanners"], {
                userAgent: "Mozilla/5.0 (X11; OpenBSD amd64; rv:128.0) Gecko/20100101 Firefox/128.0",
                path: "/"
            })
        ).toBeNull();
    });

    it("does not fire on a request that sent no user agent at all", () => {
        expect(verdict(["scanners"], { path: "/", userAgent: null })).toBeNull();
    });
});

describe("dotfiles", () => {
    it.each(["/.env", "/.git/config", "/.ssh/id_rsa", "/backup.sql", "/.DS_Store", "/.idea/workspace.xml"])(
        "blocks %s",
        (path) => {
            expect(verdict(["dotfiles"], { path, userAgent: BROWSER })?.action).toBe("block");
        }
    );

    it("blocks an unlisted hidden path via the catch-all", () => {
        expect(verdict(["dotfiles"], { path: "/.secret-thing", userAgent: BROWSER })?.action).toBe("block");
    });

    it("lets certificate validation through", () => {
        expect(
            verdict(["dotfiles"], { path: "/.well-known/acme-challenge/xyz", userAgent: BROWSER })
        ).toBeNull();
    });

    it("leaves ordinary paths alone", () => {
        expect(verdict(["dotfiles"], { path: "/pricing", userAgent: BROWSER })).toBeNull();
        expect(verdict(["dotfiles"], { path: "/assets/app.2f9c.css", userAgent: BROWSER })).toBeNull();
    });
});

describe("cms-probes", () => {
    it.each(["/wp-login.php", "/wp-admin/install.php", "/phpmyadmin/", "/xmlrpc.php", "/index.php"])(
        "blocks %s",
        (path) => {
            expect(verdict(["cms-probes"], { path, userAgent: BROWSER })?.action).toBe("block");
        }
    );

    it("leaves a Next.js route alone", () => {
        expect(verdict(["cms-probes"], { path: "/blog/hello-world", userAgent: BROWSER })).toBeNull();
    });
});

describe("crawler packs", () => {
    it("blocks AI agents only when that pack is on", () => {
        expect(verdict(["ai-crawlers"], { userAgent: "GPTBot/1.2", path: "/" })?.action).toBe("block");
        expect(verdict(["ai-crawlers"], { userAgent: "ClaudeBot/1.0", path: "/" })?.action).toBe("block");
        expect(verdict(["scanners", "dotfiles"], { userAgent: "GPTBot/1.2", path: "/" })).toBeNull();
    });

    it("blocks search indexers only when that pack is on", () => {
        expect(verdict(["search-crawlers"], { userAgent: "Googlebot/2.1", path: "/" })?.action).toBe("block");
        expect(verdict(["search-crawlers"], { userAgent: "bingbot/2.0", path: "/" })?.action).toBe("block");
        expect(verdict(["ai-crawlers"], { userAgent: "Googlebot/2.1", path: "/" })).toBeNull();
    });

    it("covers the Googlebot variants through the canonical entry", () => {
        for (const agent of ["Googlebot-Image/1.0", "Googlebot-News", "AdsBot-Google-Mobile"]) {
            expect(verdict(["search-crawlers"], { userAgent: agent, path: "/" })?.action).toBe("block");
        }
    });
});

describe("defaults", () => {
    it("starts an instance on the stack-agnostic packs only", () => {
        expect(instanceDefaultWafPresets()).toEqual(["scanners", "dotfiles"]);
    });

    it("turns CMS probing on for a service that does not run PHP", () => {
        expect(applicationDefaultWafPresets("nixpacks/node")).toEqual(["cms-probes"]);
        expect(applicationDefaultWafPresets(null)).toEqual(["cms-probes"]);
    });

    it("leaves it off for a service that does", () => {
        expect(applicationDefaultWafPresets("php:8.3-apache")).toEqual([]);
        expect(applicationDefaultWafPresets("wordpress:latest")).toEqual([]);
    });

    it("never enables a crawler pack on its own", () => {
        const defaults = [...instanceDefaultWafPresets(), ...applicationDefaultWafPresets("node")];
        expect(defaults).not.toContain("ai-crawlers");
        expect(defaults).not.toContain("search-crawlers");
    });
});

describe("the wire format", () => {
    it("carries packs as ids, not as their contents", () => {
        const header = encodeGuardRule({ deny: [], requireLogin: false, presets: ["scanners"], rules: [] });
        const json = Buffer.from(header, "base64").toString("utf8");
        expect(json).toContain("scanners");
        expect(json).not.toContain("sqlmap");
        // The whole point of ids: a forty-agent pack still fits in a tiny header.
        expect(header.length).toBeLessThan(120);
    });

    it("expands them on the way out, after the operator's own rules", () => {
        const own = {
            name: "Let my scanner in",
            enabled: true,
            action: "allow" as const,
            conditions: [{ field: "ip" as const, operator: "equals" as const, values: ["203.0.113.9"] }]
        };
        const decoded = decodeGuardRule(
            encodeGuardRule({ deny: [], requireLogin: false, presets: ["scanners"], rules: [own] })
        );
        expect(decoded.presets).toEqual(["scanners"]);
        expect(decoded.rules[0]).toEqual(own);
        expect(decoded.rules.length).toBeGreaterThan(1);

        // And that ordering is what lets the exception win over the pack.
        const facts = { ip: "203.0.113.9", userAgent: "sqlmap/1.7", path: "/" };
        expect(evaluateWafRules(decoded.rules, facts)?.action).toBe("allow");
        expect(evaluateWafRules(decoded.rules, { ...facts, ip: "203.0.113.10" })?.action).toBe("block");
    });

    it("returns the same decoded object for a repeated header", () => {
        const header = encodeGuardRule({ deny: [], requireLogin: false, presets: ["dotfiles"], rules: [] });
        expect(decodeGuardRule(header)).toBe(decodeGuardRule(header));
    });
});
