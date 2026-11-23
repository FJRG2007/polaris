/**
 * The strict Content-Security-Policy (docs/integrity.md): scripts run only when
 * they carry this response's nonce or were loaded by one that did
 * (`'strict-dynamic'`), so a script injected into a page - by a proxy, by a
 * changed file, by markup that slipped through - does not run.
 *
 * Sent report-only for now. Next.js puts the nonce on its own scripts when it
 * finds one in the request's policy header (app-render reads
 * `content-security-policy-report-only` as well), but a page that writes an
 * inline script of its own, or one served from a prerender without a nonce,
 * would stop working under an enforced policy. The reports
 * (`/api/csp-report`) say which those are; enforcing waits until they are
 * none.
 */

export const CSP_REPORT_PATH = "/api/csp-report";

/** A fresh nonce for one response: 128 random bits, base64. */
export function cspNonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export function strictCsp(nonce: string): string {
    return [
        `script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' https: 'unsafe-inline'`,
        "object-src 'none'",
        "base-uri 'self'",
        `report-uri ${CSP_REPORT_PATH}`
    ].join("; ");
}
