/**
 * Polar's avatar on a 2D canvas, the renderer of Libraries.dev's bot avatars
 * (MIT, see LICENSE beside this file) with Polar's own mark as the body.
 *
 * The body is a stack of copies of the bear's outline - the head and both
 * ears - spaced along a depth axis with a pillow profile; each copy is
 * projected with the head's yaw and pitch, so the stack reads as a rounded
 * solid that turns, hops and shows its side. The near copies are lit with a
 * directional gradient, the far side sits in shade. The face lives on a
 * sphere behind the front cap, so a turn slides it round the head. The North
 * Star hangs in the sky, outside the body, and stays put while the bear moves.
 *
 * Every path and colour is made once; a frame allocates nothing it keeps.
 */

import type { AvatarPose } from "./avatar-engine";

/* The canvas is drawn larger than the avatar's layout box, so a hop can
   leave the box without being clipped. */
export const OVERSCAN = 1.5;
/** The body's centre sits this fraction of the box below the canvas centre:
    hops need the room above, not below. */
export const RISE = 0.1;

// Polar's identity colours, fixed in every theme like a logo's (polar-mascot.tsx).
const VIOLET = "#7E4FEE";
const FUR = "#F4F6FB";
const INK = "#161A24";
const EAR = "#C9B8FA";
const MUZZLE = "#E3E7F1";

/* The mark is drawn on a 64-unit grid; the body box here is 100. */
const K = 100 / 64;
const at64 = (v: number) => v * K;

/* The outline: the head ellipse and the two ears, as in the mark. */
const HEAD = { x: at64(32), y: at64(37), rx: at64(22.5), ry: at64(19.5) };
const EARS = [
    { x: at64(15), y: at64(19) },
    { x: at64(49), y: at64(19) }
];
const EAR_R = at64(7.5);
const EAR_INNER_R = at64(3.8);
/* the bear's feet, below the body box's centre: squash keeps them down */
const FEET = HEAD.y + HEAD.ry - 50;
/* the face's centre in body units, and its features around it */
const FACE_Y = HEAD.y;
const EYE_X = at64(8.5);
const EYE_Y = at64(35) - FACE_Y;
const MUZZLE_AT = { y: at64(44.5) - FACE_Y, rx: at64(9.5), ry: at64(7) };
const NOSE_AT = { y: at64(40.8) - FACE_Y, rx: at64(3.4), ry: at64(2.4) };
const MOUTH_TOP = at64(43.2) - FACE_Y;
const MOUTH_WIDTH = at64(1.6);
/* the open eye is the library's at this scale: the mark's eyes are smaller */
const EYE_SCALE = 0.62;
/* the North Star: four points around (56, 8), 5 units out */
const STAR_AT = { x: at64(56), y: at64(8), r: at64(5) };

/* Copies through the depth, and the half-depth in body units. */
const SLICES = 17;
const HALF_DEPTH = 15 * 0.65;
/* Cap scale at the ends of the pillow. */
const CAP = 1 - (1 - 0.9) * 0.5;
const profile = (z: number) => CAP + (1 - CAP) * Math.sqrt(Math.max(0, 1 - z * z));
/* the light's direction on screen: from the upper left */
const LIGHT = (300 * Math.PI) / 180;
const LX = Math.sin(LIGHT);
const LY = -Math.cos(LIGHT);
/* Radius of the sphere the face is drawn on, in body units. */
const FACE_R = 30;

/* ---- colour: the fur's shades, made once ---- */

