# 同声传译实时翻译系统

基于火山引擎同声传译2.0 API 的实时语音翻译系统，支持现场演讲的实时翻译和 TTS 播放。

## 功能特性

- 🎤 实时麦克风/系统音频采集
- 🌐 中英互译（支持 S2S 模式自动声音复刻）
- 📝 实时显示原文和译文（保留最近 8 条历史记录）
- 🔊 TTS 语音播放（支持音色选择和播放速度控制）
- 💬 WebSocket 实时通信（HTTP/WebSocket 统一端口）
- 🎚️ 音频处理控制（环境音增益、噪音抑制、静音阈值）
- ✨ 文本纠正和敏感词过滤
- 📱 移动设备支持（HTTPS）
- 👥 多查看端支持（广播模式）
- 📋 会后会议纪要：保存定稿字幕，由独立文本模型生成草稿，管理员审核发布后查看端沿原分享链接阅读
- 🎨 现代化三列布局界面

## 系统要求

- **Python**: 3.11 或更高版本
- **操作系统**: Windows / Linux / macOS
- **浏览器**: Chrome / Edge / Safari（推荐 Chrome 或 Edge 以获得最佳体验）

## 快速开始

本指南将带你完成从零开始的完整安装和配置流程。

**安装流程概览：**

1. 安装 Python 依赖
2. 配置火山引擎 API 凭证
3. 配置 TTS 音色（可选）
4. 生成 SSL 证书（移动设备需要）
5. 启动服务器
6. 打开前端页面
7. 开始使用

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

**如果遇到依赖安装问题，尝试：**

```bash
# 更新 pip
pip install --upgrade pip

# 使用国内镜像源（加速下载）
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### 2. 配置 API 凭证

复制配置文件模板并填入你的火山引擎 API 凭证：

```bash
cp config/config.example.json config/config.json
```

编辑 `config/config.json`，填入以下信息:

- `api_key`: 火山引擎 API Key（新版控制台获取）
- `resource_id`: 资源 ID（默认：volc.service_type.10053）

### 3. TTS 音色配置（S2S 模式）

**在豆包同声音传译2.0中无法更改音色，项目中的音色代码未清理**

在 `config/config.json` 中可以配置 TTS 音色：

```json
{
  "tts": {
    "speaker_id": "",
    "comment": "speaker_id: 留空时，S2S模式会自动从输入音频中提取说话人音色特征，实现0样本声音复刻；如果指定音色ID，则使用指定音色（会覆盖自动复刻）"
  }
}
```

**S2S 模式（推荐）：**

- **`speaker_id` 留空**：启用自动声音复刻功能
  - 系统会自动从输入音频中提取说话人音色特征
  - 实现"0样本声音复刻"
  - 输出语音会保持说话人的音色特征
  - 这是 S2S 模式的核心功能

**指定音色模式：**
如果指定 `speaker_id`，系统会使用指定的音色（会覆盖自动复刻功能）：

**常用音色 ID：**

- `zh_female_shuangkuaisisi` - 中文女声（双快思思）
- `zh_male_zhongyinshuni` - 中文男声（中音书宁）
- `zh_female_qingxin` - 中文女声（清新）
- `en_female_amy` - 英文女声（Amy）
- `en_male_daniel` - 英文男声（Daniel）

**注意：**

- 推荐使用 S2S 模式（`speaker_id` 留空）以获得最佳体验
- 如需固定音色，可指定 `speaker_id`
- 具体可用的音色 ID 请参考火山引擎官方文档

### 4. 生成 SSL 证书（移动设备访问需要）
如果要在 iPad/手机 上使用麦克风功能，需要 HTTPS：

```bash
./generate_cert.sh
```

这会生成自签名 SSL 证书（保存在 `ssl/` 目录）。

### 会议纪要模型配置（可在启动前完成）

在 `config/config.json` 的 `minutes` 节填写独立文本模型的 `base_url` 与 `model`。
服务会向 `{base_url}/chat/completions` 发送兼容 Chat Completions 的请求；
密钥建议通过环境变量 `MINUTES_API_KEY` 设置，也可填 `minutes.api_key`。
模型未配置时，实时翻译继续工作，会议和字幕仍会保存；管理员可在“会议纪要”页配置模型后重新生成，或直接手工编辑草稿。
纪要默认只在管理员发布后向持有查看端分享链接的人开放。

### 5. 启动服务器

系统使用 `aiohttp` 在同一端口（默认 15677）同时提供 HTTP/HTTPS 和 WebSocket/WSS 服务。

**方式一：使用 Python 直接启动（跨平台）**

HTTP 服务器（仅电脑使用）：

```bash
python start_server.py
```

HTTPS 服务器（支持移动设备，推荐）：

```bash
python start_server.py --https
```

指定端口：

```bash
python start_server.py --https --port 15677
```

**方式二：使用启动脚本**

Linux/macOS：

```bash
./start.sh
```

Windows PowerShell：

```powershell
.\start.ps1
```

或使用 HTTP（不推荐移动设备）：

```powershell
.\start.ps1 -Http
```

**两个启动脚本的行为**（`start.sh` / `start.ps1` 一致）：
- 自动选择 Python 解释器：优先项目自带的 `.doubao`（macOS/Linux）或 `.doubao`/`.venv`（Windows，`Scripts\python.exe`）虚拟环境，找不到才用系统 Python；
- 端口被占用时**自动关闭占用进程后启动**（`start.sh --keep-port` / `start.ps1 -KeepPort` 可改为报错退出）；
- 默认端口读取 `config/config.json` 的 `server.port`，命令行参数可覆盖；
- `-Install`（`--install`）可在启动前安装依赖。

**注意**：如果 PowerShell 提示执行策略错误，运行以下命令：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**服务器说明：**

- 默认端口：**15677**（可在 `config/config.json` 中配置）
- HTTP/HTTPS 和 WebSocket/WSS 使用**同一端口**
- WebSocket 路径：`/ws`
- 静态文件路径：`/`（前端文件）

启动后会显示：

- 本地访问地址：`http://localhost:15677` 或 `https://localhost:15677`
- 局域网访问地址：`http://<你的IP>:15677` 或 `https://<你的IP>:15677`

