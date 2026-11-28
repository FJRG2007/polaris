---
id: BUG-0075
title: Polaris's update list shows changes that belong to a device plugin with its own update
status: fixed-watching
area: updates
location: dashboard/packages/core/src/changelog.ts
related:
  - dashboard/packages/core/test/changelog.test.ts
  - dashboard/apps/web/src/lib/update-changelog.ts
reported: 2026-11-28
fixed: 2026-11-28
fix_commit:
---

## What was seen

Settings > Updates, "What this update carries" for ec22323...5b67079 listed five
Hercules Stream 100 commits (profiles, custom actions, idle screen, settings
page) under New and Fixed, although the plugin ships through its own update.

## Cause

The list was built from commit subjects alone: every `feat`/`fix` was listed
whatever it changed, and nothing told a device plugin's commit from Polaris's.

## Fix

A commit with a `Plugin: <id>` trailer or a `plugins/<id>` scope belongs to that
plugin. Older `plugins` commits whose subject names exactly one plugin from the
signed catalogue count as that plugin's. They leave Polaris's list and show as
one line, "N changes ship with device plugin updates". Stored ranges are read
again under a new key, so existing deployments drop them after updating.

## Known gap

Two of the five commits (0610a6f, 0388690) name no plugin in their message, so
they stay listed until that range is no longer the one shown. New commits carry
the trailer or scope.
