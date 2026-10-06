import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngrx/store';
import { provideTransloco, TranslocoLoader } from '@jsverse/transloco';
import { of } from 'rxjs';
import { scriptReducer } from './state/script.reducer';

class InlineTranslocoLoader implements TranslocoLoader {
  getTranslation() {
    return of({
      title: '戏剧排练台词版本与舞台提示管控',
      normalMode: '正式版本',
      rehearsalMode: '排练提词模式',
      online: '在线',
      offline: '离线缓存中'
    });
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideAnimations(),
    provideRouter([]),
    provideStore({ script: scriptReducer }),
    provideTransloco({
      config: { availableLangs: ['zh'], defaultLang: 'zh', fallbackLang: 'zh' },
      loader: InlineTranslocoLoader
    }),
  ]
};
