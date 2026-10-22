/**
 * The weekly rebuild in dashboard-publish.yml.
 *
 * An image whose own files never change keeps the base image it was first
 * built on, CVEs and all. The schedule rebuilds every image, so it has to be
 * treated exactly like a manual run: every filter on, every image job allowed.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(
    join(__dirname, "..", "..", "..", "..", "..", ".github", "workflows", "dashboard-publish.yml"),
    "utf8"
);

describe("dashboard-publish schedule", () => {
    it("runs on a weekly schedule", () => {
        expect(WORKFLOW).toMatch(/\n {2}schedule:\n {4}- cron: "\d+ \d+ \* \* \d"\n/);
    });

    it("rebuilds every image on a scheduled run, the same as a manual one", () => {
        expect(WORKFLOW).toContain(
            '[ "$EVENT" = "workflow_dispatch" ] || [ "$EVENT" = "schedule" ]'
        );
    });

    it("lets every job a manual run forces also run on the schedule", () => {
        const conditions = WORKFLOW.split("\n").filter((line) =>
            /^\s+if: .*github\.event_name == 'workflow_dispatch'/.test(line)
        );
        expect(conditions.length).toBeGreaterThan(10);
        for (const line of conditions) expect(line).toContain("github.event_name == 'schedule'");
    });

    it("keeps one publish queue that never cancels the running build", () => {
        expect(WORKFLOW).toContain(
            "group: dashboard-publish${{ inputs.dry_run && '-dry-run' || '' }}"
        );
        expect(WORKFLOW).toContain("cancel-in-progress: false");
    });
});
