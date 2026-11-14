"use client";

import { useEffect } from "react";
import { watchIdle } from "@/lib/idle";

/** Marks `<html data-idle>` while nobody can be looking - see `lib/idle`. */
export function IdleWatch() {
    useEffect(() => watchIdle(), []);
    return null;
}
