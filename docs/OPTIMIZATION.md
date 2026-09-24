# 优化建议清单

> 基于对全项目代码的遍历审查（后端 8 个模块、前端、配置、启动脚本）。
> 状态标记：✅ 已修复 ｜ ⬜ 待处理

---

## P0：正确性 / 安全问题（建议尽快处理）

### 1. ✅ TTS 音频被原样广播给所有查看端（已修复，改为订阅制）

**位置**：`backend/server.py` `_handle_volcengine_message` / `broadcast_to_viewers`、`frontend/viewer.js`

**原问题**：`message_to_send` 里包含 base64 编码的 TTS 音频（`data` 字段），然后原封不动广播给所有查看端。
查看端 TTS 播放默认关闭，一条 TTS 几十 KB，N 个查看端就是 N 倍纯浪费。

**修复内容**：
- `TranslationSession` 新增 `viewer_wants_tts` 订阅集合，查看端断开时自动清理；
- 查看端新增 `set_tts` 消息：前端切换 TTS 播放开关时同步订阅状态，WebSocket 重连后自动重新订阅；
- `broadcast_to_viewers` 支持按订阅分发：订阅端收完整消息，未订阅端收剥离音频负载的精简消息（事件元信息保留，字幕不受影响）；
- 顺带完成建议 #8：广播前预序列化，所有查看端复用同一字符串，不再逐个 `json.dumps`；
- 已验证：模拟 5KB TTS 负载，未订阅端仅收 59B（节省约 98%），字幕广播两端一致，移除查看端后订阅集合正确清理。

**行为变化说明**：查看端默认不再收到 TTS 音频；需要播放语音的查看端打开页面上的 TTS 播放开关即可恢复（与开关语义一致）。

---

### 2. ✅ 用量报表分页 total 错误（已修复）

**位置**：`start_server.py` `api_admin_usage`、`backend/access_db.py`

**原问题**：
- `"by_day"` 的 `total` 错误地使用了 `by_code_total`（访问码数），导致按天报表分页失真；
- `count_usage_codes` 完全忽略 `days` 参数（统计的是全部访问码），且 `usage_summary` 用 LEFT JOIN 会把无活动的码也返回，两者口径不一致。

**修复内容**：
- `usage_summary` 改为 INNER JOIN，只聚合时间窗内有会话活动的访问码；
- `count_usage_codes(days)` 改为统计时间窗内有会话活动的去重访问码数，与 `usage_summary` 行数严格对应；
- 新增 `count_daily_usage(days)`，统计时间窗内有会话记录的天数，`by_day.total` 改用此值；
- 已用生产库 `data/access.db` 在 days=7/30/365 三档验证：行数与 total 完全一致。

**行为变化说明**：管理后台"按访问码用量"列表不再展示时间窗内零活动的访问码（访问码本身的完整列表仍在 `/api/admin/codes`）。

---

### 3. ✅ `.gitignore` 语法错误导致规则失效（已修复）

**位置**：`.gitignore`

**原问题**：`ssl/key.pem //SSL证书` —— gitignore 不支持 `//` 行内注释，该行被整体当作一个字面量模式，
匹配不到任何文件（此前靠下一行的 `key.pem` 兜底，私钥才未被提交）。

**修复内容**：改为独立注释行 + 干净的 `ssl/cert.pem`、`ssl/key.pem`、`key.pem` 三条规则。

---

### 4. ✅ 日志泄露 API Key 片段（已修复）

**位置**：`backend/volcengine_client.py` `connect()` 的 403 错误分支

**原问题**：连接被拒绝时打印 `self.api_key[:8]...`，Key 前 8 位会进入 journald / 日志文件。

**修复内容**：改为只打印 Key 长度，内容完全隐藏。

---

### 5. ⬜ 公开申请接口无限流

**位置**：`start_server.py` `api_submit_request`

没有速率限制，可被脚本刷爆数据库并触发管理员邮件轰炸。
`api_verify_code` 已有按 IP 限速，建议复用同一套 `is_rate_limited`。
另外 `_verify_failures` 字典只在命中限速时才清理，长期会缓慢膨胀，建议加定期清理。

---

## P1：架构 / 性能（收益明显）

### 6. ⬜ 双入口并存，`websockets` 依赖已成死代码

**位置**：`backend/server.py` `main()`、`requirements.txt`

`server.py` 的 `main()` 仍用 `websockets` 库提供独立入口，而实际生产走 `start_server.py` 的 aiohttp。导致：

- 代码里到处是 `hasattr(ws, 'send_str') / hasattr(ws, 'send')` 的双轨判断和 `WebSocketAdapter` 适配器；
- `requirements.txt` 里的 `websockets`、`grpcio`（客户端实际用 aiohttp WS + protobuf，未走 gRPC）都是无用依赖。

