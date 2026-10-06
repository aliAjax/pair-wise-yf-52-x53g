import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription } from 'rxjs';
import { activateVersion, addVersion, reorderLines, reviewCue, reviewLine, setOnline, toggleRehearsal } from './state/script.actions';
import { ScriptState, ScriptVersion } from './state/script.reducer';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, DragDropModule, MatToolbarModule, MatButtonModule, MatCardModule, MatTabsModule, MatChipsModule, MatIconModule, TranslocoModule],
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
      <section class="summary">
        <mat-card>
          <mat-card-title>版本控制</mat-card-title>
          <p>编剧提交后由舞台监督逐条采纳，未确认内容不会进入排练版本。</p>
          <div class="chips">
            <button mat-stroked-button *ngFor="let version of (state$ | async)?.versions" [color]="version.id === (state$ | async)?.activeVersionId ? 'primary' : ''" (click)="activate(version.id)">
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
              <div cdkDropList (cdkDropListDropped)="dropLine($event)"><article class="line" cdkDrag *ngFor="let line of activeVersion.lines">
                <div><b>{{ line.role }}</b><p>{{ line.text }}</p><span class="status" [class.ok]="line.status === 'accepted'">{{ line.status }}</span></div>
                <div>
                  <button mat-button color="primary" (click)="reviewLine(line.id, 'accepted')">采纳</button>
                  <button mat-button color="warn" (click)="reviewLine(line.id, 'returned')">退回</button>
                </div>
              </article></div>
            </mat-tab>
            <mat-tab label="舞台提示">
              <article class="line" *ngFor="let cue of activeVersion.cues">
                <div><b>{{ cue.scene }}</b><p>{{ cue.text }}</p><span class="status" [class.ok]="cue.status === 'accepted'">{{ cue.status }}</span></div>
                <div>
                  <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
                  <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
                </div>
              </article>
            </mat-tab>
          </mat-tab-group>
        </mat-card>

        <mat-card class="compare">
          <mat-card-title>版本对比</mat-card-title>
          <p class="version-name">基准 v12 → {{ activeVersion.label }}</p>
          <div class="diff"><b>新增</b><span>{{ activeVersion.lines.length }} 条台词 / {{ activeVersion.cues.length }} 条提示</span></div>
          <div class="diff"><b>待确认</b><span>{{ pendingCount(activeVersion) }} 项</span></div>
          <div class="diff warn"><b>规则</b><span>台词退回后会自动标记为不可进入正式排练</span></div>
        </mat-card>
      </section>

      <aside class="offline" *ngIf="!(state$ | async)?.online">网络不可用，当前修改已写入本地缓存；恢复网络后需逐条确认合并。</aside>
    </main>
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
    .line p { margin: 8px 0; font-size: 17px; line-height: 1.6; }
    .status { font-size: 12px; color: #b45309; }
    .status.ok { color: #15803d; }
    .version-name { padding: 12px; background: #f3f4f6; border-radius: 8px; }
    .diff { display: flex; justify-content: space-between; border-bottom: 1px solid #e5e7eb; padding: 14px 0; }
    .diff.warn b { color: #b45309; }
    .offline { position: fixed; right: 18px; bottom: 18px; padding: 14px 18px; color: #fff; background: #b45309; border-radius: 10px; box-shadow: 0 8px 30px #0003; }
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
  pendingCount(version: ScriptVersion) { return version.lines.filter((item) => item.status === 'pending').length + version.cues.filter((item) => item.status === 'pending').length; }
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

