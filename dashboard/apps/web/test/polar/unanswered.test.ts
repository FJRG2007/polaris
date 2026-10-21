/**
 * A turn that ends on its tool steps with nothing said: the last step is made to
 * answer, and if an answer still comes back empty the screen names it.
 */

import { describe, expect, it } from "vitest";
import { nextStep } from "@/lib/polar/tool-relevance";
import { answeredNothing } from "@/lib/polar/unanswered";

const activeFor = (found: ReadonlySet<string>) => ["always", ...found];
const found = [{ toolResults: [{ toolName: "find_tools", output: { tools: [{ name: "deploy_list" }] } }] }];

describe("the next step of a turn", () => {
    it("changes nothing while tools are left and none were found", () => {
        expect(nextStep(0, 12, [], activeFor)).toBeUndefined();
    });

    it("sends what find_tools turned up", () => {
        expect(nextStep(3, 12, found, activeFor)).toEqual({ activeTools: ["always", "deploy_list"] });
    });

    it("may call no tool on the last step, so the turn ends in an answer", () => {
        expect(nextStep(11, 12, [], activeFor)).toEqual({ toolChoice: "none" });
        expect(nextStep(11, 12, found, activeFor)).toEqual({
            activeTools: ["always", "deploy_list"],
            toolChoice: "none"
        });
    });
});

describe("an answer that said nothing", () => {
    it("is only steps", () => {
        expect(answeredNothing([{ type: "step-start" }, { type: "tool-deploy_list", state: "output-available" }])).toBe(true);
        expect(answeredNothing([{ type: "reasoning", text: "Looking" }, { type: "text", text: "  " }])).toBe(true);
    });

    it("is not one with text, a failure, a picture, or a call waiting on the person", () => {
        expect(answeredNothing([{ type: "text", text: "PHP 8.3" }])).toBe(false);
        expect(answeredNothing([{ type: "data-polar-failure" }])).toBe(false);
        expect(answeredNothing([{ type: "tool-polar_show", state: "output-available" }])).toBe(false);
        expect(answeredNothing([{ type: "file" }])).toBe(false);
        expect(answeredNothing([{ type: "tool-deploy_delete", state: "approval-requested" }])).toBe(false);
    });
});
