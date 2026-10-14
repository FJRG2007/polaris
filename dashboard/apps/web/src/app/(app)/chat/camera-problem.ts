/**
 * Why a camera background could not be built, in a form a screen can translate.
 *
 * Polaris's own sentences travel as a code, so each reader gets them in their
 * language. What the browser or the graphics driver said travels as it is, in
 * `said`: those words are the only ones that tell "out of memory" apart from a
 * driver bug, and they are not Polaris's to translate.
 */

import type { NamespaceTranslator } from "@/lib/i18n/types";

export type CameraProblemCode =
    | "noCanvas"
    | "noVideoOut"
    | "noWebgl"
    | "noModel"
    | "graphics"
    | "tooSlow"
    | "silent"
    | "said";

export interface CameraProblem {
    readonly code: CameraProblemCode;
    /** The browser's or the driver's own words, when there were any. */
    readonly said: string | null;
}

/** A failure Polaris can name, thrown from deep in the pipeline. */
export class CameraFailure extends Error {
    readonly code: CameraProblemCode;
    readonly said: string | null;

    constructor(code: CameraProblemCode, said: string | null = null) {
        super(said ? `${code}: ${said}` : code);
        this.name = "CameraFailure";
        this.code = code;
        this.said = said;
    }
}

/** Whatever was thrown, as a problem: a `CameraFailure` as itself, anything
 *  else as the browser's own words. */
export function problemOf(caught: unknown): CameraProblem {
    if (caught instanceof CameraFailure) return { code: caught.code, said: clip(caught.said) };
    const message = caught instanceof Error ? caught.message : String(caught ?? "");
    const said = clip(message);
    return said ? { code: "said", said } : { code: "silent", said: null };
}

/** The problem in the reader's language. */
export function cameraProblemText(problem: CameraProblem, t: NamespaceTranslator<"chat">): string {
    switch (problem.code) {
        case "noCanvas":
            return t("cameraProblem.noCanvas");
        case "noVideoOut":
            return t("cameraProblem.noVideoOut");
        case "noWebgl":
            return t("cameraProblem.noWebgl");
        case "noModel":
            return t("cameraProblem.noModel");
        case "graphics":
            return problem.said
                ? t("cameraProblem.graphicsSaid", { said: problem.said })
                : t("cameraProblem.graphics");
        case "tooSlow":
            return t("cameraProblem.tooSlow");
        case "said":
            return problem.said ?? t("cameraProblem.silent");
        case "silent":
            return t("cameraProblem.silent");
    }
}

function clip(text: string | null): string | null {
    const said = (text ?? "").trim().replace(/\s+/g, " ");
    if (!said) return null;
    return said.length > 160 ? `${said.slice(0, 157)}...` : said;
}
