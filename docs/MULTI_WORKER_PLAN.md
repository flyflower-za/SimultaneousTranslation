# 多进程水平扩展方案（第二阶段，暂缓实施）

> 状态：**设计已评审通过，暂缓实施**。第一阶段（多房间化，单进程支持多用户并发）已上线，
> 见 `backend/server.py` 的 `RoomRegistry` 与 `ROOM_REGISTRY`。
> 当出现下文"触发条件"中的任一情况时，按本方案实施。

## 1. 背景与现状

- 第一阶段已把"一场翻译会议"从进程级单例改造为**房间**（`TranslationSession` + `RoomRegistry`），
  单进程即可支持多场会议并发，各房间拥有独立的控制端、查看端、火山引擎会话、TTS 看门狗和计量记录。
- 房间生命周期：控制端断开后保留 5 分钟等待重连，超时回收并通知查看端（`ROOM_IDLE_TEARDOWN_SEC`）。
- 前端协议：控制端首次连接收到 `room_info`（room_id + 查看端链接），断线重连带 `room` 参数恢复；
  查看端仅能通过 `/viewer?room=XXXXXX` 加入指定房间。
- `data/access.db`（SQLite, WAL, `busy_timeout=5000`）已支持同机多进程共享访问。
- 已具备 `/api/health` 健康检查。

## 2. 触发条件（满足其一即启动本阶段）

1. **故障隔离需求**：一场会议的异常（进程崩溃/OOM）不应影响其他进行中的会议。
2. **规模需求**：同时进行中的房间数使单进程 CPU 饱和（经验上数十场以上；音频转发每房间约 32KB/s，CPU 主要花在 protobuf 解析与 JSON 序列化）。
3. **跨主机部署需求**：单机容量或可用性不再满足。

## 3. 核心设计：房间粘性路由（避免跨进程广播）

**关键洞察**：一个房间的控制端和查看端只要始终路由到同一个 worker，
广播就永远是进程内操作，**不需要任何进程间消息总线**（无 Redis pub/sub、无跨进程状态同步）。
复杂度从"分布式广播"降为"路由粘性"。

```
 用户 ──▶ nginx/caddy (15677, TLS 终止)
            │  路由：cookie/path 中的 room → 固定转发到该房间所在 worker
            ├──▶ worker1 :15681 ── Room A
            ├──▶ worker2 :15682 ── Room B, C
            └──▶ worker3 :15683 ── Room D
 所有 worker 共享 data/access.db（SQLite WAL + busy_timeout，同机）
```

## 4. 实施要点

### 4.1 房间登记表（复用现有 SQLite）

新增运行态表 `rooms`（与内存 `RoomRegistry` 并存，仅用于跨进程寻址）：

```sql
CREATE TABLE IF NOT EXISTS rooms_runtime (
    room_id     TEXT PRIMARY KEY,
    worker_port INTEGER NOT NULL,   -- 房间所在 worker 的内部端口
    code_id     INTEGER,
    applicant   TEXT DEFAULT '',    -- 冗余字段，管理页跨进程展示用
    topic       TEXT DEFAULT '',
    started_at  TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL      -- worker 定期刷新
);
```

- 控制端连接到达任意 worker：查表无此房间 → 就地创建并登记（先认领后建，`INSERT OR IGNORE` 抢占）；
  已存在 → 返回 302/重定向到归属 worker 的入口路径。
- worker 每 10 秒批量刷新自己名下房间的 `heartbeat_at`。
- 心跳超时（如 30 秒）的记录由任意 worker 顺手清理（`DELETE ... WHERE heartbeat_at < now-30s`，幂等）。

### 4.2 粘性路由

- 进入房间后由 worker 发放 `st_room` cookie：`{room_id, worker_port}`，用现有 `CookieSigner`（`backend/auth.py`）签名。
- nginx 按 cookie map 到对应 upstream；查看端链接自带 `?room=` 参数，任意 worker 校验后重定向到归属 worker。
- nginx 配置骨架（示意）：