### 6. 打开前端页面

系统提供两种前端页面：

**控制端页面（Controller）**

- 负责音频采集和翻译处理
- 支持麦克风和系统音频输入
- 可调整音色、播放速度等设置
- **访问地址**：`/` 或 `https://<IP>:15677/`
- 适用于：演讲者、主持人

**查看端页面（Viewer）**

- 只接收和显示翻译结果
- 不发送音频，无需麦克风权限
- 支持多个查看端同时连接
- **访问地址**：`/viewer` 或 `https://<IP>:15677/viewer`
- 适用于：观众、投影仪、远程设备

**本地访问（电脑）：**

- 控制端：在浏览器中访问 `http://localhost:15677` 或 `https://localhost:15677`
- 查看端：在浏览器中访问 `http://localhost:15677/viewer` 或 `https://localhost:15677/viewer`

**iPad/手机访问：**

1. 确保设备和电脑在同一 WiFi 网络
2. **必须使用 HTTPS**：移动设备需要 HTTPS 才能使用麦克风功能
3. 使用 `--https` 参数启动服务器
4. 在设备浏览器中输入：`https://<你的电脑IP>:15677`
5. **首次访问会显示安全警告**（因为是自签名证书）：
   - iOS Safari：点击"显示详细信息" -> "访问此网站"
   - Android Chrome：点击"高级" -> "继续访问"

**注意**：

- iOS Safari 和 Android Chrome 要求 HTTPS 连接才能访问麦克风
- 如果使用 HTTP 访问，会显示"浏览器不支持音频采集功能"的错误
- 自签名证书会在浏览器显示安全警告，这是正常的，点击继续访问即可
- 手机端的声音输出暂未修复完成， 仍然存在问题，默认关闭

### 7. 开始使用

**控制端使用步骤（演讲者）：**

