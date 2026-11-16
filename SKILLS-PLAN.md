# Polar skills: view and edit every skill

Branch `feat/polar-skills-edit`.

## Done

- Storage: `PolarSkillOverride` (schema.prisma, migration `20271120000210_polar_skill_overrides`, rerunnable).
- Layering, diff, three-way merge, input schemas: `apps/web/src/lib/polar/skills/overrides.ts`.
- Store: `apps/web/src/lib/polar/skills/override-store.ts`; admin rule: `override-access.ts`.
- Server actions: `apps/web/src/app/(app)/polar/settings/skill-override-actions.ts`.
- Chat loads effective skills (switched-on built-ins + Enigma, both with edits applied): `app/api/polar/chat/route.ts`.
- UI: `skill-detail-dialog.tsx` (SKILL.md view, changes diff, edit, reset, merge / keep mine / take theirs, tier picker for admins), wired into `polar-skills.tsx` (built-ins: switch + open; own skills: open) and `enigma-settings.tsx`.
- i18n en-US / es-ES `polar.settings.skills.upstream.*`, `errors.adminOnly`, `errors.moved`.
- Tests: `test/polar/skills/skill-overrides.test.ts`, `test/polar/skills/skill-detail-dialog.test.tsx`.

## Not done

- Code sessions: Enigma is installed inside the container by the CLI, so edits do not reach it. Reaching it means writing the
  edited SKILL.md files into the session home from `core.enigmaConfigureScript`; a 110 KB skill as base64 exceeds the
  128 KB per-variable limit, so it needs a file channel (volume or fetch with the run token), not the environment.
- "Org" tier is the instance (all of this Polaris, administrators only): Polar chats are not tied to an organization.
