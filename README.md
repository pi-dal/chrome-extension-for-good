# chrome-extension-for-good (c4g)

CDP + Chrome 扩展混合架构的自动化做题与学习时长监督工具。内置 Moodle 类 LMS 视频页适配器,其他平台靠自动 inspect + 配方蒸馏自适应。

## 架构

```
┌─ packages/host(Node 编排进程,大脑)──────────────┐
│ cdp.ts        连接真实 Chrome(--remote-debugging-port)│
│ ws-server.ts  与扩展的 WebSocket 桥                  │
│ jev.ts        TypeSafe Jev 决策驱动(元素表→操作)      │
│ solver.ts     LLM 解题器(OpenAI 兼容)               │
│ quiz-loop.ts  做题状态机                             │
│ timekeeper.ts 播放监督器(只监督,不加速)              │
└───────────────────────────────────────────────────┘
        │ WebSocket(快照/动作/事件)      │ CDP(trusted input / evaluate)
┌─ packages/extension(MV3,常驻手眼)─────────────────┐
│ background.ts  WS client、webRequest 心跳观测        │
│ content.ts     元素表快照、动作执行、quizSlot 标注     │
└───────────────────────────────────────────────────┘
        packages/protocol — 双端共享 wire 契约(类型+校验器)
```

## 开发

```sh
pnpm install
pnpm -r build          # 注意先于单独 build,protocol 需先产出 dist
pnpm -r typecheck
pnpm --filter @c4g/protocol test
```

- 加载扩展:Chrome → `chrome://extensions` → 开发者模式 → 加载已解压的压缩程序 → 选择 `packages/extension/dist`
- 启动 Chrome 调试端口:`open -a "Google Chrome" --args --remote-debugging-port=9222`
- host:`cp .env.example .env` 填入 key 后 `pnpm --filter @c4g/host dev`(无 key 时自动进入 dry-run,只记录决策不调用外部 API)
- **端点配置可在扩展侧热更新**:扩展 options 页可填解题 LLM 与 TypeSafe(Jev)的 Base URL / API Key / Model,保存后经 `config_sync` 推送给 host 运行时生效(留空 = 回落 `.env` 默认值)。密钥仅存本机 `chrome.storage.local`,仅经 loopback WebSocket 发送给 host 进程,日志永不打印密钥。
- **过夜批跑**:`pnpm --filter @c4g/host dev chain <课程页URL> --loop` —— 队列清空后自动重扫课程页,按完成台账(`data/completions.json`)去重补队列,直到全部看完或 `--max-passes N`(默认 3)用尽;Ctrl-C 先持久化队列与台账再退出。失败重试记录在 `data/failed.json`(封顶,防死循环)。
- **断流自愈**:播放中若服务端记账时长停滞,先页内恢复(弹窗处理),再自动重载页面并恢复真实播放;每视频最多重试 3 次,超限标记失败并自动切下一个,结束后输出每视频账目(时长/记账/恢复次数)。

## 安全边界(硬约束)

- **永不伪造学习时长心跳、永不加速播放**:许多 LMS 平台在服务端按真实墙钟差校验时长增量,伪造请求不仅无效,还可能触发风控。本工具只做无人值守的 1x 真实播放监督(自动处理暂停弹窗、播完自动连播)。
- **不自动交卷**:`AUTO_SUBMIT=false` 时 quiz-loop 到提交步骤即停,只保存不提交。
- 密钥可存于 host 侧 `.env` 或扩展 options 页(仅本机),不发送给任何第三方。

## 免责声明

本项目仅供学习与研究。使用前请自行确认并遵守所在平台的服务条款与课程纪律,因使用本工具产生的一切后果由使用者自行承担。
