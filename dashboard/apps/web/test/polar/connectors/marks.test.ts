/**
 * Every connector in the catalog shows its brand's mark: a `logo` key with no
 * sourced mark silently falls back to a monogram, which is how Booking.com
 * shipped without one.
 */

import { describe, expect, it } from "vitest";
import { CONNECTOR_CATALOG } from "@/lib/polar/connectors/catalog";
import { CONNECTOR_MARKS } from "@/components/polar/connector-marks";

describe("connector marks", () => {
    it.each(CONNECTOR_CATALOG.map((entry) => [entry.id, entry.logo]))(
        "%s resolves its logo key %s to a sourced mark",
        (_id, logo) => {
            expect(CONNECTOR_MARKS[logo]).toBeTypeOf("function");
        }
    );
});