**建议**：删除 `server.py` 的 `main()` 和 `websockets` import，统一 aiohttp 单入口，适配器里的大量 `hasattr` 分支可以全部简化。

---

### 7. ✅ 每个 WebSocket 连接都重新读配置文件（已修复）

**位置**：`start_server.py` `websocket_handler`

**原问题**：每次连接都调用 `load_config()`，而 `load_config()` 还会执行 `_init_text_corrector()`（磁盘读写纠正词库）。
查看端高频扫码进入时纯属浪费。

**修复内容**：
- 配置仅在 `start_server()` 启动时加载一次（存入 `AppContext`），纠正器单例也随之在启动时初始化一次；
- `websocket_handler` 改为传 `copy.deepcopy(ctx.config)` 给每个连接：深拷贝小 dict 成本近乎为零，
  同时保证 `TranslationServer` 内部的配置修改（如 `update_language`）不会跨连接/跨房间泄露；
- 已验证：AST 检查确认 handler 不再调用 `load_config`，副本隔离性测试通过。

**行为变化说明**：修改 `config/config.json` 后需重启服务才生效（之前新连接会重读文件）。

---

### 8. ✅ 广播时重复 JSON 序列化（已随 #1 一并修复）

**位置**：`backend/server.py` `broadcast_to_viewers`

**原问题**：对每个查看端都 `json.dumps(message)` 一次，字幕事件频率高。

**修复内容**：广播前在循环外序列化一次（必要时额外生成一份剥离音频的精简负载），所有查看端复用。

---

### 9. ⬜ 同步 SQLite 阻塞事件循环

**位置**：`backend/access_db.py`、`backend/server.py` `_record_usage_event`

`AccessDB` 用 `threading.Lock` + 同步 sqlite3，但调用方全在 async 上下文（尤其是热路径
`_record_usage_event`，每条 UsageResponse 都写库并持有全局锁）。当前规模可接受，
但多房间并发时会阻塞整个事件循环。

**建议**：至少把写库调用包进 `asyncio.to_thread`，或给 `usage_events` 做内存批量聚合后定时落库。
多 worker 扩展（见 `MULTI_WORKER_PLAN.md`）前必须先解决此项。

---

### 10. ⬜ 火山引擎客户端缺超时与消息大小防护

**位置**：`backend/volcengine_client.py`

- `connect()` 用 `ClientTimeout(total=None)`，且 `ws_connect` 无连接超时——网络异常时可能永久挂起，建议加 `sock_connect` / `total=10s`；
- `max_msg_size=1000000000`（1GB）过于激进，单条异常消息可撑爆内存，建议降到 32~64MB；
- `send_audio` 里会话未启动时 `await asyncio.sleep(0.1)` 位于音频热路径，建议改为等待 `SessionStarted` 事件的 `asyncio.Event`。

---

### 11. ✅ 文本纠正 + 过滤执行了两遍（已修复）

**位置**：`backend/server.py` `_handle_volcengine_message`

**原问题**：先为更新会话状态做一遍 `correct_text` + `filter_text`，转发前对同一文本又做一遍。

**修复内容**：
- 将“确保 text 字段 + 纠正 + 过滤”合并为单一处理步骤并前移，只执行一次；
- 会话状态更新（651/652/654/655）与转发均直接复用处理后的 `data["text"]`；
- 原语义完整保留：652/655 空文本不入历史、不清当前行；
- 已验证：拦截器计数确认每条非空消息恰处理 1 次（修复前为 2 次），字幕历史/当前行状态与转发内容一致。

---

## P2：工程质量 / 可维护性

### 12. ✅ 时区不一致，时长统计可能出错（已修复）

**位置**：`backend/access_db.py` `tick_session`

**原问题**：用 SQLite 的 `julianday('now', 'localtime')` 减去 Python `datetime.now().isoformat()` 存入的 `started_at`，
两套时间体系混用，时区变更或解析差异可能导致墙钟时长算错。

**修复内容**：
- `tick_session` 改为纯 Python 计算：`datetime.now() - datetime.fromisoformat(started_at)`，
  两端均为本地时间，不再依赖 SQLite 时间函数解析 Python 时间戳；
- 增加防护：`started_at` 格式异常时记日志并跳过（不抛异常）；时钟回拨时 `wall_sec` 截断为非负；
- 原语义保持：已结束的会话（`ended_at` 非空）不被刷新；`codes.used_sec` 同步逻辑不变；
- 已验证：90 秒前开始的会话刷新后 `wall_sec≈90.4s`，`used_sec` 同步一致，已结束会话不被触碰。

