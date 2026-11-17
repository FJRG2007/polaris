# Polaris - license notice

Copyright (C) FJRG2007 and the Polaris contributors.

Polaris is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License, version 3, as published by the
Free Software Foundation ([LICENSE](LICENSE)), together with the additional
terms below.

Polaris is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

Versions of Polaris published before this notice was added remain available
under the license they were published with (Apache-2.0).

## What this means in practice

- You may use, study, change and share Polaris, including for commercial
  purposes, as long as you follow the AGPL-3.0.
- If you distribute a modified version, or let people use a modified version
  over a network (for example as a hosted service), you must publish the
  complete source of that version under the AGPL-3.0. A closed-source fork is
  not allowed.
- Modified versions must say visibly that they are based on Polaris (see the
  additional terms below).

## Additional terms (AGPL-3.0, section 7)

These terms are added under section 7 of the GNU Affero General Public License
and apply to every covered work that contains Polaris or a part of it.

1. **Attribution** (section 7(b)). Any covered work with an interactive user
   interface must keep, in its Appropriate Legal Notices, a visible statement
   that it is based on Polaris, with a link to
   <https://github.com/FJRG2007/polaris>. In Polaris this statement lives on the
   public About page; a modified version must keep it there or in an equally
   visible place.
2. **Marking of modified versions** (section 7(c)). A modified version must be
   marked as changed from the original, and must not be presented as the
   original Polaris or as made or endorsed by its authors.
3. **Names and logos** (section 7(e)). This license grants no right to use the
   Polaris name or logos, beyond the attribution required in term 1.

## Commercial license

If the AGPL-3.0 does not fit what you want to do - for example, keeping your
changes private, embedding Polaris in a closed-source product, or selling a
hosted service built on it without publishing its source - a separate
commercial license is available from the author. Contact the maintainer listed
in [CITATION.cff](CITATION.cff).

## Third-party material

- **Agent Orchestrator** (github.com/OrchestratorInc/agent-orchestrator),
  Apache License 2.0. The coding-agent logos under
  `dashboard/apps/web/public/logos/agents/` are copied from its
  `frontend/src/renderer/assets/agents/`, and the agent catalogue entries listed
  in [docs/agent-catalogue.md](docs/agent-catalogue.md) were written from its
  adapter source. The session hook files and hook activity mapping
  (`dashboard/packages/core/src/agent-hook-files.ts`,
  `dashboard/apps/web/src/lib/agents/hook-activity.ts`) are ported from its
  `backend/internal/adapters/agent/` at commit e4ded08c6f15. Which of a
  session's delivered files are listed
  (`dashboard/apps/web/src/lib/agents/artifacts/deliverables.ts`) is copied
  from its `packages/shared/artifacts/deliverables.ts` at the same commit, with
  three index reads checked for a stricter compiler. The note an agent starts
  with when it takes over or restores a session
  (`dashboard/apps/web/src/lib/agents/session-handoff.ts`) is ported from its
  `backend/pkg/handoffnote/handoffnote.go` at the same commit. The Codewhale and MiMo Code marks are MIT and the Stakpak mark
  Apache-2.0, with their notices kept beside the files. The marks remain their
  owners' trademarks.

- **OpenCode** (github.com/sst/opencode), Copyright (c) its contributors, MIT
  License, commit b083c4d510e4. Polar's voice handoff and spoken session search
  (`dashboard/apps/web/src/lib/polar/voice-handoff.ts`) and the voice
  delegator's instructions and session tools
  (`dashboard/apps/web/src/lib/polar/voice-delegate.ts`) are ported from its
  `packages/app/src/voice/`. Its license:

  > MIT License
  >
  > Copyright (c) 2025 opencode
  >
  > Permission is hereby granted, free of charge, to any person obtaining a copy
  > of this software and associated documentation files (the "Software"), to deal
  > in the Software without restriction, including without limitation the rights
  > to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  > copies of the Software, and to permit persons to whom the Software is
  > furnished to do so, subject to the following conditions:
  >
  > The above copyright notice and this permission notice shall be included in all
  > copies or substantial portions of the Software.
  >
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  > IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  > FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  > LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  > OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  > SOFTWARE.
