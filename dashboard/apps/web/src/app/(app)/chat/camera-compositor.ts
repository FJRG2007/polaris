"use client";

/**
 * The GPU half of a camera background: mask in, finished frame out, without a
 * pixel ever passing through JavaScript.
 *
 * It draws on the same WebGL 2 context the segmenter runs on, so the mask the
 * model produces is already a texture here. That context is shared, which is
 * the one thing to keep in mind when changing this file: every pass sets all
 * the state it relies on, because the model's own passes leave theirs behind.
 *
 * The passes, in order (see `camera-mask` for the numbers and their source):
 *
 * 1. **Temporal** - the new mask is blended into the last one, more where it
 *    agrees (noise) and less where it does not (movement).
 * 2. **Refine** - a joint bilateral filter moves the mask's edge onto the
 *    picture's edge: hair and shoulders instead of a 256-pixel staircase.
 * 3. **Blur** - the background at a quarter size, with the person weighted out
 *    of it so they do not bleed into the room as a halo, then a separable
 *    Gaussian.
 * 4. **Composite** - person over background, with a little of the background's
 *    light wrapped onto the outline so the cut-out does not look pasted on.
 */

import * as mask from "./camera-mask";
import { CameraFailure } from "./camera-problem";

type Size = { width: number; height: number };

interface Target {
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    width: number;
    height: number;
}

/** One frame to composite. A blind frame is one the model has given up on:
 *  everything is drawn as background, strongly blurred. */
export interface CompositorFrame {
    readonly source: TexImageSource;
    readonly width: number;
    readonly height: number;
    readonly blind: boolean;
}

export interface Compositor {
    /** Fold a new model answer into the smoothed mask. */
    readonly track: (texture: WebGLTexture, width: number, height: number) => void;
    /** Draw a finished frame onto the canvas at the frame's size. */
    readonly render: (frame: CompositorFrame) => void;
    /** The smoothed mask, RGBA with the mask in alpha, top row first; null
     *  before the model has answered once. */
    readonly readMask: (width: number, height: number) => Uint8Array | null;
    readonly dispose: () => void;
}

export interface CompositorOptions {
    readonly params: mask.CompositeParams | null;
    readonly blindParams: mask.CompositeParams;
    readonly image: HTMLImageElement | null;
}

const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
    uv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
