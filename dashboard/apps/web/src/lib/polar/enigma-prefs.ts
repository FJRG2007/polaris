/**
 * The Enigma settings a person changes from Polar's settings, and how they map
 * onto their own tier of `EnigmaSettings`.
 *
 * Each key and value is one the pinned CLI accepts (`enigma config <key>
 * <value>`), checked against its settings registry. Only a value that differs
 * from Enigma's own default is stored, so a session runs no call that changes
 * nothing. Pure, and safe to import from the client.
 */

import { z } from "zod";
import * as core from "@polaris/core";

const LEVELS = ["off", "lite", "full", "ultra"] as const;
const SEVERITIES = ["error", "warning", "info"] as const;

/** The settings with several values, each with Enigma's own default. */
export const ENIGMA_CHOICES = {
    "output-style": { values: LEVELS, fallback: "off" },
    "minimal-code": { values: LEVELS, fallback: "full" },
    "gate-severity": { values: SEVERITIES, fallback: "warning" }
} as const;

/** The on/off settings, each with Enigma's own default. The gate is not here:
 *  it is a field of its own on `EnigmaSettings`. */
export const ENIGMA_TOGGLES = {
    "commit-emoji": true,
    recall: false,
    "code-graph": true,
    compress: false,
    guardrails: true,
    verify: true
} as const;

export type EnigmaChoiceKey = keyof typeof ENIGMA_CHOICES;
export type EnigmaToggleKey = keyof typeof ENIGMA_TOGGLES;
export const ENIGMA_CHOICE_KEYS = Object.keys(ENIGMA_CHOICES) as EnigmaChoiceKey[];
export const ENIGMA_TOGGLE_KEYS = Object.keys(ENIGMA_TOGGLES) as EnigmaToggleKey[];

export const enigmaPrefsSchema = z.object({
    enabled: z.boolean(),
    gate: z.boolean(),
    choices: z.object({
        "output-style": z.enum(LEVELS),
        "minimal-code": z.enum(LEVELS),
        "gate-severity": z.enum(SEVERITIES)
    }),
    toggles: z.object({
        "commit-emoji": z.boolean(),
        recall: z.boolean(),
        "code-graph": z.boolean(),
        compress: z.boolean(),
        guardrails: z.boolean(),
        verify: z.boolean()
    }),
    skillsOff: z
        .array(z.string().regex(core.ENIGMA_SKILL_NAME))
        .max(core.ENIGMA_SKILLS_OFF_MOST)
});
export type EnigmaPrefs = z.infer<typeof enigmaPrefsSchema>;

/** What a resolved setup shows on the settings screen. */
export function enigmaPrefsOf(resolved: core.ResolvedEnigma): EnigmaPrefs {
    const choice = <K extends EnigmaChoiceKey>(key: K) => {
        const value = resolved.config[key];
        const known = ENIGMA_CHOICES[key].values as readonly string[];
        return (value && known.includes(value) ? value : ENIGMA_CHOICES[key].fallback) as EnigmaPrefs["choices"][K];
    };
    const toggle = (key: EnigmaToggleKey) => {
        const value = resolved.config[key];
        return value === "on" ? true : value === "off" ? false : ENIGMA_TOGGLES[key];
    };
    return {
        enabled: resolved.enabled,
        gate: resolved.gate !== "off",
        choices: {
            "output-style": choice("output-style"),
            "minimal-code": choice("minimal-code"),
            "gate-severity": choice("gate-severity")
        },
        toggles: Object.fromEntries(
            ENIGMA_TOGGLE_KEYS.map((key) => [key, toggle(key)])
        ) as EnigmaPrefs["toggles"],
        skillsOff: [...resolved.skillsOff]
    };
}

/**
 * A person's own tier with `prefs` applied. Every other config key they set
 * elsewhere is kept. A value that matches what the tiers beneath resolve to
 * (`inherited`) is left to them rather than stored, so a session runs no call
 * that changes nothing; any other value is stored, even Enigma's own default,
 * so it holds over an administrator's different one.
 */
export function applyEnigmaPrefs(
    own: core.EnigmaSettings,
    prefs: EnigmaPrefs,
    inherited: core.ResolvedEnigma
): core.EnigmaSettings {
    const beneath = enigmaPrefsOf(inherited);
    const config: Record<string, string> = { ...(own.config ?? {}) };
    for (const key of ENIGMA_CHOICE_KEYS) {
        if (prefs.choices[key] === beneath.choices[key]) delete config[key];
        else config[key] = prefs.choices[key];
    }
    for (const key of ENIGMA_TOGGLE_KEYS) {
        if (prefs.toggles[key] === beneath.toggles[key]) delete config[key];
        else config[key] = prefs.toggles[key] ? "on" : "off";
    }
    // A gate left on keeps the mode this tier already names; one turned on
    // takes the inherited mode, or the default where the inherited one is off.
    const gate = !prefs.gate
        ? "off"
        : own.gate && own.gate !== "off"
          ? own.gate
          : beneath.gate
            ? null
            : core.DEFAULT_ENIGMA.gate;
    return {
        ...own,
        enabled: prefs.enabled === beneath.enabled ? null : prefs.enabled,
        gate,
        config: Object.keys(config).length > 0 ? config : null,
        skillsOff: [...new Set(prefs.skillsOff)].sort()
    };
}
