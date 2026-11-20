/**
 * The few `Buffer` calls server modules make at module scope, for the browser.
 *
 * The scenes import screens whose modules sit next to server code, and some of
 * that code turns a constant into base64 the moment it loads
 * (`lib/agents/session-commands.ts`). The browser has no `Buffer`, so the whole
 * page threw before any scene drew. esbuild's `inject` points every bare
 * `Buffer` in the bundle here. Text and base64 in, text and base64 out: nothing
 * a scene pictures depends on more.
 */

class ShimBuffer extends Uint8Array {
    static from(value: string | ArrayLike<number> | ArrayBuffer, encoding = "utf8"): ShimBuffer {
        if (typeof value !== "string") return new ShimBuffer(value as ArrayLike<number>);
        if (encoding === "base64" || encoding === "base64url") {
            const plain = value.replace(/-/g, "+").replace(/_/g, "/");
            return new ShimBuffer(Array.from(atob(plain), (char) => char.charCodeAt(0)));
        }
        if (encoding === "hex")
            return new ShimBuffer((value.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
        return new ShimBuffer(new TextEncoder().encode(value));
    }

    static isBuffer(value: unknown): boolean {
        return value instanceof ShimBuffer;
    }

    static byteLength(value: string): number {
        return new TextEncoder().encode(value).length;
    }

    override toString(encoding = "utf8"): string {
        if (encoding === "base64" || encoding === "base64url") {
            const text = btoa(String.fromCharCode(...this));
            return encoding === "base64" ? text : text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        }
        if (encoding === "hex") return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return new TextDecoder().decode(this);
    }
}

export { ShimBuffer as Buffer };
