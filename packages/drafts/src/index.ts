// SPDX-License-Identifier: AGPL-3.0-only

export {
  type ConflictChoice,
  type DraftConflicts,
  DraftHeadMoved,
  draftConflicts,
  type FileConflict,
  type FileResolution,
  resolveDraft,
} from './conflicts.js';
export {
  type Draft,
  type DraftFile,
  DraftInputError,
  DraftStateError,
  DraftVersionConflict,
  discardDraft,
  findOpenDraft,
  getDraft,
  listDraftFiles,
  OPEN_STATES,
  openDraft,
  openDraftsTouching,
  removeDraftFile,
  type SaveFileInput,
  saveDraftFile,
  saveDraftFiles,
} from './drafts.js';
export {
  conflictCount,
  type MergeRegion,
  mergeText,
  mergeUnitLists,
  type RegionChoice,
  resolveRegions,
} from './merge3.js';
export {
  applyPullRequestEvent,
  assertCanPropose,
  draftBranch,
  type ProposeEnvironment,
  ProposeForbidden,
  type ProposeInput,
  type ProposeOutcome,
  ProposeRetry,
  type PullRequestEvent,
  proposeDraft,
  spaceRoleOf,
} from './propose.js';
export {
  type BlobSource,
  type ConflictCode,
  draftDiff,
  type FileDiff,
  type RebaseOutcome,
  rebaseDrafts,
} from './rebase.js';
export { type FileChange, planRename, type RenamePlan, type SpaceFile } from './rename.js';
