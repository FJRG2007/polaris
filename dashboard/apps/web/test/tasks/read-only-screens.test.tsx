/**
 * What a reader who may not manage work is offered.
 *
 * `tasks.read` and `tasks.manage` are two permissions, and the screens used to
 * ask only which spaces somebody reached. Somebody holding the first and a place
 * on a space's roster was drawn the whole editing surface - new sprint, new goal,
 * delete, the status picker - and every one of those calls an action that
 * requires the second, which does not answer with an explanation but sends them
 * to their home page.
 *
 * So the assertion is the affordances themselves: what is not offered cannot be
 * pressed, and there is nothing left to explain.
 */

import { describe, expect, it, vi } from "vitest";
import { DISPLAY_DEFAULTS } from "@polaris/core";
import { renderToStaticMarkup } from "react-dom/server";
import { DisplayFormatProvider } from "@/components/display-format";
import { GoalsView, SprintsView } from "@/app/(app)/tasks/planning-view";

// The views reach for the server actions at import time, and those drag in the
// database and the session. Nothing here presses a button, so they are stubbed.
vi.mock("@/app/(app)/tasks/actions", () => ({}));

const SPACES = [{ id: "s1", name: "Engineering" }];

const SPRINT = {
    id: "sp1",
    spaceId: "s1",
    spaceName: "Engineering",
    name: "Sprint 14",
    status: "active" as const,
    startDate: "2026-08-01T00:00:00.000Z",
    endDate: "2026-08-14T00:00:00.000Z",
    taskCount: 4,
    doneCount: 1,
    points: 0,
    donePoints: 0
};

const GOAL = {
    id: "g1",
    name: "Ship the new billing flow",
    color: "#7c3aed",
    ownerName: "Ana Ruiz",
    dueDate: null,
    completedAt: null,
    percent: 40,
    targets: []
};

function draw(node: React.ReactNode): string {
    return renderToStaticMarkup(
        <DisplayFormatProvider preferences={DISPLAY_DEFAULTS}>{node}</DisplayFormatProvider>
    );
}

describe("sprints, for somebody who may not manage work", () => {
    it("offers no way to start or delete one", () => {
        const markup = draw(
            <SprintsView sprints={[SPRINT]} spaces={SPACES} burndowns={{}} canEdit={false} />
        );
        expect(markup).toContain("Sprint 14");
        expect(markup).not.toContain("New sprint");
        expect(markup).not.toContain(`Delete ${SPRINT.name}`);
    });

    it("still offers both to somebody who may", () => {
        const markup = draw(
            <SprintsView sprints={[SPRINT]} spaces={SPACES} burndowns={{}} canEdit />
        );
        expect(markup).toContain("New sprint");
        expect(markup).toContain(`Delete ${SPRINT.name}`);
    });
});

describe("goals, for somebody who may not manage work", () => {
    it("offers no way to start, delete or add a target", () => {
        const markup = draw(<GoalsView goals={[GOAL]} spaces={SPACES} lists={[]} canEdit={false} />);
        expect(markup).toContain(GOAL.name);
        expect(markup).not.toContain("New goal");
        expect(markup).not.toContain(`Delete ${GOAL.name}`);
        expect(markup).not.toContain("Target</button>");
    });

    it("still offers them to somebody who may", () => {
        const markup = draw(<GoalsView goals={[GOAL]} spaces={SPACES} lists={[]} canEdit />);
        expect(markup).toContain("New goal");
        expect(markup).toContain(`Delete ${GOAL.name}`);
    });
});
