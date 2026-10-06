# pair-wise-yf-52 戏剧排练台词版本与舞台提示管控

## 源提示词摘要
导演、编剧、舞台监督和演员共同维护不同版本的剧本、角色台词、上下场提示、道具与灯光音效提示。编剧提交后需逐条合并，演员可查看最新版并标记疑问；支持版本对比、单条采纳、批注、冲突处理、排练模式、大字号提词和断网缓存。

## 技术栈
Angular + TypeScript + Angular Material + NgRx + Angular Router + RxJS + Angular CDK + Transloco。

## 已实现闭环
- 剧本版本和导演修订的创建、切换与版本差异摘要。
- 角色台词、舞台提示的采纳、退回和待确认状态。
- 排练模式、在线/离线切换与 localStorage 持久化。
- 未确认内容保留在草稿版本中，不会自动混入已采纳版本。

## 启动
```bash
npm install
npm run dev
```
开发端口：62017
