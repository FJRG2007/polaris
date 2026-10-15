/**
 * The promotion dialog and history build their keys from codes the server
 * writes, so the type checker cannot see them: every code has its words in
 * every locale here.
 */

import { describe, expect, it } from "vitest";
import { ENVIRONMENT_STAGES } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";

const REASONS = ["missing", "engine", "dataFailed", "builtDifferently", "noImage", "otherRepository", "notDeployed"];
const STATUSES = ["running", "succeeded", "partial", "failed"];
const OUTCOMES = ["deployed", "copied", "skipped", "failed"];

describe("promotion words", () => {
    for (const locale of ["en-US", "es-ES"] as const) {
        it(`has every stage, reason, status and outcome in ${locale}`, () => {
            const say = translatorFor(locale, "deploySettings");
            const keys = [
                ...ENVIRONMENT_STAGES.map((stage) => `environments.stages.${stage}`),
                ...REASONS.map((reason) => `promotion.reasons.${reason}`),
                ...STATUSES.map((status) => `promotion.status.${status}`),
                ...OUTCOMES.map((outcome) => `promotion.outcome.${outcome}`),
                "promotion.notes.tagOnly"
            ];
            for (const key of keys) {
                const words = say(key, { name: "fixture" });
                expect(words, key).not.toBe(key);
                expect(words, key).not.toMatch(/[–—]/);
            }
        });
    }
});
