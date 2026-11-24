/**
 * JSON with every character outside ASCII written as a `\uXXXX` escape. The
 * value is the same to any JSON reader, and the bytes read the same whatever
 * encoding a reader assumes: GitHub serves release files as
 * `application/octet-stream` with no charset, and a reader that falls back to
 * Latin-1 (PowerShell's Invoke-WebRequest, a browser's raw view) turned the
 * UTF-8 "botón" into "botÃ³n".
 */
export function asciiJson(value, space) {
    return JSON.stringify(value, null, space).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
