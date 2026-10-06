import { createAction, props } from '@ngrx/store';
import { CueDecision, ScriptVersion } from './script.reducer';
import { LocalEdit, MergeReport, ServerVersion } from './script.merge';

export const addVersion = createAction('[Script] Add Version', props<{ version: ScriptVersion }>());
export const activateVersion = createAction('[Script] Activate Version', props<{ id: string }>());
export const reviewLine = createAction('[Script] Review Line', props<{ id: string; decision: 'accepted' | 'returned' }>());
export const reorderLines = createAction('[Script] Reorder Lines', props<{ from: number; to: number }>());
export const reviewCue = createAction('[Script] Review Cue', props<{ id: string; decision: CueDecision }>());
export const toggleRehearsal = createAction('[Script] Toggle Rehearsal');
export const setOnline = createAction('[Script] Set Online', props<{ online: boolean }>());

// 断网期间导演/舞台监督对台词或舞台提示的本地修改（记录原文作为合并基准）
export const editLineOffline = createAction('[Script] Edit Line Offline', props<{ id: string; text: string; author: string }>());
export const editCueOffline = createAction('[Script] Edit Cue Offline', props<{ id: string; text: string; author: string }>());
export const discardLocalEdit = createAction('[Script] Discard Local Edit', props<{ kind: 'line' | 'cue'; id: string }>());

// 网络恢复后编剧新版到达 / 执行合并 / 合并失败重试
export const serverVersionArrived = createAction('[Script] Server Version Arrived', props<{ incoming: ServerVersion }>());
export const clearServerVersion = createAction('[Script] Clear Server Version');
export const mergeRequested = createAction('[Script] Merge Requested', props<{ fail?: boolean }>());
export const mergeSucceeded = createAction('[Script] Merge Succeeded', props<{ version: ScriptVersion; report: MergeReport }>());
export const mergeFailed = createAction('[Script] Merge Failed', props<{ report: MergeReport }>());
export const dismissReport = createAction('[Script] Dismiss Merge Report');

// 待确认候选处理：采纳候选（候选进入正文，仍需走确认流程）或放弃候选
export const resolveCandidate = createAction(
  '[Script] Resolve Candidate',
  props<{ kind: 'line' | 'cue'; id: string; apply: boolean }>(),
);

// 调试用：让下一次合并模拟失败
export const toggleFailNextMerge = createAction('[Script] Toggle Fail Next Merge');
