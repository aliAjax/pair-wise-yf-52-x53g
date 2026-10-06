import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription } from 'rxjs';
import {
  activateVersion,
  addVersion,
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
} from './state/script.actions';
import { ScriptState, ScriptVersion } from './state/script.reducer';

/** 模拟编剧在网络恢复后提交的新版剧本（服务端版本） */
const SERVER_VERSION: ScriptVersion = {
  id: 'v14',
  label: '编剧新版 v14',
  playwright: '林编剧',
  note: '网络恢复后收到编剧提交的新版剧本，已与本地改动逐条合并。',
  lines: [
    { id: 'l1', role: '周岚', text: '你总说等明天，可明天不会自己走来。', status: 'pending' },
    { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending' }
  ],
  cues: [
    { id: 'c1', scene: '第三场', text: '侧灯收至20%，雨声提前两拍进入', status: 'pending' },
    { id: 'c2', scene: '第三场', text: '周野坐到舞台右前区，保留三拍静默', status: 'pending' }
  ]
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, DragDropModule, MatToolbarModule, MatButtonModule, MatCardModule, MatTabsModule, MatChipsModule, MatIconModule, MatProgressSpinnerModule, TranslocoModule],
  template: `
    <ng-container *ngIf="state$ | async as state">
      <mat-toolbar color="primary" class="topbar">
        <span>{{ 'title' | transloco }}</span>
        <span class="spacer"></span>
        <button mat-stroked-button (click)="toggleOnline()">
          {{ (state.online ? 'online' : 'offline') | transloco }}
        </button>
        <button mat-flat-button color="accent" (click)="toggleRehearsal()">
          {{ (state.rehearsalMode ? 'normalMode' : 'rehearsalMode') | transloco }}
        </button>
      </mat-toolbar>

      <main [class.rehearsal]="state.rehearsalMode">
        <aside class="offline" *ngIf="!state.online">网络不可用，当前修改已写入本地缓存；恢复网络后需逐条确认合并。</aside>

        <section class="merge-banner" *ngIf="state.online && state.mergeStatus !== 'succeeded'">
          <mat-card>
            <ng-container [ngSwitch]="state.mergeStatus">
              <div *ngSwitchCase="'idle'" class="merge-row">
                <p>网络已恢复 · 检测到编剧新版剧本 <b>v14</b> · 本地有未合并改动</p>
                <button mat-flat-button color="primary" (click)="merge()">立即合并编剧新版</button>
              </div>
              <div *ngSwitchCase="'merging'" class="merge-row">
                <mat-spinner diameter="22"></mat-spinner><span>正在合并编剧版本…</span>
              </div>
              <div *ngSwitchCase="'failed'" class="merge-row failed">
                <p>合并失败：{{ state.mergeError }} <b>本地改动已保留</b>，可重试。</p>
                <button mat-flat-button color="primary" (click)="merge()">重试合并</button>
              </div>
            </ng-container>
          </mat-card>
        </section>

        <section class="merge-banner success" *ngIf="state.online && state.mergeStatus === 'succeeded'">
          <mat-card>
            <div class="merge-row">
              <p>合并完成 · 编剧版本已生效，本地改动留为待确认候选，已采纳条目未受影响。</p>
              <button mat-button (click)="dismissMerge()">知道了</button>
            </div>
          </mat-card>
        </section>

        <section class="summary">
          <mat-card>
            <mat-card-title>版本控制</mat-card-title>
            <p>编剧提交后由舞台监督逐条采纳；未确认内容不会进入排练版本。</p>
            <div class="chips">
              <button mat-stroked-button *ngFor="let version of state.versions" [color]="version.id === state.activeVersionId ? 'primary' : ''" (click)="activate(version.id)">
                {{ version.label }} · {{ version.playwright }}
              </button>
              <button mat-flat-button color="primary" (click)="createDraft()">新增导演修订</button>
            </div>
          </mat-card>
        </section>

        <section *ngIf="activeVersion$ | async as activeVersion" class="workspace">
          <mat-card class="script">
            <mat-card-title>{{ activeVersion.label }}</mat-card-title>
            <mat-card-subtitle>{{ activeVersion.note }}</mat-card-subtitle>
            <mat-tab-group>
              <mat-tab label="角色台词">
                <div cdkDropList (cdkDropListDropped)="dropLine($event)">
                  <article class="line" cdkDrag *ngFor="let line of visibleLines(activeVersion, state.rehearsalMode)">
                    <div class="line-body">
                      <div><b>{{ line.role }}</b></div>
                      <p>{{ line.text }}</p>
                      <span class="status" [class.ok]="line.status === 'accepted'">{{ line.status }}</span>
                      <div class="invalidated" *ngIf="line.invalidatedReason">已失效：{{ line.invalidatedReason }}</div>
                      <div class="candidate" *ngIf="line.candidateText">
                        <span class="candidate-label">待确认候选（本地改动，未盖掉编剧版）：</span>
                        <p class="candidate-text">{{ line.candidateText }}</p>
                        <div class="candidate-actions">
                          <button mat-stroked-button color="primary" (click)="adoptCandidate(line.id, 'line')">采纳本地候选</button>
                          <button mat-button (click)="discardCandidate(line.id, 'line')">保留编剧版</button>
                        </div>
                      </div>
                    </div>
                    <div class="line-actions">
                      <button mat-button color="primary" (click)="reviewLine(line.id, 'accepted')">采纳</button>
                      <button mat-button color="warn" (click)="reviewLine(line.id, 'returned')">退回</button>
                    </div>
                  </article>
                </div>
                <p class="empty" *ngIf="visibleLines(activeVersion, state.rehearsalMode).length === 0">排练版本仅显示已采纳条目，未确认内容不会混入。</p>
              </mat-tab>
              <mat-tab label="舞台提示">
                <article class="line" *ngFor="let cue of visibleCues(activeVersion, state.rehearsalMode)">
                  <div class="line-body">
                    <div><b>{{ cue.scene }}</b></div>
                    <p>{{ cue.text }}</p>
                    <span class="status" [class.ok]="cue.status === 'accepted'">{{ cue.status }}</span>
                    <div class="invalidated" *ngIf="cue.invalidatedReason">已失效：{{ cue.invalidatedReason }}</div>
                    <div class="candidate" *ngIf="cue.candidateText">
                      <span class="candidate-label">待确认候选（本地改动，未盖掉编剧版）：</span>
                      <p class="candidate-text">{{ cue.candidateText }}</p>
                      <div class="candidate-actions">
                        <button mat-stroked-button color="primary" (click)="adoptCandidate(cue.id, 'cue')">采纳本地候选</button>
                        <button mat-button (click)="discardCandidate(cue.id, 'cue')">保留编剧版</button>
                      </div>
                    </div>
                  </div>
                  <div class="line-actions">
                    <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
                    <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
                  </div>
                </article>
                <p class="empty" *ngIf="visibleCues(activeVersion, state.rehearsalMode).length === 0">排练版本仅显示已采纳条目，未确认内容不会混入。</p>
              </mat-tab>
            </mat-tab-group>
          </mat-card>

          <mat-card class="compare">
            <mat-card-title>版本对比</mat-card-title>
            <p class="version-name">基准 v12 → {{ activeVersion.label }}</p>
            <div class="diff"><b>新增</b><span>{{ activeVersion.lines.length }} 条台词 / {{ activeVersion.cues.length }} 条提示</span></div>
            <div class="diff"><b>待确认</b><span>{{ pendingCount(activeVersion) }} 项</span></div>
            <div class="diff"><b>待确认候选</b><span>{{ candidateCount(activeVersion) }} 项</span></div>
            <div class="diff"><b>已失效</b><span>{{ invalidatedCount(activeVersion) }} 项</span></div>
            <div class="diff warn"><b>规则</b><span>两边都动过以编剧版为准；已采纳条目被服务端更新即失效退回待确认。</span></div>
            <div class="reasons" *ngIf="state.mergeReasons.length">
              <b>合并说明</b>
              <ul>
                <li *ngFor="let reason of state.mergeReasons">{{ reason }}</li>
              </ul>
            </div>
          </mat-card>
        </section>
      </main>
    </ng-container>
  `,
  styles: [`
    .topbar { position: sticky; top: 0; z-index: 4; }
    .spacer { flex: 1; }
    main { max-width: 1180px; margin: 24px auto; padding: 0 18px 48px; }
    main.rehearsal { max-width: 860px; background: #111827; color: #f9fafb; margin-top: 0; }
    main.rehearsal .script, main.rehearsal .compare, main.rehearsal .summary { opacity: .92; }
    .summary { margin-bottom: 18px; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .workspace { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 18px; }
    .line { cursor: grab; display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 0; border-bottom: 1px solid #e5e7eb; }
    .line-body { flex: 1; min-width: 0; }
    .line p { margin: 8px 0; font-size: 17px; line-height: 1.6; }
    .status { font-size: 12px; color: #b45309; }
    .status.ok { color: #15803d; }
    .invalidated { margin-top: 6px; font-size: 13px; color: #b91c1c; }
    .candidate { margin-top: 10px; padding: 10px 12px; background: #fffbeb; border: 1px dashed #d97706; border-radius: 8px; }
    .candidate-label { font-size: 12px; color: #b45309; }
    .candidate-text { margin: 6px 0; font-size: 15px; color: #92400e; }
    .candidate-actions { display: flex; gap: 8px; }
    .line-actions { display: flex; flex-direction: column; gap: 4px; }
    .empty { padding: 18px 0; color: #6b7280; font-size: 14px; }
    .version-name { padding: 12px; background: #f3f4f6; border-radius: 8px; }
    .diff { display: flex; justify-content: space-between; border-bottom: 1px solid #e5e7eb; padding: 14px 0; }
    .diff.warn b { color: #b45309; }
    .reasons { margin-top: 14px; font-size: 13px; color: #374151; }
    .reasons ul { margin: 6px 0 0; padding-left: 18px; }
    .reasons li { margin-bottom: 4px; }
    .merge-banner { margin-bottom: 18px; }
    .merge-banner.success mat-card { background: #ecfdf5; }
    .merge-row { display: flex; align-items: center; gap: 14px; justify-content: space-between; }
    .merge-row p { margin: 0; }
    .merge-row.failed { color: #b91c1c; }
    .offline { position: fixed; right: 18px; bottom: 18px; padding: 14px 18px; color: #fff; background: #b45309; border-radius: 10px; box-shadow: 0 8px 30px #0003; z-index: 5; }
    @media (max-width: 820px) { .workspace { grid-template-columns: 1fr; } .line { align-items: flex-start; } }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  readonly state$ = this.store.select('script');
  readonly activeVersion$ = this.store.select((state) => {
    const script = state.script as ScriptState;
    return script.versions.find((item) => item.id === script.activeVersionId) ?? script.versions[0];
  });
  private subscription?: Subscription;
  private onlineHandler = () => this.store.dispatch(setOnline({ online: navigator.onLine }));
  private offlineHandler = () => this.store.dispatch(setOnline({ online: false }));
  private mergeAttempt = 0;

  constructor(private readonly store: Store<{ script: ScriptState }>) {}

  ngOnInit() {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.subscription = this.state$.subscribe((state) => localStorage.setItem('yf52-script-state', JSON.stringify(state)));
  }

  ngOnDestroy() {
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.subscription?.unsubscribe();
  }

  activate(id: string) { this.store.dispatch(activateVersion({ id })); }
  toggleRehearsal() { this.store.dispatch(toggleRehearsal()); }
  setOnline(online: boolean) { this.store.dispatch(setOnline({ online })); }
  toggleOnline() { this.state$.subscribe((state) => this.setOnline(!state.online)).unsubscribe(); }
  reviewLine(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewLine({ id, decision })); }
  dropLine(event: CdkDragDrop<unknown>) { if (event.previousIndex !== event.currentIndex) this.store.dispatch(reorderLines({ from: event.previousIndex, to: event.currentIndex })); }
  reviewCue(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewCue({ id, decision })); }

  /** 断网恢复后合并编剧新版：首次模拟合并失败（保留本地改动），重试时成功 */
  merge() {
    this.store.dispatch(setMergeStatus({ status: 'merging' }));
    this.mergeAttempt++;
    window.setTimeout(() => {
      if (this.mergeAttempt === 1) {
        this.store.dispatch(mergeFailure({ error: '合并失败：服务端版本校验未通过，本地改动已保留，请重试。' }));
      } else {
        this.store.dispatch(mergeFromServer({ serverVersion: SERVER_VERSION }));
      }
    }, 700);
  }

  dismissMerge() { this.store.dispatch(clearMergeStatus()); }
  adoptCandidate(id: string, kind: 'line' | 'cue') { this.store.dispatch(adoptCandidate({ id, kind })); }
  discardCandidate(id: string, kind: 'line' | 'cue') { this.store.dispatch(discardCandidate({ id, kind })); }

  /** 排练版本不能混入未确认内容：仅返回已采纳条目 */
  visibleLines(version: ScriptVersion, rehearsal: boolean) {
    return rehearsal ? version.lines.filter((line) => line.status === 'accepted') : version.lines;
  }
  visibleCues(version: ScriptVersion, rehearsal: boolean) {
    return rehearsal ? version.cues.filter((cue) => cue.status === 'accepted') : version.cues;
  }
  pendingCount(version: ScriptVersion) { return version.lines.filter((item) => item.status === 'pending').length + version.cues.filter((item) => item.status === 'pending').length; }
  candidateCount(version: ScriptVersion) { return version.lines.filter((item) => item.candidateText).length + version.cues.filter((item) => item.candidateText).length; }
  invalidatedCount(version: ScriptVersion) { return version.lines.filter((item) => item.invalidatedReason).length + version.cues.filter((item) => item.invalidatedReason).length; }

  createDraft() {
    const id = `v${Date.now().toString().slice(-4)}`;
    const version: ScriptVersion = {
      id,
      label: `导演修订 ${id}`,
      playwright: '本地草稿',
      note: '断网期间创建的修订，等待与编剧版本合并。',
      lines: [{ id: `${id}-l1`, role: '周岚', text: '这次换你告诉我，灯亮之后准备去哪里。', status: 'pending' }],
      cues: [{ id: `${id}-c1`, scene: '第三场', text: '追光保持到台词结束，再执行全场收光', status: 'pending' }]
    };
    this.store.dispatch(addVersion({ version }));
    this.store.dispatch(activateVersion({ id }));
  }
}