1. **选择音频源**：麦克风或系统音频
2. **配置音色**（可选）：选择 TTS 音色，或使用"自动复刻（推荐）"启用 S2S 模式
3. **调整播放速度**（可选）：使用滑块调整 TTS 播放速度（0.5x - 2.0x）
4. **音频处理设置**（可选）：
   - 环境音增益：调整输入音频增益（50% - 200%）
   - 噪音抑制：开启/关闭噪音抑制
   - 静音阈值：设置静音检测阈值（0.1% - 5%）
5. **测试麦克风**（可选）：点击"测试麦克风"按钮测试音频采集
6. **开始翻译**：点击"开始翻译"按钮
7. 允许浏览器访问麦克风
8. 开始说话，系统将实时显示原文和译文
9. 译文将通过 TTS 自动播放（按顺序播放，不会重叠）

**界面说明：**

- **左侧控制区域**：包含所有控制按钮和设置选项
- **右侧上方**：显示 ASR 语音识别原文（保留最近 8 条）
- **右侧下方**：显示翻译后的文字（保留最近 8 条）
- **当前文本**：正在构建的句子会以加粗、更大字号和主题色显示

**查看端使用步骤（观众）：**

1. 在浏览器中打开查看端页面：`https://<IP>:15677/viewer`
2. 页面会自动连接到控制端
3. 实时显示翻译结果（原文和译文）
4. 无需任何操作，自动接收更新
5. 支持多个设备同时连接

**使用场景示例：**

**场景 1：会议演讲**

- 演讲者使用 iPad（控制端）进行翻译
- 观众通过手机或电脑（查看端）查看结果
- 投影仪显示查看端页面给全场观众

**场景 2：远程会议**

- 主讲人使用控制端（需要麦克风权限）
- 远程参会者使用查看端（无需麦克风权限）
- 多个查看端可同时连接

**场景 3：教学演示**

- 老师使用控制端进行授课翻译
- 学生通过查看端查看翻译结果
- 支持大屏幕投影显示

## 访问控制与用量统计（内部上线）

系统内置基于**访问码**的权限控制和用量/成本统计：

### 生产部署（Linux + systemd）

推荐用 systemd 托管（崩溃自动重启、开机自启、journald 日志、每日备份）：

```bash
# 1. 把项目拷到 Linux 服务器（确保 config/config.json 已填好）
# 2. 在项目目录执行：
sudo bash deploy/deploy-linux.sh
# 3. 完成。升级时拉取最新代码后重跑同一脚本即可（数据与证书自动保留）
```

默认部署到 `/opt/simtrans`，端口 15677，可用环境变量覆盖（`DEPLOY_DIR=... SERVICE_USER=... PORT=... sudo -E bash deploy/deploy-linux.sh`）。常用运维命令：`systemctl status simtrans`、`journalctl -u simtrans -f`、`systemctl restart simtrans`；数据库每日 03:00 自动备份到 `data/backup/`（保留 30 天）。

- `/` 首页：提交使用申请（申请人、邮箱、部门、主题、使用时间、预计时长），或输入访问码进入系统
- `/app` 控制端、`/viewer` 查看端：需要访问码登录态（cookie），未登录自动跳回首页
- `/admin` 管理后台：管理员密码登录（`security.admin_password`），审批申请、管理访问码、查看用量与成本

**TTS 停流自愈**：长会话中若出现"字幕正常显示但没有语音"（火山引擎停止下发 TTS），服务端看门狗会自动重建会话恢复语音输出（默认字幕活跃但 3 分钟无 TTS 即触发，`tts.stall_reconnect_min` 可调，0 关闭）。重建期间字幕不受影响，控制端状态栏会显示"语音恢复中…"。

