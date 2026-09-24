
<span id="0b6c5874"></span>

# 简介

本文档介绍如何通过WebSocket协议实时访问同传大模型 (AST)服务，主要包含鉴权相关、协议详情、常见问题和使用Demo四部分。支持s2s（Speech-to-Speech），s2t（Speech-to-Text），目前支持支持克隆本身说话人的音色，支持的语种如下：

| | | | | | \

| **输入/输出模式**         | **源语种/目标语种设置模式**      | **支持语种**                                                                                                                                                                                                   | **语种数量** | **备注**                                                     |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------ |
|                                 |                                        |                                                                                                                                                                                                                      |                    |                                                                    |
| **语音到语音（S2S）模式** | 1. 需指定源语种、目标语种              | \                                                                                                                                                                                                                    |                    |                                                                    |
|                                 | 2. 源语种或目标语种必须是zh中文/en英语 | zh中文、en英语、pt葡萄牙语、es西班牙语、ja日语、id印尼语、de德语、fr法语                                                                                                                                             | 8                  | 如果目标语种为zh中文/en英语，可支持使用公版音色播报，可选2个音色： |
|                                 |                                        |                                                                                                                                                                                                                      |                    |                                                                    |
|                                 |                                        |                                                                                                                                                                                                                      |                    | * zh_female_vv_uranus_bigtts                                       |
|                                 |                                        |                                                                                                                                                                                                                      |                    | * zh_male_jingqiangkanye_emo_mars_bigtts                           |
| ^^                              |                                        |                                                                                                                                                                                                                      |                    | ^^                                                                 |
|                                 | 自动识别免切换                         | zh中文、en英语                                                                                                                                                                                                       | 2                  |                                                                    |
|                                 |                                        |                                                                                                                                                                                                                      |                    | ^^                                                                 |
| **语音到文本（S2T）模式** | \                                      |                                                                                                                                                                                                                      |                    |                                                                    |
|                                 | 1. 需指定源语种、目标语种              | \                                                                                                                                                                                                                    |                    |                                                                    |
|                                 | 2. 源语种或目标语种必须是zh中文/en英语 | \                                                                                                                                                                                                                    |                    |                                                                    |
|                                 | 3. 方言仅支持作为源语种                | **外语：**zh中文、en英语、pt葡萄牙语、es西班牙语、ja日语、id印尼语、de德语、fr法语、ru俄语、it意大利语、ko韩语、ar阿拉伯语、tr土耳其语、ms马来语、vi越南语、th泰语、nl荷兰语、ro罗马尼亚语、pl波兰语、cs捷克语 | \                  |                                                                    |
|                                 |                                        | **方言：**粤语、上海话                                                                                                                                                                                         | 20外语             | \                                                                  |
|                                 |                                        |                                                                                                                                                                                                                      | 2方言              |                                                                    |

AST 服务使用的接口地址是：wss://openspeech.bytedance.com/api/v4/ast/v2/translate
<span id="a1166af9"></span>

# 非业务直接相关协议

<span id="064104b5"></span>

## 鉴权

