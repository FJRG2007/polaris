/**
 * Opens shared search segments and searches them off the page's thread
 * (docs/chat-e2ee-mls.md, "Shared search segments"). What it opens stays in
 * this Worker's memory only, and goes with it when the page closes.
 */

import { openSegment, SegmentSearcher } from "./search-segment";
import type { SegmentWorkerRequest } from "./search-segments-client";

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<{ id: number; request: SegmentWorkerRequest }>) => void) | null;
    postMessage(message: unknown): void;
};

const searcher = new SegmentSearcher();

async function run(request: SegmentWorkerRequest): Promise<unknown> {
    switch (request.op) {
        case "add": {
            const { key, binding, indexKey, nonce, ciphertext } = request;
            const index = await openSegment(indexKey, { ...binding, epoch: BigInt(binding.epoch) }, nonce, ciphertext);
            if (index) searcher.add(key, binding.channelId, index);
            return Boolean(index);
        }
        case "search":
            return searcher.search(request.term, request.channelId, request.limit);
        case "clear":
            searcher.clear();
            return true;
    }
}

scope.onmessage = (event) => {
    const { id, request } = event.data;
    run(request).then(
        (value) => scope.postMessage({ id, ok: true, value }),
        () => scope.postMessage({ id, ok: false })
    );
};
