/**
 * A machine that looks after its own disk.
 *
 * A container store grows on its own: every build leaves its cache and every
 * pull leaves the layers of the version it replaced. Neither is ever asked for
 * again, so a machine that is only ever deployed to walks up to full over months
 * and then refuses the next deploy - with a sentence about a rename that nobody
 * would connect to disk space.
 *
 * There was a button for it, and a button is the wrong shape: somebody has to
 * know the screen exists, know to look before it matters, and be holding the
 * phone the evening it does. Measured on a real machine that had just refused a
 * pull - 97% of 98 GB, 3.6 GB free, a 2.7 GB image to fetch - with 6.5 GB of
 * build cache sitting there that nothing was using.
 *
 * The two halves worth pinning are when it acts and what it will never take.
 */

import { describe, expect, it } from "vitest";
import { diskFullness } from "@/lib/deploy/local-disk";
import { notificationEvent, resolveRule } from "@polaris/core";
import { shouldReclaim } from "@/lib/deploy/host-housekeeping";

const GB = 1024 * 1024 * 1024;

describe("when the machine hands room back", () => {
    it("does nothing to a disk with room to spare", () => {
        // Cache that is still there is cache the next build reuses. Throwing it
        // away every six hours to keep a half-empty disk tidy costs every build
        // after it and buys nothing.
        expect(shouldReclaim(0.4, 8 * GB)).toBe(false);
        expect(shouldReclaim(0.84, 8 * GB)).toBe(false);
    });

    it("acts on the machine that actually refused the pull", () => {
        // 97% full, 6.5 GB of loose build cache. This is the case that has to
        // come out true or the whole thing is decoration.
        expect(shouldReclaim(0.97, 6.5 * GB)).toBe(true);
    });

    it("does not bother when there is nothing worth taking", () => {
        // A full disk with no loose cache on it is a person's problem, and
        // pruning nothing every six hours only hides that.
        expect(shouldReclaim(0.97, 0)).toBe(false);
        expect(shouldReclaim(0.97, 10 * 1024 * 1024)).toBe(false);
    });

    it("does nothing at all when the disk cannot be read", () => {
        // Null is "cannot say", never "there is plenty" - and never a reason to
        // start deleting on a machine nothing has measured.
        expect(shouldReclaim(null, 8 * GB)).toBe(false);
    });

    it("treats an unreadable store as nothing to take", () => {
        expect(shouldReclaim(0.97, null)).toBe(false);
    });
});

describe("how full the disk is", () => {
    it("reads the way df does", () => {
        expect(diskFullness({ used: 90 * GB, total: 98 * GB })).toBeCloseTo(0.918, 2);
    });

    it("does not divide by a disk of no size", () => {
        expect(diskFullness({ used: 0, total: 0 })).toBe(0);
    });
});

describe("what it says when handing room back was not enough", () => {
    it("declares the event, so the dispatcher does not refuse it", () => {
        expect(notificationEvent("server.space")).not.toBeNull();
        expect(notificationEvent("server.space")?.group).toBe("deploy");
    });

    it("reaches a mailbox, not only the bell", () => {
        // By the time this is raised the housekeeping has already run and not
        // been enough, so what is left is data only a person can decide about -
        // and the next thing that happens is a deploy or a recording failing.
        expect(resolveRule({}, "server.space")).toMatchObject({ inapp: true, email: true });
    });

    it("can still be turned off", () => {
        expect(notificationEvent("server.space")?.critical).toBeFalsy();
        const off = { inapp: false, email: false, destinations: [] };
        expect(resolveRule({ "server.space": off }, "server.space").inapp).toBe(false);
    });
});