```nginx
upstream st_w1 { server 127.0.0.1:15681; }
upstream st_w2 { server 127.0.0.1:15682; }
upstream st_w3 { server 127.0.0.1:15683; }

# map $cookie_st_room -> $st_upstream（房间号段或查表生成的 map 文件）
# WebSocket 需要 proxy_http_version 1.1 + Upgrade/Connection 头透传
```

- TLS 终止在入口层，用公司内部 CA 签发正式证书（顺带解决自签名证书的用户体验问题）；
  worker 之间走本机 HTTP。

### 4.3 worker 生命周期

- systemd（Linux）或 launchd（macOS）托管 N 个实例，`KeepAlive` 自动拉起；
  启动命令即现有 `start_server.py --port <内部端口>`（无需 HTTPS 参数）。
- worker 崩溃：其名下房间随进程消失；守护进程自动重启 worker；前端已有断线重连逻辑，
  重连请求被入口层重新分配到存活 worker 并新建房间——用户侧表现为"几秒后自动恢复（字幕历史清空）"。
- 计量不受影响：`sessions`/`usage_events` 按 code_id 聚合，与房间/worker 无关。
  worker 崩溃时未 `end_session` 的计量记录由启动时对账逻辑补齐（扫描 `ended_at IS NULL`
  且心跳超时的 session 补结束时间）。

### 4.4 需要的代码改动清单（预估 2-3 天）

| # | 改动 | 文件 | 说明 |
|---|------|------|------|
| 1 | `rooms_runtime` 表 + 读写方法 | `backend/access_db.py` | 认领/心跳/清理/查表 |
| 2 | 控制端连接时登记房间、发放 `st_room` cookie | `start_server.py` | 已有房间则返回归属 worker |
| 3 | 心跳刷新任务 | `start_server.py` 或 `server.py` | 每 10 秒批量 UPDATE |
| 4 | worker 启动时孤儿会话对账 | `backend/server.py` | 补 `ended_at` |
| 5 | 管理页"活跃房间"改为读 `rooms_runtime` | `frontend/admin.html` + `/api/admin/rooms` | 跨进程聚合 |
| 6 | nginx 配置 + systemd/launchd 单元文件 | `deploy/` 新目录 | 含健康检查 |
| 7 | 端口占用自检移除/调整（入口层负责端口） | `start_server.py` | worker 只绑本机回环 |

### 4.5 明确不做的事

- **不做跨进程消息广播**（Redis pub/sub 等）：粘性路由已消除该需求。
- **不做 aiohttp 内置多进程**：GIL 非瓶颈（纯 I/O），且事件循环对象无法跨进程共享。
- **暂不引入 PostgreSQL**：同机多 worker 场景 SQLite（WAL + busy_timeout）足够；
  跨主机部署时再评估迁移。

## 5. 验收标准

1. 两个浏览器分别用不同访问码同时开会，字幕/语音互不串扰；
2. `kill -9` 某个 worker，其他房间的会议进程不中断、无感知；
3. 被杀 worker 的控制端在数秒内自动重连并被重新分配，恢复翻译；
4. 管理后台"活跃房间"能看到所有 worker 上的房间（含申请人/主题）；
5. `/api/health` 经入口层访问正常，任一 worker 停机不影响入口可用性；
6. 计量数据完整：worker 异常退出后 session 记录经对账闭环。

## 6. 相关代码索引（第一阶段产出，本阶段直接复用）

- 房间核心：`backend/server.py` — `TranslationSession` / `RoomRegistry` / `ROOM_REGISTRY`
- 房间参数与端点：`start_server.py` — `/ws?room=`、`/api/health`、`/api/admin/rooms`
- 前端：`frontend/app.js`（`room_info`/`sessionStorage` 恢复）、`frontend/viewer.js`（按房间加入）
- SQLite 多进程前置：`backend/access_db.py` — WAL + `busy_timeout=5000`
