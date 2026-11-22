"use client";

import { createContext } from "react";

/**
 * Whether the messages drawn below may be published to the channels that
 * follow this one: an announcement channel, read by one of its administrators.
 * The server checks the same on every press - this only decides whether the
 * item is offered.
 */
export const PublishContext = createContext(false);
