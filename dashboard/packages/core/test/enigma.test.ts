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
    INHERIT_ENIGMA,
    enigmaConfigArgv,
    enigmaGateArgv,
    enigmaInstallArgv,
    enigmaPackageSpec,
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
        expect(resolveEnigma({ ...INHERIT_ENIGMA, enabled: false }, { ...INHERIT_ENIGMA, enabled: true }).enabled).toBe(
            false
        );
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
        expect(enigmaInstallArgv(DEFAULT_ENIGMA)).toContain("--yes");
    });

    it("takes whatever ships when no version is pinned, and the pin when one is", () => {
        expect(enigmaInstallArgv(DEFAULT_ENIGMA)).toContain("enigma-cli");
        expect(enigmaInstallArgv({ ...DEFAULT_ENIGMA, version: "1.4.0" })).toContain("enigma-cli@1.4.0");
    });

    it("installs less when asked for policies only", () => {
        expect(enigmaInstallArgv({ ...DEFAULT_ENIGMA, scope: "policies" })).toContain("--policies");
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
        expect(enigmaGateArgv({ ...DEFAULT_ENIGMA, gate: "off" })).toEqual(["config", "gate", "off"]);
        expect(enigmaGateArgv({ ...DEFAULT_ENIGMA, gate: "checks" })).toEqual(["config", "gate", "on"]);
        expect(enigmaGateArgv({ ...DEFAULT_ENIGMA, gate: "full" })).toEqual(["config", "gate", "on"]);
    });
});

describe("enigmaPackageSpec", () => {
    it("is the same spec the install uses, so the settings reach the version that was installed", () => {
        expect(enigmaInstallArgv({ ...DEFAULT_ENIGMA, version: "1.4.0" })).toContain(
            enigmaPackageSpec({ ...DEFAULT_ENIGMA, version: "1.4.0" })
        );
        expect(enigmaPackageSpec(DEFAULT_ENIGMA)).toBe("enigma-cli");
    });
});

describe("parseEnigmaSettings", () => {
    it("reads back what was stored", () => {
        expect(parseEnigmaSettings(JSON.stringify({ enabled: false, gate: "full" }))).toMatchObject({
            enabled: false,
            gate: "full"
        });
    });

    it("treats a value it cannot read as inherit rather than answering for the operator", () => {
        expect(parseEnigmaSettings("{not json")).toEqual(INHERIT_ENIGMA);
        expect(parseEnigmaSettings(JSON.stringify({ gate: "paranoid" })).gate).toBeNull();
        expect(parseEnigmaSettings(null)).toEqual(INHERIT_ENIGMA);
    });
});
