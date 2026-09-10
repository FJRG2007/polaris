/**
 * The stepper names every step and what happened to it, so a screen reader and
 * a glance agree on where a deploy is.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { deploySteps } from "@/lib/deploy/deploy-steps";
import { DeployStepSegments, DeployStepper } from "@/app/(app)/apps/deploy/deploy-stepper";

const MIDWAY =
    "==> Fetching the source...\n==> Fetching the source: 2.0s\n==> Building the image...\n";

describe("the deploy stepper", () => {
    it("labels each step with its state and shows the time a finished one took", () => {
        const html = renderToStaticMarkup(
            <DeployStepper steps={deploySteps("deploying", MIDWAY)} />
        );
        expect(html).toContain('aria-label="Clone: done"');
        expect(html).toContain('aria-label="Build: in progress"');
        expect(html).toContain('aria-label="Live: not started"');
        expect(html).toContain("2.0s");
    });

    it("says in the compact row which step it is on", () => {
        const html = renderToStaticMarkup(
            <DeployStepSegments steps={deploySteps("deploying", MIDWAY)} />
        );
        expect(html).toContain("Build");
    });

    it("names the step that failed", () => {
        const html = renderToStaticMarkup(
            <DeployStepSegments steps={deploySteps("failed", `${MIDWAY}==> Failed: it broke\n`)} />
        );
        expect(html).toContain("text-danger-ink");
        expect(html).toContain("Build");
    });
});
