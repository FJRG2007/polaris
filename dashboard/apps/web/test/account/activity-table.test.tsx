/**
 * What the audit table puts on screen. It is the one surface both the account's
 * own history and the administrator's global feed are read through, so its
 * contract is asserted once: the dotted action code reads as a sentence, the
 * second column is named by whoever mounted it, and the states that are not rows
 * (loading, failed, empty) say what happened instead of drawing an empty frame.
 *
 * The action column carries the answer to "what happened", so it is never the
 * one a narrow screen drops - the context is repeated inside it instead.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityTable, type ActivityRow } from "@/components/activity-table";

function row(overrides: Partial<ActivityRow> = {}): ActivityRow {
    return {
        id: "entry-1",
        at: "2026-08-03T10:00:00.000Z",
        context: "Chrome on Windows",
        action: "drive.file.uploaded",
        metadata: '{"path":"/photos"}',
        ...overrides
    };
}

function render(props: Partial<Parameters<typeof ActivityTable>[0]> = {}): string {
    return renderToStaticMarkup(
        <ActivityTable
            rows={[row()]}
            loading={false}
            error={null}
            contextLabel="Session"
            emptyLabel="Nothing recorded yet."
            {...props}
        />
    );
}

describe("the activity table", () => {
    it("reads a dotted action code as a sentence, keeping the code itself to hand", () => {
        const markup = render();
        expect(markup).toContain("Drive file uploaded");
        expect(markup).toContain('title="drive.file.uploaded"');
    });

    it("is named by the screen that mounted it rather than assuming one reader", () => {
        expect(render()).toContain(">Session</th>");
        expect(render({ contextLabel: "Who" })).toContain(">Who</th>");
    });

    it("keeps what happened on screen when the columns beside it are dropped", () => {
        const markup = render();
        // The action column carries no responsive class of its own, and the
        // context it loses on a phone is repeated inside it.
        expect(markup.match(/Chrome on Windows/g)).toHaveLength(2);
        expect(markup).toContain("lg:hidden");
    });

    it("scrolls rather than clipping a row too wide for the screen", () => {
        expect(render()).toContain("overflow-x-auto");
    });

    it("shows what an entry was aimed at, which is all a phone gets of the detail", () => {
        expect(render({ rows: [row({ detail: "file f-1" })] })).toContain("file f-1");
    });

    it("explains an empty log instead of showing an empty frame", () => {
        expect(render({ rows: [] })).toContain("Nothing recorded yet.");
    });

    it("says why there is nothing rather than reading as an empty log", () => {
        const markup = render({ rows: null, error: "Could not load your activity." });
        expect(markup).toContain("Could not load your activity.");
        expect(markup).not.toContain("Nothing recorded yet.");
    });

    it("sketches the rows it is waiting for, so the table does not jump", () => {
        const markup = render({ rows: null, loading: true });
        expect(markup).not.toContain("Nothing recorded yet.");
        expect(markup).toContain("animate-pulse");
    });
});