**多房间并发**：单进程支持多场会议同时进行，互不干扰。每场会议一个房间（Room），控制端连接后收到 `room_info`（含本场专属查看端链接 `/viewer?room=XXXXXX`），观众仅能通过该链接进入对应场次；控制端断线 10 分钟内重连自动恢复本场（字幕历史与查看端不丢失），房间空闲 5 分钟后自动回收。管理后台"活跃房间"页可查看各场次（申请人/主题/在线状态/查看端数）。后续如需故障隔离或更大规模的多进程水平扩展，见 [`MULTI_WORKER_PLAN.md`](MULTI_WORKER_PLAN.md)（设计已定稿，按触发条件实施）。

**流程**：用户提交申请 → 管理员在后台审批 → 系统自动生成访问码并通过邮件发送（SMTP 未配置时可在管理页复制手动发送）→ 用户输入访问码进入。

**访问码规则**：
- 自计划使用时间**提前 2 小时**生效（`security.code_valid_before_start_min` 可调），结束时间不限制
- 申请时填写的预计时长仅作参考展示，**不做额度限制**，不会因时长用尽而中断
- 管理员可随时撤销、重发邮件；实际使用时长和 token 消耗照常统计

**用量统计**：每次翻译会话按墙钟累计时长，火山引擎的 UsageResponse（token 消耗）逐条落库（`data/access.db`，SQLite），管理后台按访问码/按天查看 token 用量与成本（在 `pricing` 节配置每千 token 单价后自动换算金额）。

上线前需要在 `config/config.json` 中配置：
- `security.secret_key`：随机长字符串（签名登录态 cookie 用）
- `security.admin_password`：管理后台密码
- `security.admin_notify_emails`：管理员邮箱列表（可选）。配置后**有新申请会自动邮件提醒**，邮件内附审批入口链接，不用天天盯后台
- `smtp.*`：邮件服务器（可选，未配置时审批通过后到管理页复制访问码）。**支持匿名内部邮件中继**：`username`/`password` 留空即不鉴权，典型配置为 `port: 25`、`use_tls: false`；需要鉴权的外部邮箱则填写账号密码（465 端口 + `use_tls: true` 走 SSL，587 + `use_tls: true` 走 STARTTLS）

## 项目结构

```
Simultaneous_Translation/
├── backend/                    # 后端代码
│   ├── server.py              # WebSocket 服务器
│   ├── volcengine_client.py   # 火山引擎客户端（aiohttp + protobuf）
│   ├── audio_processor.py     # 音频处理
│   ├── text_corrector.py      # 文本纠正器
│   └── text_filter.py         # 敏感词过滤器
├── frontend/                   # 前端代码
│   ├── index.html             # 控制端页面
│   ├── viewer.html            # 查看端页面
│   ├── app.js                 # 控制端逻辑
│   ├── viewer.js              # 查看端逻辑
│   └── styles.css             # 样式
├── config/                     # 配置文件
│   ├── config.example.json    # 配置文件模板
│   ├── config.json            # 配置文件（需创建）
│   ├── corrections.example.json  # 纠正规则示例
│   └── corrections.json       # 纠正规则（自动生成）
├── ssl/                        # SSL 证书目录
│   ├── cert.pem               # SSL 证书（自生成）
│   └── key.pem                # SSL 密钥（自生成）
├── start_server.py             # 服务器启动脚本
├── start.sh                    # Linux/macOS 启动脚本
├── start.ps1                   # Windows PowerShell 启动脚本
├── generate_cert.sh            # SSL 证书生成脚本
├── kill_port.sh                # 端口清理脚本
└── requirements.txt            # Python 依赖
```

## 技术栈

- **后端**: Python 3.11+, aiohttp, asyncio
- **前端**: HTML5, JavaScript, Web Audio API, WebSocket
- **API**: 火山引擎同声传译2.0（Protobuf 协议）
- **音频处理**: Web Audio API, AudioWorklet
- **通信**: WebSocket/WSS (实时双向通信)

## 使用说明

### 启动系统

1. **启动后端服务器**

   ```bash
   python backend/server.py
   ```

   或者使用启动脚本：

   ```bash
   ./start.sh
   ```
2. **打开前端页面**

   - 在浏览器中打开 `frontend/index.html`
   - 或使用本地服务器（见上文）