在 websocket 建连的 HTTP 请求头（Request Header 中）添加以下信息
使用[新版控制台](https://console.volcengine.com/speech/new)时，推荐采用以下更简化的鉴权方式。

| | | | | | \

| Key               | 说明                                                                                                                     | 参数类型 | 是否必须 | Value示例               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- | -------- | ----------------------- |
|                   |                                                                                                                          |          |          |                         |
| X-Api-Key         | 使用火山引擎控制台获取的API Key，可参考[控制台API Key管理](https://www.volcengine.com/docs/6561/2119699?lang=zh#ew1HctnP) | string   | 必须     | "your-api-key"          |
|                   |                                                                                                                          |          |          |                         |
| X-Api-Resource-Id | \                                                                                                                        |          |          |                         |
|                   | 表示调用服务的资源信息 ID，是固定值                                                                                      | \        |          |                         |
|                   |                                                                                                                          | string   | 必须     | volc.service_type.10053 |

```Python
headers = {
    "X-Api-Key": "your-api-key",
    "X-Api-Resource-Id": "volc.service_type.10053"
}
```

若使用[旧版控制台](https://console.volcengine.com/speech/app)，鉴权方式如下。建议尽快切换至新版，以体验更便捷的鉴权流程。

| | | | | | \

| Key               | 说明                                                                                                                                                                                                                                                                                                                                                                  | 参数类型 | 是否必须 | Value示例               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- | ----------------------- |
|                   |                                                                                                                                                                                                                                                                                                                                                                       |          |          |                         |
| X-Api-App-Id      | 使用火山引擎控制台获取的App-Id，可参考[控制台API Id管理](https://www.volcengine.com/docs/6561/196768?lang=zh#q1%EF%BC%9A%E5%93%AA%E9%87%8C%E5%8F%AF%E4%BB%A5%E8%8E%B7%E5%8F%96%E5%88%B0%E4%BB%A5%E4%B8%8B%E5%8F%82%E6%95%B0appid%EF%BC%8Ccluster%EF%BC%8Ctoken%EF%BC%8Cauthorization-type%EF%BC%8Csecret-key-%EF%BC%9F)                                                | string   | 必须     | “12345678”            |
|                   |                                                                                                                                                                                                                                                                                                                                                                       |          |          |                         |
| X-Api-Access-Key  | 使用火山引擎控制台获取的Access Token，可参考[控制台使用FAQ-Q1](https://www.volcengine.com/docs/6561/196768#q1%EF%BC%9A%E5%93%AA%E9%87%8C%E5%8F%AF%E4%BB%A5%E8%8E%B7%E5%8F%96%E5%88%B0%E4%BB%A5%E4%B8%8B%E5%8F%82%E6%95%B0appid%EF%BC%8Ccluster%EF%BC%8Ctoken%EF%BC%8Cauthorization-type%EF%BC%8Csecret-key-%EF%BC%9F)（旧版控制台使用，新版控制台只需要X-Api-Key即可） | string   | 必须     | “your-access-key”     |
|                   |                                                                                                                                                                                                                                                                                                                                                                       |          |          |                         |
| X-Api-Resource-Id | \                                                                                                                                                                                                                                                                                                                                                                     |          |          |                         |
|                   | 表示调用服务的资源信息 ID，是固定值                                                                                                                                                                                                                                                                                                                                   | \        |          |                         |
|                   |                                                                                                                                                                                                                                                                                                                                                                       | string   | 必须     | volc.service_type.10053 |

```Python
headers = {
    "X-Api-App-Id": "123456789",
    "X-Api-Access-Key": "your-access-key",
    "X-Api-Resource-Id": "volc.service_type.10053"
}
```

websocket 握手成功后，会返回 Response header

| | | | \

| Key        | 说明                                               | Value 示例                         |
| ---------- | -------------------------------------------------- | ---------------------------------- |
|            |                                                    |                                    |
| X-Tt-Logid | 服务端返回的 logid，建议用户获取和打印方便定位问题 | 202407261553070FACFE6D19421815D605 |

<span id="445dcdc5"></span>

## 建连 HTTP 请求头示例

```Plain
GET /api/v4/ast/v2/translate 
Host: openspeech.bytedance.com
X-Api-App-Key: 123456789
X-Api-Resource-Id: volc.service_type.10053

# 返回 Header
X-Tt-Logid: 202407261553070FACFE6D19421815D605
```

<span id="4368fc69"></span>

# 业务协议详情

<span id="673d2256"></span>

## Protobuf

<Attachment link="https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/7d318979f1b44273b1d050302a1b16f7~tplv-goo7wpa0wc-image.image" name="protos.tar.gz" ></Attachment>
**构建方法**：下载并解压上面的gzip压缩包后，参考其中的`HOWTO.md`教程
> 目前有Go，Python, Java语言的构建教程，此压缩包为Go的示例教程， Python, Java语言的构建教程直接打包在下方Client Demo中，请直接下载获取。

<span id="07ee5ae2"></span>

### Client Demo

Go：

Python：

Java:

<span id="84c46f39"></span>

## 交互流程

![Image](https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/d9b9280715014742a02bbc47003d1421~tplv-goo7wpa0wc-image.image =317x)
<span id="d97def23"></span>

## WebSocket 二进制协议

WebSocket protobuf传输数据。
<span id="12afe749"></span>

### Event 字段描述

发送端 Event Type:

| | | | \

| Event         | 取值 | 描述         |
| ------------- | ---- | ------------ |
|               |      |              |
| StartSession  | 100  | 建联请求     |
|               |      |              |
| UpdateConfig  | 201  | 更新参数     |
|               |      |              |
| TaskRequest   | 200  | 发送音频数据 |
|               |      |              |
| FinishSession | 102  | 结束session  |

接收端 Event Type:

| | | | \

| Type                        | 取值 | 描述         |
| --------------------------- | ---- | ------------ |
|                             |      |              |
| SessionStarted              | 150  | 建联成功     |
|                             |      |              |
| SourceSubtitleStart         | 650  | 原文开始     |
|                             |      |              |
| SourceSubtitleResponse      | 651  | 原文数据     |
|                             |      |              |
| SourceSubtitleEnd           | 652  | 原文结束     |
|                             |      |              |
| TranslationSubtitleStart    | 653  | 译文开始     |
|                             |      |              |
| TranslationSubtitleResponse | 654  | 译文数据     |
|                             |      |              |
| TranslationSubtitleEnd      | 655  | 译文结束     |
|                             |      |              |
| TTSSentenceStart            | 350  | TTS开始      |
|                             |      |              |
| TTSResponse                 | 352  | TTS数据      |
|                             |      |              |
| TTSSentenceEnd              | 351  | TTS结束      |
|                             |      |              |
| UsageResponse               | 154  | 计量计费     |
|                             |      |              |
| SessionFinished             | 152  | 会话正常结束 |
|                             |      |              |
| SessionFailed               | 153  | 会话失败     |
|                             |      |              |
| AudioMuted                  | 250  | 静音事件     |

<span id="84ff0301"></span>

## 请求流程

<span id="4ebfc331"></span>

### 发送端

<span id="65eb2f78"></span>

#### 建立连接-StartSession

根据 WebSocket 协议本身的机制，client 会发送 HTTP GET 请求和 server 建立连接做协议升级。
需要在其中根据身份认证协议加入鉴权签名头。设置方法请参考鉴权。
WebSocket 建立连接后，发送的第一个请求是 建联 request。请求体字段说明：

| | | | | | | \

| 字段名                        | 说明                 | 层级 | 格式                 | 是否必填                                  | 备注                                                                                                 |
| ----------------------------- | -------------------- | ---- | -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
|                               |                      |      |                      |                                           |                                                                                                      |
| request_meta                  | 请求元信息           | 1    | dict                 | ✓                                        | 请求元信息                                                                                           |
|                               |                      |      |                      |                                           |                                                                                                      |
| session_id                    | 会话ID               | 2    | string               | ✓                                        | 建议采用UUID                                                                                         |
|                               |                      |      |                      |                                           |                                                                                                      |
| event                         | 请求事件说明         | 1    | enum(int32)          | ✓                                        | 建联请求的event 为100，见上文Event 字段描述                                                          |
|                               |                      |      |                      |                                           |                                                                                                      |
| user                          | 用户相关配置         | 1    | dict                 |                                           | 提供后可供服务端过滤日志                                                                             |
|                               |                      |      |                      |                                           |                                                                                                      |
| uid                           | 用户标识             | 2    | string               |                                           | 建议采用 IMEI 或 MAC。                                                                               |
|                               |                      |      |                      |                                           |                                                                                                      |
| did                           | 设备名称             | 2    | string               |                                           |                                                                                                      |
|                               |                      |      |                      |                                           |                                                                                                      |
| platform                      | 操作系统及API版本号  | 2    | string               |                                           | iOS/Android/Linux                                                                                    |
|                               |                      |      |                      |                                           |                                                                                                      |
| sdk_version                   | sdk版本              | 2    | string               |                                           |                                                                                                      |
|                               |                      |      |                      |                                           |                                                                                                      |
| request                       | 请求相关配置         | 1    | dict                 | ✓                                        | 请求配置说明                                                                                         |
|                               |                      |      |                      |                                           |                                                                                                      |
| mode                          | 模式                 | 2    | string               |                                           | s2t/s2s 选一个, 控制是否需要语音                                                                     |
|                               |                      |      |                      |                                           |                                                                                                      |
| speaker_id                    | 说话人音色           | 2    | string               |                                           | 选择传入以下精品音色作为输出音频的说话人，不传或者传错则使用默认行为（复刻输入音频音色）             |
|                               |                      |      |                      |                                           | `zh_female_vv_uranus_bigtts`                                                                       |
|                               |                      |      |                      |                                           | `zh_male_jingqiangkanye_emo_mars_bigtts`                                                           |
|                               |                      |      |                      |                                           |                                                                                                      |
| is_custom_speaker             | 外接音色是否复刻音色 | 2    | bool                 |                                           | 默认值为`false`                                                                                    |
|                               |                      |      |                      |                                           | 是否复刻音色（触发鉴权）。                                                                           |
|                               |                      |      |                      |                                           |                                                                                                      |
| tts_resource_id               | 外接音色tts资源id    | 2    | string               | **当走精品/复刻音色链路时必须提供** | 默认值为 空                                                                                          |
|                               |                      |      |                      |                                           | 可选范围：                                                                                           |
|                               |                      |      |                      |                                           | ```JSON                                                                                              |
|                               |                      |      |                      |                                           | seed-tts-1.0                                                                                         |
|                               |                      |      |                      |                                           | seed-tts-2.0                                                                                         |
|                               |                      |      |                      |                                           | seed-icl-1.0                                                                                         |
|                               |                      |      |                      |                                           | seed-icl-2.0                                                                                         |
|                               |                      |      |                      |                                           | ```                                                                                                  |
|                               |                      |      |                      |                                           |                                                                                                      |
|                               |                      |      |                      |                                           |                                                                                                      |
| speech_rate                   | 语速                 | 2    | number               |                                           | 取值范围[-50,100],100代表2.0倍速,-50代表0.5倍数                                                      |
|                               |                      |      |                      |                                           |                                                                                                      |
| source_language               | 源语言               | 2    | string               |                                           | 见下方：**语种说明**                                                                           |
|                               |                      |      |                      |                                           |                                                                                                      |
| target_language               | 目标语言             | 2    | string               |                                           | 见下方：**语种说明**                                                                           |
|                               |                      |      |                      |                                           |                                                                                                      |
| enable_source_language_detect | 返回语种标签         | 2    | bool                 |                                           | 默认值为`false`                                                                                    |
|                               |                      |      |                      |                                           | 开启后，会在`SourceSubtitleEnd` 事件中额外返回原文语种信息。                                       |
|                               |                      |      |                      |                                           | 示例：                                                                                               |
|                               |                      |      |                      |                                           | ```JSON                                                                                              |
|                               |                      |      |                      |                                           | {                                                                                                    |
|                               |                      |      |                      |                                           | "event": 652,                                                                                        |
|                               |                      |      |                      |                                           | "text": "今日天气不错",                                                                              |
|                               |                      |      |                      |                                           | "detected_language": "zh"                                                                            |
|                               |                      |      |                      |                                           | }                                                                                                    |
|                               |                      |      |                      |                                           | ```                                                                                                  |
|                               |                      |      |                      |                                           |                                                                                                      |
|                               |                      |      |                      |                                           |                                                                                                      |
| corpus                        | 语料/干预词等        | 2    | dict                 |                                           | 自定义词典，该object的所有配置字段（热词和术语）加和不超过1000个。超过则会报错。                     |
|                               |                      |      |                      |                                           |                                                                                                      |
| hot_words_list                | 热词列表             | 3    | [string]             |                                           | 原文字幕识别时使用的热词词库,用来指导模型，不一定干预生效（优先级高于传热词表）                      |
|                               |                      |      |                      |                                           | 示例：                                                                                               |
|                               |                      |      |                      |                                           | ```JSON                                                                                              |
|                               |                      |      |                      |                                           | ["视频直播","赛事直播","智能家居"]                                                                   |
|                               |                      |      |                      |                                           | ```                                                                                                  |
|                               |                      |      |                      |                                           |                                                                                                      |
|                               |                      |      |                      |                                           |                                                                                                      |
|                               |                      |      |                      |                                           |                                                                                                      |
| boosting_table_id             | 热词表ID             | 3    | string               |                                           | 自学习平台上设置的热词词表ID                                                                         |
|                               |                      |      |                      |                                           | 热词表功能和设置方法可以参考[文档](https://www.volcengine.com/docs/6561/155739)                       |
|                               |                      |      |                      |                                           |                                                                                                      |
| boosting_table_name           | 热词表名             | 3    | string               |                                           | 自学习平台上设置的热词词表名称                                                                       |
|                               |                      |      |                      |                                           | 热词表功能和设置方法可以参考[文档](https://www.volcengine.com/docs/6561/155739)                       |
|                               |                      |      |                      |                                           |                                                                                                      |
| correct_words                 | 替换词               | 3    | json string          |                                           | 原文和译文字幕识别时使用的替换词词库，（优先级高于传替换词表）                                       |
|                               |                      |      |                      |                                           | 示例：                                                                                               |
|                               |                      |      |                      |                                           | ```JSON                                                                                              |
|                               |                      |      |                      |                                           | "{\"接受\":\"接收\",\"Accept\":\"Receive\"}"                                                         |
|                               |                      |      |                      |                                           | ```                                                                                                  |
|                               |                      |      |                      |                                           |                                                                                                      |
|                               |                      |      |                      |                                           |                                                                                                      |
| regex_correct_table_id        | 替换词表ID           | 3    | string               |                                           | 自学习平台上设置的替换词词表名称                                                                     |
|                               |                      |      |                      |                                           | 替换词功能和设置方法可以参考[文档](https://www.volcengine.com/docs/6561/1206007)                      |
|                               |                      |      |                      |                                           |                                                                                                      |
| regex_correct_table_name      | 替换词表名           | 3    | string               |                                           | 自学习平台上设置的替换词词表ID                                                                       |
|                               |                      |      |                      |                                           | 替换词功能和设置方法可以参考[文档](https://www.volcengine.com/docs/6561/1206007)                      |
|                               |                      |      |                      |                                           |                                                                                                      |
| glossary_list                 | 术语列表             | 3    | dict{string: string} |                                           | 原文翻译成译文时使用的术语词词库，用来指导模型，不一定干预生效（优先级高于传术语词表）               |
|                               |                      |      |                      |                                           | 示例:                                                                                                |
|                               |                      |      |                      |                                           | ```JSON                                                                                              |
|                               |                      |      |                      |                                           | {"人工智能":"Machine Learning"}                                                                      |
|                               |                      |      |                      |                                           | ```                                                                                                  |
|                               |                      |      |                      |                                           |                                                                                                      |
|                               |                      |      |                      |                                           |                                                                                                      |
| glossary_table_id             | 术语词表ID           | 3    | string               |                                           | 自学习平台上设置的术语词词表ID                                                                       |
|                               |                      |      |                      |                                           |                                                                                                      |
| glossary_table_name           | 术语词表名           | 3    | string               |                                           | 自学习平台上设置的术语词词表名称                                                                     |
|                               |                      |      |                      |                                           |                                                                                                      |
| source_audio                  | 源音频相关配置       | 1    | dict                 | ✓                                        | 源音频信息                                                                                           |
|                               |                      |      |                      |                                           |                                                                                                      |
| format                        | 音频容器格式         | 2    | string               | ✓                                        | wav，仅支持wav                                                                                       |
|                               |                      |      |                      |                                           |                                                                                                      |
| codec                         | 音频编码格式         | 2    | string               |                                           | raw， raw(表示pcm编码) 。 仅支持raw                                                                  |
|                               |                      |      |                      |                                           |                                                                                                      |
| rate                          | 音频采样率           | 2    | int                  |                                           | 必须是16000                                                                                          |
|                               |                      |      |                      |                                           |                                                                                                      |
| bits                          | 音频采样点位数       | 2    | int                  |                                           | 必须是16                                                                                             |
|                               |                      |      |                      |                                           |                                                                                                      |
| channel                       | 音频声道数           | 2    | int                  |                                           | 1(mono) / 2(stereo)，当前仅支持单声道，必须传1                                                       |
|                               |                      |      |                      |                                           |                                                                                                      |
| target_audio                  | 目标音频相关配置     | 1    | dict                 | s2s时必填，s2t时非必填                    | 目标音频信息                                                                                         |
|                               |                      |      |                      |                                           |                                                                                                      |
| format                        | 音频容器格式         | 2    | string               | s2s时必填，s2t时非必填                    | pcm/ogg_opus                                                                                         |
|                               |                      |      |                      |                                           |                                                                                                      |
| rate                          | 音频采样率           | 2    | int                  | s2s时必填，s2t时非必填                    | 默认为 24000。支持16000/24000                                                                        |
|                               |                      |      |                      |                                           | **注：**                                                                                       |
|                               |                      |      |                      |                                           | pcm 格式：16000Hz 采样率下默认 16 位整型（16bit），24000Hz 采样率下默认 32 位浮点型（32float）。     |
|                               |                      |      |                      |                                           | ogg_opus 格式：默认32 位浮点型（32float）且输出的采样率固定为48000，rate配置无法更改该格式的采样率； |

参数示例：

> Request中的`request_meta.session_id`为必填字段，不可缺省

```JSON
{
  "request_meta": {
      "session_id": "xxxxxxxx-xxxxxxxxxx-xxxxxxx-xxxxxxxxxx"
  }
  "event": event.Type_StartSession,
  "user": {
    "uid": "388808088185088",
    "did": "xxxxxx"
  },
  "source_audio": {
    "format": "wav",
    "rate": 16000,
    "bits": 16,
    "channel": 1,
  },
  "target_audio": {
    "format": "pcm",
    "rate": 48000
  },
  "request": {
    "mode": "s2s",
    "speaker_id": "zh_female_vv_uranus_bigtts", //可选，不传或者传错则使用默认行为（复刻输入音频音色）
    "speech_rate": 0,
    "source_language": "zh",
    "target_language": "en",
    "corpus": {
      "hot_words_list": ["xxxxx","xxxxx"],//(优先级最高)
      "boosting_table_id":"", //热词表id(优先级其次)
      "boosting_table_name":"", //热词表名(优先级最后)
      "correct_words":"{\"xxx\":\"xxx\",\"xxx\":\"xxx\"}", //正则替换词json格式的map字符串(优先级最高)
      "regex_correct_table_id":"", //正则替换词表id(优先级其次)
      "regex_correct_table_name":"", //正则替换词表名(优先级最后)
      "glossary_list": {
          "xxxxx": "yyy",
          "zzzzz": "www",
      },//(优先级最高)
      "glossary_table_id":"",//术语词表id(优先级其次)
      "glossary_table_name":"",//术语词表名(优先级最后)
    }
  }
}
```

**语种说明**

* 语种集

  | | | | \

  | 语种集  | 语种数 | 语种清单                                                                                                                                                     |
  | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  |         |        |                                                                                                                                                              |
  | lang_8  | 8      | 中文、英文、德语、法语、西班牙语、印尼语、日语、葡萄牙语                                                                                                     |
  |         |        |                                                                                                                                                              |
  | lang_20 | 20     | 中文、英文、德语、法语、西班牙语、印尼语、日语、葡萄牙语、韩语、土耳其语、马来语、荷兰语、罗马尼亚语、波兰语、捷克语、阿拉伯语、泰语、越南语、俄语、意大利语 |
  |         |        |                                                                                                                                                              |
  | 方言    | 2      | 粤语（yue-CN）、上海话（sh-CN）                                                                                                                              |
* 模式与语种匹配/约束关系

  | | | | \

  | 输入/输出模式                              | 语种设置特性及约束                      | 支持语种                |
  | ------------------------------------------ | --------------------------------------- | ----------------------- |
  |                                            |                                         |                         |
  | **语音到文本（S2T）**                | \                                       |                         |
  |                                            | * 源语种和目标语种必须指定              | \                       |
  |                                            | * 源语种**或** 目标语种必须是中英 | \                       |
  |                                            | * 支持中英反转互译（zhen）              | \                       |
  |                                            |                                         | \                       |
  |                                            |                                         | * 源语种：lang_20、方言 |
  |                                            |                                         | * 目标语种：lang_20     |
  |                                            |                                         |                         |
  | **语音到语音（S2S）- 指定音色模式**  | \                                       |                         |
  | > 传入 speaker_id，支持 2 个公版音色       | \                                       |                         |
  |                                            | \                                       |                         |
  | > * zh_female_vv_uranus_bigtts             | \                                       |                         |
  | > * zh_male_jingqiangkanye_emo_mars_bigtts | \                                       |                         |
  |                                            | \                                       |                         |
  |                                            | * 源语种和目标语种必须指定              | \                       |
  |                                            | * 目标语种必须为中英                    | \                       |
  |                                            | * 支持中英反转互译（zhen）              | \                       |
  |                                            |                                         | \                       |
  |                                            |                                         | * 源语种：lang_20、方言 |
  |                                            |                                         | * 目标语种：中英        |
  |                                            |                                         |                         |
  | **语音到语音（S2S）- 声音复刻模式**  | \                                       |                         |
  | > 不传 speaker_id，自动复刻说话人声音      | \                                       |                         |
  |                                            | \                                       |                         |
  |                                            | * 源语种和目标语种必须指定              | \                       |
  |                                            | * 源语种**或** 目标语种必须是中英 | \                       |
  |                                            | * 支持中英反转互译（zhen）              | * 源语种：lang_8        |
  |                                            |                                         | * 目标语种：lang_8      |
  |                                            |                                         |                         |
  |                                            |                                         |                         |
* 语种代号及说明

  | | | | \

  | 语言         | 参数值     | 说明                                                         |
  | ------------ | ---------- | ------------------------------------------------------------ |
  |              |            |                                                              |
  | 中文         | `zh`     | 中英语种之一                                                 |
  |              |            |                                                              |
  | 英文         | `en`     | 中英语种之一                                                 |
  |              |            |                                                              |
  | 德语         | `de`     |                                                              |
  |              |            |                                                              |
  | 法语         | `fr`     |                                                              |
  |              |            |                                                              |
  | 西班牙语     | `es`     |                                                              |
  |              |            |                                                              |
  | 印尼语       | `id`     |                                                              |
  |              |            |                                                              |
  | 日语         | `ja`     |                                                              |
  |              |            |                                                              |
  | 葡萄牙语     | `pt`     |                                                              |
  |              |            |                                                              |
  | 韩语         | `ko`     |                                                              |
  |              |            |                                                              |
  | 土耳其语     | `tr`     |                                                              |
  |              |            |                                                              |
  | 马来语       | `ms`     |                                                              |
  |              |            |                                                              |
  | 荷兰语       | `nl`     |                                                              |
  |              |            |                                                              |
  | 罗马尼亚语   | `ro`     |                                                              |
  |              |            |                                                              |
  | 波兰语       | `pl`     |                                                              |
  |              |            |                                                              |
  | 捷克语       | `cs`     |                                                              |
  |              |            |                                                              |
  | 阿拉伯语     | `ar`     |                                                              |
  |              |            |                                                              |
  | 泰语         | `th`     |                                                              |
  |              |            |                                                              |
  | 越南语       | `vi`     |                                                              |
  |              |            |                                                              |
  | 俄语         | `ru`     |                                                              |
  |              |            |                                                              |
  | 意大利语     | `it`     |                                                              |
  |              |            |                                                              |
  | 粤语         | `yue-CN` | 方言，仅支持作为源语种                                       |
  |              |            |                                                              |
  | 上海话       | `sh-CN`  | 方言，仅支持作为源语种                                       |
  |              |            |                                                              |
  | 中英反转互译 | `zhen`   | `source_language` 和 `target_language` 需同时传 `zhen` |
  |              |            | > 示例：`你好，everyone` 翻译为 `Hello，大家`            |
* 使用方式

  * `source_language` 和 `target_language` 均传上表中的参数值，例如中文传 `zh`，英文传 `en`。
  * `mode=s2t` 时返回文本结果，按“语音到文本（S2T）”的语种约束传参。
  * `mode=s2s` 且传入支持的 `speaker_id` 时，按“语音到语音（S2S）- 指定音色模式”的语种约束传参。
  * `mode=s2s` 且不传或传入不支持的 `speaker_id` 时，按“语音到语音（S2S）- 声音复刻模式”的语种约束传参。

<span id="8075ce8e"></span>

#### 发送音频数据-TaskRequest

Client 发送 建连请求后，再发送包含音频数据的 TaskRequest。音频应采用建立连接request 中指定的格式（音频格式、编解码器、采样率、声道）。二进制数据放在protobuf 的request体内部
例如在流式语音识别中如果每次发送 100ms 的音频数据，那么data中的 内容 就是 100ms 的音频数据。
**注意：需要等到收到服务端响应的SessionStarted后再发参数包及音频包**

* 具体的参数字段见下表：

| | | | | | | \

| 字段         | 说明           | 层级 | 格式         | 是否必填 | 备注                                                             |
| ------------ | -------------- | ---- | ------------ | -------- | ---------------------------------------------------------------- |
|              |                |      |              |          |                                                                  |
| event        | 请求事件说明   | 1    | enum (int32) | ✓       | 发送音频数据的的event 为200，见上文Event 字段描述                |
|              |                |      |              |          |                                                                  |
| source_audio | 源音频相关配置 | 1    | dict         | ✓       | 源音频信息                                                       |
|              |                |      |              |          |                                                                  |
| data         | 音频数据       | 2    | bytes        | ✓       | 音频流的二进制数据, 要求16khz,16bit,单通道wav/pcm, 建议80ms 一包 |

参数示例：

```JSON
{
  "event": event.Type_TaskRequest,
  "source_audio": {
    "data": "ff\xa2\xfe*\xfeB\xfe\xa3\xfe\x9c\xff\xe2\x0"
  }
}
```

<span id="9caf1d45"></span>

#### 更新参数-ConfigUpdate

用于在session中更新语料/干预词等
参数示例：

```JSON
{
  "event": event.Type_UpdateConfig,
  "request": {
    "mode": "s2s",     // 注意：当前不支持在会话中切换语言及mode，如需切换，请重新建立连接
    "corpus": {    // 用于在中间包修改热词和术语列表
      "hot_words_list": ["xxxxx","xxxxx"],//(优先级最高)
      "boosting_table_id":"", //热词表id(优先级其次)
      "boosting_table_name":"", //热词表名(优先级最后)
      "correct_words":"{\"xxx\":\"xxx\",\"xxx\":\"xxx\"}", //正则替换词json格式的map字符串(优先级最高)
      "regex_correct_table_id":"", //正则替换词表id(优先级其次)
      "regex_correct_table_name":"", //正则替换词表名(优先级最后)
      "glossary_list": {
          "xxxxx": "yyy",
          "zzzzz": "www",
      },//(优先级最高)
      "glossary_table_id":"",//术语词表id(优先级其次)
      "glossary_table_name":"",//术语词表名(优先级最后)
    }
  }
}
```

<span id="855a0b70"></span>

#### 结束session-FinishSession

单独的结束事件，不带音频，在要发送的音频全部发送完毕后发送
参数示例：

```JSON
{
  "event": event.FinishSession
}
```

<span id="42dc830a"></span>

### 服务端

Client 发送请求，服务端都会返回response。格式具体见protobuf定义，具体关键字段说明如下：

| | | | | | | \

| 字段              | 说明                       | 层级 | 格式   | 是否必填 | 备注                                                                                                                                               |
| ----------------- | -------------------------- | ---- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
|                   |                            |      |        |          |                                                                                                                                                    |
| response_meta     | 响应元信息                 | 1    | dict   |          |                                                                                                                                                    |
|                   |                            |      |        |          |                                                                                                                                                    |
| status_code       | 错误码                     | 2    | int    |          |                                                                                                                                                    |
|                   |                            |      |        |          |                                                                                                                                                    |
| message           | 错误信息                   | 2    | string |          |                                                                                                                                                    |
|                   |                            |      |        |          |                                                                                                                                                    |
| billing           | 计量计费信息               | 2    | dict   |          | 仅计量计费-UsageResponse event返回此字段                                                                                                           |
|                   |                            |      |        |          |                                                                                                                                                    |
| duration_msec     | 音频的持续时长             | 3    | int    |          | 单位：毫秒                                                                                                                                         |
|                   |                            |      |        |          |                                                                                                                                                    |
| items             | 计量计费详情               | 3    | array  |          |                                                                                                                                                    |
|                   |                            |      |        |          |                                                                                                                                                    |
| unit              | token分类                  | 4    | string |          | 取值为：                                                                                                                                           |
|                   |                            |      |        |          | output_text_tokens                                                                                                                                 |
|                   |                            |      |        |          | output_audio_tokens                                                                                                                                |
|                   |                            |      |        |          | input_audio_tokens                                                                                                                                 |
|                   |                            |      |        |          |                                                                                                                                                    |
| quantity          | 消耗token量                | 4    | float  |          |                                                                                                                                                    |
|                   |                            |      |        |          |                                                                                                                                                    |
| event             | 响应事件                   | 1    | int    |          | 响应事件标志，例如建联成功（SessionStarted   取值为150）                                                                                           |
|                   |                            |      |        |          |                                                                                                                                                    |
| text              | 整个音频的识别结果文本     | 1    | string |          | 原文或者译文                                                                                                                                       |
|                   |                            |      |        |          |                                                                                                                                                    |
| data              | 响应数据                   | 1    | raw    |          | 响应的二进制数据                                                                                                                                   |
|                   |                            |      |        |          |                                                                                                                                                    |
| start_time        | 起始时间（毫秒）           | 1    | int    |          | 仅当识别成功时填写                                                                                                                                 |
|                   |                            |      |        |          |                                                                                                                                                    |
| end_time          | 结束时间（毫秒）           | 1    | int    |          | 仅当识别成功时填写                                                                                                                                 |
|                   |                            |      |        |          |                                                                                                                                                    |
| spk_chg           | 说话人是否发生了切换的标志 | 1    | bool   |          | 默认为false，在检测到说话人发生切换的那个句子的**SourceSubtitleStart**和**TranslationSubtitleStart**响应的响应体里会把此参数设置为true |
|                   |                            |      |        |          |                                                                                                                                                    |
| muted_duration_ms | 静音时间                   |      | int    |          | 单位ms, 表示静音了多久，存在误差，不是精确值                                                                                                       |

<span id="698bfd2a"></span>

#### 接收到建联成功-SessionStarted

响应示例：

```Plain
{
  "event": event.Type_SessionStarted
}
```

<span id="6d24f760"></span>

#### 原文开始-SourceSubtitleStart

标记原文开始发送，包含开始时间戳(startTime), 说话人切换信号(如开启相关功能)

```JSON
{
  "event": event.Type_SourceSubtitleStart,
  "start_time": xxx,
  "spk_chg": false    //默认为false，如果检测到此句说话人发生切换，那么为true
}
```

<span id="b0fe6f14"></span>

#### 原文数据-SourceSubtitleResponse

发送音频，要求16khz,16bit,单通道wav/pcm, 建议80ms一包

```JSON
{
  "event": event.Type_SourceSubtitleResponse,
  "text": "xxx"   //原文文本
}
```

<span id="8f0fe9eb"></span>

#### 原文结束-SourceSubtitleEnd

```JSON
{
  "event": event.Type_SourceSubtitleEnd,
  "start_time": xxx,
  "end_time": xxx,
  "text": "xxx"
}
```

<span id="9caccdf1"></span>

#### 译文开始-TranslationSubtitleStart

```JSON
{
  "event": event.Type_TranslationSubtitleStart,
  "start_time": xxx,
  "spk_chg": false    //默认为false，如果检测到此句说话人发生切换，那么为true
}
```

<span id="28ef6615"></span>

#### 译文数据-TranslationSubtitleResponse

```JSON
{
  "event": event.Type_TranslationSubtitleResponse,
  "text": "xxx"
}
```

<span id="6974090b"></span>

#### 译文结束-TranslationSubtitleEnd

```JSON
{
  "event": event.Type_TranslationSubtitleEnd,
  "start_time": xxx,
  "end_time": xxx,
  "text": "xxx"
}
```

<span id="40ae81e3"></span>

#### TTS开始-TTSSentenceStart

```JSON
{
  "event": event.Type_TTSSentenceStart,
  "start_time": xxx
}
```

<span id="785aff28"></span>

#### TTS数据-TTSResponse

音频数据：data (音频数据，按设置的target_audio格式返回)，

```JSON
{
  "event": event.Type_TTSResponse,
  "data": "xxx"
}
```

<span id="497a1bd5"></span>

#### TTS结束-TTSSentenceEnd

```JSON
{
  "event": event.Type_TTSSentenceEnd,
  "data": "xxx",
  "start_time": xxx,
  "end_time": xxx
}
```

<span id="9f9aefe8"></span>

#### 计量计费-UsageResponse

```JSON
{
  "event": event.Type_UsageResponse,
  "responseMeta": {
    "session_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "status_code": 20000000,             // 成功的状态码
    "message": "OK",
    "billing": {                         // 计费详情
      "items": [
        {
          "unit": "output_text_tokens",  //  API调用token, 文本输出
          "quantity": 15.0               // 消耗的token量
        },
        {
          "unit": "output_audio_tokens",  // API调用token, 音频输出
          "quantity": 11.0                // 消耗的token量
        },
        {
          "unit": "input_audio_tokens",  // API调用token，音频输入
          "quantity": 4.0                // 消耗的token量
        }
      ],
      "duration_msec": 640            // 音频的持续时间,单位：毫秒
    }
  }
}
```

<span id="7d50d229"></span>

#### 会话正常结束-SessionFinished

```JSON
{
  "event": event.Type_SessionFinished
}
```

<span id="89c134ee"></span>

#### 会话失败-SessionFailed

```JSON
{
  "event": event.Type_SessionFailed
}
```

<span id="69d5a278"></span>

#### 返回AudioMuted

vad检测到静音时会响应静音事件，第一次响应为静音2s后，之后每静音约1s返回一次wen

```JSON

{
  "event": event.Type_Type_AudioMuted,
  "muted_duration_ms": xxx //单位ms, 表示静音了多久，存在误差，不是精确值
}
```

<span id="d55c0f61"></span>

### Error message from server

当 server 发现无法解决的二进制/传输协议问题时，将发送 Error message from server 消息（例如，client 以 server 不支持的序列化格式发送消息）。格式见前文response_meta字段：
<span id="4fa43ff9"></span>

## 错误码

| | | | \

| 错误码   | 含义             | 说明                                           |
| -------- | ---------------- | ---------------------------------------------- |
|          |                  |                                                |
| 20000000 | 成功             |                                                |
|          |                  |                                                |
| 45000001 | 请求参数无效     | 请求参数缺失必需字段 / 字段值无效 / 重复请求。 |
|          |                  |                                                |
| 45000002 | 空音频           |                                                |
|          |                  |                                                |
| 45000081 | 等包超时         |                                                |
|          |                  |                                                |
| 45000151 | 音频格式不正确   |                                                |
|          |                  |                                                |
| 550xxxxx | 服务内部处理错误 |                                                |
|          |                  |                                                |
| 55000031 | 服务器繁忙       | 服务过载，无法处理当前请求。                   |
