/**
 * The Matches column is a replay of each rule over the edge log, and it decides
 * whether somebody arms a rule. Two things have to hold or the number is worse than
 * no number at all.
 *
 * A rule must be counted against the traffic it really matches - which means the log's
 * path has to be split into path and query the way the edge splits it, or a rule about
 * the path silently matches on the query string. And a rule that is switched off has
 * to be counted anyway, because "what would this catch here?" is the question being
 * asked of the switch.
 */

import { describe, expect, it } from "vitest";
import type { WafCustomRule } from "../src/schemas/deploy.js";
import { wafRuleActivity, type WafTrafficEntry } from "../src/waf-analytics.js";

const FROM = Date.parse("2026-08-04T00:00:00Z");
const TO = FROM + 24 * 3600 * 1000;

function entry(at: number, path: string, extra: Partial<WafTrafficEntry> = {}): WafTrafficEntry {
    return {
        time: new Date(at).toISOString(),
        ip: "203.0.113.9",
        path,
        status: 200,
        method: "GET",
        userAgent: "curl/8.4.0",
        host: "app.example.com",
        ...extra
    };
}

const wpAdmin: WafCustomRule = {
    name: "no wp-admin",
    enabled: true,
    action: "block",
    conditions: [{ field: "path", operator: "starts_with", values: ["/wp-admin"] }]
};

describe("what a rule matches over recent traffic", () => {
    it("counts the requests the rule matches and places them in time", () => {
        const entries = [
            entry(FROM + 1000, "/wp-admin/setup.php"),
            entry(FROM + 2000, "/about"),
            entry(TO - 1000, "/wp-admin/index.php")
        ];

        const activity = wafRuleActivity(entries, [{ key: "r", rule: wpAdmin }], FROM, TO, 4);
        const answer = activity.get("r")!;

        expect(answer.total).toBe(2);
        expect(answer.series).toEqual([1, 0, 0, 1]);
    });

    it("counts a rule that is switched off, which is when the count matters most", () => {
        const activity = wafRuleActivity(
            [entry(FROM + 1000, "/wp-admin/setup.php")],
            [{ key: "r", rule: { ...wpAdmin, enabled: false } }],
            FROM,
            TO,
            4
        );

        expect(activity.get("r")?.total).toBe(1);
    });

    it("splits the log's path from its query, as the edge does", () => {
        const queryRule: WafCustomRule = {
            name: "debug",
            enabled: true,
            action: "block",
            conditions: [{ field: "query", operator: "contains", values: ["debug=1"] }]
        };
        const pathRule: WafCustomRule = {
            name: "not really the path",
            enabled: true,
            action: "block",
            conditions: [{ field: "path", operator: "contains", values: ["debug=1"] }]
        };
        const entries = [entry(FROM + 1000, "/status?debug=1")];

        const activity = wafRuleActivity(
            entries,
            [
                { key: "query", rule: queryRule },
                { key: "path", rule: pathRule }
            ],
            FROM,
            TO,
            4
        );

        expect(activity.get("query")?.total).toBe(1);
        // Without the split this would be 1 too, and a rule about the path would be
        // reporting matches it will never make.
        expect(activity.get("path")?.total).toBe(0);
    });

    it("ignores traffic outside the window and entries with no usable time", () => {
        const entries = [
            entry(FROM - 1000, "/wp-admin/a"),
            entry(TO + 1000, "/wp-admin/b"),
            { ...entry(FROM + 1000, "/wp-admin/c"), time: null }
        ];

        expect(wafRuleActivity(entries, [{ key: "r", rule: wpAdmin }], FROM, TO, 4).get("r")?.total).toBe(0);
    });

    it("answers with a zeroed series when there is nothing to count", () => {
        const answer = wafRuleActivity([], [{ key: "r", rule: wpAdmin }], FROM, TO, 4).get("r");

        expect(answer).toEqual({ total: 0, series: [0, 0, 0, 0] });
    });
});
