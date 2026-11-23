/**
 * The page side of sealed-browser.test.ts: the chat's own sealed-chat module,
 * bundled as the dashboard ships it, on the window for the test to drive.
 */

import * as sealed from "@/lib/chat/e2ee/sealed-chat";

(globalThis as { sealed?: typeof sealed }).sealed = sealed;
