"use client";

/**
 * The browser picked on the extension card, for what is drawn inside it. The
 * release's files arrive as a slot from the server, so they cannot be handed it as
 * a prop. Null outside the card, where every browser's file is listed.
 */

import { createContext } from "react";
import type { BrowserId } from "./browser-guide";

export const BrowserChoice = createContext<BrowserId | null>(null);