function hexHsl(hex: string): [number, number, number] {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h =
        max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const css = ([h, s, l]: [number, number, number]) =>
    `hsl(${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
/** A colour `dl` lighter (negative darker) and `ds` more saturated, as hsl numbers. */
function shade(hex: string, dl: number, ds = 0): [number, number, number] {
    const [h, s, l] = hexHsl(hex);
    return [h, clamp01(s + ds + (dl < 0 ? -dl * 0.25 : 0)), clamp01(l + dl)];
}
const mix = (a: [number, number, number], b: [number, number, number], t: number) =>
    css([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);

/* the stock crisp look: shadow 0.35, highlight 1.3 */
const SHADOW = 0.35;
const HIGHLIGHT = 1.3;
const FAR = shade(FUR, -0.3 * SHADOW, 0.05 * SHADOW);
const NEAR = shade(FUR, -0.12 * SHADOW, 0.03 * SHADOW);
const PAL = {
    near: css(NEAR),
    light: css(shade(FUR, 0.04 * HIGHLIGHT)),
    dark: css(FAR),
    capTop: css(shade(FUR, 0.035 * HIGHLIGHT)),
    capBottom: css(shade(FUR, -0.035 * SHADOW)),
    /* the far slices' colours by draw order; the near ones take the lit gradient */
    mix: Array.from({ length: SLICES }, (_, j) => {
        const t = j / (SLICES - 1);
        return t > 0.6 ? "" : mix(FAR, NEAR, t / 0.6);
    })
};

/* ---- paths, made once on first use (Path2D is a browser global) ---- */

interface Paths {
    body: Path2D;
    star: Path2D;
    eyes: Map<number, Path2D>;
}
let paths: Paths | null = null;
function getPaths(): Paths {
    if (paths) return paths;
    const body = new Path2D();
    body.ellipse(HEAD.x, HEAD.y, HEAD.rx, HEAD.ry, 0, 0, Math.PI * 2);
    for (const ear of EARS) {
        body.moveTo(ear.x + EAR_R, ear.y);
        body.arc(ear.x, ear.y, EAR_R, 0, Math.PI * 2);
    }
    /* the star around its own centre, so it can twinkle and turn in place */
    const s = (v: number) => (v * K).toFixed(3);
    const star = new Path2D(
        `M0 ${s(-5)} Q0 0 ${s(5)} 0 Q0 0 0 ${s(5)} Q0 0 ${s(-5)} 0 Q0 0 0 ${s(-5)} Z`
    );
    paths = { body, star, eyes: new Map() };
    return paths;
}

/* An eye's curve as a short polyline with round joins, cached by its
   numbers: Safari's stroker does not round a cusp, both stroke a polyline
   the same way. */
const EYE_STEPS = 8;
function eyePath(x0: number, y0: number, cy: number): Path2D {
    const cache = getPaths().eyes;
    const qx = Math.round(x0 * 50);
    const qy = Math.round(y0 * 50);
    const qc = Math.round(cy * 50);
    const key = qx + 2000 * qy + 4e6 * qc;
    let p = cache.get(key);
    if (!p) {
        const ax = qx / 50;
        const ay = qy / 50;
        const ac = qc / 50;
        let d = `M${-ax} ${ay}`;
        for (let i = 1; i <= EYE_STEPS; i++) {
            const t = i / EYE_STEPS;
            const mt = 1 - t;
            d += ` L${(mt * mt * -ax + t * t * ax).toFixed(3)} ${((mt * mt + t * t) * ay + 2 * mt * t * ac).toFixed(3)}`;
        }
        p = new Path2D(d);
        if (cache.size > 256) cache.clear();
        cache.set(key, p);
    }
    return p;
}

/* the gradients belong to a context: made once per canvas */
const gradients = new WeakMap<
    CanvasRenderingContext2D,
    { lit: CanvasGradient; cap: CanvasGradient }
>();
function gradientsFor(ctx: CanvasRenderingContext2D) {
    let g = gradients.get(ctx);
    if (!g) {
        const lit = ctx.createLinearGradient(LX * 56, LY * 56, -LX * 56, -LY * 56);
        lit.addColorStop(0, PAL.light);
        lit.addColorStop(0.45, PAL.near);
        lit.addColorStop(1, PAL.dark);
        const cap = ctx.createLinearGradient(LX * 46, LY * 46, -LX * 46, -LY * 46);
        cap.addColorStop(0, PAL.capTop);
        cap.addColorStop(1, PAL.capBottom);
        g = { lit, cap };
        gradients.set(ctx, g);
    }
    return g;
}

/* A feature's place on the sphere, written into one reused object. */
const spot = { x: 0, y: 0, sx: 1, sy: 1, z: 1 };
function onSphere(x: number, y: number, yaw: number, pitch: number) {
    const lon = Math.asin(Math.max(-1, Math.min(1, x / FACE_R))) + yaw;
    const lat = Math.asin(Math.max(-1, Math.min(1, -y / FACE_R))) + pitch;
    const cl = Math.cos(lat);
    spot.x = FACE_R * Math.sin(lon) * cl;
    spot.y = -FACE_R * Math.sin(lat);
    spot.sx = Math.cos(lon);
    spot.sy = cl;
    spot.z = Math.cos(lon) * cl;
    return spot;
}

/* where a sideways or upward look stops being "at rest" */
const past = (v: number, d: number) =>
    Math.abs(v) <= d ? 0 : (Math.sign(v) * (Math.abs(v) - d)) / (1 - d);
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/**
 * Draw one frame. `box` is the avatar's layout size in CSS px; the canvas is
 * `box * OVERSCAN` square at `dpr`, with the body's centre `RISE * box` below
 * its middle. `seconds` drives only the star.
 */
export function drawAvatar(
    ctx: CanvasRenderingContext2D,
    box: number,
    dpr: number,
    pose: AvatarPose,
    seconds: number
): void {
    const full = box * OVERSCAN;
    const S = box / 100;
    const { body: bodyPath, star } = getPaths();
    const grad = gradientsFor(ctx);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, full, full);
    const [wd, ww, ws] = pose.w;

    /* the North Star, in the sky: it twinkles while Polar looks around,
       turns while it works and dims while it sleeps */
    const twinkle = 0.5 - 0.5 * Math.cos((seconds * Math.PI * 2) / 2.8);
    const turn = easeInOut((seconds / 1.4) % 1) * (Math.PI / 2);
    const starScale = 1 + 0.18 * twinkle * wd;
    const cx = full / 2 + (STAR_AT.x - 50) * S;
    const cy = full / 2 + RISE * box + (STAR_AT.y - 50) * S;
    const cr = Math.cos(turn * ww) * starScale * S * dpr;
    const sr = Math.sin(turn * ww) * starScale * S * dpr;
    ctx.setTransform(cr, sr, -sr, cr, cx * dpr, cy * dpr);
    ctx.globalAlpha = (1 - 0.15 * twinkle * wd) * (1 - 0.45 * ws);
    ctx.fillStyle = VIOLET;
    ctx.fill(star);
    ctx.globalAlpha = 1;

    const cy0 = Math.cos(pose.yaw);
    const sy = Math.sin(pose.yaw);
    const cp0 = Math.cos(pose.pitch);
    const sp = Math.sin(pose.pitch);
    /* which cap faces the viewer: the front while this is positive */
    const facing = cy0 * cp0;
    /* edge-on every slice would thin to a line; a floor keeps it a solid */
    const floor = (v: number) => (Math.abs(v) < 0.22 ? (v < 0 ? -0.22 : 0.22) : v);
    const cyf = floor(cy0);
    const cpf = floor(cp0);

    /* body space: the box centre plus the pose's offset, roll and squash,
       scaled about the feet so a landing keeps them on the ground */
    const rc = Math.cos(pose.roll);
    const rs = Math.sin(pose.roll);
    const kx = pose.sx * S;
    const ky = pose.sy * S;
    const lift = FEET * (1 - pose.sy) * S;
    const ba = rc * kx * dpr;
    const bb = rs * kx * dpr;
    const bc = -rs * ky * dpr;
    const bd = rc * ky * dpr;
    const be = (full / 2 - rs * lift) * dpr;
    const bf = (full / 2 + RISE * box + pose.y * S + rc * lift) * dpr;
    ctx.save();
    ctx.setTransform(ba, bb, bc, bd, be, bf);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    /* slices, far to near; each transform is set relative to the last */
    const order = facing >= 0 ? 1 : -1;
    let pa = 1;
    let pb = 0;
    let pc = 0;
    let pd = 1;
    let pe = 0;
    let pf = 0;
    let fill: CanvasGradient | string | null = null;
    for (let j = 0; j < SLICES; j++) {
        const k = order > 0 ? j : SLICES - 1 - j;
        const z = -1 + (2 * k) / (SLICES - 1);
        const s = profile(z);
        const near = j / (SLICES - 1);
        const m0 = cyf * s;
        const m1 = sy * sp * s;
        const m3 = cpf * s;
        const e = z * sy * HALF_DEPTH - 50 * m0;
        const fo = -z * cyf * sp * HALF_DEPTH - 50 * m1 - 50 * m3;
        const det = pa * pd - pb * pc;
        const ia = pd / det;
        const ib = -pb / det;
        const ic = -pc / det;
        const id = pa / det;
        const ie = (pc * pf - pd * pe) / det;
        const jf = (pb * pe - pa * pf) / det;
        ctx.transform(
            ia * m0 + ic * m1,
            ib * m0 + id * m1,
            ic * m3,
            id * m3,
            ia * e + ic * fo + ie,
            ib * e + id * fo + jf
        );
        pa = m0;
        pb = m1;
        pc = 0;
        pd = m3;
        pe = e;
        pf = fo;
        const style = j === SLICES - 1 ? grad.cap : near > 0.6 ? grad.lit : PAL.mix[j]!;
        if (style !== fill) ctx.fillStyle = fill = style;
        ctx.fill(bodyPath);
    }

    /* the front cap's own transform: the outline's edge, the inner ears,
       and the clip that keeps the face on the body */
    const zf = facing >= 0 ? 1 : -1;
    const sf = profile(zf);
    const fm0 = cyf * sf;
    const fm1 = sy * sp * sf;
    const fm3 = cpf * sf;
    const fe = zf * sy * HALF_DEPTH - 50 * fm0;
    const ffo = -zf * cyf * sp * HALF_DEPTH - 50 * fm1 - 50 * fm3;
    ctx.setTransform(
        ba * fm0 + bc * fm1,
        bb * fm0 + bd * fm1,
        bc * fm3,
        bd * fm3,
        ba * fe + bc * ffo + be,
        bb * fe + bd * ffo + bf
    );
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.4;
    ctx.stroke(bodyPath);
    ctx.globalAlpha = 1;

    if (facing > -0.2) {
        ctx.clip(bodyPath);
        ctx.fillStyle = EAR;
        for (const ear of EARS) {
            ctx.beginPath();
            ctx.arc(ear.x, ear.y, EAR_INNER_R, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.setTransform(ba, bb, bc, bd, be, bf);
        ctx.translate(0, FACE_Y - 50);
        drawFace(ctx, pose);
    }
    ctx.restore();
}

/* place a feature on the sphere: skipped once it has gone round the side */
function feature(
    ctx: CanvasRenderingContext2D,
    pose: AvatarPose,
    x: number,
    y: number,
    alpha: number,
    paint: () => void
) {
    const q = onSphere(x, y, pose.yaw, pose.pitch);
    if (q.z <= 0.02 || alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha * Math.min(1, q.z * 5);
    ctx.translate(q.x, q.y);
    ctx.scale(Math.max(0.02, q.sx), Math.max(0.02, q.sy));
    paint();
    ctx.restore();
}

function drawFace(ctx: CanvasRenderingContext2D, pose: AvatarPose) {
    const [wd, ww, ws] = pose.w;
    const lx = pose.lookX * 0.7;
    const ly = pose.lookY * 0.7;

    feature(ctx, pose, lx * 0.2, MUZZLE_AT.y, 1, () => {
        ctx.fillStyle = MUZZLE;
        ctx.beginPath();
        ctx.ellipse(0, 0, MUZZLE_AT.rx, MUZZLE_AT.ry, 0, 0, Math.PI * 2);
        ctx.fill();
    });
    feature(ctx, pose, lx * 0.25, NOSE_AT.y, 1, () => {
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.ellipse(0, 0, NOSE_AT.rx, NOSE_AT.ry, 0, 0, Math.PI * 2);
        ctx.fill();
    });

    /* the mouth: the line under the nose and one curve whose numbers are a
       blend of the three states' - the mark's smile, a wide open grin at
       work, a small flat line asleep - so a switch morphs it */
    const b = (d: number, w: number, s: number) => wd * d + ww * w + ws * s;
    const half = b(at64(2.6), at64(3.4), at64(2));
    const ends = b(at64(2.2), at64(1.8), at64(2.6));
    const dip = b(at64(4.6), at64(6.2), at64(2.9)) * (1 + 0.06 * pose.breath);
    feature(ctx, pose, lx * 0.3, MOUTH_TOP, 1, () => {
        ctx.strokeStyle = INK;
        ctx.lineWidth = MOUTH_WIDTH;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, ends);
        ctx.moveTo(-half, ends);
        ctx.quadraticCurveTo(0, dip, half, ends);
        ctx.stroke();
    });

    /* Each eye is one stroked curve - endpoints at x0, y0, a control point
       at 0, cy, width w - so every look is the same shape with different
       numbers and a blend of them is a real morph: the open pill squashes
       into a shut line, swings into a laughing arc, or droops into a
       sleeping lid. The eyes draw taller looking up and a little wider
       from a sideways glance. */
    const up = past(clamp1(-pose.pitch / 0.26 - pose.lookY / 7), 0.34);
    const side = Math.abs(past(clamp1(pose.lookX / 4.5), 0.4));
    const tall = Math.max(0.3, 1 + 0.55 * up - 0.1 * side);
    const wide = 1 - 0.05 * up + 0.12 * side;
    const open = wd + ww * (1 - pose.laugh);
    const laugh = ww * pose.laugh;
    const lift = Math.max(0, -pose.y) / 26;
    const sag = 0.5 + 0.5 * pose.breath;
    for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
        const dir = sideIndex === 0 ? -1 : 1;
        const lid = dir < 0 ? pose.blinkL : pose.blinkR;
        const e = clamp01(1 - lid);
        const kOpen = open * e;
        const kShut = open * (1 - e);
        const x0 = kOpen * 0.01 + kShut * 5.4 + laugh * 6.2 + ws * 6;
        const y0 =
            kOpen * 1.1 * tall + kShut * 0.6 + laugh * (2.2 - lift * 1.5) + ws * (-1.4 + sag);
        const cy =
            kOpen * -3.3 * tall + kShut * 0.6 + laugh * (-11.4 - 4 * lift) + ws * (5.4 + 2 * sag);
        const w = kOpen * 6.3 * 2 * wide + kShut * 2.8 + laugh * 4.4 + ws * 4;
        const dx = lx * (kOpen + 0.5 * (kShut + laugh));
        const dy = ly * (kOpen + 0.5 * kShut);
        feature(ctx, pose, dir * EYE_X + dx, EYE_Y + dy, 1, () => {
            ctx.scale(EYE_SCALE, EYE_SCALE);
            ctx.strokeStyle = INK;
            ctx.lineWidth = w;
            ctx.stroke(eyePath(x0, y0, cy));
            /* the mark's catch-light, while the eye is open */
            if (kOpen > 0.05) {
                ctx.globalAlpha *= kOpen;
                ctx.fillStyle = "#FFFFFF";
                ctx.beginPath();
                ctx.arc(2.1, -2.4 * tall, 2.1, 0, Math.PI * 2);
                ctx.fill();
            }
        });
    }
}
