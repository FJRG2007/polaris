/**
 * The phone's door widget goes through the Places tools, as its owner, with
 * only the Places scopes that owner holds.
 */

import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

let permissions: string[] = [];
const calls: { name: string; input: unknown; scopes: readonly string[] }[] = [];
let controlAnswer: () => unknown = () => ({ structured: { confirmed: true } });

class McpRefusal extends Error {}

vi.mock("@polaris/auth", () => ({ scopesAvailableTo: async () => permissions }));
vi.mock("@/lib/mcp/call-guard", () => ({ spendToolBudget: async () => null, auditToolChange: async () => {} }));
vi.mock("@/lib/mcp/protocol", () => ({
    McpRefusal,
    callerMayUse: (tool: { scope: string }, caller: { scopes: readonly string[] }) => caller.scopes.includes(tool.scope)
}));
vi.mock("@/lib/mcp/catalog", () => ({
    mcpTools: async () => [
        {
            name: "places_devices",
            scope: "places.read",
            readOnly: true,
            input: z.object({ deviceId: z.string().optional() }),
            run: async (input: unknown, caller: { scopes: readonly string[] }) => {
                calls.push({ name: "places_devices", input, scopes: caller.scopes });
                return {
                    structured: {
                        devices: [
                            { id: "d1", name: "Front door", state: "locked", online: true, actions: ["open", "unlock", "lock"] },
                            { id: "d2", name: "Lamp", state: "off", online: true, actions: ["turn-on", "turn-off"] },
                            { id: "d3", name: "Gate", state: null, online: false, actions: ["open"] }
                        ]
                    }
                };
            }
        },
        {
            name: "places_device_control",
            scope: "places.control",
            readOnly: false,
            input: z.object({ deviceId: z.string(), action: z.string() }),
            run: async (input: unknown, caller: { scopes: readonly string[] }) => {
                calls.push({ name: "places_device_control", input, scopes: caller.scopes });
                return controlAnswer();
            }
        }
    ]
}));

const widget = await import("@/lib/mobile/door-widget");
const me = { id: "me", isAdmin: false };

beforeEach(() => {
    calls.length = 0;
    permissions = ["home.read", "home.control"];
    controlAnswer = () => ({ structured: { confirmed: true } });
});

describe("the door widget", () => {
    it("lists only what opens, offline doors included", async () => {
        const doors = await widget.doorsFor(await widget.phoneCaller(me));
        expect(doors?.map((door) => door.name)).toEqual(["Front door", "Gate"]);
    });

    it("holds only the Places scopes its owner holds", async () => {
        permissions = ["home.read"];
        const caller = await widget.phoneCaller(me);
        expect(caller.scopes).toEqual(["places.read"]);
        expect(await widget.openDoor(caller, "d1")).toMatchObject({ ok: false, reason: "missing" });
        expect(calls.some((call) => call.name === "places_device_control")).toBe(false);
    });

    it("says Places is not theirs when it cannot read it at all", async () => {
        permissions = [];
        expect(await widget.doorsFor(await widget.phoneCaller(me))).toBeNull();
    });

    it("opens with action open, never unlock, and passes the tool's refusal on", async () => {
        expect(await widget.openDoor(await widget.phoneCaller(me), "d1")).toEqual({ ok: true, confirmed: true });
        expect(calls.at(-1)).toMatchObject({ name: "places_device_control", input: { deviceId: "d1", action: "open" } });
        controlAnswer = () => {
            throw new McpRefusal("That device is not shared with you");
        };
        expect(await widget.openDoor(await widget.phoneCaller(me), "d1")).toEqual({
            ok: false,
            reason: "refused",
            message: "That device is not shared with you"
        });
    });
});
