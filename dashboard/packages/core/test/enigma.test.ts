/**
 * How Enigma resolves across the tiers, and what it turns into on a machine.
 *
 * The two cases that matter are the ones a screen cannot show you. Tiers: a
 * session that says nothing must land on the instance's answer rather than on a
 * default, or an operator's instance-wide policy silently stops applying the
 * moment anybody opens a session. Config keys: they become a command line on
 * somebody else's machine, so what is refused is as important as what is passed.
 */

import { describe, expect, it } from "vitest";
import {
    DEFAULT_ENIGMA,
    ENIGMA_VERSION,
    INHERIT_ENIGMA,
    enigmaConfigArgv,
    enigmaConfigureScript,
    enigmaGateArgv,
    enigmaHasHostCli,
    enigmaReleaseInstallScript,
    enigmaSetupScript,
    ENIGMA_INSTALLER_SHA256,
    ENIGMA_INSTALLER_URL,
    enigmaInstallArgv,
    enigmaPackageSpec,
    enigmaSkillsArgv,
    parseEnigmaSettings,
    resolveEnigma
} from "../src/enigma.js";

describe("resolveEnigma", () => {
    it("is on with the full install when nobody has said anything", () => {
        expect(resolveEnigma()).toEqual(DEFAULT_ENIGMA);
        expect(resolveEnigma(INHERIT_ENIGMA, INHERIT_ENIGMA).enabled).toBe(true);
    });

    it("lets the nearest tier with an opinion win, field by field", () => {
        const resolved = resolveEnigma(
            { ...INHERIT_ENIGMA, gate: "full" },
            { ...INHERIT_ENIGMA, gate: "off", scope: "policies" }
        );
        expect(resolved.gate).toBe("full");
        expect(resolved.scope).toBe("policies");
    });

    it("honours a deliberate refusal rather than reading it as unset", () => {
        expect(
            resolveEnigma(
                { ...INHERIT_ENIGMA, enabled: false },
                { ...INHERIT_ENIGMA, enabled: true }
            ).enabled
        ).toBe(false);
    });

    it("merges the config from the far tier inwards, so a session keeps the instance policy", () => {
        const resolved = resolveEnigma(
            { ...INHERIT_ENIGMA, config: { "commit-emoji": "off" } },
            { ...INHERIT_ENIGMA, config: { "commit-emoji": "on", gate: "off" } }
        );
        expect(resolved.config).toEqual({ "commit-emoji": "off", gate: "off" });
    });
});

describe("enigmaInstallArgv", () => {
    it("never opens the picker, which would hang a session nobody is watching", () => {
        expect(enigmaInstallArgv(DEFAULT_ENIGMA)).toEqual(["install", "--all", "--yes"]);
    });

    it("spells policies only as the parts left out, since the CLI has no --policies flag", () => {
        const argv = enigmaInstallArgv({ ...DEFAULT_ENIGMA, scope: "policies" });
        expect(argv).not.toContain("--policies");
        expect(argv).toContain("--no-hooks");
        expect(argv).toContain("--skip");
        expect(argv[argv.indexOf("--skip") + 1]).toBe("commands,dashboard,statusline,mcp");
    });

    it("leaves extra parts out, but never passes --skip to a version that predates it", () => {
        expect(enigmaInstallArgv(DEFAULT_ENIGMA, ["stop-hook"])).toEqual(["install", "--all", "--yes", "--skip", "stop-hook"]);
        expect(enigmaInstallArgv({ ...DEFAULT_ENIGMA, version: "1.72.2" }, ["stop-hook"])).toEqual(["install", "--all", "--yes"]);
        expect(enigmaInstallArgv({ ...DEFAULT_ENIGMA, version: "latest" }, ["stop-hook"])).toEqual(["install", "--all", "--yes"]);
    });
});

