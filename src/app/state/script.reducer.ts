import { createReducer, on } from '@ngrx/store';
import { addVersion, activateVersion, reorderLines, reviewCue, reviewLine, setOnline, toggleRehearsal } from './script.actions';

export type CueDecision = 'pending' | 'accepted' | 'returned';

export interface ScriptVersion {
  id: string;
  label: string;
  playwright: string;
  note: string;
  lines: Array<{ id: string; role: string; text: string; status: 'pending' | 'accepted' | 'returned' }>;
  cues: Array<{ id: string; scene: string; text: string; status: CueDecision }>;
}

export interface ScriptState {
  versions: ScriptVersion[];
  activeVersionId: string;
  rehearsalMode: boolean;
  online: boolean;
}

const initialVersions: ScriptVersion[] = [
  {
    id: 'v12', label: '排练稿 v12', playwright: '林编剧', note: '重写第三场父女冲突，舞台灯光提示延后2拍。',
    lines: [
      { id: 'l1', role: '周岚', text: '你每次都说等明天，可舞台不会等我们。', status: 'pending' },
      { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending' }
    ],
    cues: [
      { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', status: 'pending' },
      { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', status: 'accepted' }
    ]
  },
  {
    id: 'v13', label: '导演修订 v13', playwright: '林编剧', note: '调整周岚结论，加入一次性追光变化。',
    lines: [
      { id: 'l1', role: '周岚', text: '你总说明天，但今晚我们必须把话说完。', status: 'pending' },
      { id: 'l3', role: '周岚', text: '看着灯，再说一次你为什么回来。', status: 'pending' }
    ],
    cues: [{ id: 'c3', scene: '第三场', text: '追光由冷白切换至琥珀，等待雨声下落', status: 'pending' }]
  }
];

function getInitialState(): ScriptState {
  if (typeof localStorage === 'undefined') return { versions: initialVersions, activeVersionId: 'v12', rehearsalMode: false, online: true };
  const saved = localStorage.getItem('yf52-script-state');
  return saved ? JSON.parse(saved) as ScriptState : { versions: initialVersions, activeVersionId: 'v12', rehearsalMode: false, online: true };
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
  on(setOnline, (state, { online }) => ({ ...state, online }))
);
