import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription, take } from 'rxjs';
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
} from './state/script.actions';
import {
  CueEntry,
  LineEntry,
  LocalEdit,
  MergeOutcome,
  ScriptState,
  ScriptVersion,
  ServerVersion,
} from './state/script.reducer';
import { computeMerge } from './state/script.merge';
import { simulatedServerVersion } from './state/script.server';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, DragDropModule, MatToolbarModule, MatButtonModule, MatCardModule, MatTabsModule, TranslocoModule],
  template: `
    <mat-toolbar color="primary" class="topbar">
      <span>{{ 'title' | transloco }}</span>
      <span class="spacer"></span>
      <button mat-stroked-button (click)="toggleOnline()">
        {{ ((state$ | async)?.online ? 'online' : 'offline') | transloco }}
      </button>
      <button mat-flat-button color="accent" (click)="toggleRehearsal()">
        {{ ((state$ | async)?.rehearsalMode ? 'normalMode' : 'rehearsalMode') | transloco }}
      </button>
    </mat-toolbar>

    <main [class.rehearsal]="(state$ | async)?.rehearsalMode">
      <!-- 排练提词模式：只显示已采纳内容，待确认/候选/失效条目一律不进入 -->
      <section *ngIf="(state$ | async)?.rehearsalMode; let state" class="prompter">
        <h2>排练提词 · {{ activeLabel(state) }}</h2>
        <p class="prompter-note">本视图只呈现「已采纳」台词与舞台提示，待确认、待确认候选与失效退回内容均已隔离。</p>
        <ng-container *ngIf="activeVersion(state) as v">
          <article class="prompt-line" *ngFor="let line of v.lines">
            <ng-container *ngIf="line.status === 'accepted'">
              <h3>{{ line.role }}</h3><p>{{ line.text }}</p>
            </ng-container>
          </article>
          <article class="prompt-cue" *ngFor="let cue of v.cues">
            <ng-container *ngIf="cue.status === 'accepted'">
              <h3>【{{ cue.scene }} · 舞台提示】</h3><p>{{ cue.text }}</p>
            </ng-container>
          </article>
          <p *ngIf="acceptedCount(v) === 0" class="prompter-empty">当前版本没有任何已采纳条目，排练版本不会混入未确认内容。</p>
        </ng-container>
      </section>

      <ng-container *ngIf="(state$ | async)?.rehearsalMode !== true; let state">
        <section class="summary">
          <mat-card>
            <mat-card-title>版本控制</mat-card-title>
            <p>编剧提交后逐条合并：冲突以编剧版为准，导演/舞台监督的断网改动保留为待确认候选；已采纳条目若被编剧更新则自动失效退回。</p>
            <div class="chips">
              <button mat-stroked-button *ngFor="let version of state.versions"
                      [color]="version.id === state.activeVersionId ? 'primary' : ''"
                      (click)="activate(version.id)">
                {{ version.label }} · {{ version.playwright }}
              </button>
              <button mat-flat-button color="primary" (click)="createDraft()">新增本地修订</button>
            </div>
          </mat-card>
        </section>

        <!-- 断网本地改动队列 -->
        <section class="queue" *ngIf="state.localEdits.length">
          <mat-card>
            <mat-card-title>断网本地改动（{{ state.localEdits.length }}）</mat-card-title>
            <p class="hint">改动只保存在本地，未写入任何版本正文；网络恢复并合并前不会进入排练版本。</p>
            <div class="edit-row" *ngFor="let edit of state.localEdits">
              <div>
                <b>{{ edit.kind === 'line' ? '角色台词' : '舞台提示' }} · {{ edit.author }}</b>
                <p class="old">原文：{{ edit.baseText }}</p>
                <p class="new">本地：{{ edit.text }}</p>
              </div>
              <button mat-button color="warn" (click)="discard(edit)">丢弃</button>
            </div>
          </mat-card>
        </section>

        <!-- 网络恢复 / 合并面板 -->
        <section class="merge-panel" *ngIf="state.online">
          <mat-card>
            <mat-card-title>网络恢复 · 合并</mat-card-title>
            <ng-container *ngIf="!state.incomingVersion">
              <p class="hint">
                当前没有待合并的编剧新版。
                <ng-container *ngIf="state.localEdits.length">本地已有 {{ state.localEdits.length }} 条改动，等待编剧提交后合并。</ng-container>
              </p>
              <button mat-flat-button color="primary" (click)="simulateIncoming()">模拟编剧提交新版剧本</button>
            </ng-container>

            <ng-container *ngIf="state.incomingVersion as incoming">
              <p class="hint">编剧刚提交了新版（{{ incoming.label }} · {{ incoming.playwright }}）：{{ incoming.note }}</p>
              <p class="hint">含台词 {{ incoming.lines.length }} 条、舞台提示 {{ incoming.cues.length }} 条。
                合并时同一条目若两边都改过，以编剧版为准，本地改动自动留成待确认候选。</p>
              <div class="merge-actions">
                <button mat-flat-button color="primary" [disabled]="state.merging" (click)="merge()">
                  {{ state.merging ? '合并中…' : (state.mergeReport?.failed ? '保留本地改动并重试合并' : '执行合并') }}
                </button>
                <label class="fail-toggle">
                  <input type="checkbox" [checked]="state.failNextMerge" (change)="toggleFail()">
                  模拟本次合并失败（验证本地改动保留与重试）
                </label>
                <button mat-button (click)="cancelIncoming()">暂不合并</button>
              </div>
            </ng-container>

            <ng-container *ngIf="state.mergeReport as report">
              <div class="failure" *ngIf="report.failed">
                <b>合并失败：</b>{{ report.failureReason }}
                <span>本地改动、编剧新版与当前排练版本均未被修改。</span>
              </div>
            </ng-container>
          </mat-card>
        </section>

        <aside class="offline-tip" *ngIf="!state.online">
          <b>断网缓存中</b>
          <p>可使用「本地改词/改提示」记录导演与舞台监督的修改，恢复网络后再与编剧新版合并。</p>
          <div class="author-switch">
            以身份记录：
            <button mat-stroked-button [color]="editAs === '导演' ? 'primary' : ''" (click)="editAs = '导演'">导演</button>
            <button mat-stroked-button [color]="editAs === '舞台监督' ? 'primary' : ''" (click)="editAs = '舞台监督'">舞台监督</button>
          </div>
        </aside>

        <section *ngIf="activeVersion(state) as activeVersion" class="workspace">
          <mat-card class="script">
            <mat-card-title>{{ activeVersion.label }}</mat-card-title>
            <mat-card-subtitle>{{ activeVersion.note }}</mat-card-subtitle>
            <mat-tab-group>
              <mat-tab [label]="'角色台词（' + activeVersion.lines.length + '）'">
                <div cdkDropList (cdkDropListDropped)="dropLine($event)">
                  <article class="line" cdkDrag *ngFor="let line of activeVersion.lines">
                    <div class="body">
                      <b>{{ line.role }}</b>
                      <p *ngIf="editingId !== 'line-' + line.id">{{ line.text }}</p>
                      <ng-container *ngIf="editingId === 'line-' + line.id">
                        <textarea [(ngModel)]="editingDraft" rows="2"></textarea>
                        <div class="edit-actions">
                          <button mat-flat-button color="primary" (click)="saveLine(line)">保存本地改动</button>
                          <button mat-button (click)="editingId = null">取消</button>
                        </div>
                      </ng-container>
                      <span class="status" [class.ok]="line.status === 'accepted'" [class.back]="line.status === 'returned'">
                        {{ statusLabel(line.status) }}
                      </span>
                      <p class="invalidate" *ngIf="line.invalidateReason">⚠ {{ line.invalidateReason }}</p>
                      <div class="candidate" *ngIf="line.candidate">
                        <b>待确认候选 · 本地修改（{{ line.candidate.author }}）</b>
                        <p>{{ line.candidate.text }}</p>
                        <span>{{ line.candidate.reason }}</span>
                        <div class="cand-actions">
                          <button mat-stroked-button color="primary" (click)="resolve('line', line.id, true)">采纳候选（仍需确认）</button>
                          <button mat-stroked-button (click)="resolve('line', line.id, false)">放弃候选</button>
                        </div>
                      </div>
                    </div>
                    <div class="ops">
                      <button mat-button color="primary" (click)="review(line.id, 'accepted')">采纳</button>
                      <button mat-button color="warn" (click)="review(line.id, 'returned')">退回</button>
                      <button mat-button *ngIf="!state.online && editingId !== 'line-' + line.id"
                              (click)="startEdit('line', line.text, line.id)">本地改词</button>
                    </div>
                  </article>
                </div>
              </mat-tab>
              <mat-tab [label]="'舞台提示（' + activeVersion.cues.length + '）'">
                <article class="line" *ngFor="let cue of activeVersion.cues">
                  <div class="body">
                    <b>{{ cue.scene }}</b>
                    <p *ngIf="editingId !== 'cue-' + cue.id">{{ cue.text }}</p>
                    <ng-container *ngIf="editingId === 'cue-' + cue.id">
                      <textarea [(ngModel)]="editingDraft" rows="2"></textarea>
                      <div class="edit-actions">
                        <button mat-flat-button color="primary" (click)="saveCue(cue)">保存本地改动</button>
                        <button mat-button (click)="editingId = null">取消</button>
                      </div>
                    </ng-container>
                    <span class="status" [class.ok]="cue.status === 'accepted'" [class.back]="cue.status === 'returned'">
                      {{ statusLabel(cue.status) }}
                    </span>
                    <p class="invalidate" *ngIf="cue.invalidateReason">⚠ {{ cue.invalidateReason }}</p>
                    <div class="candidate" *ngIf="cue.candidate">
                      <b>待确认候选 · 本地修改（{{ cue.candidate.author }}）</b>
                      <p>{{ cue.candidate.text }}</p>
                      <span>{{ cue.candidate.reason }}</span>
                      <div class="cand-actions">
                        <button mat-stroked-button color="primary" (click)="resolve('cue', cue.id, true)">采纳候选（仍需确认）</button>
                        <button mat-stroked-button (click)="resolve('cue', cue.id, false)">放弃候选</button>
                      </div>
                    </div>
                  </div>
                  <div class="ops">
                    <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
                    <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
                    <button mat-button *ngIf="!state.online && editingId !== 'cue-' + cue.id"
                            (click)="startEdit('cue', cue.text, cue.id)">本地改提示</button>
                  </div>
                </article>
              </mat-tab>
            </mat-tab-group>
          </mat-card>

          <mat-card class="compare">
            <mat-card-title>版本对比</mat-card-title>
            <p class="version-name">{{ activeVersion.label }} · {{ activeVersion.playwright }}</p>
            <div class="diff"><b>台词 / 提示</b><span>{{ activeVersion.lines.length }} / {{ activeVersion.cues.length }}</span></div>
            <div class="diff"><b>待确认</b><span>{{ pendingCount(activeVersion) }} 项</span></div>
            <div class="diff"><b>待确认候选</b><span>{{ candidateCount(activeVersion) }} 项</span></div>
            <div class="diff warn"><b>采纳失效退回</b><span>{{ invalidatedCount(activeVersion) }} 项</span></div>
            <div class="diff ok"><b>已采纳（可入排练）</b><span>{{ acceptedCount(activeVersion) }} 项</span></div>

            <ng-container *ngIf="state.mergeReport as report">
              <div class="report-head">
                <b [class.failed]="report.failed">{{ report.failed ? '最近一次合并：失败' : '合并报告 · ' + report.mergedLabel }}</b>
                <button mat-icon-button aria-label="关闭报告" (click)="dismissReport()">✕</button>
              </div>
              <p class="hint" *ngIf="!report.failed">基准 {{ report.baseLabel }} → {{ report.mergedLabel }}</p>
              <div class="report-item" *ngFor="let item of report.items" [attr.data-outcome]="item.outcome">
                <span class="outcome" [ngClass]="item.outcome">{{ outcomeLabel(item.outcome) }}</span>
                <b>{{ item.kind === 'line' ? '台词' : '提示' }} · {{ item.title }}</b>
                <p class="reason">{{ item.reason }}</p>
                <div class="three-way" *ngIf="item.outcome === 'conflict' || item.outcome === 'local-restored'">
                  <span><i>原文</i>{{ item.baseText }}</span>
                  <span *ngIf="item.serverText !== undefined && item.serverText !== null"><i>编剧版（已采用）</i>{{ item.serverText || '（新版已移除）' }}</span>
                  <span><i>本地候选</i>{{ item.localText }}</span>
                </div>
              </div>
              <p *ngIf="!report.failed && !report.items.length" class="hint">本次合并没有内容差异。</p>
            </ng-container>
          </mat-card>
        </section>
      </ng-container>
    </main>
  `,
  styles: [`
    .topbar { position: sticky; top: 0; z-index: 4; }
    .spacer { flex: 1; }
    main { max-width: 1180px; margin: 24px auto; padding: 0 18px 48px; }
    main.rehearsal { max-width: 960px; background: #111827; color: #f9fafb; margin-top: 0; min-height: 100vh; padding: 32px 28px 64px; }
    .summary, .queue, .merge-panel { margin-bottom: 18px; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .hint { color: #6b7280; font-size: 13px; }
    .workspace { display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); gap: 18px; }
    .line { cursor: grab; display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding: 16px 0; border-bottom: 1px solid #e5e7eb; }
    .line .body { min-width: 0; }
    .line p { margin: 8px 0; font-size: 17px; line-height: 1.6; }
    .ops { display: flex; flex-direction: column; flex-shrink: 0; }
    .status { font-size: 12px; color: #b45309; }
    .status.ok { color: #15803d; }
    .status.back { color: #6b7280; }
    .invalidate { color: #b91c1c !important; font-size: 13px !important; }
    .candidate { margin-top: 10px; padding: 12px; background: #fffbeb; border: 1px solid #f59e0b; border-radius: 8px; }
    .candidate p { font-size: 15px; }
    .candidate span { font-size: 12px; color: #92400e; }
    .cand-actions, .edit-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    textarea { width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; resize: vertical; }
    .edit-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1px solid #e5e7eb; padding: 10px 0; }
    .edit-row .old { color: #6b7280; font-size: 13px; margin: 4px 0; text-decoration: line-through; }
    .edit-row .new { color: #92400e; font-size: 14px; margin: 4px 0; }
    .merge-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
    .fail-toggle { font-size: 13px; color: #6b7280; display: flex; align-items: center; gap: 6px; }
    .failure { margin-top: 14px; padding: 12px 14px; background: #fef2f2; border: 1px solid #ef4444; border-radius: 8px; color: #b91c1c; font-size: 14px; }
    .failure span { display: block; color: #7f1d1d; font-size: 12px; margin-top: 4px; }
    .offline-tip { margin-bottom: 18px; padding: 14px 18px; background: #fffbeb; border: 1px solid #f59e0b; border-radius: 10px; color: #92400e; }
    .offline-tip p { margin: 6px 0; font-size: 13px; }
    .author-switch { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    .version-name { padding: 12px; background: #f3f4f6; border-radius: 8px; }
    .diff { display: flex; justify-content: space-between; border-bottom: 1px solid #e5e7eb; padding: 14px 0; }
    .diff.warn b { color: #b45309; }
    .diff.ok b { color: #15803d; }
    .report-head { display: flex; justify-content: space-between; align-items: center; margin-top: 18px; }
    .report-head .failed { color: #b91c1c; }
    .report-item { border-left: 4px solid #d1d5db; padding: 10px 12px; margin: 10px 0; background: #f9fafb; border-radius: 0 8px 8px 0; }
    .report-item[data-outcome="conflict"] { border-color: #f59e0b; background: #fffbeb; }
    .report-item[data-outcome="invalidated"] { border-color: #ef4444; background: #fef2f2; }
    .report-item[data-outcome="new"] { border-color: #3b82f6; }
    .report-item[data-outcome="local-only"] { border-color: #8b5cf6; }
    .report-item[data-outcome="local-restored"] { border-color: #d97706; background: #fffbeb; }
    .outcome { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; margin-right: 8px; color: #fff; background: #6b7280; }
    .outcome.conflict, .outcome.local-restored { background: #d97706; }
    .outcome.invalidated { background: #dc2626; }
    .outcome.server-updated { background: #2563eb; }
    .outcome.new { background: #0891b2; }
    .outcome.local-only { background: #7c3aed; }
    .reason { font-size: 13px; color: #374151; margin: 6px 0 !important; }
    .three-way { display: grid; gap: 6px; font-size: 13px; margin-top: 6px; }
    .three-way i { display: block; font-style: normal; font-size: 11px; color: #6b7280; }
    .prompter h2 { font-size: 40px; }
    .prompter-note { color: #9ca3af; font-size: 14px; }
    .prompt-line h3 { font-size: 30px; color: #fbbf24; margin: 28px 0 8px; }
    .prompt-line p { font-size: 34px; line-height: 1.5; margin: 0; }
    .prompt-cue h3 { font-size: 20px; color: #60a5fa; margin: 24px 0 6px; }
    .prompt-cue p { font-size: 24px; line-height: 1.5; margin: 0; color: #e5e7eb; }
    .prompter-empty { color: #9ca3af; margin-top: 40px; font-size: 18px; }
    @media (max-width: 820px) { .workspace { grid-template-columns: 1fr; } .line { flex-direction: column; } .ops { flex-direction: row; } }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  readonly state$ = this.store.select('script');
  private subscription?: Subscription;
  private onlineHandler = () => this.store.dispatch(setOnline({ online: navigator.onLine }));
  private offlineHandler = () => this.store.dispatch(setOnline({ online: false }));

  editingId: string | null = null;
  editingDraft = '';
  editAs: '导演' | '舞台监督' = '导演';

  constructor(private readonly store: Store<{ script: ScriptState }>) {}

  ngOnInit() {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.subscription = this.state$.subscribe((state) =>
      localStorage.setItem('yf52-script-state', JSON.stringify(state)));
  }

  ngOnDestroy() {
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.subscription?.unsubscribe();
  }

  activeVersion(state: ScriptState): ScriptVersion | undefined {
    return state.versions.find((item) => item.id === state.activeVersionId) ?? state.versions[0];
  }

  activeLabel(state: ScriptState): string {
    return this.activeVersion(state)?.label ?? '';
  }

  activate(id: string) { this.store.dispatch(activateVersion({ id })); }
  toggleRehearsal() { this.store.dispatch(toggleRehearsal()); }
  setOnline(online: boolean) { this.store.dispatch(setOnline({ online })); }
  toggleOnline() { this.state$.pipe(take(1)).subscribe((state) => this.setOnline(!state.online)); }

  review(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewLine({ id, decision })); }
  reviewCue(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewCue({ id, decision })); }

  dropLine(event: CdkDragDrop<unknown>) {
    if (event.previousIndex !== event.currentIndex) {
      this.store.dispatch(reorderLines({ from: event.previousIndex, to: event.currentIndex }));
    }
  }

  startEdit(kind: 'line' | 'cue', text: string, id: string) {
    this.editingId = `${kind}-${id}`;
    this.editingDraft = text;
  }

  saveLine(line: LineEntry) {
    const text = this.editingDraft.trim();
    if (text) this.store.dispatch(editLineOffline({ id: line.id, text, author: this.editAs }));
    this.editingId = null;
  }

  saveCue(cue: CueEntry) {
    const text = this.editingDraft.trim();
    if (text) this.store.dispatch(editCueOffline({ id: cue.id, text, author: this.editAs }));
    this.editingId = null;
  }

  discard(edit: LocalEdit) {
    this.store.dispatch(discardLocalEdit({ kind: edit.kind, id: edit.id }));
  }

  simulateIncoming() {
    this.store.dispatch(serverVersionArrived({ incoming: simulatedServerVersion }));
  }

  cancelIncoming() {
    this.store.dispatch(clearServerVersion());
  }

  toggleFail() {
    this.store.dispatch(toggleFailNextMerge());
  }

  /**
   * 网络恢复后的合并：纯函数 computeMerge 完成三路对比。
   * 合并失败（模拟服务端拒绝）时只登记失败报告，本地改动与编剧新版原样保留，可直接重试。
   */
  merge() {
    this.state$.pipe(take(1)).subscribe((state) => {
      const base = this.activeVersion(state);
      if (!base || state.merging) return;
      this.store.dispatch(mergeRequested({}));
      const snapshot = state;
      // 模拟一次网络往返
      setTimeout(() => {
        const result = computeMerge({
          base,
          edits: snapshot.localEdits,
          incoming: snapshot.incomingVersion,
          newVersionId: `v${Date.now().toString().slice(-6)}`,
          now: Date.now(),
          fail: snapshot.failNextMerge,
        });
        if (result.version) {
          this.store.dispatch(mergeSucceeded({ version: result.version, report: result.report }));
        } else {
          this.store.dispatch(mergeFailed({ report: result.report }));
        }
      }, 600);
    });
  }

  dismissReport() { this.store.dispatch(dismissReport()); }

  resolve(kind: 'line' | 'cue', id: string, apply: boolean) {
    this.store.dispatch(resolveCandidate({ kind, id, apply }));
  }

  statusLabel(status: string): string {
    return status === 'accepted' ? '已采纳' : status === 'returned' ? '已退回' : '待确认';
  }

  outcomeLabel(outcome: MergeOutcome): string {
    const labels: Record<MergeOutcome, string> = {
      conflict: '冲突·编剧优先',
      invalidated: '采纳已失效',
      'server-updated': '编剧更新',
      new: '编剧新增',
      'local-only': '仅本地改动',
      'local-restored': '本地改动留候选',
    };
    return labels[outcome];
  }

  pendingCount(version: ScriptVersion): number {
    return version.lines.filter((item) => item.status === 'pending').length
      + version.cues.filter((item) => item.status === 'pending').length;
  }

  candidateCount(version: ScriptVersion): number {
    return version.lines.filter((item) => item.candidate).length
      + version.cues.filter((item) => item.candidate).length;
  }

  invalidatedCount(version: ScriptVersion): number {
    return version.lines.filter((item) => item.invalidateReason).length
      + version.cues.filter((item) => item.invalidateReason).length;
  }

  acceptedCount(version: ScriptVersion): number {
    return version.lines.filter((item) => item.status === 'accepted').length
      + version.cues.filter((item) => item.status === 'accepted').length;
  }

  createDraft() {
    const id = `v${Date.now().toString().slice(-4)}`;
    const version: ScriptVersion = {
      id,
      label: `导演修订 ${id}`,
      playwright: '本地草稿',
      note: '断网期间创建的修订，等待与编剧版本合并。',
      lines: [{ id: `${id}-l1`, role: '周岚', text: '这次换你告诉我，灯亮之后准备去哪里。', status: 'pending' }],
      cues: [{ id: `${id}-c1`, scene: '第三场', text: '追光保持到台词结束，再执行全场收光', status: 'pending' }],
    };
    this.store.dispatch(addVersion({ version }));
    this.store.dispatch(activateVersion({ id }));
  }
}
