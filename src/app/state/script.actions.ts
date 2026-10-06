import { createAction, props } from '@ngrx/store';
import { CueDecision, ScriptVersion } from './script.reducer';

export const addVersion = createAction('[Script] Add Version', props<{ version: ScriptVersion }>());
export const activateVersion = createAction('[Script] Activate Version', props<{ id: string }>());
export const reviewLine = createAction('[Script] Review Line', props<{ id: string; decision: 'accepted' | 'returned' }>());
export const reorderLines = createAction('[Script] Reorder Lines', props<{ from: number; to: number }>());
export const reviewCue = createAction('[Script] Review Cue', props<{ id: string; decision: CueDecision }>());
export const toggleRehearsal = createAction('[Script] Toggle Rehearsal');
export const setOnline = createAction('[Script] Set Online', props<{ online: boolean }>());

// 断网恢复后与编剧新版剧本合并
export const setMergeStatus = createAction('[Script] Set Merge Status', props<{ status: 'idle' | 'merging' | 'failed' | 'succeeded' }>());
export const mergeFromServer = createAction('[Script] Merge From Server', props<{ serverVersion: ScriptVersion }>());
export const mergeFailure = createAction('[Script] Merge Failure', props<{ error: string }>());
export const clearMergeStatus = createAction('[Script] Clear Merge Status');
// 采纳 / 丢弃与服务端冲突时保留的本地待确认候选
export const adoptCandidate = createAction('[Script] Adopt Candidate', props<{ id: string; kind: 'line' | 'cue' }>());
export const discardCandidate = createAction('[Script] Discard Candidate', props<{ id: string; kind: 'line' | 'cue' }>());
