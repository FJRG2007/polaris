// A stand-in language server for the native agent's tests: answers
// `initialize`, asks the client one `workspace/configuration` request, and on
// every opened or changed document publishes one error per line that holds
// "BAD" (and a warning per line that holds "MEH").
"use strict";

let buffer = Buffer.alloc(0);

function send(message) {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function publish(uri, text) {
    const diagnostics = [];
    text.split("\n").forEach((line, index) => {
        const bad = line.indexOf("BAD");
        if (bad >= 0) diagnostics.push({ range: { start: { line: index, character: bad }, end: { line: index, character: bad + 3 } }, severity: 1, message: "BAD is not allowed" });
        const meh = line.indexOf("MEH");
        if (meh >= 0) diagnostics.push({ range: { start: { line: index, character: meh }, end: { line: index, character: meh + 3 } }, severity: 2, message: "MEH is discouraged" });
    });
    send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
}

function handle(message) {
    if (message.method === "initialize") {
        send({ id: 900, method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
        send({ id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
    } else if (message.method === "textDocument/didOpen") {
        publish(message.params.textDocument.uri, message.params.textDocument.text);
    } else if (message.method === "textDocument/didChange") {
        publish(message.params.textDocument.uri, message.params.contentChanges[0].text);
    }
}

process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))[1]);
        if (buffer.length < end + 4 + length) return;
        const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
        buffer = buffer.subarray(end + 4 + length);
        handle(JSON.parse(body));
    }
});
process.stdin.on("end", () => process.exit(0));
