/**
 * Mapping somebody else's tracker onto ours.
 *
 * Two things here decide whether a connected board is usable or nonsense. The
 * status mapping, because a tracker whose states all land in one column is a
 * board nobody will look at twice. And the rich-text flattening, because Jira
 * hands over a document tree and a task description that shows JSON is a task
 * nobody can read.
 */

import { describe, expect, it } from "vitest";
import {
    ISSUE_TRACKERS,
    ISSUE_TRACKER_FIELDS,
    flattenRichText,
    isIssueTracker,
    isTrackerSite,
    linkedDescription,
    linkedName,
    normalizeTrackerSite,
    statusTypeFromName,
    statusTypeFromTracker,
    type TrackerIssue
} from "../src/trackers.js";

describe("the catalogue", () => {
    it("says what every tracker needs, with exactly one secret each", () => {
        for (const tracker of ISSUE_TRACKERS) {
            const fields = ISSUE_TRACKER_FIELDS[tracker];
            expect(fields.length, tracker).toBeGreaterThan(0);
            expect(fields.filter((field) => field.secret).length, tracker).toBe(1);
            for (const field of fields) expect(field.hint, `${tracker}.${field.key}`).not.toBe("");
        }
    });

    it("refuses a stored value naming a tracker this build does not have", () => {
        expect(isIssueTracker("linear")).toBe(true);
        expect(isIssueTracker("shortcut")).toBe(false);
    });
});

describe("statusTypeFromTracker", () => {
    it("reads Linear's own state kinds rather than its names", () => {
        expect(statusTypeFromTracker("linear", "started", "Ready for review")).toBe("active");
        expect(statusTypeFromTracker("linear", "completed", "Shipped")).toBe("done");
        expect(statusTypeFromTracker("linear", "canceled", "Nope")).toBe("closed");
        expect(statusTypeFromTracker("linear", "backlog", "Icebox")).toBe("open");
    });

    it("reads Jira's three categories", () => {
        expect(statusTypeFromTracker("jira", "indeterminate", "Codificando")).toBe("active");
        expect(statusTypeFromTracker("jira", "done", "Cerrado")).toBe("done");
        expect(statusTypeFromTracker("jira", "new", "Pendiente")).toBe("open");
    });

    it("falls back to the name when the category is one it does not know", () => {
        expect(statusTypeFromTracker("jira", "", "In Review")).toBe("active");
        expect(statusTypeFromTracker("linear", "mystery", "Blocked on design")).toBe("blocked");
    });

    it("puts anything it cannot place in the column that means untouched", () => {
        expect(statusTypeFromName("Zzzz")).toBe("open");
    });

    it("does not read a cancelled state as finished, which is a different column", () => {
        expect(statusTypeFromName("Won't do")).toBe("closed");
        expect(statusTypeFromName("Duplicate")).toBe("closed");
    });
});

describe("flattenRichText", () => {
    it("takes the words out of a document tree", () => {
        const doc = {
            type: "doc",
            content: [
                { type: "paragraph", content: [{ type: "text", text: "The login redirect loops." }] },
                {
                    type: "bulletList",
                    content: [
                        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Safari only" }] }] }
                    ]
                }
            ]
        };
        expect(flattenRichText(doc)).toContain("The login redirect loops.");
        expect(flattenRichText(doc)).toContain("- Safari only");
    });

    it("keeps a link as a link rather than losing where it pointed", () => {
        expect(
            flattenRichText({
                type: "text",
                text: "the ticket",
                marks: [{ type: "link", attrs: { href: "https://example.com/x" } }]
            })
        ).toBe("[the ticket](https://example.com/x)");
    });

    it("survives a shape it has never seen instead of throwing on somebody's issue", () => {
        expect(flattenRichText({ type: "mediaGroup", content: [{ type: "text", text: "caption" }] })).toBe("caption");
        expect(flattenRichText(null)).toBe("");
        expect(flattenRichText(42)).toBe("");
    });
});

describe("linkedDescription", () => {
    const issue: TrackerIssue = {
        id: "1",
        key: "ENG-42",
        title: "Fix it",
        description: "It is broken.",
        url: "https://example.com/ENG-42",
        status: "In Progress",
        statusType: "active",
        assignee: "",
        updatedAt: ""
    };

    it("says where the task came from, so nobody edits a mirror expecting it to travel", () => {
        expect(linkedDescription(issue, "jira")).toContain("Mirrored from [ENG-42]");
        expect(linkedDescription(issue, "jira")).toContain("It is broken.");
    });

    it("still says it on an issue with no description at all", () => {
        expect(linkedDescription({ ...issue, description: "" }, "linear")).toContain("Mirrored from");
    });
});

describe("isTrackerSite", () => {
    it("takes a site however somebody pasted it", () => {
        expect(normalizeTrackerSite("https://Acme.atlassian.net/")).toBe("acme.atlassian.net");
        expect(isTrackerSite("https://acme.atlassian.net/")).toBe(true);
        expect(isTrackerSite("jira.acme.co.uk:8443")).toBe(true);
    });

    it("refuses the addresses that are not a site but a way onto the server's own network", () => {
        expect(isTrackerSite("127.0.0.1:9200")).toBe(false);
        expect(isTrackerSite("169.254.169.254")).toBe(false);
        expect(isTrackerSite("localhost:8080")).toBe(false);
        expect(isTrackerSite("acme.example/@internal-host")).toBe(false);
        expect(isTrackerSite("user:pass@acme.example")).toBe(false);
        expect(isTrackerSite("acme.example?x=1")).toBe(false);
        expect(isTrackerSite("intranet")).toBe(false);
        expect(isTrackerSite("")).toBe(false);
    });
});

describe("what a mirrored issue becomes", () => {
    const issue = (over: Partial<TrackerIssue>): TrackerIssue => ({
        id: "1",
        key: "ENG-42",
        title: "A title",
        description: "",
        url: "https://acme.atlassian.net/browse/ENG-42",
        status: "In Progress",
        statusType: "active",
        assignee: "",
        updatedAt: "",
        ...over
    });

    it("clamps a title to what a name can hold rather than refusing the issue", () => {
        const name = linkedName(issue({ title: "x".repeat(400) }));
        expect(name.length).toBeLessThanOrEqual(255);
        expect(name.endsWith("...")).toBe(true);
    });

    it("takes the control characters out of a title, which a name refuses", () => {
        expect(linkedName(issue({ title: `bad${String.fromCharCode(7)}title` }))).toBe("bad title");
        expect(linkedName(issue({ title: "   " }))).toBe("ENG-42");
    });

    it("clamps a description and keeps the line saying where it came from", () => {
        const description = linkedDescription(issue({ description: "y".repeat(30_000) }), "jira");
        expect(description.length).toBeLessThanOrEqual(20_000);
        expect(description).toContain("Mirrored from [ENG-42]");
    });

    it("leaves an ordinary description alone", () => {
        expect(linkedDescription(issue({ description: "Short." }), "jira")).toContain("Short.\n\n---");
    });
});

describe("flattenRichText", () => {
    it("stops rather than walking a document nested past anything anybody wrote", () => {
        let node: unknown = { type: "text", text: "deep" };
        for (let level = 0; level < 500; level += 1) node = { type: "paragraph", content: [node] };
        expect(() => flattenRichText(node)).not.toThrow();
        expect(flattenRichText(node)).not.toContain("deep");
    });
});
