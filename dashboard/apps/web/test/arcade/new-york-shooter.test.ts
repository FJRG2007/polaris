/**
 * The shooter's rules: weapon fire, reload and recoil, where a bullet stops,
 * the crews' state machine and the wanted level.
 */

import { describe, expect, it } from "vitest";

import * as weapons from "../../../arcade/game/new-york/engine/weapons.js";
import * as hits from "../../../arcade/game/new-york/engine/hit-resolution.js";
import * as ai from "../../../arcade/game/new-york/engine/combat-ai.js";

const fixed = () => 0.5;

describe("weapons", () => {
    it("fires once per press with a semi-automatic and holds for an automatic", () => {
        const pistol = weapons.createWeaponState("pistol");
        expect(weapons.pullTrigger(pistol, 0, { down: true, random: fixed })).not.toBeNull();
        expect(weapons.pullTrigger(pistol, 10, { down: true, random: fixed })).toBeNull();
        weapons.pullTrigger(pistol, 10.1, { down: false });
        expect(weapons.pullTrigger(pistol, 10.2, { down: true, random: fixed })).not.toBeNull();

        const smg = weapons.createWeaponState("smg");
        let shots = 0;
        for (let t = 0; t < 1; t += 1 / 120) if (weapons.pullTrigger(smg, t, { down: true, random: fixed })) shots++;
        expect(shots).toBe(12);
    });

    it("respects the fire rate", () => {
        const rifle = weapons.createWeaponState("rifle");
        expect(weapons.pullTrigger(rifle, 0, { down: true, random: fixed })).not.toBeNull();
        expect(weapons.pullTrigger(rifle, 0.05, { down: true, random: fixed })).toBeNull();
        expect(weapons.pullTrigger(rifle, 1 / 9 + 0.001, { down: true, random: fixed })).not.toBeNull();
    });

    it("reloads from the reserve after the reload time, starting by itself when empty", () => {
        const s = weapons.createWeaponState("pistol", { magazine: 1, reserve: 5 });
        weapons.pullTrigger(s, 0, { down: true, random: fixed });
        expect(s.magazine).toBe(0);
        expect(weapons.isReloading(s, 0.5)).toBe(true);
        expect(weapons.pullTrigger(s, 0.6, { down: false })).toBeNull();
        weapons.finishReload(s, 0.25 + 1.3 + 0.01);
        expect(s.magazine).toBe(5);
        expect(s.reserve).toBe(0);
        expect(weapons.startReload(s, 5)).toBe(false);
    });

    it("does not reload a full magazine or with no reserve", () => {
        expect(weapons.startReload(weapons.createWeaponState("smg"), 0)).toBe(false);
        expect(weapons.startReload(weapons.createWeaponState("smg", { magazine: 3, reserve: 0 }), 0)).toBe(false);
    });

    it("kicks the view up per shot and recovers it back to zero", () => {
        const s = weapons.createWeaponState("rifle");
        weapons.pullTrigger(s, 0, { down: true, random: fixed });
        expect(s.recoilPitch).toBeCloseTo(0.018);
        const back = weapons.recoverRecoil(s, 0.05);
        expect(back.pitch).toBeCloseTo(0.01);
        expect(s.recoilPitch).toBeCloseTo(0.008);
        weapons.recoverRecoil(s, 1);
        expect(s.recoilPitch).toBe(0);
        expect(s.bloom).toBe(0);
    });

    it("narrows the spread when aiming and widens it on the move", () => {
        const s = weapons.createWeaponState("rifle");
        const hip = weapons.currentSpread(s);
        expect(weapons.currentSpread(s, { aiming: true })).toBeCloseTo(hip * 0.25);
        expect(weapons.currentSpread(s, { moving: true })).toBeCloseTo(hip * 2);
    });

    it("keeps every pellet inside the cone", () => {
        const s = weapons.createWeaponState("shotgun");
        const shot = weapons.pullTrigger(s, 0, { down: true });
        expect(shot.pellets).toHaveLength(9);
        for (const p of shot.pellets) expect(Math.hypot(p.yaw, p.pitch)).toBeLessThanOrEqual(0.075 + 1e-9);
    });
});

