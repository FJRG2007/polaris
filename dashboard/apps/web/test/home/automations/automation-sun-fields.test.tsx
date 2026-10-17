// @vitest-environment jsdom

/**
 * The sun's fields in a block: what is missing for the sun to be timed is said
 * once for the block, however many events it names, and each event still shows
 * its time today once the place has a location.
 */

import "@/components/app-host/client";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type * as auto from "@polaris-app/places/src/lib/automation-kinds";
import {
    AutomationScopeProvider,
    SunConditionFields,
    SunTriggerFields,
    type AutomationScope
} from "@polaris-app/places/src/screens/automations/sun-fields";

const NO_LOCATION = /This place has no location yet/;
const MADRID = { latitude: 40.42, longitude: -3.7 };

function scope(extra: Partial<AutomationScope> = {}): AutomationScope {
    return {
        triggers: [],
        lookup: () => undefined,
        location: null,
        timeZone: "Europe/Madrid",
        setLocation: async () => undefined,
        now: () => new Date("2026-06-21T10:00:00Z"),
        ...extra
    };
}

const BETWEEN: Extract<auto.Condition, { kind: "sun" }> = {
    id: "sun-1",
    kind: "sun",
    after: { event: "sunset", offset: { amount: 30, unit: "minutes", direction: "before" } },
    before: { event: "sunrise" }
} as Extract<auto.Condition, { kind: "sun" }>;

function between(value: AutomationScope) {
    return render(
        <AutomationScopeProvider value={value}>
            <SunConditionFields condition={BETWEEN} path={["c"]} onChange={() => {}} />
        </AutomationScopeProvider>
    );
}

afterEach(cleanup);

describe("the sun's fields", () => {
    it("asks for the location once for a condition between two events", () => {
        between(scope());
        expect(screen.getAllByText(NO_LOCATION)).toHaveLength(1);
        expect(screen.getAllByRole("button", { name: /Use my location/ })).toHaveLength(1);
        expect(screen.queryByText(/^Today:/)).toBeNull();
    });

    it("puts the notice after both events", () => {
        const { container } = between(scope());
        const notice = screen.getByText(NO_LOCATION);
        const offsets = container.querySelectorAll('input[type="number"]');
        expect(offsets).toHaveLength(2);
        const last = offsets[offsets.length - 1]!;
        expect(last.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING
        );
    });

    it("shows each event's time today and no notice once there is a location", () => {
        between(scope({ location: MADRID }));
        expect(screen.queryByText(NO_LOCATION)).toBeNull();
        expect(screen.getAllByText(/^Today: \d\d:\d\d$/)).toHaveLength(2);
    });

    it("asks once for a trigger too", () => {
        render(
            <AutomationScopeProvider value={scope()}>
                <SunTriggerFields
                    trigger={{ id: "t-1", kind: "sun", event: "sunset" } as never}
                    path={["t"]}
                    onChange={() => {}}
                />
            </AutomationScopeProvider>
        );
        expect(screen.getAllByText(NO_LOCATION)).toHaveLength(1);
    });

    it("keeps an offset's value in a field wide enough to read it", () => {
        const { container } = between(scope());
        const input = container.querySelector('input[type="number"]')!;
        expect((input as HTMLInputElement).value).toBe("30");
        expect(input.className).toContain("min-w-[5rem]");
        expect(input.parentElement!.className).toContain("flex-wrap");
    });
});
