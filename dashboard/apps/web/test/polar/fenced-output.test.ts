/**
 * A tool's answer in the panel: a connector's fenced output is unwrapped and
 * the connector named, and JSON is painted as JSON - one document, several
 * (JSON lines, a connector's pieces), or one cut short with the cut mark.
 * Prose stays prose.
 */

import { describe, expect, it } from "vitest";
import { readableOutput } from "@/lib/polar/fenced-output";

describe("readableOutput", () => {
    it("unwraps a connector's fence and finds the JSON inside", () => {
        const text = '<untrusted_connector_output connector="Stripe">\n{"id":"acct_1","object":"account"}\n</untrusted_connector_output>';
        expect(readableOutput(text)).toEqual({
            connector: "Stripe",
            body: '{\n  "id": "acct_1",\n  "object": "account"\n}',
            json: true
        });
    });

    it("keeps prose as prose, fenced or not", () => {
        expect(readableOutput("Lamp turned off.")).toEqual({ connector: null, body: "Lamp turned off.", json: false });
        const fenced = readableOutput('<untrusted_connector_output connector="Linear">\nNo issues found.\n</untrusted_connector_output>');
        expect(fenced).toEqual({ connector: "Linear", body: "No issues found.", json: false });
    });

    it("paints a JSON answer as JSON, and not a bare number or a broken one", () => {
        expect(readableOutput('[{"a":1}]').json).toBe(true);
        expect(readableOutput("42").json).toBe(false);
        expect(readableOutput("{not json").json).toBe(false);
        expect(readableOutput('{"a":1} and more').json).toBe(false);
    });

    it("paints JSON lines and several documents, each re-indented", () => {
        const lines = readableOutput('{"a":1}\n{"b":"x}"}\n[2]');
        expect(lines.json).toBe(true);
        expect(lines.body).toBe('{\n  "a": 1\n}\n{\n  "b": "x}"\n}\n[\n  2\n]');
        const pieces = readableOutput('{\n  "rows": [1]\n}\n{"total":1}');
        expect(pieces.json).toBe(true);
    });

    it("paints a document cut short, keeping the cut mark", () => {
        const cut = readableOutput('{"a":1}\n{"rows":[{"id":1},{"id":\n[cut at 16000 characters]');
        expect(cut.json).toBe(true);
        expect(cut.body.endsWith('{"rows":[{"id":1},{"id":\n[cut at 16000 characters]')).toBe(true);
        // Without the mark an unclosed document is not JSON.
        expect(readableOutput('{"rows":[{"id":1}').json).toBe(false);
    });
});
