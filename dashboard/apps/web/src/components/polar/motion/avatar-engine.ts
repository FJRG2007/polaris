/**
 * The rig behind Polar's avatar, ported from Libraries.dev's bot avatars (MIT,
 * see LICENSE beside this file). A pose is a handful of numbers - head yaw,
 * pitch and roll, a position, squash, the lids, where the eyes look - and blend
 * weights for the three states. A `Sim` advances a pose through time: each
 * state sets targets and wanders around them, runs its own events (a jump, a
 * hop, a nod, a blink), and a state change eases from one set of targets to the
 * next on a timed curve, so it starts and ends softly.
 *
 * Nothing here touches the DOM, so the whole rig runs under test.
 */

export const AVATAR_STATES = ["idle", "working", "sleeping"] as const;
export type AvatarState = (typeof AVATAR_STATES)[number];

/**
 * Which state Polar's avatar shows. Asleep while offline, or where nothing of
 * Polar is open (the launcher with the panel shut); at work while it thinks or
 * writes an answer; otherwise awake and looking around.
 */
export function avatarStateFor({
    open,
    online,
    busy
}: {
    open: boolean;
    online: boolean;
    busy: boolean;
}): AvatarState {
    if (!online || !open) return "sleeping";
    return busy ? "working" : "idle";
}

type SquashEase = "sharp" | "pulse" | "soft" | "bouncy";

/* the working state's hop: its period, and the height of the spinning one */
const HOP_T = 0.68;
const HOP_SPIN_H = 26;
/* an idle jump: a crouch before it (measured in hop periods) */
const FLIP_PRE = 0.2;

/** The jump's numbers: an idle jump's and a click's. */
const JUMP = {
    /** how high, in body units (the body is 100 tall) */
    height: HOP_SPIN_H,
    /** seconds in the air */
    time: HOP_T,
    stretch: 1,
    squash: 1.15,
    squashTime: 0.37,
    squashEase: "pulse" as SquashEase,
    groundTime: 0.11,
    groundEase: "pulse" as SquashEase,
    riseTime: 0.33,
    riseEase: "pulse" as SquashEase,
    clickSquashTime: 0.24,
    spin: 1,
    lean: 6,
    /** seconds between idle jumps, roughly (40 % either way) */
    every: 8,
    /** when the landing squash begins, seconds from touch-down */
    land: 0
};

/* where in its time each easing reaches the deepest squash */
const SQUASH_PEAK: Record<SquashEase, number> = {
    sharp: 0,
    pulse: 2 / 7,
    soft: 0.5,
    bouncy: 0.144
};

/* a click's jump crouches for its squash time before take-off; an idle
   jump's crouch is the working hop's short one */
const flipPre = (poked: boolean) => (poked ? JUMP.clickSquashTime : FLIP_PRE * JUMP.time);
const flipDuration = (poked: boolean) =>
    flipPre(poked) +
    JUMP.time +
    SQUASH_PEAK[JUMP.squashEase] * (poked ? JUMP.clickSquashTime : JUMP.squashTime) +
    Math.max(0, JUMP.groundTime) +
    JUMP.riseTime +
    Math.max(0, JUMP.land) +
    0.05;

/* the rise: how the body comes back from its deepest squash, 1 -> 0 */
const risePulse = (v: number, ease: SquashEase) => {
    if (v <= 0) return 1;
    if (v >= 1) return 0;
    switch (ease) {
        case "sharp":
            return (1 - v) * (1 - v);
        case "soft":
            return 0.5 + 0.5 * Math.cos(Math.PI * v);
        case "bouncy":
            return Math.exp(-3.2 * v) * Math.cos(5.4 * v) - v * v * v * 0.026;
        default: {
            const k = 4.2 * v;
            return (1 + k) * Math.exp(-k) - v * v * v * 0.078;
        }
    }
};

