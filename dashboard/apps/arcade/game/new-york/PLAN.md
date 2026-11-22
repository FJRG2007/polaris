# New York: graphics and shooter plan

New York (based on mrdoob/slop-newyork, MIT) is an open city on three.js
`WebGPURenderer` with TSL node materials, a WebGL 2 fallback, clustered lights,
a Preetham sky with clouds baked to a PMREM environment, aerial fog, two
cascaded sun shadows, half-res SSR, bloom and a colour grade. On top of it the
operator asked for a GTA-style shooter and a picture closer to a modern game.

The techniques follow published work, cited where they are implemented. No code
from other games is used.

## What exists

| Area      | Before this plan                                                         |
| --------- | ------------------------------------------------------------------------ |
| Levels    | Auto, Low, Medium, High (`engine/quality.js`)                            |
| Tone      | ACES, grade, vignette                                                    |
| Shadows   | `SunLight` CSM, 2 x 2048 tiles, 5-tap Vogel PCF                          |
| Post      | SSR (High), bloom (Medium+)                                              |
| Sky / IBL | `SkyMesh` + clouds, PMREM bake per time of day, sky-matched aerial fog   |
| Play      | Walk, drive, cycle, fly; keyboard/mouse, gamepad, touch, phone as a pad  |

## Phases

1. **Levels, tone, exposure, shadows.** Ultra level; each level sets render
   scale, shadow tile, shadow filter, AO, shafts, motion blur and rain. Auto reads
   the chip name (software -> Low, integrated -> Medium, top discrete -> Ultra).
   AgX tone mapping, centre-weighted auto exposure, display dither, damage
   vignette and fringing. Contact-hardening soft sun shadows on High/Ultra.
2. **Post stack.** Half-res GTAO (High+), screen-space light shafts (Medium+),
   camera motion blur from depth reprojection (Ultra).
3. **Weather.** Rain around the camera with wet, reflective streets.
4. **Shooter.** Over-the-shoulder aim on foot, hitscan weapons (magazine,
   reserve, fire rate, spread, damage, recoil and recovery, aim-down-sights FOV),
   hits resolved against buildings first and then body parts (head x2.5),
   synthesized gunshots, crews with a patrol / investigate / engage / search /
   cover state machine, a wanted level that escalates, weapon pickups, health
   and respawn.

## Budget per level (1280 x 720, frame time on the GPU the level targets)

| Level  | Scale | Shadow tile | Shadow filter      | AO      | Shafts | Motion blur | Target            |
| ------ | ----- | ----------- | ------------------ | ------- | ------ | ----------- | ----------------- |
| Low    | 0.8   | none        | none               | no      | no     | no          | 33 ms, any GPU    |
| Medium | 1.0   | 2048        | 5-tap PCF          | no      | 16     | no          | 33 ms, integrated |
| High   | 1.0   | 2048        | 28-tap contact     | half    | 32     | no          | 16 ms, mid card   |
| Ultra  | <=1.5 | 4096        | 28-tap contact     | half    | 48     | 6 taps      | 16 ms, top card   |

Measured numbers live in the commit messages of each phase; they come from a
headless Chrome on the development machine and are no substitute for a real
integrated GPU or a phone.
