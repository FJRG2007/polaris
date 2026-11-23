// @vitest-environment jsdom

/**
 * A code box takes the cursor when it appears: it shows up because a code was
 * just sent, so typing it is the next thing anybody does.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CodeInput } from "@/components/code-input";

afterEach(cleanup);

describe("a code box", () => {
    it("takes focus when it appears", () => {
        render(<CodeInput aria-label="code" value="" onValueChange={() => undefined} />);
        expect(document.activeElement).toBe(screen.getByLabelText("code"));
    });

    it("leaves focus alone when told to", () => {
        render(<CodeInput aria-label="code" value="" autoFocus={false} onValueChange={() => undefined} />);
        expect(document.activeElement).not.toBe(screen.getByLabelText("code"));
    });
});
