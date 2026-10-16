/**
 * Who may move a domain: every action asks for `domains.manage` on the domain's
 * project, and somebody without it is answered with a sentence and nothing runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DOMAIN = "0192f1e2-7b5c-7d3e-8f00-00000000000d";
const TARGET = "0192f1e2-7b5c-7d3e-8f00-0000000000a2";

const state = vi.hoisted(() => ({
    allowed: true,
    asked: [] as string[],
    calls: [] as string[]
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "user-1" }) }));
vi.mock("@/app/(app)/apps/deploy/reply", () => ({ reply: async (key: string) => key }));
vi.mock("@/lib/deploy-project-access", () => ({
    requireDomainAccess: async (_domainId: string, _userId: string, capability: string) => {
        state.asked.push(capability);
        if (!state.allowed) throw new Error("Service not found");
        return { environmentIds: null };
    }
}));
vi.mock("@/lib/deploy/dns-cutover-service", () => {
    class CutoverRefusedError extends Error {
        constructor(readonly reason: string) {
            super(reason);
        }
    }
    const record = (name: string) => async () => {
        state.calls.push(name);
    };
    return {
        CutoverRefusedError,
        cutoverPanel: async () => {
            state.calls.push("panel");
            return { cutover: null, targets: [] };
        },
        startCutover: async () => {
            state.calls.push("start");
            throw new CutoverRefusedError("same-service");
        },
        openCutoverId: async () => "cutover-1",
        switchCutover: record("switch"),
        rollbackCutover: record("rollback")
    };
});

import * as actions from "@/app/(app)/apps/deploy/dns-cutover-actions";

beforeEach(() => {
    state.allowed = true;
    state.asked = [];
    state.calls = [];
});

describe("the domain move actions", () => {
    it("refuse somebody who cannot manage the project's domains, and run nothing", async () => {
        state.allowed = false;
        const replies = await Promise.all([
            actions.cutoverPanelAction(DOMAIN),
            actions.startCutoverAction({ domainId: DOMAIN, targetApplicationId: TARGET }),
            actions.switchCutoverAction(DOMAIN),
            actions.rollbackCutoverAction(DOMAIN)
        ]);
        for (const reply of replies) expect(reply).toEqual({ error: "cutover.notAllowed" });
        expect(state.calls).toEqual([]);
        expect(new Set(state.asked)).toEqual(new Set(["domains.manage"]));
    });

    it("let a domain manager switch and roll back, answering with the panel", async () => {
        expect(await actions.switchCutoverAction(DOMAIN)).toEqual({
            panel: { cutover: null, targets: [] }
        });
        await actions.rollbackCutoverAction(DOMAIN);
        expect(state.calls).toEqual(["switch", "panel", "rollback", "panel"]);
    });

    it("turn a refusal of the service into its sentence", async () => {
        expect(
            await actions.startCutoverAction({ domainId: DOMAIN, targetApplicationId: TARGET })
        ).toEqual({
            error: "cutover.refused.same-service"
        });
    });

    it("refuse an input that is not a domain and a service", async () => {
        expect(
            await actions.startCutoverAction({ domainId: "nope", targetApplicationId: TARGET })
        ).toEqual({
            error: "cutover.chooseTarget"
        });
        expect(await actions.switchCutoverAction("../etc")).toEqual({
            error: "cutover.notAllowed"
        });
        expect(state.asked).toEqual([]);
    });
});
