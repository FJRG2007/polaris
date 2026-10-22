/**
 * What the worker asks the script inside a Polar tab (`entrypoints/polar-agent.ts`)
 * and what it answers. Kept apart from both so each imports only the shapes.
 */

import type { BrowserElement, BrowserRefusal } from "@polaris/core/browser-agent";

export type AgentOp =
    | { readonly op: "banner"; readonly text: string; readonly stop: string }
    | { readonly op: "unbanner" }
    | { readonly op: "snapshot"; readonly query?: string }
    | { readonly op: "read"; readonly selector?: string }
    | { readonly op: "click"; readonly ref: string }
    | {
          readonly op: "type";
          readonly ref: string;
          readonly text: string;
          readonly submit?: boolean;
      };

export type AgentReply = (
    | {
          readonly ok: true;
          readonly elements?: readonly BrowserElement[];
          readonly text?: string;
          readonly truncated?: boolean;
      }
    | { readonly ok: false; readonly refusal: BrowserRefusal; readonly detail?: string }
) & { readonly title?: string; readonly url?: string };
