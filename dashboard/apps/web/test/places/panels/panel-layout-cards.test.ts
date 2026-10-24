/**
 * The camera, automation-button and sensor cards: what the schema accepts,
 * their sizes, and what a panel reaches through them.
 */

import { describe, expect, it } from "vitest";
import {
    addCard,
    panelAutomationIds,
    panelCameraIds,
    panelCardSchema,
    panelDeviceIds,
    panelDirectDeviceIds,
    type PanelCard
} from "@polaris-app/places/src/lib/panel-layout";

const CAM = "00000000-0000-4000-8000-0000000000c1";
const AUTO = "00000000-0000-4000-8000-0000000000a1";
const DEV = "00000000-0000-4000-8000-0000000000d1";

describe("new panel cards", () => {
    it("accepts a camera, an automation button and a sensor", () => {
        expect(
            panelCardSchema.safeParse({
                id: "c",
                type: "camera",
                cameraId: CAM,
                x: 0,
                y: 0,
                w: 4,
                h: 3
            }).success
        ).toBe(true);
        expect(
            panelCardSchema.safeParse({
                id: "s",
                type: "sensor",
                deviceId: DEV,
                x: 0,
                y: 0,
                w: 2,
                h: 2
            }).success
        ).toBe(true);
    });

    it("reads a button saved without confirm as one that does not ask", () => {
        const parsed = panelCardSchema.parse({
            id: "a",
            type: "action",
            automationId: AUTO,
            x: 0,
            y: 0,
            w: 3,
            h: 1
        });
        expect(parsed.type === "action" && parsed.confirm).toBe(false);
    });

    it("refuses a card without its id, a bad id, or one too small to draw", () => {
        expect(
            panelCardSchema.safeParse({ id: "c", type: "camera", x: 0, y: 0, w: 4, h: 3 }).success
        ).toBe(false);
        expect(
            panelCardSchema.safeParse({
                id: "a",
                type: "action",
                automationId: "x",
                confirm: true,
                x: 0,
                y: 0,
                w: 3,
                h: 1
            }).success
        ).toBe(false);
        expect(
            panelCardSchema.safeParse({
                id: "c",
                type: "camera",
                cameraId: CAM,
                x: 0,
                y: 0,
                w: 2,
                h: 2
            }).success
        ).toBe(false);
    });

    it("names what each card reaches, and a sensor counts as a device on the panel", () => {
        const cards: PanelCard[] = [
            { id: "c", type: "camera", cameraId: CAM, x: 0, y: 0, w: 4, h: 3 },
            { id: "a", type: "action", automationId: AUTO, confirm: true, x: 4, y: 0, w: 3, h: 1 },
            { id: "s", type: "sensor", deviceId: DEV, x: 7, y: 0, w: 3, h: 2 }
        ];
        expect(panelCameraIds(cards)).toEqual([CAM]);
        expect(panelAutomationIds(cards)).toEqual([AUTO]);
        expect(panelDirectDeviceIds(cards)).toEqual([DEV]);
        expect([...panelDeviceIds(cards, new Map())]).toEqual([DEV]);
    });

    it("adds each at its default size", () => {
        const one = addCard([], { type: "action", automationId: AUTO, confirm: true }, "a");
        expect(one[0]).toMatchObject({ w: 3, h: 1, confirm: true });
        const two = addCard(one, { type: "camera", cameraId: CAM }, "c");
        expect(two[1]).toMatchObject({ w: 4, h: 3 });
    });
});
