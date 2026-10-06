import { createReducer, on } from '@ngrx/store';
import {
  activateVersion,
  addVersion,
  clearServerVersion,
  discardLocalEdit,
  dismissReport,
  editCueOffline,
  editLineOffline,
  mergeFailed,
  mergeRequested,
  mergeSucceeded,
  reorderLines,
  resolveCandidate,
  reviewCue,
  reviewLine,
  serverVersionArrived,
  setOnline,
  toggleFailNextMerge,
  toggleRehearsal,
} from './script.actions';
import {
  CueEntry,
  EntryStatus,
  LineEntry,
  LocalEdit,
  MergeReport,
  ScriptVersion,
  ServerVersion,
} from './script.merge';

export type CueDecision = EntryStatus;
export type {
  Candidate,
  CueEntry,
  EntryStatus,
  LineEntry,
  LocalEdit,
  MergeOutcome,
  MergeReport,
  MergeReportItem,
  ScriptVersion,
  ServerVersion,
} from './script.merge';

export interface ScriptState {
  versions: ScriptVersion[];
  activeVersionId: string;
  rehearsalMode: boolean;
  online: boolean;
  /** 断网期间导演/舞台监督的本地改动，网络恢复合并前不写入任何版本正文 */
  localEdits: LocalEdit[];
  /** 编剧刚提交、等待合并的服务端新版 */
  incomingVersion: ServerVersion | null;
  /** 最近一次合并报告（成功/失败均保留，失败可据此重试） */
  mergeReport: MergeReport | null;
  merging: boolean;
  failNextMerge: boolean;
}