3. **开始翻译**

   - 点击"开始翻译"按钮
   - 允许浏览器访问麦克风
   - 开始说话，系统将实时显示原文和译文
   - 译文将通过 TTS 自动播放

### 配置说明

在 `config/config.json` 中配置以下参数：

**火山引擎配置：**

- `volcengine.api_key`: 火山引擎 API Key
- `volcengine.resource_id`: 资源 ID（默认：volc.service_type.10053）

**服务器配置：**

- `server.host`: 服务器地址（默认：0.0.0.0，允许外部访问）
- `server.port`: 服务器端口（默认：15677）

**音频配置：**

- `audio.sample_rate`: 采样率（默认：16000）
- `audio.channels`: 声道数（默认：1，单声道）
- `audio.bits_per_sample`: 位深度（默认：16）
- `audio.chunk_duration_ms`: 音频块时长（默认：80ms）

**翻译配置：**

- `translation.source_language`: 源语言（默认：zh，中文）
- `translation.target_language`: 目标语言（默认：en，英文）

**TTS 配置：**

- `tts.speaker_id`: TTS 音色 ID（留空启用 S2S 自动声音复刻，推荐）

**文本纠正配置（可选）：**

- 在 `config/corrections.json` 中配置文本纠正规则
- 示例：
  ```json
  {
    "静莹": "静音",
    "测试测试": "测试"
  }
  ```
- 系统会在显示和播报前自动应用这些纠正规则
- 可根据实际识别错误添加更多规则

**文本过滤配置（可选）：**

- 在 `backend/text_filter.py` 中配置敏感词列表
- 默认替换为 `***`
- 可自定义替换字符

## 功能说明

### S2S 模式（Speech-to-Speech）

系统支持火山引擎同声传译的 S2S 模式，具有以下特性：

- **自动声音复刻**：当 `speaker_id` 留空时，系统会自动从输入音频中提取说话人音色特征
- **0样本复刻**：无需预先训练，即可实现声音复刻
- **音色一致性**：输出语音会保持说话人的音色特征
- **多语言支持**：支持中英互译，自动适配目标语言音色

### 前端功能

- **音色选择**：可在前端选择 TTS 音色，或使用自动复刻
- **播放速度控制**：支持 0.5x - 2.0x 播放速度（步长 0.05）
- **音频处理**：
  - 环境音增益：50% - 200%
  - 噪音抑制：开关控制
  - 静音阈值：0.1% - 5%
- **文本历史**：自动保留最近 8 条历史记录
- **实时显示**：当前正在构建的句子会高亮显示

### 文本处理功能

系统包含两层文本处理机制：

**1. 文本纠正（Text Correction）**

- 自动识别并纠正常见的语音识别错误
- 配置文件：`config/corrections.json`
- 示例纠正规则：
  ```json
  {
    "静莹": "静音",
    "测试测试": "测试"
  }
  ```
- 可自定义添加更多纠正规则

**2. 敏感词过滤（Text Filtering）**

- 自动过滤敏感词汇
- 默认替换为 `***`
- 可配置替换字符
- 确保输出内容安全合规

**处理流程**：

1. 接收翻译结果
2. 应用文本纠正规则
3. 过滤敏感词
4. 显示和播报处理后的文本

### 多查看端支持

系统支持多个查看端同时连接：

**控制端**（Controller）：

- 负责音频采集和翻译
- 一个会话只能有一个控制端
- 访问地址：`https://<IP>:15677/`

**查看端**（Viewer）：

- 只接收翻译结果，不发送音频
- 支持多个查看端同时连接
- 访问地址：`https://<IP>:15677/viewer`
- 适用于：投影仪、远程设备等

**使用场景**：

- 演讲者在 iPad（控制端）上翻译
- 观众通过多个设备（查看端）查看结果

### 布局设计

- **三列布局**：左侧控制区域 + 右侧两个文本区域（均分）
- **响应式设计**：支持桌面和移动设备
- **现代化 UI**：简洁美观的界面设计

## 性能优化建议

### 网络优化

