/**
 * Auth form schemas, shared so the client validates in real time against exactly
 * what the server actions enforce. Registration is closed: accounts come from the
 * one-time admin setup (guarded by a setup token) or an admin invite.
 */

import { z } from "zod";

export const emailField = z.string().trim().min(1, "Email is required").email("Enter a valid email");
export const nameField = z.string().trim().min(1, "Name is required").max(120);
export const passwordField = z
    .string()
    .min(10, "Use at least 10 characters")
    .max(256, "Too long");

export const loginSchema = z.object({
    email: emailField,
    password: z.string().min(1, "Password is required")
});

export const setupSchema = z.object({
    name: nameField,
    email: emailField,
    password: passwordField,
    token: z.string().trim().min(1, "Setup token is required")
});

export const acceptInviteSchema = z.object({
    name: nameField,
    password: passwordField
});

export const INVITE_ROLES = ["admin", "member", "viewer"] as const;

export const createInviteSchema = z.object({
    email: emailField,
    role: z.enum(INVITE_ROLES).default("member")
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SetupInput = z.infer<typeof setupSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