/* the landing squash over its time, 0-1 -> its depth, faded out at the end */
const squashPulse = (u: number, ease: SquashEase) => {
    if (u <= 0 || u >= 1) return 0;
    let x: number;
    switch (ease) {
        case "sharp":
            x = (1 - u) * (1 - u);
            break;
        case "soft":
            x = Math.sin(Math.PI * u) ** 2;
            break;
        case "bouncy":
            x = (Math.exp(-3.15 * u) * Math.sin(8.43 * u)) / 0.596;
            break;
        default: {
            const k = 7 * u;
            x = (k * k * Math.exp(2 - k)) / 4;
        }
    }
    const tail = u > 0.85 ? 1 - (u - 0.85) / 0.15 : 1;
    return x * tail * tail * (3 - 2 * tail);
};

/* the weight settling through the hold, as a gain on the deepest squash */
const groundShape = (v: number, ease: SquashEase) => 1 + 0.25 * squashPulse(v, ease);
/* the hop's shaping: squash on the ground, stretch at the top */
const hopSquash = (a: number) =>
    Math.exp(-Math.pow(Math.min(Math.abs(a), Math.abs(a - 1)) / 0.11, 2));

export interface AvatarPose {
    /** radians; yaw > 0 turns the face to the viewer's right, pitch > 0 looks up */
    yaw: number;
    pitch: number;
    roll: number;
    /** body-box units (the 100 by 100 design space) */
    y: number;
    sx: number;
    sy: number;
    /** how far each lid is down right now, 0 to 1 */
    blinkL: number;
    blinkR: number;
    lookX: number;
    lookY: number;
    /** the breathing cycle, -1 to 1 */
    breath: number;
    /** how far the eyes have closed into a laugh, 0 to 1 */
    laugh: number;
    /** blend weights: idle, working, sleeping - they sum to 1 */
    w: [number, number, number];
}

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
/* how long a switch takes: settling down is slower than getting to work */
const SWITCH_TO: Record<AvatarState, number> = { idle: 1.2, working: 0.7, sleeping: 1.4 };
const SWITCH_FROM_SLEEP = 1;

