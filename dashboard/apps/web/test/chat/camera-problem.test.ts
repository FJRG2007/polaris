import { describe, expect, it } from "vitest";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { CameraFailure, cameraProblemText, problemOf } from "@/app/(app)/chat/camera-problem";

/** A translator that answers the key and its arguments, so a test can see which
 *  sentence was picked without loading a catalog. */
const t = ((key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key) as unknown as NamespaceTranslator<"chat">;

describe("what went wrong", () => {
    it("keeps Polaris's own failures as a code to translate", () => {
        expect(problemOf(new CameraFailure("noModel"))).toEqual({ code: "noModel", said: null });
        expect(cameraProblemText({ code: "noModel", said: null }, t)).toBe("cameraProblem.noModel");
    });

    it("passes the browser's own words through untranslated", () => {
        const problem = problemOf(new Error("  Out of   memory "));
        expect(problem).toEqual({ code: "said", said: "Out of memory" });
        expect(cameraProblemText(problem, t)).toBe("Out of memory");
    });

    it("puts the driver's words inside Polaris's sentence", () => {
        const problem = problemOf(new CameraFailure("graphics", "ERROR: 0:1: bad"));
        expect(cameraProblemText(problem, t)).toBe('cameraProblem.graphicsSaid {"said":"ERROR: 0:1: bad"}');
        expect(cameraProblemText({ code: "graphics", said: null }, t)).toBe("cameraProblem.graphics");
    });

    it("says it said nothing when nothing was said", () => {
        expect(problemOf(new Error(""))).toEqual({ code: "silent", said: null });
        expect(problemOf(undefined)).toEqual({ code: "silent", said: null });
    });

    it("cuts a long message short", () => {
        const said = problemOf(new Error("x ".repeat(200))).said ?? "";
        expect(said.length).toBe(160);
        expect(said.endsWith("...")).toBe(true);
    });
});