- 使用有线网络连接以提高稳定性
- 确保防火墙允许 15677 端口访问
- 移动设备使用 5GHz WiFi 以降低延迟

### 音频优化

- 调整静音阈值以适应环境噪音
- 启用噪音抑制功能以提高识别准确率
- 根据需要调整环境音增益（避免过载）

### 系统优化

- 使用 Chrome 或 Edge 浏览器（最佳 Web Audio API 支持）
- 关闭不必要的后台应用以降低延迟
- 确保系统时间同步（影响 SSL 证书验证）

## 注意事项

- 需要有效的火山引擎 API 凭证
- 浏览器需要允许麦克风访问权限
- 音频格式：16kHz, 16bit, 单通道 PCM
- 建议使用 Chrome 或 Edge 浏览器以获得最佳体验
- 移动设备访问需要 HTTPS（使用 `--https` 参数）
- 默认端口为 15677，确保防火墙允许该端口访问
- 如果遇到连接问题，检查防火墙设置和端口占用情况
- TTS 音频按顺序播放，不会出现重叠

## 常见问题

### 1. WebSocket 连接失败

**错误**: `'ClientWebSocketResponse' object has no attribute 'send'`

**解决方案**: 已在最新代码中修复。确保使用最新版本的代码。

### 2. 移动设备无法使用麦克风

**原因**: iOS Safari 和 Android Chrome 要求 HTTPS 连接才能访问麦克风

**解决方案**:

1. 生成 SSL 证书：`./generate_cert.sh`
2. 使用 HTTPS 启动服务器：`python start_server.py --https`
3. 在移动设备上使用 HTTPS 地址访问：`https://<电脑IP>:15677`

### 4. PowerShell 脚本执行失败

**错误**: 无法加载文件，因为在此系统上禁止运行脚本

**解决方案**:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 5. favicon.ico 404 错误

**说明**: 这是浏览器自动请求的图标文件，不影响功能使用

**状态**: 已在最新代码中修复（返回 204 No Content）

### 6. SSL 证书安全警告

**原因**: 使用自签名证书

**解决方案**:

- **iOS Safari**: 点击"显示详细信息" → "访问此网站"
- **Android Chrome**: 点击"高级" → "继续访问"
- 这是正常现象，自签名证书仅用于开发测试

### 7. 端口被占用

**错误**: `Address already in use` 或 `端口已被占用`

**解决方案**:

```bash
# 查找占用端口的进程
lsof -i :15677  # Linux/macOS
netstat -ano | findstr :15677  # Windows

# 使用脚本关闭端口
./kill_port.sh 15677  # Linux/macOS

# 或修改配置文件中的端口
# 编辑 config/config.json，修改 server.port
```

## 更新日志

### 最新修复

- ✅ 修复 aiohttp WebSocket `send_bytes()` 方法调用问题
- ✅ 添加 favicon.ico 处理器，避免 404 错误
- ✅ 修复 Windows PowerShell 脚本编码问题（UTF-8 without BOM）
- ✅ 优化移动设备 HTTPS 访问支持
- ✅ 改进错误处理和日志输出

## 技术亮点

### 1. aiohttp + Protobuf 实现

- 使用 `aiohttp` 替代 `websockets` 库，提高兼容性
- 使用 Protobuf 序列化，减小数据传输量
- 正确使用 `send_bytes()` 方法发送二进制数据

### 2. 多客户端架构

- 支持控制端和查看端分离
- 广播机制确保所有查看端同步更新
- 状态同步机制支持新查看端获取历史记录

### 3. 音频处理链

- Web Audio API 实时音频处理
- 动态范围压缩
- 均衡器调整
- 音量控制
- 噪音抑制和静音检测

### 4. 跨平台支持

- Linux/macOS 使用 shell 脚本
- Windows 使用 PowerShell 脚本
- 统一的 Python 启动脚本

## 贡献与反馈

如有问题或建议，欢迎：

- 提交 Issue
- 发起 Pull Request
- 联系开发者

## 许可证

MIT
