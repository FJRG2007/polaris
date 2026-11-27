/**
 * The page side of the sealed search Worker test (`search-segment-worker.test.ts`):
 * the dashboard's own Worker host, as `sealed-chat.ts` starts it.
 */

import { workerSearchHost } from "@/lib/chat/e2ee/search-segments-client";

Object.assign(globalThis, { segmentHost: workerSearchHost() });
