/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

export { ProjectStore } from './store.js'
export type {
  ChatMessage,
  ChatMeta,
  ProjectData,
  ProjectIndex,
  ProjectInfo,
  ProjectSummary,
  TimelineEntry,
  ToolActivity,
} from './types.js'
export type {
  AppendChatArgs,
  LoadChatArgs,
  ProjectApi,
  RebindChatArgs,
  ResolveChatArgs,
  ResolveChatResult,
} from './ipc.js'
