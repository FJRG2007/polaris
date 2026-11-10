// @vitest-environment jsdom

/** A link from before each section had its own page. */

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SectionFromHash } from "@/app/(app)/polar/settings/section-from-hash";

const replaced: string[] = [];

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: (href: string) => replaced.push(href) })
}));

afterEach(() => {
    replaced.length = 0;
    window.history.replaceState(null, "", "/");
});

describe("a section named by a hash", () => {
    it("becomes the section's page", () => {
        window.history.replaceState(null, "", "/polar/settings#tools");
        render(<SectionFromHash ids={["tools"]} />);
        expect(replaced).toEqual(["/polar/settings/tools"]);
    });

    it("keeps how a connector sign-in went", () => {
        window.history.replaceState(null, "", "/polar/settings?connector=signed_in#connectors");
        render(<SectionFromHash ids={["connectors"]} />);
        expect(replaced).toEqual(["/polar/settings/connectors?connector=signed_in"]);
    });

    it("leaves a hash it does not know alone", () => {
        window.history.replaceState(null, "", "/polar/settings#nothing");
        render(<SectionFromHash ids={["tools"]} />);
        expect(replaced).toEqual([]);
    });
});
