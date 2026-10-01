/**
 * The rules the sharing dialog relies on: a manager shares and changes levels
 * but cannot hand out "edit and share" nor take it away, the owner can; and
 * turning publishing off deletes the address, so turning it on again is a new
 * one and the old link never comes back to life.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser } from "../fixtures/fake-host";
import * as sharing from "@polaris-app/calendar/src/lib/sharing";
import { publishedRange } from "@polaris-app/calendar/src/lib/published";

describe("sharing and publishing rules", () => {
    let owner: ReturnType<typeof addUser>;
    let manager: ReturnType<typeof addUser>;
    let carol: ReturnType<typeof addUser>;
    let calendar: string;

    beforeEach(() => {
        world.resetWorld();
        owner = addUser({ name: "Owner", email: "owner@example.test" });
        manager = addUser({ name: "Manager", email: "manager@example.test" });
        carol = addUser({ name: "Carol", email: "carol@example.test" });
        calendar = world.addCalendar(owner.id);
        world.addShare(calendar, { userId: manager.id }, "manage");
    });

    it("lets a manager share below manage, and never grant manage", async () => {
        await sharing.share(manager as never, {
            calendarId: calendar,
            target: { kind: "user", id: carol.id },
            access: "write"
        });
        expect(db.rows("calendarShare").find((row) => row.userId === carol.id)?.access).toBe(
            "write"
        );
        await expect(
            sharing.share(manager as never, {
                calendarId: calendar,
                target: { kind: "user", id: carol.id },
                access: "manage"
            })
        ).rejects.toThrow(world.en("sharing.onlyOwnerManage"));
        await sharing.share(owner as never, {
            calendarId: calendar,
            target: { kind: "user", id: carol.id },
            access: "manage"
        });
        expect(db.rows("calendarShare").find((row) => row.userId === carol.id)?.access).toBe(
            "manage"
        );
    });

    it("keeps a manager from removing another manager", async () => {
        const other = db.rows("calendarShare").find((row) => row.userId === manager.id)!;
        const second = addUser({ name: "Second", email: "second@example.test" });
        world.addShare(calendar, { userId: second.id }, "manage");
        await expect(sharing.unshare(second as never, String(other.id))).rejects.toThrow(
            world.en("sharing.onlyOwnerManage")
        );
        await sharing.unshare(owner as never, String(other.id));
        expect(db.rows("calendarShare").some((row) => row.userId === manager.id)).toBe(false);
    });

    it("deletes the address when publishing is turned off, so a new one is issued", async () => {
        const first = await sharing.publish(owner as never, calendar, "busy");
        expect(first).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
        expect(
            await publishedRange(
                first!,
                { from: world.NOW, to: new Date(world.NOW.getTime() + 86_400_000) },
                "UTC"
            )
        ).not.toBeNull();
        expect(await sharing.publish(owner as never, calendar, "")).toBeNull();
        expect(db.byId("calendar", calendar)).toEqual(
            expect.objectContaining({ publicToken: null, publicMode: "" })
        );
        expect(
            await publishedRange(
                first!,
                { from: world.NOW, to: new Date(world.NOW.getTime() + 86_400_000) },
                "UTC"
            )
        ).toBeNull();
        const second = await sharing.publish(owner as never, calendar, "full");
        expect(second).not.toBe(first);
    });

    it("keeps a reader below manage from publishing", async () => {
        world.addShare(calendar, { userId: carol.id }, "write");
        await expect(sharing.publish(carol as never, calendar, "full")).rejects.toThrow(
            world.en("errors.calendarNotFound")
        );
    });
});