`;

const TEMPORAL = `${HEADER}
uniform sampler2D current;
uniform sampler2D previous;
uniform float first;
void main() {
    float now = texture(current, uv).r;
    float before = texture(previous, uv).r;
    float weight = first > 0.5
        ? 1.0
        : mix(${glsl(mask.TEMPORAL.still)}, 1.0,
              smoothstep(${glsl(mask.TEMPORAL.low)}, ${glsl(mask.TEMPORAL.high)}, abs(now - before)));
    color = vec4(mix(before, now, weight));
}`;

const REFINE = `${HEADER}
uniform sampler2D smoothed;
uniform sampler2D frame;
uniform vec2 maskTexel;
void main() {
    vec3 centre = texture(frame, uv).rgb;
    float total = 0.0;
    float weights = 0.0;
    for (int y = -${mask.REFINE.radius}; y <= ${mask.REFINE.radius}; y++) {
        for (int x = -${mask.REFINE.radius}; x <= ${mask.REFINE.radius}; x++) {
            vec2 at = uv + vec2(float(x), float(y)) * maskTexel;
            vec3 difference = texture(frame, at).rgb - centre;
            float space = exp(-float(x * x + y * y) / ${glsl(2 * mask.REFINE.sigmaSpace ** 2)});
            float tone = exp(-dot(difference, difference) / ${glsl(2 * mask.REFINE.sigmaColor ** 2)});
            float weight = space * tone;
            total += texture(smoothed, at).r * weight;
            weights += weight;
        }
    }
    color = vec4(total / max(weights, 0.0001));
}`;

/** The background with the person weighted out, premultiplied: rgb * weight,
 *  weight. A blur of that, divided by its alpha, is a blur of the room alone. */
const WEIGHT = `${HEADER}
uniform sampler2D frame;
uniform sampler2D refined;
uniform float useMask;
void main() {
    float person = useMask > 0.5 ? smoothstep(0.1, 0.6, texture(refined, uv).r) : 0.0;
    float weight = 1.0 - person;
    color = vec4(texture(frame, uv).rgb * weight, weight);
}`;

const BLUR = `${HEADER}
uniform sampler2D source;
uniform vec2 direction;
uniform float sigma;
uniform int radius;
void main() {
    vec4 sum = vec4(0.0);
    float total = 0.0;
    for (int i = -${mask.MAX_BLUR_RADIUS}; i <= ${mask.MAX_BLUR_RADIUS}; i++) {
        if (i < -radius || i > radius) continue;
        float weight = exp(-float(i * i) / (2.0 * sigma * sigma));
        sum += texture(source, uv + direction * float(i)) * weight;
        total += weight;
    }
    color = sum / total;
}`;

/** The final draw, onto the canvas. The canvas's rows run bottom-up, every
 *  texture here top-down, hence the flipped coordinate. */
const COMPOSITE = `${HEADER}
uniform sampler2D frame;
uniform sampler2D refined;
uniform sampler2D background;
uniform int picture;
uniform vec4 cover;
uniform vec2 edge;
uniform float wrap;
uniform float blind;
void main() {
    vec2 at = vec2(uv.x, 1.0 - uv.y);
    vec3 person = texture(frame, at).rgb;
    vec3 room;
    if (picture == 1) {
        room = texture(background, at * cover.xy + cover.zw).rgb;
    } else {
        vec4 blurred = texture(background, at);
        room = blurred.a > 0.004 ? blurred.rgb / blurred.a : person;
    }
    float alpha = blind > 0.5 ? 0.0 : smoothstep(edge.x, edge.y, texture(refined, at).r);
    float rim = 4.0 * alpha * (1.0 - alpha);
    vec3 lit = mix(person, room, wrap * rim);
    color = vec4(mix(room, lit, alpha), 1.0);
}`;

/** The smoothed mask, copied into alpha for reading back. */
const COPY = `${HEADER}
uniform sampler2D source;
void main() {
    color = vec4(texture(source, uv).r);
}`;

/**
 * Build the compositor on a WebGL 2 context, or throw saying why not - a
 * shader that will not compile is a reason the screen can show.
 */
export function createCompositor(
    gl: WebGL2RenderingContext,
    options: CompositorOptions
): Compositor {
    const programs = {
        temporal: program(gl, TEMPORAL),
        refine: program(gl, REFINE),
        weight: program(gl, WEIGHT),
        blur: program(gl, BLUR),
        composite: program(gl, COMPOSITE),
        copy: program(gl, COPY)
    };

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One triangle that covers the viewport.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const built of Object.values(programs)) {
        const at = gl.getAttribLocation(built, "position");
        if (at >= 0) {
            gl.enableVertexAttribArray(at);
            gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
        }
    }
    gl.bindVertexArray(null);

    const frame = texture(gl);
    const picture = options.image ? texture(gl) : null;
    if (picture && options.image) upload(gl, picture, options.image);

    // Two buffers for the smoothed mask, swapped every frame: one is read as
    // the previous answer while the other is written.
    const smoothed: [Target | null, Target | null] = [null, null];
    let latest = -1;
    let refined: Target | null = null;
    let weighted: Target | null = null;
    let across: Target | null = null;
    let down: Target | null = null;
    let reading: Target | null = null;

    function prepare(): void {
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.STENCIL_TEST);
        gl.colorMask(true, true, true, true);
        gl.bindVertexArray(vao);
    }

    function finishPass(): void {
        gl.bindVertexArray(null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
    }

    function draw(
        target: Target | null,
        size: Size,
        used: WebGLProgram,
        textures: Record<string, WebGLTexture>,
        uniforms: (location: (name: string) => WebGLUniformLocation | null) => void
    ): void {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
        gl.viewport(0, 0, size.width, size.height);
        gl.useProgram(used);
        let unit = 0;
        for (const [name, bound] of Object.entries(textures)) {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, bound);
            gl.uniform1i(gl.getUniformLocation(used, name), unit);
            unit += 1;
        }
        uniforms((name) => gl.getUniformLocation(used, name));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function track(current: WebGLTexture, width: number, height: number): void {
        prepare();
        // The model's texture may be a float format that cannot be filtered
        // without an extension; sampled as it comes, it reads as all zeros.
        gl.bindTexture(gl.TEXTURE_2D, current);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const next = latest === 0 ? 1 : 0;
        smoothed[next] = sized(gl, smoothed[next], { width, height });
        const previous = latest >= 0 ? smoothed[latest] : null;
        const fresh = !previous || previous.width !== width || previous.height !== height;
        draw(
            smoothed[next],
            { width, height },
            programs.temporal,
            // Never the target itself: sampling what is being drawn into is an
            // error. A first frame takes the new mask whole, so either is fine.
            { current, previous: fresh || !previous ? current : previous.texture },
            (at) => gl.uniform1f(at("first"), fresh ? 1 : 0)
        );
        latest = next;
        finishPass();
    }

    function render(input: CompositorFrame): void {
        const blind = input.blind || !options.params;
        const params = blind || !options.params ? options.blindParams : options.params;
        const output = { width: input.width, height: input.height };
        const canvas = gl.canvas;
        if (canvas.width !== output.width || canvas.height !== output.height) {
            canvas.width = output.width;
            canvas.height = output.height;
        }
        prepare();
        upload(gl, frame, input.source);

        const current = latest >= 0 ? smoothed[latest] : null;
        const usable = !blind && current;
        if (usable) {
            const size = mask.refineSize(output.width, output.height);
            refined = sized(gl, refined, size);
            draw(refined, size, programs.refine, { smoothed: current.texture, frame }, (at) =>
                gl.uniform2f(at("maskTexel"), 1 / current.width, 1 / current.height)
            );
        }

        let room: WebGLTexture;
        if (!blind && picture && options.image) {
            room = picture;
        } else {
            const small = mask.blurSize(output.width, output.height);
            weighted = sized(gl, weighted, small);
            across = sized(gl, across, small);
            down = sized(gl, down, small);
            draw(
                weighted,
                small,
                programs.weight,
                { frame, refined: usable && refined ? refined.texture : frame },
                (at) => gl.uniform1f(at("useMask"), usable ? 1 : 0)
            );
            const blur = (from: Target, to: Target, dx: number, dy: number) =>
                draw(to, small, programs.blur, { source: from.texture }, (at) => {
                    gl.uniform2f(at("direction"), dx / small.width, dy / small.height);
                    gl.uniform1f(at("sigma"), params.sigma);
                    gl.uniform1i(at("radius"), params.radius);
                });
            blur(weighted, across, 1, 0);
            blur(across, down, 0, 1);
            room = down.texture;
        }

        const cover = options.image
            ? mask.coverUv(
                  options.image.naturalWidth,
                  options.image.naturalHeight,
                  output.width,
                  output.height
              )
            : [1, 1, 0, 0];
        draw(
            null,
            output,
            programs.composite,
            { frame, refined: usable && refined ? refined.texture : frame, background: room },
            (at) => {
                gl.uniform1i(at("picture"), !blind && picture ? 1 : 0);
                gl.uniform4f(at("cover"), cover[0]!, cover[1]!, cover[2]!, cover[3]!);
                gl.uniform2f(at("edge"), params.edge[0], params.edge[1]);
                gl.uniform1f(at("wrap"), params.wrap);
                gl.uniform1f(at("blind"), usable ? 0 : 1);
            }
        );
        finishPass();
    }

    function readMask(width: number, height: number): Uint8Array | null {
        const current = latest >= 0 ? smoothed[latest] : null;
        if (!current) return null;
        prepare();
        reading = sized(gl, reading, { width, height });
        draw(
            reading,
            { width, height },
            programs.copy,
            { source: current.texture },
            () => undefined
        );
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        finishPass();
        return pixels;
    }

    function dispose(): void {
        for (const target of [...smoothed, refined, weighted, across, down, reading]) {
            if (!target) continue;
            gl.deleteFramebuffer(target.framebuffer);
            gl.deleteTexture(target.texture);
        }
        gl.deleteTexture(frame);
        if (picture) gl.deleteTexture(picture);
        for (const built of Object.values(programs)) gl.deleteProgram(built);
        gl.deleteBuffer(buffer);
        gl.deleteVertexArray(vao);
    }

    return { track, render, readMask, dispose };
}

/** A number as a GLSL float literal: `1` is an int there, and an int where a
 *  float is wanted does not compile. */
function glsl(value: number): string {
    return Number.isInteger(value) ? `${value}.0` : String(value);
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
    const built = gl.createProgram();
    const parts = [shader(gl, gl.VERTEX_SHADER, VERTEX), shader(gl, gl.FRAGMENT_SHADER, fragment)];
    for (const part of parts) gl.attachShader(built, part);
    gl.linkProgram(built);
    for (const part of parts) gl.deleteShader(part);
    if (!gl.getProgramParameter(built, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(built) ?? "";
        gl.deleteProgram(built);
        throw new CameraFailure("graphics", log.trim() || null);
    }
    return built;
}

function shader(gl: WebGL2RenderingContext, kind: number, source: string): WebGLShader {
    const built = gl.createShader(kind);
    if (!built) throw new CameraFailure("graphics");
    gl.shaderSource(built, source);
    gl.compileShader(built);
    if (!gl.getShaderParameter(built, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(built) ?? "";
        gl.deleteShader(built);
        throw new CameraFailure("graphics", log.trim() || null);
    }
    return built;
}

function texture(gl: WebGL2RenderingContext): WebGLTexture {
    const made = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, made);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return made;
}

function upload(gl: WebGL2RenderingContext, into: WebGLTexture, source: TexImageSource): void {
    gl.bindTexture(gl.TEXTURE_2D, into);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

/** A render target of `size`, reusing `current` when it already is that size. */
function sized(gl: WebGL2RenderingContext, current: Target | null, size: Size): Target {
    if (current && current.width === size.width && current.height === size.height) return current;
    if (current) {
        gl.deleteFramebuffer(current.framebuffer);
        gl.deleteTexture(current.texture);
    }
    const made = texture(gl);
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        size.width,
        size.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null
    );
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, made, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture: made, framebuffer, ...size };
}