/* Deterministic per-instance randomness (mulberry32). */
function rng(seed: number): () => number {
    let a = (seed * 0x9e3779b1) >>> 0 || 1;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Exponential approach: `rate` per second, frame-rate independent. */
function approach(cur: number, target: number, rate: number, dt: number): number {
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
/* gentler at both ends than the cubic: for drifting off and waking */
const easeSine = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * p);

/* A value that drifts: picks a new target inside its range every hold and
   moves to it - the head as a lightly damped spring, the eyes with a quick
   exponential approach. */
class Wander {
    value = 0;
    private vel = 0;
    private target = 0;
    private next = 0;
    constructor(
        private rand: () => number,
        public amp: number,
        public holdMin: number,
        public holdMax: number,
        public rate: number,
        private spring = false
    ) {}
    update(t: number, dt: number) {
        if (t >= this.next) {
            this.target = (this.rand() * 2 - 1) * this.amp;
            this.next = t + this.holdMin + this.rand() * (this.holdMax - this.holdMin);
        }
        if (this.spring) {
            const w = this.rate * 1.6;
            const z = 0.9;
            this.vel += (w * w * (this.target - this.value) - 2 * z * w * this.vel) * dt;
            this.value += this.vel * dt;
        } else this.value = approach(this.value, this.target, this.rate, dt);
    }
    /** aim at a value and stay there: the rig picks the next one */
    aim(v: number) {
        this.target = v;
        this.next = Infinity;
    }
    set(amp: number, holdMin: number, holdMax: number, rate: number) {
        this.amp = amp;
        this.holdMin = holdMin;
        this.holdMax = holdMax;
        this.rate = rate;
        this.next = 0;
    }
}

/* A one-shot event: progress 0 -> 1 over its duration, then idle at -1. */
class OneShot {
    p = -1;
    constructor(public duration: number) {}
    fire() {
        this.p = 0;
    }
    get active() {
        return this.p >= 0;
    }
    update(dt: number) {
        if (this.p < 0) return;
        this.p += dt / this.duration;
        if (this.p >= 1) this.p = -1;
    }
}

/* The idle gaze: how far the head swings, and how long it stays. */
const GAZE_YAW = 35 * DEG;
const GAZE_PITCH = 14 * DEG;
const GAZE_ROLL = 3.2 * DEG;
const GAZE_HOLD_MIN = 2.6;
const GAZE_HOLD_MAX = 4.4;

/* Resting targets per state; the wanderers and events add on top. */
const REST: Record<AvatarState, { pitch: number; roll: number; y: number; lookY: number }> = {
    idle: { pitch: 0, roll: 0, y: 0, lookY: 0 },
    working: { pitch: 5 * DEG, roll: 0, y: 0, lookY: 0 },
    sleeping: { pitch: -16 * DEG, roll: 6 * DEG, y: 3, lookY: 1 }
};

export class Sim {
    readonly pose: AvatarPose;
    state: AvatarState = "idle";

    private rand: () => number;
    private t = 0;
    private wFrom: [number, number, number] = [1, 0, 0];
    private tr = 1;
    private trDuration = 1.2;
    private yawW: Wander;
    private pitchW: Wander;
    private rollW: Wander;
    private lookXW: Wander;
    private lookYW: Wander;
    private blink = new OneShot(0.17);
    private blinkAt: number;
    private blinkAgain = false;
    private dart = new OneShot(0.12);
    private dartAt: number;
    private dartX = 0;
    private dartY = 0;
    private flip = new OneShot(flipDuration(false));
    private flipPoked = false;
    private flipAt: number;
    private flipSide = 1;
    private nod = new OneShot(1.7);
    private nodAt: number;
    private hopPhase = 0;
    private hopCount = 0;
    /** the hops' gain: the working weight, then held so a hop under way
        finishes whole when the state is left */
    private hopGain = 0;
    private laughEv = new OneShot(0.8);
    private laughAt: number;
    /* the jelly: a damped spring driven by how fast the head turns */
    private prevYaw = 0;
    private jelly = 0;
    private jellyV = 0;
    private gazeLead = 0;
    private gazeDir: [number, number] = [0, 0];
    private gazeAt = 0;
    private breathPhase = 0;
    /* the pointer, as an offset from the head in head widths, and how much
       to follow it - both smoothed */
    private ptrX = 0;
    private ptrY = 0;
    private ptrS = 0;
    private ptrTargetX = 0;
    private ptrTargetY = 0;
    private ptrTargetS = 0;
    private baseYaw = 0;

    constructor(seed: number, state: AvatarState = "idle") {
        this.pose = restPose(state);
        this.rand = rng(Math.floor(seed * 1e6) + 1);
        const r = this.rand;
        this.yawW = new Wander(r, 36 * DEG, 1.1, 2.6, 3, true);
        this.pitchW = new Wander(r, 10 * DEG, 1.1, 2.6, 2.6, true);
        this.rollW = new Wander(r, 5 * DEG, 1.6, 3.2, 2, true);
        this.lookXW = new Wander(r, 3.6, 0.5, 2, 14);
        this.lookYW = new Wander(r, 2.4, 0.5, 2, 14);
        /* every instance starts somewhere else in its loops */
        this.t = r() * 10;
        this.hopPhase = r();
        this.breathPhase = r();
        this.blinkAt = this.t + 1 + r() * 3;
        this.flipAt = this.nextFlip(this.t, 1);
        this.nodAt = this.t + 3 + r() * 4;
        this.dartAt = this.t + 1 + r() * 2;
        this.laughAt = this.t + 0.6 + r() * 1.5;
        this.setState(state, true);
    }

    setState(next: AvatarState, immediate = false) {
        if (next === this.state && !immediate) return;
        const from = this.state;
        this.state = next;
        const w = this.pose.w;
        if (immediate) {
            for (let i = 0; i < 3; i++) w[i] = AVATAR_STATES[i] === next ? 1 : 0;
            this.tr = 1;
        } else {
            this.wFrom = [w[0], w[1], w[2]];
            this.tr = 0;
            this.trDuration = from === "sleeping" ? SWITCH_FROM_SLEEP : SWITCH_TO[next];
        }
        switch (next) {
            case "idle":
                this.yawW.set(GAZE_YAW, 2.6, 5.4, 2);
                this.pitchW.set(GAZE_PITCH, 2.8, 5.8, 1.8);
                this.rollW.set(GAZE_ROLL, 3.4, 6.6, 1.5);
                this.gazeAt = 0;
                this.gazeDir = [0, 0];
                this.lookXW.set(3.6, 0.6, 2.2, 13);
                this.lookYW.set(2.4, 0.6, 2.2, 13);
                this.flipAt = this.nextFlip(this.t, 0.6);
                break;
            case "working":
                this.yawW.set(16 * DEG, 0.9, 1.8, 4);
                this.pitchW.set(3 * DEG, 1.2, 2.4, 3);
                this.rollW.set(0, 1, 2, 3);
                this.lookXW.set(2, 0.5, 1.2, 12);
                this.lookYW.set(1, 0.5, 1.2, 12);
                this.hopPhase = 0;
                this.hopCount = 0;
                this.laughAt = this.t + 0.5 + this.rand() * 1.2;
                break;
            case "sleeping":
                this.yawW.set(7 * DEG, 3, 6, 0.7);
                this.pitchW.set(3 * DEG, 3, 6, 0.7);
                this.rollW.set(2 * DEG, 3, 6, 0.6);
                this.lookXW.set(0, 2, 4, 2);
                this.lookYW.set(0, 2, 4, 2);
                this.nodAt = this.t + 2.5 + this.rand() * 4;
                break;
        }
    }

    /** Where the pointer is, relative to the head (-1 to 1 across a head
        width), and how strongly to follow it (0 lets go). */
    setPointer(x: number, y: number, strength: number) {
        this.ptrTargetX = Math.max(-1.2, Math.min(1.2, x));
        this.ptrTargetY = Math.max(-1.2, Math.min(1.2, y));
        this.ptrTargetS = Math.max(0, Math.min(1, strength));
    }

    /** A hop and a full turn, right now, whatever the state. */
    poke() {
        if (this.flip.active && this.flip.p < 0.6) return;
        this.flipPoked = true;
        this.flip.duration = flipDuration(true);
        this.flipSide = this.rand() < 0.5 ? -1 : 1;
        this.flip.fire();
        this.flipAt = this.nextFlip(this.t, 1.1);
    }

    /* Where the head looks next: from a corner mostly straight across to the
       opposite one, now and then only sideways, or back to the middle. */
    private nextGaze(): [number, number] {
        const r = this.rand;
        const [px, py] = this.gazeDir;
        if (px !== 0 || py !== 0) {
            const p = r();
            if (p < 0.66) return [-px, -py];
            if (p < 0.85) return [-px, py];
            return [0, 0];
        }
        const corners: Array<[number, number]> = [
            [1, -1],
            [-1, 1],
            [-1, -1],
            [1, 1]
        ];
        return corners[Math.floor(r() * corners.length)]!;
    }

    /** when the next idle jump is due: `every` seconds, give or take 40 % */
    private nextFlip(t: number, k: number) {
        return JUMP.every > 0 ? t + JUMP.every * k * (0.625 + this.rand() * 0.75) : Infinity;
    }

    /** Advance by `dt` seconds. */
    update(dt: number) {
        dt = Math.min(dt, 0.05);
        this.t += dt;
        const t = this.t;
        const p = this.pose;
        const w = p.w;

        if (this.tr < 1) {
            this.tr = Math.min(1, this.tr + dt / this.trDuration);
            const e = easeSine(this.tr);
            for (let i = 0; i < 3; i++) {
                const target = AVATAR_STATES[i] === this.state ? 1 : 0;
                w[i] = this.wFrom[i]! + (target - this.wFrom[i]!) * e;
            }
        }
        const [wd, ww, ws] = w;

        let restPitch = 0;
        let restRoll = 0;
        let restY = 0;
        let restLookY = 0;
        for (let i = 0; i < 3; i++) {
            const r = REST[AVATAR_STATES[i]!];
            restPitch += r.pitch * w[i]!;
            restRoll += r.roll * w[i]!;
            restY += r.y * w[i]!;
            restLookY += r.lookY * w[i]!;
        }

        /* the idle gaze: a place to look, a while to stay, then the swing */
        if (this.state === "idle" && t >= this.gazeAt) {
            const [gx, gy] = this.nextGaze();
            this.gazeDir = [gx, gy];
            const reach = 0.84 + this.rand() * 0.16;
            this.yawW.aim(gx * GAZE_YAW * reach);
            this.pitchW.aim(gy * GAZE_PITCH * reach);
            this.rollW.aim(gx * GAZE_ROLL * reach);
            this.gazeAt = t + GAZE_HOLD_MIN + this.rand() * (GAZE_HOLD_MAX - GAZE_HOLD_MIN);
        }

        this.yawW.update(t, dt);
        this.pitchW.update(t, dt);
        this.rollW.update(t, dt);
        this.lookXW.update(t, dt);
        this.lookYW.update(t, dt);

        /* following the pointer: the eyes lead, the head turns after them,
           and the wander quietens while it lasts */
        this.ptrS = approach(this.ptrS, this.ptrTargetS, 8, dt);
        this.ptrX = approach(this.ptrX, this.ptrTargetX, 14, dt);
        this.ptrY = approach(this.ptrY, this.ptrTargetY, 14, dt);
        const ps = this.ptrS * (1 - ws);
        const quiet = 1 - 0.75 * ps;

        this.baseYaw = approach(
            this.baseYaw,
            this.yawW.value * quiet + 22 * DEG * this.ptrX * ps,
            5,
            dt
        );
        const basePitch = restPitch + this.pitchW.value * quiet - 12 * DEG * this.ptrY * ps;
        const baseRoll = restRoll + this.rollW.value * quiet;
        const baseLookX = this.lookXW.value * quiet + 4.5 * this.ptrX * ps;
        const baseLookY = restLookY + this.lookYW.value * quiet + 3 * this.ptrY * ps;

        let spin = 0;
        let hopY = 0;
        let sx = 1;
        let sy = 1;
        let pitchAdd = 0;
        let rollAdd = 0;
        let blinkClose = 0;
        let lookXAdd = 0;
        let lookYAdd = 0;
        let laugh = 0;

        /* blinks, idle and working; a double blink now and then */
        if (t >= this.blinkAt && !this.blink.active && wd + ww > 0.5) {
            this.blink.fire();
            this.blinkAgain = !this.blinkAgain && this.rand() < 0.22;
            this.blinkAt = t + (this.blinkAgain ? 0.28 : 2.2 + this.rand() * 2.6);
        }
        this.blink.update(dt);
        if (this.blink.active) blinkClose = Math.sin(Math.PI * this.blink.p);

        /* eye darts: a quick glance to the side and back */
        if (t >= this.dartAt && !this.dart.active && wd + ww > 0.5) {
            this.dart.fire();
            this.dartX = (this.rand() * 2 - 1) * 4;
            this.dartY = (this.rand() * 2 - 1) * 2;
            this.dart.duration = 0.25 + this.rand() * 0.45;
            this.dartAt = t + 1.2 + this.rand() * 2.6;
        }
        this.dart.update(dt);
        if (this.dart.active) {
            const q = this.dart.p;
            const hold = q < 0.15 ? q / 0.15 : q > 0.8 ? (1 - q) / 0.2 : 1;
            lookXAdd += this.dartX * hold * (wd + ww);
            lookYAdd += this.dartY * hold * (wd + ww);
        }

        /* idle: a full turn now and then, with a jump */
        if (this.state === "idle" && t >= this.flipAt && !this.flip.active) {
            this.flipPoked = false;
            this.flip.duration = flipDuration(false);
            this.flipSide = this.rand() < 0.5 ? -1 : 1;
            this.flip.fire();
            this.flipAt = this.nextFlip(t, 1);
        }
        this.flip.update(dt);
        if (this.flip.active) {
            const J = JUMP;
            const preS = flipPre(this.flipPoked);
            const a = (this.flip.p * this.flip.duration - preS) / J.time;
            const q = Math.min(1, Math.max(0, a));
            const arc = Math.sin(Math.PI * q);
            spin += TAU * J.spin * easeInOut(q);
            hopY -= J.height * arc;
            const tl = (a - 1) * J.time - J.land;
            const squashTime = this.flipPoked ? J.clickSquashTime : J.squashTime;
            const crouch = (u: number) => (this.flipPoked ? u * u * (3 - 2 * u) : hopSquash(u - 1));
            const hold = Math.max(0, J.groundTime);
            const peakT = SQUASH_PEAK[J.squashEase] * squashTime;
            const rise = tl - peakT - hold;
            const depth =
                tl <= peakT
                    ? squashPulse(tl / squashTime, J.squashEase)
                    : rise <= 0
                      ? groundShape((tl - peakT) / hold, J.groundEase)
                      : risePulse(rise / J.riseTime, J.riseEase);
            const land =
                (a < 0
                    ? crouch(Math.max(0, 1 + (a * J.time) / preS))
                    : tl > 0
                      ? depth
                      : a < 0.2
                        ? hopSquash(a)
                        : 0) * J.squash;
            sx += 0.16 * land - 0.06 * arc * J.stretch;
            sy += -0.18 * land + 0.09 * arc * J.stretch;
            rollAdd += this.flipSide * J.lean * DEG * arc;
            laugh = Math.max(laugh, arc);
        }

        /* working: hops all the time; every third one spins. Leaving the
           state, the hop under way flies its whole arc and lands properly. */
        const exitHold = Math.max(0, JUMP.groundTime);
        const exitFor = exitHold + JUMP.riseTime;
        if (this.state === "working") this.hopGain = ww;
        if (this.hopGain > 0.02 && (this.state === "working" || this.hopPhase > 0)) {
            this.hopPhase += dt / HOP_T;
            if (this.hopPhase >= 1) {
                if (this.state === "working") {
                    this.hopPhase -= 1;
                    this.hopCount += 1;
                } else if ((this.hopPhase - 1) * HOP_T >= exitFor) {
                    this.hopPhase = 0;
                    this.hopGain = 0;
                }
            }
            const g = this.hopGain;
            const q = Math.min(1, this.hopPhase);
            const arc = Math.sin(Math.PI * q);
            const spinning = this.hopCount % 3 === 2;
            hopY -= (spinning ? HOP_SPIN_H : 18) * arc * g;
            const exitT =
                this.state !== "working" && this.hopPhase > 1 ? (this.hopPhase - 1) * HOP_T : -1;
            const land =
                exitT < 0
                    ? hopSquash(this.hopPhase)
                    : exitT < exitHold
                      ? groundShape(exitT / exitHold, JUMP.groundEase)
                      : risePulse((exitT - exitHold) / JUMP.riseTime, JUMP.riseEase);
            sx += (0.16 * land - 0.06 * arc) * g;
            sy += (-0.18 * land + 0.09 * arc) * g;
            if (spinning) {
                spin += TAU * easeInOut(q) * g;
                laugh = Math.max(laugh, arc * g);
            }
            rollAdd += (this.hopCount % 2 === 0 ? 1 : -1) * 6 * DEG * arc * g;
        }

        /* working: now and then a laugh shuts the eyes into arcs */
        if (this.state === "working" && t >= this.laughAt && !this.laughEv.active) {
            this.laughEv.fire();
            this.laughEv.duration = 0.6 + this.rand() * 0.5;
            this.laughAt = t + 1.6 + this.rand() * 2.2;
        }
        this.laughEv.update(dt);
        if (this.laughEv.active) {
            const q = this.laughEv.p;
            laugh = Math.max(laugh, q < 0.18 ? q / 0.18 : q > 0.78 ? (1 - q) / 0.22 : 1);
        }

        /* sleeping: the head drops, then jerks back up */
        if (this.state === "sleeping" && t >= this.nodAt && !this.nod.active) {
            this.nod.fire();
            this.nodAt = t + 4 + this.rand() * 4;
        }
        this.nod.update(dt);
        if (this.nod.active) {
            const q = this.nod.p;
            const dip = q < 0.72 ? easeInOut(q / 0.72) : 1 - easeInOut((q - 0.72) / 0.28);
            pitchAdd -= 13 * DEG * dip * ws;
        }

        /* breathing, always, deeper and slower asleep */
        this.breathPhase += dt / (3.6 + 1.2 * ws);
        const breath = Math.sin(this.breathPhase * TAU);
        p.breath = breath;
        sx += breath * (0.008 + 0.014 * ws);
        sy += breath * (0.012 + 0.02 * ws);
        const bob = Math.sin((t * TAU) / 3.4) * 2 * (1 - ws);

        p.yaw = this.baseYaw + spin;

        /* the jelly: the faster the head turns, the more the body stretches */
        let dyaw = this.baseYaw - this.prevYaw;
        dyaw = ((((dyaw + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
        this.prevYaw = this.baseYaw;
        const rate = dt > 0 ? Math.abs(dyaw) / dt : 0;
        /* the eyes lead a head turn and come back as the head settles */
        const leadTarget = dt > 0 ? Math.max(-2.2, Math.min(2.2, (dyaw / dt) * 2.4)) : 0;
        this.gazeLead = approach(this.gazeLead, leadTarget, 9, dt);
        const jellyTarget = Math.min(0.22, 0.055 * rate);
        const omega = 16;
        const zeta = 0.45;
        this.jellyV +=
            (omega * omega * (jellyTarget - this.jelly) - 2 * zeta * omega * this.jellyV) * dt;
        this.jelly += this.jellyV * dt;
        const jelly = Math.max(-0.08, Math.min(0.28, this.jelly)) * 0.6;
        sx *= 1 + jelly;
        sy *= 1 - 0.55 * jelly;

        p.pitch = basePitch + pitchAdd;
        p.roll = baseRoll + rollAdd;
        p.y = restY + hopY + bob;
        p.sx = sx;
        p.sy = sy;
        p.laugh = approach(p.laugh, laugh, 30, dt);
        p.blinkL = blinkClose;
        p.blinkR = blinkClose;
        p.lookX = baseLookX + lookXAdd + this.gazeLead;
        p.lookY = baseLookY + lookYAdd;
    }
}

/** The still pose of a state, for reduced motion and the first paint. */
export function restPose(state: AvatarState): AvatarPose {
    const r = REST[state];
    return {
        yaw: 0,
        pitch: r.pitch,
        roll: r.roll,
        y: r.y,
        sx: 1,
        sy: 1,
        blinkL: 0,
        blinkR: 0,
        lookX: 0,
        lookY: r.lookY,
        breath: 0,
        laugh: 0,
        w: [state === "idle" ? 1 : 0, state === "working" ? 1 : 0, state === "sleeping" ? 1 : 0]
    };
}
