/**
 * Transactions shaped as the official SDKs send them: @sentry/browser's page
 * load (Web Vitals in `measurements`, resource and browser spans), its
 * standalone INP span, and @sentry/node's served request (a parameterized
 * route, database spans). Fixture values, not captured traffic.
 */

// 2026-01-01T00:00:00Z, in seconds as the SDKs send it.
const start = 1_767_225_600;

export const browserPageload = {
    type: "transaction",
    event_id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    platform: "javascript",
    transaction: "/checkout/:step",
    transaction_info: { source: "route" },
    start_timestamp: start,
    timestamp: start + 3.4,
    release: "shop@1.2.3",
    environment: "production",
    contexts: { trace: { op: "pageload", trace_id: "a".repeat(32), span_id: "b".repeat(16), status: "ok" } },
    request: { url: "https://shop.example.test/checkout/payment?coupon=x", headers: {} },
    measurements: {
        lcp: { value: 3120.5, unit: "millisecond" },
        fcp: { value: 900, unit: "millisecond" },
        ttfb: { value: 420, unit: "millisecond" },
        cls: { value: 0.12, unit: "" }
    },
    spans: [
        {
            span_id: "c".repeat(16),
            parent_span_id: "b".repeat(16),
            op: "resource.script",
            description: "/static/app.js",
            start_timestamp: start + 0.1,
            timestamp: start + 1.9,
            trace_id: "a".repeat(32)
        },
        {
            span_id: "d".repeat(16),
            parent_span_id: "b".repeat(16),
            op: "browser.request",
            description: "https://shop.example.test/checkout",
            start_timestamp: start,
            timestamp: start + 0.42,
            trace_id: "a".repeat(32)
        }
    ],
    sdk: { name: "sentry.javascript.browser", version: "8.0.0" }
};

export const browserInp = {
    span_id: "e".repeat(16),
    trace_id: "a".repeat(32),
    op: "ui.interaction.click",
    description: "body > button.pay",
    start_timestamp: start + 10,
    timestamp: start + 10.35,
    data: { "sentry.op": "ui.interaction.click", transaction: "/checkout/:step" },
    measurements: { inp: { value: 350, unit: "millisecond" } }
};

export const nodeRequest = {
    type: "transaction",
    event_id: "1f1e2d3c4b5a69788796a5b4c3d2e1f0",
    platform: "node",
    transaction: "GET /api/orders/:id",
    transaction_info: { source: "route" },
    start_timestamp: start,
    timestamp: start + 0.95,
    contexts: { trace: { op: "http.server", trace_id: "f".repeat(32), span_id: "1".repeat(16), status: "ok" } },
    request: { url: "http://api.internal/api/orders/1234", method: "GET" },
    spans: [
        {
            span_id: "2".repeat(16),
            parent_span_id: "1".repeat(16),
            op: "db",
            description: "SELECT * FROM orders WHERE id = $1",
            start_timestamp: start + 0.05,
            timestamp: start + 0.85
        },
        { op: "broken", start_timestamp: "not a time", timestamp: start }
    ]
};

/** An envelope exactly as a client writes one, with an item per payload. */
export function envelopeOf(items: readonly { type: string; payload: unknown }[]): string {
    const lines = [JSON.stringify({ event_id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", sent_at: new Date().toISOString() })];
    for (const item of items) {
        const body = JSON.stringify(item.payload);
        lines.push(JSON.stringify({ type: item.type, length: body.length }), body);
    }
    return lines.join("\n");
}