describe("enigmaHasHostCli", () => {
    it("is true from 1.73.0 on, and false for anything that is not an exact version", () => {
        expect(enigmaHasHostCli(ENIGMA_VERSION)).toBe(true);
        expect(enigmaHasHostCli("1.73.0")).toBe(true);
        expect(enigmaHasHostCli("1.80.1")).toBe(true);
        expect(enigmaHasHostCli("2.0.0")).toBe(true);
        expect(enigmaHasHostCli("1.72.9")).toBe(false);
        expect(enigmaHasHostCli("0.99.0")).toBe(false);
        expect(enigmaHasHostCli("^1.73.0")).toBe(false);
        expect(enigmaHasHostCli("latest")).toBe(false);
    });
});

describe("enigmaReleaseInstallScript", () => {
    it("checks the installer against its hash before running it, pinned to the version", () => {
        const script = enigmaReleaseInstallScript("1.73.0", "$HOME/.enigma/cli", "$HOME/.enigma/bin");
        expect(script).toContain(ENIGMA_INSTALLER_URL);
        expect(script).toContain(`[ "$sum" = "${ENIGMA_INSTALLER_SHA256}" ]`);
        expect(script).toContain("ENIGMA_INSTALL_VERSION=1.73.0");
        expect(script).toContain("ENIGMA_NO_SETUP=1");
        expect(script.indexOf("sha256sum")).toBeLessThan(script.indexOf('sh "$f"'));
    });

    it("reads the installer from the tag of the version Polaris ships", () => {
        expect(ENIGMA_INSTALLER_URL).toContain(`/v${ENIGMA_VERSION}/scripts/install.sh`);
        expect(ENIGMA_INSTALLER_SHA256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses a spec that is not an exact version, which would reach a shell", () => {
        expect(() => enigmaReleaseInstallScript("1.73.0; rm -rf /", "a", "b")).toThrow();
        expect(() => enigmaReleaseInstallScript("latest", "a", "b")).toThrow();
    });
});

describe("enigmaSetupScript", () => {
    it("installs the pinned release from GitHub, with npm only as the fallback", () => {
        const script = enigmaSetupScript(DEFAULT_ENIGMA);
        expect(script).toContain(`[ "$(enigma --version 2>/dev/null)" = "${ENIGMA_VERSION}" ]`);
        expect(script).toContain(ENIGMA_INSTALLER_SHA256);
        expect(script.indexOf(ENIGMA_INSTALLER_URL)).toBeLessThan(script.indexOf("npm install -g"));
    });

    it("installs a version spec that is not exact through npm, as before", () => {
        const script = enigmaSetupScript({ ...DEFAULT_ENIGMA, version: "^1.70.0" });
        expect(script).not.toContain(ENIGMA_INSTALLER_URL);
        expect(script).toContain("npm install -g --allow-scripts=enigma-cli enigma-cli@^1.70.0");
    });
});

describe("enigmaConfigArgv", () => {
    it("turns each setting into its own call", () => {
        expect(enigmaConfigArgv({ ...DEFAULT_ENIGMA, config: { "commit-emoji": "off" } })).toEqual([
            ["config", "commit-emoji", "off"]
        ]);
    });

    it("drops a key or value that is not a plain setting, rather than escaping and running it", () => {
        expect(
            enigmaConfigArgv({
                ...DEFAULT_ENIGMA,
                config: { "commit-emoji; rm -rf /": "off", gate: "off && curl evil" }
            })
        ).toEqual([]);
    });
});

describe("enigmaGateArgv", () => {
    it("carries the resolved gate to the machine as the setting the CLI has for it", () => {
        expect(enigmaGateArgv({ ...DEFAULT_ENIGMA, gate: "off" })).toEqual([
            "config",
            "gate",
            "off"
        ]);
        expect(enigmaGateArgv({ ...DEFAULT_ENIGMA, gate: "checks" })).toEqual([
            "config",
            "gate",
            "on"
        ]);
        expect(enigmaGateArgv({ ...DEFAULT_ENIGMA, gate: "full" })).toEqual([
            "config",
            "gate",
            "on"
        ]);
    });
});

describe("enigmaPackageSpec", () => {
    it("takes the version Polaris ships against when no tier pins one, and the pin when one does", () => {
        expect(enigmaPackageSpec(DEFAULT_ENIGMA)).toBe(`enigma-cli@${ENIGMA_VERSION}`);
        expect(enigmaPackageSpec({ ...DEFAULT_ENIGMA, version: "1.4.0" })).toBe("enigma-cli@1.4.0");
    });
});

describe("parseEnigmaSettings", () => {
    it("reads back what was stored", () => {
        expect(parseEnigmaSettings(JSON.stringify({ enabled: false, gate: "full" }))).toMatchObject(
            {
                enabled: false,
                gate: "full"
            }
        );
    });

    it("treats a value it cannot read as inherit rather than answering for the operator", () => {
        expect(parseEnigmaSettings("{not json")).toEqual(INHERIT_ENIGMA);
        expect(parseEnigmaSettings(JSON.stringify({ gate: "paranoid" })).gate).toBeNull();
        expect(parseEnigmaSettings(null)).toEqual(INHERIT_ENIGMA);
    });
});

describe("enigmaSkillsArgv", () => {
    it("switches off each skill once, in the configure script the agent's account runs", () => {
        const settings = { ...DEFAULT_ENIGMA, skillsOff: ["git-policy", "git-policy", "ci-policy"] };
        expect(enigmaSkillsArgv(settings)).toEqual([
            ["skills", "disable", "git-policy"],
            ["skills", "disable", "ci-policy"]
        ]);
        expect(enigmaConfigureScript(settings)).toContain("enigma skills disable git-policy ci-policy || {");
        expect(enigmaConfigureScript(settings)).toContain("enigma skills disable ci-policy || true");
        expect(enigmaConfigureScript({ ...settings, version: "1.72.2" })).toContain("enigma skills disable git-policy || true");
        expect(enigmaConfigureScript(DEFAULT_ENIGMA)).not.toContain("skills disable");
    });

    it("drops a name that is not a plain skill name rather than running it", () => {
        expect(enigmaSkillsArgv({ ...DEFAULT_ENIGMA, skillsOff: ["x; rm -rf /", "Git", "ok"] })).toEqual([
            ["skills", "disable", "ok"]
        ]);
    });

    it("lets the nearest tier with a list decide it, and reads back only plain names", () => {
        expect(resolveEnigma({ ...INHERIT_ENIGMA, skillsOff: ["a"] }, { ...INHERIT_ENIGMA, skillsOff: ["b"] }).skillsOff).toEqual(["a"]);
        expect(resolveEnigma().skillsOff).toEqual([]);
        expect(parseEnigmaSettings(JSON.stringify({ skillsOff: ["git-policy", 3, "Bad Name"] })).skillsOff).toEqual(["git-policy"]);
    });
});

describe("enigmaConfigureScript", () => {
    it("applies every setting in one call, with the gate last, and one call per value if that is refused", () => {
        const script = enigmaConfigureScript({ ...DEFAULT_ENIGMA, config: { "commit-emoji": "off", gate: "on" }, gate: "off" });
        expect(script).toContain("enigma config set commit-emoji=off gate=off >/dev/null || {");
        expect(script).toContain("enigma config commit-emoji off || true; enigma config gate off || true;");
        expect(script).not.toContain("gate=on");
    });

    it("keeps one call per setting for a version that predates config set", () => {
        const script = enigmaConfigureScript({ ...DEFAULT_ENIGMA, version: "1.72.2", config: { "commit-emoji": "off" } });
        expect(script).not.toContain("config set");
        expect(script).toContain("enigma config commit-emoji off || true");
        expect(script).toContain("enigma config gate on || true");
    });

    it("finds an enigma the release installer put next to the npm prefix", () => {
        expect(enigmaConfigureScript(DEFAULT_ENIGMA).split("\n")[0]).toBe('PATH="${NPM_CONFIG_PREFIX:-$HOME/.local}/bin:$PATH"');
    });
});
