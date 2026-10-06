import { createReducer, on } from '@ngrx/store';
import {
  addVersion,
  activateVersion,
  adoptCandidate,
  clearMergeStatus,
  discardCandidate,
  mergeFailure,
  mergeFromServer,
  reorderLines,
  reviewCue,
  reviewLine,
  setMergeStatus,
  setOnline,
  toggleRehearsal
} from './script.actions';

export type CueDecision = 'pending' | 'accepted' | 'returned';

export interface ScriptLine {
  id: string;
  role: string;
  text: string;
  status: 'pending' | 'accepted' | 'returned';
  /** 与服务端冲突时保留的本地改动，作为待确认候选，不覆盖编剧版内容 */
  candidateText?: string;
  candidateRole?: string;
  /** 已采纳条目被服务端更新后失效退回待确认的原因 */
  invalidatedReason?: string;
}

export interface ScriptCue {
  id: string;
  scene: string;
  text: string;
  status: CueDecision;
  candidateText?: string;
  invalidatedReason?: string;
}

export interface ScriptVersion {
  id: string;
  label: string;
  playwright: string;
  note: string;
  lines: ScriptLine[];
  cues: ScriptCue[];
}

interface SyncItem { id: string; text: string; role?: string; scene?: string; }
interface SyncSnapshot { versionId: string; lines: SyncItem[]; cues: SyncItem[]; }

export interface ScriptState {
  versions: ScriptVersion[];
  activeVersionId: string;
  rehearsalMode: boolean;
  online: boolean;
  /** 上一次与服务端同步的快照，用于判断服务端是否更新了原文 */
  lastSynced?: SyncSnapshot;
  mergeStatus: 'idle' | 'merging' | 'failed' | 'succeeded';
  mergeError?: string;
  /** 版本对比中标明的合并原因 */
  mergeReasons: string[];
}

function snapshotLines(lines: ScriptLine[]): SyncItem[] {
  return lines.map((line) => ({ id: line.id, text: line.text, role: line.role }));
}

function snapshotCues(cues: ScriptCue[]): SyncItem[] {
  return cues.map((cue) => ({ id: cue.id, text: cue.text, scene: cue.scene }));
}

