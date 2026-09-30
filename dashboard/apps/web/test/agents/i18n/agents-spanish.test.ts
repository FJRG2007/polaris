/**
 * The Agents app, in Spanish.
 *
 * Core names every execution place, trigger, state and policy in English, and
 * the agent services and shared schemas refuse in English. The screens say both
 * through the `agents` catalog, so the English catalog is held to core's own
 * words here and a sample is read in Spanish.
 */

import { describe, expect, it } from "vitest";
import { recommendExecution } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import { agentText, AGENT_WORD_GROUPS, agentWord, sessionStateWord, type AgentWordGroup } from "@/lib/agents/words";

const english = translatorFor("en-US", "agents");
const spanish = translatorFor("es-ES", "agents");

describe("the English core writes", () => {
    it("names every id of every group as core does", () => {
        for (const [group, labels] of Object.entries(AGENT_WORD_GROUPS)) {
            for (const [id, label] of Object.entries(labels)) {
                expect(agentWord(english, group as AgentWordGroup, id)).toBe(label);
            }
        }
    });

    it("gives every piece of advice back as it went in", () => {
        for (const publiclyReachable of [true, false]) {
            for (const serverCapable of [true, false]) {
                for (const servingPool of [true, false]) {
                    for (const isPrivate of [true, false]) {
                        const advice = recommendExecution({ publiclyReachable, serverCapable, servingPool, isPrivate });
                        expect(agentText(english, advice.reason)).toBe(advice.reason);
                        for (const reason of Object.values(advice.unavailable)) {
                            expect(agentText(english, reason ?? "")).toBe(reason);
                        }
                    }
                }
            }
        }
    });

    it("keeps a usage-limit refusal and a stored run reason word for word", () => {
        const limit =
            "Repositories under acme has used 5 of the 5 runs allowed in 1 day. An administrator sets these under Admin > Agents.";
        expect(agentText(english, limit)).toBe(limit);
        expect(agentText(english, "Canceled from Polaris.")).toBe("Canceled from Polaris.");
        expect(agentText(english, "Cancelled from Polaris.")).toBe("Canceled from Polaris.");
    });
});

describe("in Spanish", () => {
    it("names states and places", () => {
        expect(agentWord(spanish, "runState", "succeeded")).toBe("Correcto");
        expect(sessionStateWord(spanish, "idle", false)).toBe("Iniciando");
        expect(agentWord(spanish, "trigger", "pr.review_requested")).toBe("Revisión pedida");
        expect(agentWord(spanish, "trigger", "something-new")).toBe("something-new");
    });

    it("reads a limit and a run that was stopped", () => {
        expect(
            agentText(spanish, "This account has used 3 of the 10 tokens allowed in 30 days. An administrator sets these under Admin > Agents.")
        ).toBe("Esta cuenta ha usado 3 de 10 tokens permitidos en 30 días. Un administrador los define en Admin > Agentes.");
        expect(agentText(spanish, "Canceled from Polaris.")).toBe("Cancelada desde Polaris.");
        expect(agentText(spanish, "Cancelled from Polaris.")).toBe("Cancelada desde Polaris.");
        expect(agentText(spanish, "GitHub returned 422 starting the workflow")).toBe("GitHub devolvió 422 al iniciar el workflow");
    });
});