const initialVersions: ScriptVersion[] = [
  {
    id: 'v12', label: '排练稿 v12', playwright: '林编剧', note: '当前排练厅在用版本：第三场父女冲突。',
    lines: [
      { id: 'l1', role: '周岚', text: '你每次都说等明天，可舞台不会等我们。', status: 'pending' },
      { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'accepted' },
      { id: 'l4', role: '陈妈', text: '门我留着，雨大就早点回来。', status: 'accepted' },
    ],
    cues: [
      { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', status: 'pending' },
      { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', status: 'accepted' },
    ],
  },
  {
    id: 'v13', label: '导演修订 v13', playwright: '林编剧', note: '调整周岚结论，加入一次性追光变化。',
    lines: [
      { id: 'l1', role: '周岚', text: '你总说明天，但今晚我们必须把话说完。', status: 'pending' },
      { id: 'l3', role: '周岚', text: '看着灯，再说一次你为什么回来。', status: 'pending' },
    ],
    cues: [{ id: 'c3', scene: '第三场', text: '追光由冷白切换至琥珀，等待雨声下落', status: 'pending' }],
  },
];

function buildDefaultState(online = true): ScriptState {
  return {
    versions: initialVersions,
    activeVersionId: 'v12',
    rehearsalMode: false,
    online,
    localEdits: [],
    incomingVersion: null,
    mergeReport: null,
    merging: false,
    failNextMerge: false,
  };
}

function getInitialState(): ScriptState {
  if (typeof localStorage === 'undefined') return buildDefaultState();
  const saved = localStorage.getItem('yf52-script-state');
  if (!saved) return buildDefaultState(navigator.onLine);
  const parsed = JSON.parse(saved) as Partial<ScriptState>;
  // 旧缓存迁移：补齐合并功能引入的字段
  return {
    ...buildDefaultState(typeof navigator !== 'undefined' ? navigator.onLine : true),
    ...parsed,
    mergeReport: parsed.mergeReport ?? null,
    merging: false,
  };
}

function recordEdit(state: ScriptState, kind: 'line' | 'cue', id: string, text: string, author: string): ScriptState {
  // 本地改动只允许在断网期间产生，且不会直接改写作版本正文
  if (state.online || state.merging) return state;
  const version = state.versions.find((item) => item.id === state.activeVersionId);
  const entry = kind === 'line'
    ? version?.lines.find((line: LineEntry) => line.id === id)
    : version?.cues.find((cue: CueEntry) => cue.id === id);
  if (!version || !entry) return state;

  const existing = state.localEdits.find((edit) => edit.kind === kind && edit.id === id);
  let edits: LocalEdit[];
  if (existing) {
    edits = state.localEdits.map((edit) =>
      edit.kind === kind && edit.id === id ? { ...edit, text, author, updatedAt: Date.now() } : edit);
  } else {
    edits = [...state.localEdits, { kind, id, text, baseText: entry.text, author, updatedAt: Date.now() }];
  }
  // 改动若回到原文，视为撤销
  if (text === existing?.baseText || text === entry.text) {
    edits = edits.filter((edit) => !(edit.kind === kind && edit.id === id));
  }
  return { ...state, localEdits: edits };
}

function patchActiveEntry(
  state: ScriptState,
  kind: 'line' | 'cue',
  id: string,
  patch: (entry: LineEntry | CueEntry) => LineEntry | CueEntry,
): ScriptState {
  return {
    ...state,
    versions: state.versions.map((version) => {
      if (version.id !== state.activeVersionId) return version;
      if (kind === 'line') {
        return { ...version, lines: version.lines.map((line) => (line.id === id ? patch(line) as LineEntry : line)) };
      }
      return { ...version, cues: version.cues.map((cue) => (cue.id === id ? patch(cue) as CueEntry : cue)) };
    }),
  };
}

export const scriptReducer = createReducer(
  getInitialState(),
  on(addVersion, (state, { version }) => ({ ...state, versions: [...state.versions, version] })),
  on(activateVersion, (state, { id }) => ({ ...state, activeVersionId: id })),
  on(reviewLine, (state, { id, decision }) =>
    patchActiveEntry(state, 'line', id, (entry) => ({ ...entry, status: decision, invalidateReason: undefined }))),
  on(reorderLines, (state, { from, to }) => ({
    ...state,
    versions: state.versions.map((version) => {
      if (version.id !== state.activeVersionId || from === to) return version;
      const lines = [...version.lines];
      const [moved] = lines.splice(from, 1);
      lines.splice(to, 0, moved);
      return { ...version, lines };
    }),
  })),
  on(reviewCue, (state, { id, decision }) =>
    patchActiveEntry(state, 'cue', id, (entry) => ({ ...entry, status: decision, invalidateReason: undefined }))),
  on(toggleRehearsal, (state) => ({ ...state, rehearsalMode: !state.rehearsalMode })),
  on(setOnline, (state, { online }) => ({ ...state, online })),

  on(editLineOffline, (state, { id, text, author }) => recordEdit(state, 'line', id, text, author)),
  on(editCueOffline, (state, { id, text, author }) => recordEdit(state, 'cue', id, text, author)),
  on(discardLocalEdit, (state, { kind, id }) => ({
    ...state,
    localEdits: state.localEdits.filter((edit) => !(edit.kind === kind && edit.id === id)),
  })),

  on(serverVersionArrived, (state, { incoming }) => ({ ...state, incomingVersion: incoming })),
  on(clearServerVersion, (state) => ({ ...state, incomingVersion: null })),

  on(toggleFailNextMerge, (state) => ({ ...state, failNextMerge: !state.failNextMerge })),
  on(mergeRequested, (state) => ({ ...state, merging: true, mergeReport: null })),
  on(mergeFailed, (state, { report }) => ({
    // 合并失败：本地改动、服务端新版、当前版本全部原样保留，仅登记失败报告供重试
    ...state,
    merging: false,
    failNextMerge: false,
    mergeReport: report,
  })),
  on(mergeSucceeded, (state, { version, report }) => ({
    ...state,
    versions: [...state.versions, version],
    activeVersionId: version.id,
    // 已合并的本地改动从队列移除；其内容要么进正文要么以候选形式挂在条目上
    localEdits: [],
    incomingVersion: null,
    merging: false,
    failNextMerge: false,
    mergeReport: report,
  })),
  on(dismissReport, (state) => ({ ...state, mergeReport: null })),

  on(resolveCandidate, (state, { kind, id, apply }) =>
    patchActiveEntry(state, kind, id, (entry) => {
      if (!entry.candidate) return entry;
      if (apply) {
        // 采纳候选：候选文本进入正文，但仍为待确认状态，确认前不进排练版本
        return {
          ...entry,
          text: entry.candidate.text,
          status: 'pending',
          candidate: undefined,
          invalidateReason: undefined,
        };
      }
      // 放弃候选：维持编剧正文
      return { ...entry, status: 'pending', candidate: undefined };
    })),
);
