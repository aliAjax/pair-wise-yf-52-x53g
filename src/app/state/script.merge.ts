// 断网合并引擎：
// 规则 1：同一条台词/提示两边都改过 -> 编剧（服务端）版本优先，本地改动保留为待确认候选，不覆盖服务端正文。
// 规则 2：已采纳条目只要原文被服务端更新 -> 自动失效退回待确认，并在版本对比中注明原因。
// 规则 3：仅本地改动的条目 -> 合并后进入待确认队列，不会直接进入排练版本。
// 规则 4：合并失败 -> 不产生新版本，本地改动与服务端提交原样保留，供重试。

export type EntryStatus = 'pending' | 'accepted' | 'returned';

export interface Candidate {
  text: string;
  author: string;
  reason: string;
}

export interface LineEntry {
  id: string;
  role: string;
  text: string;
  status: EntryStatus;
  candidate?: Candidate;
  invalidateReason?: string;
}

export interface CueEntry {
  id: string;
  scene: string;
  text: string;
  status: EntryStatus;
  candidate?: Candidate;
  invalidateReason?: string;
}

export interface ScriptVersion {
  id: string;
  label: string;
  playwright: string;
  note: string;
  lines: LineEntry[];
  cues: CueEntry[];
}

export interface LocalEdit {
  kind: 'line' | 'cue';
  id: string;
  text: string;
  baseText: string;
  author: string;
  updatedAt: number;
}

export interface ServerVersion {
  id: string;
  label: string;
  playwright: string;
  note: string;
  lines: Array<Pick<LineEntry, 'id' | 'role' | 'text'>>;
  cues: Array<Pick<CueEntry, 'id' | 'scene' | 'text'>>;
}

export type MergeOutcome =
  | 'conflict'        // 两边都动过，编剧优先，本地留候选
  | 'invalidated'     // 已采纳内容被服务端更新，失效退回待确认
  | 'server-updated'  // 未采纳内容被服务端更新
  | 'new'             // 编剧新增条目
  | 'local-only'      // 仅本地改动
  | 'local-restored'; // 服务端新版已不含该条，本地改动留候选

export interface MergeReportItem {
  kind: 'line' | 'cue';
  id: string;
  title: string;
  outcome: MergeOutcome;
  baseText: string;
  serverText?: string;
  localText?: string;
  reason: string;
}

export interface MergeReport {
  at: number;
  failed: boolean;
  failureReason?: string;
  mergedVersionId?: string;
  mergedLabel?: string;
  baseLabel?: string;
  items: MergeReportItem[];
}

export interface MergeInput {
  base: ScriptVersion;
  edits: LocalEdit[];
  incoming: ServerVersion | null;
  newVersionId: string;
  now: number;
  fail: boolean;
}

export interface MergeResult {
  version: ScriptVersion | null;
  report: MergeReport;
}

type MergeableEntry = LineEntry | CueEntry;