const initialVersions: ScriptVersion[] = [
  {
    id: 'v12', label: '排练稿 v12', playwright: '林编剧', note: '上一次与服务端同步的排练稿。',
    lines: [
      { id: 'l1', role: '周岚', text: '你每次都说等明天，可舞台不会等我们。', status: 'accepted' },
      { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending' }
    ],
    cues: [
      { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', status: 'pending' },
      { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', status: 'accepted' }
    ]
  },
  {
    id: 'v13', label: '导演修订 v13', playwright: '本地草稿', note: '断网期间导演与舞台监督的本地改动，待网络恢复后合并。',
    lines: [
      { id: 'l1', role: '周岚', text: '你总说明天，但今晚我们必须把话说完。', status: 'pending' },
      { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending' },
      { id: 'l3', role: '周岚', text: '看着灯，再说一次你为什么回来。', status: 'pending' }
    ],
    cues: [
      { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', status: 'pending' },
      { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', status: 'accepted' },
      { id: 'c3', scene: '第三场', text: '追光由冷白切换至琥珀，等待雨声下落', status: 'pending' }
    ]
  }
];

function fallbackState(): ScriptState {
  return {
    versions: initialVersions,
    activeVersionId: 'v13',
    rehearsalMode: false,
    online: true,
    lastSynced: { versionId: 'v12', lines: snapshotLines(initialVersions[0].lines), cues: snapshotCues(initialVersions[0].cues) },
    mergeStatus: 'idle',
    mergeReasons: []
  };
}

function getInitialState(): ScriptState {
  const fallback = fallbackState();
  if (typeof localStorage === 'undefined') return fallback;
  const saved = localStorage.getItem('yf52-script-state');
  if (!saved) return fallback;
  try {
    const parsed = JSON.parse(saved) as Partial<ScriptState>;
    return {
      ...fallback,
      ...parsed,
      mergeStatus: parsed.mergeStatus ?? 'idle',
      mergeReasons: parsed.mergeReasons ?? [],
      lastSynced: parsed.lastSynced ?? (() => {
        const v12 = parsed.versions?.find((version) => version.id === 'v12');
        return v12 ? { versionId: 'v12', lines: snapshotLines(v12.lines), cues: snapshotCues(v12.cues) } : undefined;
      })()
    };
  } catch {
    return fallback;
  }
}

/**
 * 将本地改动与编剧新版（服务端版本）合并。
 * 规则：
 * - 同一角色的台词/提示两边都动过 → 以编剧版为准，本地改动留作待确认候选，不覆盖编剧版内容。
 * - 仅服务端改过 → 采用服务端文本；若该条目已采纳，则失效退回待确认并标明原因。
 * - 仅本地改过 → 保留本地文本。
 * - 本地新增（服务端没有）→ 加入合并版本待确认。
 */
function mergeVersions(
  local: ScriptVersion,
  server: ScriptVersion,
  lastSynced: SyncSnapshot | undefined
): { version: ScriptVersion; reasons: string[] } {
  const reasons: string[] = [];
  const syncedLines = new Map((lastSynced?.lines ?? []).map((item) => [item.id, item]));
  const syncedCues = new Map((lastSynced?.cues ?? []).map((item) => [item.id, item]));
  const localLines = new Map(local.lines.map((line) => [line.id, line]));
  const localCues = new Map(local.cues.map((cue) => [cue.id, cue]));

  const mergedLines: ScriptLine[] = server.lines.map((serverLine) => {
    const synced = syncedLines.get(serverLine.id);
    const localLine = localLines.get(serverLine.id);
    const isNew = !synced;
    const serverModified = !isNew && synced!.text !== serverLine.text;
    const localModified = !!localLine && !isNew && synced!.text !== localLine.text;
    // 两边都动过同一角色台词 → 以编剧版为准
    const conflict = !!localLine && (isNew ? localLine.text !== serverLine.text : serverModified && localModified);

    if (conflict) {
      reasons.push(`台词「${serverLine.role}」两边均有修改，以编剧版本为准，本地改动留作待确认候选`);
      return { ...serverLine, status: 'pending', candidateText: localLine!.text, candidateRole: localLine!.role, invalidatedReason: undefined };
    }
    if (serverModified) {
      if (localLine?.status === 'accepted') {
        reasons.push(`已采纳台词「${serverLine.role}」原文被服务端更新，已失效退回待确认`);
        return { ...serverLine, status: 'pending', invalidatedReason: '原文被服务端更新，已采纳条目失效退回待确认' };
      }
      return { ...serverLine, status: localLine?.status ?? 'pending' };
    }
    if (localLine) return { ...localLine };
    return { ...serverLine };
  });

  // 本地新增台词（服务端没有）→ 加入合并版本待确认
  for (const localLine of local.lines) {
    if (!server.lines.some((line) => line.id === localLine.id)) {
      reasons.push(`本地新增台词「${localLine.role}」服务端暂无，已加入合并版本待确认`);
      mergedLines.push({ ...localLine, status: 'pending' });
    }
  }

  const mergedCues: ScriptCue[] = server.cues.map((serverCue) => {
    const synced = syncedCues.get(serverCue.id);
    const localCue = localCues.get(serverCue.id);
    const isNew = !synced;
    const serverModified = !isNew && synced!.text !== serverCue.text;
    const localModified = !!localCue && !isNew && synced!.text !== localCue.text;
    const conflict = !!localCue && (isNew ? localCue.text !== serverCue.text : serverModified && localModified);

    if (conflict) {
      reasons.push(`提示「${serverCue.scene}」两边均有修改，以编剧版本为准，本地改动留作待确认候选`);
      return { ...serverCue, status: 'pending', candidateText: localCue!.text, invalidatedReason: undefined };
    }
    if (serverModified) {
      if (localCue?.status === 'accepted') {
        reasons.push(`已采纳提示「${serverCue.scene}」原文被服务端更新，已失效退回待确认`);
        return { ...serverCue, status: 'pending', invalidatedReason: '原文被服务端更新，已采纳条目失效退回待确认' };
      }
      return { ...serverCue, status: localCue?.status ?? 'pending' };
    }
    if (localCue) return { ...localCue };
    return { ...serverCue };
  });

  // 本地新增提示（服务端没有）→ 加入合并版本待确认
  for (const localCue of local.cues) {
    if (!server.cues.some((cue) => cue.id === localCue.id)) {
      reasons.push(`本地新增提示「${localCue.scene}」服务端暂无，已加入合并版本待确认`);
      mergedCues.push({ ...localCue, status: 'pending' });
    }
  }

  const version: ScriptVersion = {
    id: server.id,
    label: server.label,
    playwright: server.playwright,
    note: server.note,
    lines: mergedLines,
    cues: mergedCues
  };
  return { version, reasons };
}

export const scriptReducer = createReducer(
  getInitialState(),
  on(addVersion, (state, { version }) => ({ ...state, versions: [...state.versions, version] })),
  on(activateVersion, (state, { id }) => ({ ...state, activeVersionId: id })),
  on(reviewLine, (state, { id, decision }) => ({
    ...state,
    versions: state.versions.map((version) => version.id !== state.activeVersionId ? version : ({
      ...version,
      lines: version.lines.map((line) => line.id === id ? { ...line, status: decision } : line)
    }))
  })),
  on(reorderLines, (state, { from, to }) => ({
    ...state,
    versions: state.versions.map((version) => {
      if (version.id !== state.activeVersionId || from === to) return version;
      const lines = [...version.lines];
      const [moved] = lines.splice(from, 1);
      lines.splice(to, 0, moved);
      return { ...version, lines };
    })
  })),
  on(reviewCue, (state, { id, decision }) => ({
    ...state,
    versions: state.versions.map((version) => version.id !== state.activeVersionId ? version : ({
      ...version,
      cues: version.cues.map((cue) => cue.id === id ? { ...cue, status: decision } : cue)
    }))
  })),
  on(toggleRehearsal, (state) => ({ ...state, rehearsalMode: !state.rehearsalMode })),
  on(setOnline, (state, { online }) => ({ ...state, online })),
  on(setMergeStatus, (state, { status }) => ({ ...state, mergeStatus: status, mergeError: status === 'merging' ? undefined : state.mergeError })),
  on(mergeFromServer, (state, { serverVersion }) => {
    const local = state.versions.find((version) => version.id === state.activeVersionId) ?? state.versions[0];
    const { version, reasons } = mergeVersions(local, serverVersion, state.lastSynced);
    const exists = state.versions.some((item) => item.id === version.id);
    return {
      ...state,
      versions: exists ? state.versions : [...state.versions, version],
      activeVersionId: version.id,
      lastSynced: { versionId: version.id, lines: snapshotLines(version.lines), cues: snapshotCues(version.cues) },
      mergeStatus: 'succeeded' as const,
      mergeError: undefined,
      mergeReasons: exists ? state.mergeReasons : reasons
    };
  }),
  on(mergeFailure, (state, { error }) => ({ ...state, mergeStatus: 'failed' as const, mergeError: error })),
  on(clearMergeStatus, (state) => ({ ...state, mergeStatus: 'idle' as const, mergeError: undefined })),
  on(adoptCandidate, (state, { id, kind }) => ({
    ...state,
    versions: state.versions.map((version) => {
      if (version.id !== state.activeVersionId) return version;
      if (kind === 'line') {
        return {
          ...version,
          lines: version.lines.map((line) => line.id === id && line.candidateText
            ? { ...line, text: line.candidateText, role: line.candidateRole ?? line.role, candidateText: undefined, candidateRole: undefined, status: 'pending' as const, invalidatedReason: undefined }
            : line)
        };
      }
      return {
        ...version,
        cues: version.cues.map((cue) => cue.id === id && cue.candidateText
          ? { ...cue, text: cue.candidateText, candidateText: undefined, status: 'pending' as const, invalidatedReason: undefined }
          : cue)
      };
    })
  })),
  on(discardCandidate, (state, { id, kind }) => ({
    ...state,
    versions: state.versions.map((version) => {
      if (version.id !== state.activeVersionId) return version;
      if (kind === 'line') {
        return { ...version, lines: version.lines.map((line) => line.id === id ? { ...line, candidateText: undefined, candidateRole: undefined } : line) };
      }
      return { ...version, cues: version.cues.map((cue) => cue.id === id ? { ...cue, candidateText: undefined } : cue) };
    })
  }))
);
