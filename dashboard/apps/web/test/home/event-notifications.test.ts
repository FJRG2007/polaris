/**
 * What a camera is allowed to interrupt somebody with.
 *
 * Every sighting used to write a notification. A camera pointed at a room
 * somebody works in reports them all day, so the bell filled with "somebody is
 * at the studio" and the four entries that mattered went under it - and there
 * was nowhere to turn it off, because Places wrote the rows itself instead of
 * declaring an event the settings page could list.
 *
 * So: the log is the record, the bell is asked for. These assert both halves,
 * plus the shape of the asking, because the failure they guard against is a
 * default quietly flipping back.
 */

import { describe, expect, it } from "vitest";
import { alertRuleInputSchema } from "@/lib/home/schemas";
import { NOTIFICATION_EVENTS, notificationEvent, resolveRule } from "@polaris/core";

/** Every event id Places hands the dispatcher. An id nothing declares is
 *  refused at the door, so a typo here is an alert that silently never
 *  arrives. */
const RAISED = ["places.sighting", "places.alert", "places.tamper"];

describe("what a camera can reach somebody with", () => {
    it("declares every event it raises", () => {
        for (const id of RAISED) expect(notificationEvent(id)).not.toBeNull();
    });

    it("puts them all where somebody can find them", () => {
        for (const id of RAISED) expect(notificationEvent(id)?.group).toBe("places");
    });

    it("leaves a sighting off the bell until it is asked for", () => {
        expect(resolveRule({}, "places.sighting")).toEqual({
            inapp: false,
            email: false,
            destinations: []
        });
    });

    it("still tells somebody a camera was interfered with", () => {
        // Not about what walked past: this is the camera saying it was covered
        // or moved, and it is rare enough to be worth the interruption.
        expect(resolveRule({}, "places.tamper").inapp).toBe(true);
    });

    it("keeps a sighting mutable, so nothing in Places is unturnoffable", () => {
        for (const id of RAISED) expect(notificationEvent(id)?.critical).toBeFalsy();
        const off = { inapp: false, email: false, destinations: [] };
        expect(resolveRule({ "places.tamper": off }, "places.tamper").inapp).toBe(false);
    });

    it("does not raise anything the catalogue does not carry", () => {
        // The id the old code wrote straight into the table. Nothing declares
        // it, and nothing may go back to using it.
        expect(NOTIFICATION_EVENTS.some((event) => event.id === "home.event")).toBe(false);
    });
});

describe("an alert as it arrives from a browser", () => {
    const rule = {
        name: "  Somebody at the door  ",
        placeId: null,
        cameraId: null,
        kinds: ["person"],
        label: null,
        zones: [],
        hours: null,
        recipients: ["8f14e45f-ceea-467a-9f4e-1a2b3c4d5e6f"],
        enabled: true
    };

    it("is quiet unless it says otherwise", () => {
        const parsed = alertRuleInputSchema.parse(rule);
        expect(parsed.notify).toBe(false);
        expect(parsed.name).toBe("Somebody at the door");
    });

    it("refuses a rule that tells nobody", () => {
        expect(alertRuleInputSchema.safeParse({ ...rule, recipients: [] }).success).toBe(false);
    });

    it("refuses a rule about something no camera reports", () => {
        expect(alertRuleInputSchema.safeParse({ ...rule, kinds: ["burglar"] }).success).toBe(false);
    });

    it("refuses somebody who is not an account", () => {
        expect(
            alertRuleInputSchema.safeParse({ ...rule, recipients: ["' OR 1=1 --"] }).success
        ).toBe(false);
    });

    it("keeps only the fields a rule is made of", () => {
        // The list edits a rule by sending the view back with one field changed,
        // and a view carries its id and the conversation it made.
        const parsed = alertRuleInputSchema.parse({
            ...rule,
            id: "8f14e45f-ceea-467a-9f4e-1a2b3c4d5e6f",
            channelId: "8f14e45f-ceea-467a-9f4e-1a2b3c4d5e6f",
            notify: true
        });
        expect(parsed).not.toHaveProperty("id");
        expect(parsed).not.toHaveProperty("channelId");
        expect(parsed.notify).toBe(true);
    });

    it("refuses an hour that is not one", () => {
        const parsed = alertRuleInputSchema.safeParse({ ...rule, hours: { from: 22, to: 99 } });
        expect(parsed.success).toBe(false);
    });
});
