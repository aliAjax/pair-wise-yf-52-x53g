import { computeMerge, ScriptVersion, ServerVersion, LocalEdit } from './script.merge';

let passed = 0;
let failCount = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.error(`  ✗ ${name} ${detail}`); }
}

const base: ScriptVersion = {
  id: 'v12', label: '排练稿 v12', playwright: '林编剧', note: '',
  lines: [
    { id: 'l1', role: '周岚', text: '原台词1', status: 'pending' },
    { id: 'l2', role: '周野', text: '原台词2', status: 'accepted' },
    { id: 'l3', role: '陈妈', text: '原台词3', status: 'accepted' },
    { id: 'l4', role: '周岚', text: '仅本地将改', status: 'pending' },
    { id: 'l5', role: '周野', text: '保持不动', status: 'accepted' },
  ],
  cues: [
    { id: 'c1', scene: '第三场', text: '原提示1', status: 'accepted' },
    { id: 'c2', scene: '第三场', text: '仅本地将改提示', status: 'pending' },
  ],
};

const incoming: ServerVersion = {
  id: 'v14', label: '编剧定稿 v14', playwright: '林编剧', note: '新版',
  lines: [
    { id: 'l1', role: '周岚', text: '编剧改台词1' },
    { id: 'l2', role: '周野', text: '编剧改台词2' },
    // l3 被编剧删除
    { id: 'l4', role: '周岚', text: '仅本地将改' },
    { id: 'l5', role: '周野', text: '保持不动' },
    { id: 'l6', role: '周岚', text: '编剧新增台词' },
  ],
  cues: [
    { id: 'c1', scene: '第三场', text: '编剧改提示1' },
    { id: 'c2', scene: '第三场', text: '仅本地将改提示' },
  ],
};

const edits: LocalEdit[] = [
  { kind: 'line', id: 'l1', text: '本地改台词1', baseText: '原台词1', author: '导演', updatedAt: 1 },
  { kind: 'line', id: 'l2', text: '本地改台词2', baseText: '原台词2', author: '舞台监督', updatedAt: 1 },
  { kind: 'line', id: 'l3', text: '本地改台词3', baseText: '原台词3', author: '导演', updatedAt: 1 },
  { kind: 'line', id: 'l4', text: '本地改了台词4', baseText: '仅本地将改', author: '导演', updatedAt: 1 },
  { kind: 'cue', id: 'c1', text: '本地也改提示1', baseText: '原提示1', author: '舞台监督', updatedAt: 1 },
  { kind: 'cue', id: 'c2', text: '本地改了提示2', baseText: '仅本地将改提示', author: '舞台监督', updatedAt: 1 },
];

const result = computeMerge({ base, edits, incoming, newVersionId: 'v14m', now: 123, fail: false });
const v = result.version!;
const byId = {
  line: new Map(v.lines.map((l) => [l.id, l])),
  cue: new Map(v.cues.map((c) => [c.id, c])),
};
const outcomes = new Map(result.report.items.map((i) => [`${i.kind}:${i.id}`, i.outcome]));

console.log('规则1：两边都动过 → 编剧优先、本地留候选');
check('l1 正文为编剧版', byId.line.get('l1')!.text === '编剧改台词1');
check('l1 本地改动保留为候选', byId.line.get('l1')!.candidate?.text === '本地改台词1');
check('l1 候选作者保留', byId.line.get('l1')!.candidate?.author === '导演');
check('l1 状态为待确认', byId.line.get('l1')!.status === 'pending');
check('l1 报告标记冲突', outcomes.get('line:l1') === 'conflict');
check('c1 同样适用（已采纳+两边都改）', byId.cue.get('c1')!.text === '编剧改提示1' && !!byId.cue.get('c1')!.candidate);
check('l2 冲突时不盖服务端', byId.line.get('l2')!.text === '编剧改台词2' && byId.line.get('l2')!.candidate?.text === '本地改台词2');

console.log('规则2：已采纳条目被服务端更新 → 失效退回待确认并注明原因');
check('l2 失效退回（冲突路径也退 pending）', byId.line.get('l2')!.status === 'pending');
// c1 走冲突路径；单独验证仅服务端更新已采纳的失效路径：
const onlyServer = computeMerge({
  base, edits: [], incoming, newVersionId: 'x', now: 1, fail: false,
}).version!;
const osC1 = onlyServer.cues.find((c) => c.id === 'c1')!;
const osL2 = onlyServer.lines.find((l) => l.id === 'l2')!;
check('c1 仅服务端更新：退回 pending', osC1.status === 'pending');
check('c1 记录失效原因（含旧文）', (osC1.invalidateReason ?? '').includes('原已采纳') && osC1.invalidateReason!.includes('原提示1'));
check('l2 仅服务端更新：退回 pending', osL2.status === 'pending' && (osL2.invalidateReason ?? '').includes('原台词2'));
check('报告标记 invalidated', result.report.items.find((i) => i.kind === 'cue' && i.id === 'c1')?.outcome === 'conflict');
check('无本地编辑时报告 invalidated',
  computeMerge({ base, edits: [], incoming, newVersionId: 'x', now: 1, fail: false }).report.items
    .some((i) => i.id === 'c1' && i.outcome === 'invalidated'));

console.log('编剧删除条目的本地改动保留为候选');
const l3 = byId.line.get('l3');
check('l3 仍在合并稿中（挂候选）', !!l3 && l3!.candidate?.text === '本地改台词3');
check('l3 状态 pending 且正文为旧文', l3!.status === 'pending' && l3!.text === '原台词3');
check('l3 报告 local-restored', outcomes.get('line:l3') === 'local-restored');

console.log('规则3：仅本地改动 → 待确认，不直接进排练版本');
check('l4 正文为本地文本', byId.line.get('l4')!.text === '本地改了台词4');
check('l4 状态 pending', byId.line.get('l4')!.status === 'pending');
check('c2 仅本地改动 pending', byId.cue.get('c2')!.text === '本地改了提示2' && byId.cue.get('c2')!.status === 'pending');

console.log('未改动条目保持原状');
check('l5 仍为 accepted（可入排练）', byId.line.get('l5')!.status === 'accepted');
check('编剧新增 l6 为 pending', byId.line.get('l6')!.text === '编剧新增台词' && byId.line.get('l6')!.status === 'pending');

console.log('规则4：合并失败 → 不产生版本，本地与服务端原样保留（由调用方状态保证），报告可重试');
const failResult = computeMerge({ base, edits, incoming, newVersionId: 'v14m', now: 9, fail: true });
check('失败时 version 为 null', failResult.version === null);
check('失败报告 flagged 且含原因', failResult.report.failed === true && failResult.report.failureReason!.length > 0);
check('失败报告没有逐条数据', failResult.report.items.length === 0);

console.log('无编剧新版时合并本地改动');
const localOnly = computeMerge({ base, edits, incoming: null, newVersionId: 'd1', now: 1, fail: false }).version!;
check('本地版含 l4 改动且 pending', localOnly.lines.find((l) => l.id === 'l4')!.text === '本地改了台词4');
check('本地版保留已采纳 l5', localOnly.lines.find((l) => l.id === 'l5')!.status === 'accepted');

console.log(`\n${passed} passed, ${failCount} failed`);
if (failCount) process.exit(1);