function mergeSide<T extends MergeableEntry>(
  kind: 'line' | 'cue',
  base: T[],
  server: Array<Omit<T, 'status' | 'candidate' | 'invalidateReason'>> | null,
  edits: LocalEdit[],
  report: MergeReportItem[],
): T[] {
  const priorById = new Map(base.map((entry) => [entry.id, entry]));
  const editById = new Map(edits.filter((edit) => edit.kind === kind).map((edit) => [edit.id, edit]));
  const seen = new Set<string>();
  const noun = kind === 'line' ? '台词' : '提示';

  // 没有服务端数据（编剧暂无新版）时，遍历基准版本本身：条目不会被删除。
  const serverEntries = server ?? base.map((entry) => ({ ...entry }));

  const merged = serverEntries.map((serverEntry): T => {
    seen.add(serverEntry.id);
    const prior = priorById.get(serverEntry.id);
    const edit = editById.get(serverEntry.id);

    // 编剧新增条目：直接进入待确认队列。
    if (!prior) {
      report.push({
        kind, id: serverEntry.id, title: entryTitle(kind, serverEntry), outcome: 'new',
        baseText: '', serverText: serverEntry.text,
        reason: `编剧新增${noun}，需逐条确认后才能进入排练版本。`,
      });
      return { ...serverEntry, status: 'pending' } as T;
    }

    const serverChanged = server !== null && serverEntry.text !== prior.text;
    const localChanged = !!edit && edit.text !== prior.text;

    // 两边都动过：编剧版本优先，本地改动降级为候选，绝不盖过刚提交的内容。
    if (serverChanged && localChanged) {
      report.push({
        kind, id: prior.id, title: entryTitle(kind, prior), outcome: 'conflict',
        baseText: prior.text, serverText: serverEntry.text, localText: edit!.text,
        reason: `导演/舞监与编剧都修改了该${noun}：以编剧新版为准，本地改动保留为待确认候选。`,
      });
      return {
        ...serverEntry,
        status: 'pending',
        candidate: {
          text: edit!.text,
          author: edit!.author,
          reason: `与编剧新版冲突，未覆盖服务端内容；显式采纳候选后才会进入排练版。`,
        },
      } as T;
    }

    // 服务端更新：原文一旦变动，之前的采纳立即失效，退回待确认并注明原因。
    if (serverChanged) {
      if (prior.status === 'accepted') {
        report.push({
          kind, id: prior.id, title: entryTitle(kind, prior), outcome: 'invalidated',
          baseText: prior.text, serverText: serverEntry.text,
          reason: `原采纳${noun}已被编剧更新，采纳结论自动失效并退回待确认。旧文：${prior.text}`,
        });
        return {
          ...serverEntry,
          status: 'pending',
          invalidateReason: `原已采纳的内容已被编剧更新，自动退回待确认。旧文：${prior.text}`,
        } as T;
      }
      report.push({
        kind, id: prior.id, title: entryTitle(kind, prior), outcome: 'server-updated',
        baseText: prior.text, serverText: serverEntry.text,
        reason: `编剧更新了该${noun}，保留待确认状态。`,
      });
      return { ...serverEntry, status: 'pending' } as T;
    }

    // 仅本地改动：正文采用本地文本，但必须重新确认，不能直接混入排练版本。
    if (localChanged) {
      report.push({
        kind, id: prior.id, title: entryTitle(kind, prior), outcome: 'local-only',
        baseText: prior.text, localText: edit!.text,
        reason: `仅本地修改、编剧未改动：合并后列入待确认，确认前不进入排练版本。`,
      });
      return { ...prior, text: edit!.text, status: 'pending' };
    }

    // 均未改动：保留原条目（含尚未处理的候选）。
    return prior;
  });

  // 编剧新版里已经不存在的条目：本地改动不丢弃，挂成候选保留待人工处理。
  for (const edit of edits.filter((item) => item.kind === kind)) {
    if (seen.has(edit.id)) continue;
    const prior = priorById.get(edit.id);
    if (!prior) continue;
    report.push({
      kind, id: prior.id, title: entryTitle(kind, prior), outcome: 'local-restored',
      baseText: prior.text, localText: edit.text,
      reason: `编剧新版已移除该${noun}，本地改动不写入编剧正文，仅保留为待确认候选。`,
    });
    merged.push({
      ...prior,
      status: 'pending',
      candidate: {
        text: edit.text,
        author: edit.author,
        reason: `编剧新版已移除该${noun}；本地改动仅作候选保留，采纳后才会重新进入正文。`,
      },
    });
  }

  return merged;
}

function entryTitle(kind: 'line' | 'cue', entry: unknown): string {
  const record = entry as { role?: string; scene?: string };
  if (kind === 'line') return record.role ? `角色台词 · ${record.role}` : '角色台词';
  return record.scene ? `舞台提示 · ${record.scene}` : '舞台提示';
}

export function computeMerge(input: MergeInput): MergeResult {
  const { base, edits, incoming, newVersionId, now, fail } = input;

  if (fail) {
    return {
      version: null,
      report: {
        at: now,
        failed: true,
        failureReason: '合并请求被服务端拒绝（模拟 503）：本地改动与编剧提交均已保留，请直接重试。',
        baseLabel: base.label,
        items: [],
      },
    };
  }

  const items: MergeReportItem[] = [];
  const lines = mergeSide('line', base.lines, incoming ? incoming.lines : null, edits, items);
  const cues = mergeSide('cue', base.cues, incoming ? incoming.cues : null, edits, items);

  const version: ScriptVersion = incoming
    ? {
        id: newVersionId,
        label: `${incoming.label} · 合并稿`,
        playwright: incoming.playwright,
        note: `${incoming.note}（与断网本地改动合并，冲突以编剧版为准）`,
        lines,
        cues,
      }
    : {
        id: newVersionId,
        label: `本地合并稿 ${newVersionId}`,
        playwright: '本地',
        note: '编剧暂无新版提交，仅合并断网期间的本地改动。',
        lines,
        cues,
      };

  return {
    version,
    report: {
      at: now,
      failed: false,
      mergedVersionId: version.id,
      mergedLabel: version.label,
      baseLabel: base.label,
      items,
    },
  };
}