---

### 13. ⬜ 数据只增不减

**位置**：`backend/access_db.py`

`codes`、`sessions`、`usage_events`、`audit_log` 四张表无保留策略。部署脚本每天备份，但库本身会持续膨胀。

**建议**：加一个启动时/定时的清理任务（如 `usage_events` 保留 180 天、已结束的 `sessions` 归档），
以及把长期未使用的 active 访问码自动标记为 `expired` 的任务。

---

### 14. ⬜ 进程退出时没有优雅收尾

**位置**：`start_server.py`

收到 Ctrl+C 后只做了 `runner.cleanup()` 和 `db.close()`，没有：

- 向火山引擎发 `FinishSession`（会漏计最后一批 usage）；
- 结束数据库里未关闭的计量会话（`ended_at` 永远为 NULL）；
- 通知查看端房间关闭。

**建议**：注册 `signal` 处理或 `app.on_shutdown` 钩子统一收尾。

---

### 15. ⬜ 日志级别过高，热路径刷日志

**位置**：`backend/volcengine_client.py`、`backend/server.py`

INFO 级别下每个 TTS 块、每 100 个音频包、每条字幕都会打日志（还带 emoji）。
长时间会议日志量很大，也会拖慢回调。

**建议**：把转发/音频类日志降为 DEBUG，只保留连接/断开/错误级别的 INFO。

---

### 16. ⬜ 前端需要拆分

**位置**：`frontend/app.js`（3583 行）

单文件职责混杂（音频采集、Opus 解码、TTS 播放队列、WS 协议、UI）。

**建议**：至少拆为 `audio-capture.js / tts-player.js / ws-client.js / ui.js` 四个模块（ES Module 即可，无需构建工具）。
另发现重复声明：构造器里 `ttsHealthCheckInterval` 和 `lastTTSPlayTime` 各写了两遍。

---

### 17. ⬜ 死代码清理

- `backend/audio_processor.py` `convert_to_pcm16_mono` 是空壳（直接原样返回），且没有调用方；
- README 已声明"音色代码未清理"：`config.json` 的 `tts.speaker_id`、前端 `app.js` 硬编码的 `ttsSpeakerId`、`update_voice` 消息分支都是无效路径，建议删除或在 UI 上明确标注；
- 查看端连接的多个 `asyncio.sleep(0.1/0.2)` iOS 兼容 hack 建议验证后移除——aiohttp 的消息在 `prepare()` 后即可接收，这类延迟通常掩盖的是其他问题（比如首条消息在 `connected` 之前发）。

---

### 18. ⬜ 工程化基建缺失

- 没有任何测试。建议优先为 `AccessDB`（审批/有效性/计量）、`CookieSigner`、`RoomRegistry`（顶替竞争、空闲回收）补 pytest 用例——这些都是纯逻辑、无外部依赖；
- 无 `pyproject.toml` / ruff / 类型检查，多处裸 `except:`（如 `server.py` 第 71、337 行）吞掉了异常；
- `requirements.txt` 建议锁版本（`aiohttp` 的 WS 行为在 minor 版本间有差异）。

---

### 19. ⬜ 小问题汇总

| 位置 | 问题 |
|---|---|
| `backend/server.py` `main()` | 默认端口 8765 与全局约定的 15677 不一致 |
| `start_server.py` 端口探测 | 写死 `0.0.0.0`，忽略 `server.host` 配置 |
| `server.py` `update_voice` 未连接分支 | `self.config.get("tts", {})` 键不存在时改的是临时 dict，不生效 |
| `start_server.py` 静态路由 `/{filename}` | 当前单段匹配是安全的，但建议直接用 `web.static()` 更规范 |
| `config.json` 管理员密码 | 明文存配置，建议支持环境变量注入或至少哈希存储 |

---

## 建议的实施顺序

1. **第一批（半天）**：~~#1 剥离查看端 TTS 负载~~、~~#2 分页 bug~~、~~#3 gitignore~~、~~#4 日志脱敏~~、~~#8 广播序列化~~（均已完成）；
2. **第二批（1-2 天）**：#6 统一入口 + 清理依赖、~~#7 配置缓存~~、#14 优雅关闭；
3. **第三批（按需）**：#16 前端拆分、#18 测试基建、#13 数据保留策略；~~#11 文本重复处理~~、~~#12 时区不一致~~ 已完成。

> 注：`MULTI_WORKER_PLAN.md` 的多进程扩展要特别注意 #9（SQLite 单锁）和 #13，
> 建议在实施多 worker 前先把计量写入异步化。
