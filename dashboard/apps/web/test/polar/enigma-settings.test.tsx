// @vitest-environment jsdom
/**
 * Enigma on Polar's settings: the stored form of what a person picks, and the
 * Skills page's Enigma group with a switch per skill.
 */

import * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { applyEnigmaPrefs, enigmaPrefsOf, enigmaPrefsSchema, type EnigmaPrefs } from "@/lib/polar/enigma-prefs";

const saved: EnigmaPrefs[] = [];

vi.mock("@/app/(app)/polar/settings/skills-actions", () => ({
    saveEnigmaAction: async (prefs: EnigmaPrefs) => {
        saved.push(prefs);
        return { ok: true, value: null };
    }
}));

const { EnigmaSettings } = await import("@/app/(app)/polar/settings/enigma-settings");

const DEFAULTS = enigmaPrefsOf(core.DEFAULT_ENIGMA);
const SKILLS = [
    { name: "git-policy", description: "Commits and branches." },
    { name: "ci-policy", description: "Pipelines." }
];

afterEach(() => {
    cleanup();
    saved.length = 0;
});

describe("Enigma preferences", () => {
    it("shows Enigma's own defaults when nothing is set, and stores nothing for them", () => {
        expect(DEFAULTS).toMatchObject({
            enabled: true,
            gate: true,
            choices: { "output-style": "off", "minimal-code": "full", "gate-severity": "warning" },
            toggles: { "commit-emoji": true, recall: false, "code-graph": true, verify: true },
            skillsOff: []
        });
        expect(applyEnigmaPrefs(core.INHERIT_ENIGMA, DEFAULTS, core.DEFAULT_ENIGMA)).toEqual({ ...core.INHERIT_ENIGMA, skillsOff: [] });
    });

    it("stores only what differs, as the values the CLI takes, and keeps other keys", () => {
        const own = { ...core.INHERIT_ENIGMA, config: { "verify-command": "npm test", recall: "on" } };
        const stored = applyEnigmaPrefs(own, {
            ...DEFAULTS,
            enabled: false,
            gate: false,
            choices: { ...DEFAULTS.choices, "output-style": "ultra" },
            toggles: { ...DEFAULTS.toggles, recall: false, "commit-emoji": false },
            skillsOff: ["git-policy", "ci-policy", "git-policy"]
        }, core.DEFAULT_ENIGMA);
        expect(stored).toEqual({
            ...own,
            enabled: false,
            gate: "off",
            config: { "verify-command": "npm test", "output-style": "ultra", "commit-emoji": "off" },
            skillsOff: ["ci-policy", "git-policy"]
        });
        expect(enigmaPrefsOf(core.resolveEnigma(stored))).toMatchObject({
            enabled: false,
            gate: false,
            choices: { "output-style": "ultra" },
            toggles: { "commit-emoji": false, recall: false }
        });
    });

    it("stores Enigma's own default when the instance beneath decides otherwise", () => {
        const inherited = core.resolveEnigma({
            ...core.INHERIT_ENIGMA,
            enabled: false,
            gate: "off",
            config: { recall: "on" }
        });
        const stored = applyEnigmaPrefs(core.INHERIT_ENIGMA, DEFAULTS, inherited);
        expect(stored).toMatchObject({ enabled: true, gate: core.DEFAULT_ENIGMA.gate, config: { recall: "off" } });
        expect(enigmaPrefsOf(core.resolveEnigma(stored, inherited))).toEqual(DEFAULTS);
    });

    it("refuses a value Enigma does not take and a name that is not a skill name", () => {
        expect(enigmaPrefsSchema.safeParse(DEFAULTS).success).toBe(true);
        expect(
            enigmaPrefsSchema.safeParse({ ...DEFAULTS, choices: { ...DEFAULTS.choices, "output-style": "max" } }).success
        ).toBe(false);
        expect(enigmaPrefsSchema.safeParse({ ...DEFAULTS, skillsOff: ["x; rm -rf /"] }).success).toBe(false);
    });
});

describe("the Enigma group on the Skills page", () => {
    it("lists each skill with a switch, and saves the one switched off", async () => {
        render(<EnigmaSettings initial={DEFAULTS} available skills={SKILLS} readOnly={false} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Enigma skills")).toBeTruthy();
        const git = screen.getByLabelText("Use git-policy");
        expect(screen.getByLabelText("Use ci-policy")).toBeTruthy();
        fireEvent.click(git);
        await waitFor(() => expect(saved).toHaveLength(1));
        expect(saved[0]!.skillsOff).toEqual(["git-policy"]);
    });

    it("says the list is unavailable rather than showing an empty one", () => {
        render(<EnigmaSettings initial={DEFAULTS} available={false} skills={[]} readOnly={false} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("The skill list can't be loaded right now.")).toBeTruthy();
    });

    it("hides the settings and skills while Enigma is off", () => {
        render(
            <EnigmaSettings initial={{ ...DEFAULTS, enabled: false }} available skills={SKILLS} readOnly={false} />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByLabelText("Use git-policy")).toBeNull();
        expect(screen.getByLabelText("Use Enigma")).toBeTruthy();
    });
});