describe("hit resolution", () => {
    const wall = { minX: 10, maxX: 12, minZ: -5, maxZ: 5, minY: 0, maxY: 20 };
    const origin = { x: 0, y: 1.6, z: 0 };
    const east = { x: 1, y: 0, z: 0 };
    const target = (x: number) => ({
        id: 1,
        alive: true,
        parts: [
            { part: "head", x, y: 1.66, z: 0, radius: 0.17 },
            { part: "body", x, y: 1.12, z: 0, radius: 0.34 }
        ]
    });

    it("stops at the wall before a target behind it", () => {
        const hit = hits.resolveShot(origin, east, 100, [wall], [target(20)]);
        expect(hit.kind).toBe("world");
        expect(hit.distance).toBeCloseTo(10);
    });

    it("hits a target in front of the wall, the head with its multiplier", () => {
        const hit = hits.resolveShot(origin, east, 100, [wall], [target(5)]);
        expect(hit.kind).toBe("target");
        expect(hit.part).toBe("head");
        expect(hit.multiplier).toBe(2.5);
    });

    it("ignores the dead and misses past the range", () => {
        expect(hits.resolveShot(origin, east, 100, [], [{ ...target(5), alive: false }]).kind).toBe("none");
        expect(hits.resolveShot(origin, east, 4, [], [target(5)]).kind).toBe("none");
    });

    it("tests boxes and spheres exactly", () => {
        expect(hits.rayBox(0, 1, 0, 0, 1, 0, wall)).toBe(Infinity);
        expect(hits.raySphere(0, 0, 0, 1, 0, 0, 5, 0.5, 0, 0.4)).toBe(Infinity);
        expect(hits.raySphere(0, 0, 0, 1, 0, 0, 5, 0, 0, 1)).toBeCloseTo(4);
    });

    it("reports line of sight and damage falloff", () => {
        expect(hits.lineOfSight({ x: 0, y: 1, z: 0 }, { x: 20, y: 1, z: 0 }, [wall])).toBe(false);
        expect(hits.lineOfSight({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 20 }, [wall])).toBe(true);
        expect(hits.falloff(10, 100)).toBe(1);
        expect(hits.falloff(100, 100)).toBeCloseTo(0.4);
    });
});

describe("crew state machine", () => {
    const player = { x: 0, z: 0 };

    it("goes patrol -> investigate on a shot, -> engage on sight, -> search when lost, -> patrol after searching", () => {
        const m = ai.createCrewMember(1, 30, 0);
        ai.think(m, { seesPlayer: false, player, heardShotAt: { x: 0, z: 0 } }, 0.2);
        expect(m.state).toBe("investigate");
        ai.think(m, { seesPlayer: true, player, heardShotAt: null }, 0.2);
        expect(m.state).toBe("engage");
        ai.think(m, { seesPlayer: false, player, heardShotAt: null }, 0.2);
        expect(m.state).toBe("search");
        expect(m.target).toEqual({ x: 0, z: 0 });
        ai.think(m, { seesPlayer: false, player, heardShotAt: null }, ai.AI.searchTime + 0.1);
        expect(m.state).toBe("patrol");
    });

    it("takes cover once when badly hurt, then returns to the fight", () => {
        const m = ai.createCrewMember(1, 10, 0);
        ai.think(m, { seesPlayer: true, player, heardShotAt: null }, 0.2);
        ai.damageMember(m, 70);
        ai.think(m, { seesPlayer: true, player, heardShotAt: null }, 0.2);
        expect(m.state).toBe("cover");
        ai.think(m, { seesPlayer: true, player, heardShotAt: null }, ai.AI.coverTime + 0.1);
        expect(m.state).toBe("engage");
        ai.think(m, { seesPlayer: true, player, heardShotAt: null }, 0.2);
        expect(m.state).toBe("engage");
    });

    it("gives up on a sound after a while and dies at zero health", () => {
        const m = ai.createCrewMember(1, 10, 0);
        ai.think(m, { seesPlayer: false, player, heardShotAt: player }, 0.2);
        ai.think(m, { seesPlayer: false, player, heardShotAt: null }, ai.AI.investigateTime + 0.1);
        expect(m.state).toBe("patrol");
        expect(ai.damageMember(m, 150)).toBe(true);
        expect(m.alive).toBe(false);
        expect(ai.damageMember(m, 10)).toBe(false);
    });
});

describe("wanted level", () => {
    it("climbs with takedowns, caps at five stars and cools only while unseen", () => {
        const w = ai.createWanted();
        expect(ai.stars(w)).toBe(0);
        ai.raiseWanted(w, "takedown");
        ai.raiseWanted(w, "takedown");
        expect(ai.stars(w)).toBe(2);
        for (let i = 0; i < 20; i++) ai.raiseWanted(w, "takedown");
        expect(ai.stars(w)).toBe(5);
        ai.coolWanted(w, 30, true);
        expect(ai.stars(w)).toBe(5);
        for (let i = 0; i < 200; i++) ai.coolWanted(w, 0.5, false);
        expect(ai.stars(w)).toBe(0);
        expect(ai.crewBudget(0)).toBeLessThan(ai.crewBudget(5));
    });
});
