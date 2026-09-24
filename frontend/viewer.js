/**
 * 同声传译实时翻译系统 - 查看端应用
 */

class ViewerApp {
    constructor() {
        // WebSocket 连接
        this.ws = null;
        // 自动检测 WebSocket URL（支持 iPad 访问）
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsHost = window.location.hostname || 'localhost';
        const wsPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
        // WebSocket 路径为 /ws，角色为 viewer；房间 ID 从 URL 读取（控制端分享的链接）
        const roomParam = new URLSearchParams(window.location.search).get('room') || '';
        this.roomId = roomParam.trim().toUpperCase();
        this.shareToken = new URLSearchParams(window.location.search).get('share') || '';
        this.minutesPoll = null;
        this.wsUrl = `${wsProtocol}//${wsHost}:${wsPort}/ws?role=viewer` +
                     (this.roomId ? `&room=${encodeURIComponent(this.roomId)}` : '');
        
        // TTS 播放
        this.ttsAudioContext = null;
        this.opusDecoder = null;
        this.ttsAudioQueue = [];
        this.isPlayingTTS = false;
        this.currentTTSAudio = null;
        this.ttsAudioBuffer = [];
        this.ttsPlayTimeout = null;
        this.maxTTSQueueSize = 10;
        this.ttsEnabled = false; // 默认关闭音频播放
        this.pendingAudioQueue = []; // 等待用户交互的音频队列
        this.audioUnlocked = false; // 音频是否已解锁（通过播放静音媒体）
        this.unlockAudioElement = null; // 用于解锁音频的静音媒体元素
        this.useWebAudioAPI = false; // 是否使用 Web Audio API 播放（移动端推荐）
        
        // iOS 检测
        this.isIOS = /iphone|ipad|ipod/i.test((navigator.userAgent || '').toLowerCase());
        // 移动设备检测（包括Android）
        this.isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
            (navigator.userAgent || navigator.vendor || window.opera || '').toLowerCase()
        );
        // Safari 检测（含 macOS/iOS Safari；不含 Chrome/Edge 等 Chromium 系浏览器）。
        // Safari 不支持 OGG/Opus 的 HTML5 Audio 播放，需走 opus-decoder 软解码 + Web Audio
        this.isSafari = /safari/i.test(navigator.userAgent || '') &&
                        !/chrome|chromium|crios|edg|android/i.test(navigator.userAgent || '');
        this.hasUserInteracted = false;
        this.fatalError = false;  // 致命错误（房间不存在/已结束），停止自动重连

        // UI 元素
        this.connectionStatusEl = document.getElementById('connectionStatus');
        this.sourceTextEl = document.getElementById('sourceText');
        this.targetTextEl = document.getElementById('targetText');
        this.ttsPlaybackToggle = document.getElementById('ttsPlayback');
        this.sourceFullscreenBtn = document.getElementById('sourceFullscreenBtn');
        this.targetFullscreenBtn = document.getElementById('targetFullscreenBtn');
        this.pageFullscreenBtn = document.getElementById('pageFullscreenBtn');

        // 字体大小调节（Viewer）
        this.fontSizeSliderEl = document.getElementById('viewerFontSize');
        this.fontSizeValueEl = document.getElementById('viewerFontSizeValue');
        this.fontSizeStorageKey = 'viewer_font_size_percent';
        this.defaultFontSizePercent = 100;
        
        // 翻译状态
        this.isTranslationActive = false;
        
        // 敏感词过滤（前端双重保障）
        this.enableTextFilter = true;
        this.sensitiveWords = [];  // 敏感词列表，可以从配置加载
        this.filterReplacement = "***";
        
        // 全屏状态
        this.isSourceFullscreen = false;
        this.isTargetFullscreen = false;
        this.isPageFullscreen = false;
        
        // 流式文本累积
        this.currentSourceSentence = '';
        this.currentTargetSentence = '';
        this.completedSourceLines = [];
        this.completedTargetLines = [];
        this.maxHistoryLines = 8;
        
        // 更新状态标志（用于 requestAnimationFrame 优化）
        this._sourceUpdatePending = false;
        this._targetUpdatePending = false;
        
        // 绑定事件
        this.initFontSizeControl();

        if (this.ttsPlaybackToggle) {
            this.ttsPlaybackToggle.addEventListener('change', async (e) => {
                this.ttsEnabled = e.target.checked;
                console.log('TTS 播放开关:', this.ttsEnabled ? '开启' : '关闭');
                
                // 同步订阅状态到服务端：只有订阅的查看端才会收到 TTS 音频负载（默认不推，节省带宽）
                this.sendTtsSubscription();
                
                // 当开关打开时立即激活音频上下文和解锁音频（移动端 / Safari 必需，
                // Safari 因不支持 OGG/Opus 的 HTML5 播放，必须走软解码 + Web Audio）
                if (this.ttsEnabled && (this.isMobile || this.isSafari)) {
                    await this.activateAudioContext();
                }
            });
        }
        
        if (this.sourceFullscreenBtn) {
            this.sourceFullscreenBtn.addEventListener('click', () => this.toggleSourceFullscreen());
        }
        
        if (this.targetFullscreenBtn) {
            this.targetFullscreenBtn.addEventListener('click', () => this.toggleTargetFullscreen());
        }
        
        if (this.pageFullscreenBtn) {
            this.pageFullscreenBtn.addEventListener('click', () => this.togglePageFullscreen());
        }
        
        // 初始化
        this.init();
    }

    sendTtsSubscription() {
        /**
         * 向服务端同步 TTS 音频订阅状态。
         * 服务端默认不向查看端广播 TTS 音频负载（节省带宽），
         * 只有显式订阅的查看端才会收到。
         */
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ type: 'set_tts', enabled: !!this.ttsEnabled }));
            } catch (e) {
                console.warn('发送 TTS 订阅状态失败:', e);
            }
        }
    }

    initFontSizeControl() {
        /**
         * Viewer 字体大小调节：100% - 500%
         * 通过设置 main.viewer-layout 的 font-size 百分比实现整体缩放（含 current-text 的 em 也会同步放大）
         */
        const layoutEl = document.querySelector('.viewer-layout');
        if (!layoutEl || !this.fontSizeSliderEl || !this.fontSizeValueEl) {
            return;
        }

        const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

        const applyPercent = (percent) => {
            const p = clamp(Number(percent) || this.defaultFontSizePercent, 100, 500);
            layoutEl.style.fontSize = `${p}%`;
            this.fontSizeSliderEl.value = String(p);
            this.fontSizeValueEl.textContent = `${p}%`;
            try {
                localStorage.setItem(this.fontSizeStorageKey, String(p));
            } catch (_) {
                // 忽略存储失败（如隐私模式）
            }
        };

        // 初始化（读取存储值）
        let saved = null;
        try {
            saved = localStorage.getItem(this.fontSizeStorageKey);
        } catch (_) {
            saved = null;
        }
        applyPercent(saved ?? this.defaultFontSizePercent);

        // 实时更新
        this.fontSizeSliderEl.addEventListener('input', (e) => {
            applyPercent(e.target.value);
        });
    }
    
    async init() {
        // 会后重开同一分享链接时，直接读取持久化纪要，不再尝试加入已回收房间。
        if (this.shareToken) {
            const ended = await this.loadMinutes();
            if (ended) return;
        }
        // 初始化音频解锁机制（移动端必需）
        this.initAudioUnlock();
        
        // iOS Safari 特殊处理：等待页面完全加载后再连接
        if (this.isIOS) {
            // 等待页面完全加载
            if (document.readyState === 'loading') {
                await new Promise(resolve => {
                    if (document.readyState === 'complete') {
                        resolve();
                    } else {
                        window.addEventListener('load', resolve, { once: true });
                    }
                });
            }
            // 额外等待一小段时间，确保iOS Safari完全准备好
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // 初始化 Opus 解码器
        await this.initOpusDecoder();
        
        // 初始化音频解锁机制（移动设备需要）
        this.initAudioUnlock();
        
        // 连接 WebSocket（带重试机制）
        await this.connectWebSocketWithRetry();
        
        // 监听全屏状态变化
        document.addEventListener('fullscreenchange', () => {
            this.handleFullscreenChange();
        });
        document.addEventListener('webkitfullscreenchange', () => {
            this.handleFullscreenChange();
        });
        document.addEventListener('mozfullscreenchange', () => {
            this.handleFullscreenChange();
        });
        document.addEventListener('MSFullscreenChange', () => {
            this.handleFullscreenChange();
        });
        
        // 标记用户已交互（iOS 和 Android 需要）
        // 监听多种用户交互事件以确保音频可以播放
        const markUserInteracted = async () => {
            if (!this.hasUserInteracted) {
                this.hasUserInteracted = true;
                console.log('✓ 用户已交互，音频播放已启用');
                
                // 尝试解锁音频（如果还未解锁）
                if (this.isMobile && !this.audioUnlocked && this.unlockAudioElement) {
                    try {
                        await this.unlockAudioElement.play();
                        this.audioUnlocked = true;
                        console.log('✓ 音频已解锁（用户交互后）');
                        this.unlockAudioElement.pause();
                        this.unlockAudioElement.currentTime = 0;
                    } catch (error) {
                        console.warn('音频解锁失败:', error);
                    }
                }
                
                // 如果之前有等待播放的音频，现在尝试播放
                if (this.pendingAudioQueue && this.pendingAudioQueue.length > 0) {
                    console.log(`尝试播放 ${this.pendingAudioQueue.length} 个等待中的音频`);
                    const pendingAudios = [...this.pendingAudioQueue];
                    this.pendingAudioQueue = [];
                    pendingAudios.forEach(audioData => {
                        this.playOggOpusAudio(audioData).catch(err => {
                            console.error('播放等待中的音频失败:', err);
                        });
                    });
                }
            }
        };
        
        // 监听多种用户交互事件
        document.addEventListener('click', markUserInteracted, { once: true });
        document.addEventListener('touchstart', markUserInteracted, { once: true });
        document.addEventListener('touchend', markUserInteracted, { once: true });
        
        // 如果用户点击了TTS开关，也标记为已交互
        if (this.ttsPlaybackToggle) {
            this.ttsPlaybackToggle.addEventListener('change', markUserInteracted, { once: true });
        }
    }
    
    handleFullscreenChange() {
        /**
         * 处理浏览器原生全屏状态变化
         */
        const isFullscreen = document.fullscreenElement || 
                            document.webkitFullscreenElement || 
                            document.mozFullScreenElement || 
                            document.msFullscreenElement;
        
        if (!isFullscreen) {
            // 已退出浏览器原生全屏
            this.isSourceFullscreen = false;
            this.isTargetFullscreen = false;
            this.isPageFullscreen = false;
        } else {
            // 已进入浏览器原生全屏
            const sourceSection = document.getElementById('sourceTextSection');
            const targetSection = document.getElementById('targetTextSection');
            
            if (isFullscreen === sourceSection) {
                this.isSourceFullscreen = true;
            } else if (isFullscreen === targetSection) {
                this.isTargetFullscreen = true;
            } else if (isFullscreen === document.documentElement) {
                this.isPageFullscreen = true;
            }
        }
        
        // 更新按钮图标
        this.updateFullscreenButtonIcon('source', this.isSourceFullscreen);
        this.updateFullscreenButtonIcon('target', this.isTargetFullscreen);
        this.updatePageFullscreenButtonIcon(this.isPageFullscreen);
    }
    
    async initOpusDecoder() {
        // 等待 Opus 解码器库加载
        console.log('开始初始化 Opus 解码器...');
        let retries = 0;
        const maxRetries = 100;
        
        const waitForEvent = new Promise((resolve) => {
            if (window.OpusDecoderReady) {
                resolve(true);
                return;
            }
            window.addEventListener('opusDecoderReady', () => resolve(true), { once: true });
            setTimeout(() => resolve(false), 10000);
        });
        
        await waitForEvent;
        
        while (retries < maxRetries) {
            if (typeof OpusDecoder !== 'undefined' && window.OpusDecoderReady) {
                try {
                    if (typeof OpusDecoder === 'function') {
                        this.opusDecoder = new OpusDecoder({
                            sampleRate: 24000,
                            channels: 1,
                            useWorker: false
                        });
                        console.log('✓ OpusDecoder 实例创建成功');
                        return;
                    }
                } catch (error) {
                    console.error('❌ 初始化 Opus 解码器失败:', error);
                    break;
                }
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            retries++;
        }
        
        if (!this.opusDecoder) {
            console.warn('⚠️ Opus 解码器库未加载');
        }
    }
    
    async activateAudioContext() {
        /**
         * 激活音频上下文（移动端 / Safari 必需）
         * 在用户打开开关时立即激活，确保音频可以播放
         */
        if (!this.isMobile && !this.isSafari) {
            return;
        }
        
        try {
            // 1. 标记用户已交互
            this.hasUserInteracted = true;
            console.log('✓ 用户已交互（开关打开）');
            
            // 2. 尝试解锁音频
            if (!this.audioUnlocked && this.unlockAudioElement) {
                try {
                    await this.unlockAudioElement.play();
                    this.audioUnlocked = true;
                    console.log('✓ 音频已解锁（开关打开后）');
                    this.unlockAudioElement.pause();
                    this.unlockAudioElement.currentTime = 0;
                } catch (error) {
                    console.warn('⚠️ 音频解锁失败:', error);
                }
            }
            
            // 3. 初始化 Web Audio API（如果支持）
            if (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined') {
                if (!this.ttsAudioContext) {
                    const AudioContextClass = AudioContext || webkitAudioContext;
                    this.ttsAudioContext = new AudioContextClass();
                    // 尝试恢复上下文（某些浏览器需要）
                    if (this.ttsAudioContext.state === 'suspended') {
                        await this.ttsAudioContext.resume();
                    }
                    this.useWebAudioAPI = true;
                    console.log('✓ Web Audio API 已激活，将使用解码后的 PCM 数据播放');
                }
            }
            
            // 4. 播放等待队列中的音频
            if (this.pendingAudioQueue && this.pendingAudioQueue.length > 0) {
                console.log(`尝试播放 ${this.pendingAudioQueue.length} 个等待中的音频`);
                const pendingAudios = [...this.pendingAudioQueue];
                this.pendingAudioQueue = [];
                for (const audioData of pendingAudios) {
                    try {
                        await this.playOggOpusAudio(audioData);
                    } catch (err) {
                        console.error('播放等待中的音频失败:', err);
                    }
                }
            }
        } catch (error) {
            console.error('激活音频上下文失败:', error);
        }
    }
    
    initAudioUnlock() {
        /**
         * 初始化音频解锁机制
         * 在移动设备上，通过播放一个静音的音频元素来"解锁"音频播放能力
         * 这可以绕过浏览器的自动播放限制
         */
        if (!this.isMobile) {
            // 非移动设备不需要
            this.audioUnlocked = true;
            return;
        }
        
        try {
            // 创建一个静音的音频元素用于解锁
            // 使用 data URI 创建一个极短的静音音频（1秒的静音）
            // 格式：WAV 格式的静音音频（44.1kHz, 16bit, 单声道）
            const silentAudioDataUri = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==';
            
            this.unlockAudioElement = new Audio(silentAudioDataUri);
            this.unlockAudioElement.volume = 0; // 静音
            this.unlockAudioElement.preload = 'auto';
            
            // 尝试播放静音音频来解锁
            const unlockPromise = this.unlockAudioElement.play().then(() => {
                this.audioUnlocked = true;
                console.log('✓ 音频已解锁（通过静音媒体播放）');
                // 立即暂停，因为我们只需要"解锁"，不需要播放
                this.unlockAudioElement.pause();
                this.unlockAudioElement.currentTime = 0;
            }).catch(error => {
                console.warn('⚠️ 音频解锁失败（需要用户交互）:', error);
                this.audioUnlocked = false;
            });
            
            // 如果用户交互后，再次尝试解锁
            const tryUnlockOnInteraction = () => {
                if (!this.audioUnlocked) {
                    this.unlockAudioElement.play().then(() => {
                        this.audioUnlocked = true;
                        console.log('✓ 音频已解锁（用户交互后）');
                        this.unlockAudioElement.pause();
                        this.unlockAudioElement.currentTime = 0;
                    }).catch(err => {
                        console.warn('音频解锁仍然失败:', err);
                    });
                }
            };
            
            // 监听用户交互事件
            document.addEventListener('click', tryUnlockOnInteraction, { once: true });
            document.addEventListener('touchstart', tryUnlockOnInteraction, { once: true });
            
        } catch (error) {
            console.error('初始化音频解锁失败:', error);
            this.audioUnlocked = false;
        }
    }
    
    async connectWebSocketWithRetry(maxRetries = 3, retryDelay = 1000) {
        /**
         * 带重试机制的 WebSocket 连接
         * iOS Safari 可能需要多次尝试才能成功连接
         */
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`正在连接 WebSocket (尝试 ${attempt}/${maxRetries}):`, this.wsUrl);
                await this.connectWebSocket();
                return; // 连接成功，退出
            } catch (error) {
                console.warn(`WebSocket 连接失败 (尝试 ${attempt}/${maxRetries}):`, error);
                if (attempt < maxRetries) {
                    // 等待后重试
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // 最后一次尝试失败，更新状态
                    this.updateConnectionStatus('Connection Failed', false);
                    // 仍然尝试自动重连
                    setTimeout(() => {
                        if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
                            console.log('尝试自动重新连接...');
                            this.connectWebSocketWithRetry(maxRetries, retryDelay);
                        }
                    }, 3000);
                }
            }
        }
    }
    
    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            try {
                console.log('正在连接 WebSocket:', this.wsUrl);
                this.ws = new WebSocket(this.wsUrl);
                
                // 设置超时（iOS Safari 可能需要更长时间）
                const timeout = setTimeout(() => {
                    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                        console.warn('WebSocket 连接超时');
                        this.ws.close();
                        reject(new Error('WebSocket connection timeout'));
                    }
                }, this.isIOS ? 10000 : 5000); // iOS 给更长的超时时间
                
                this.ws.onopen = () => {
                    clearTimeout(timeout);
                    console.log('✓ WebSocket 连接已建立');
                    this.updateConnectionStatus('Connected', true);
                    
                    // 重连后服务端是新连接，若当前开着 TTS 开关需重新订阅音频推送
                    if (this.ttsEnabled) {
                        this.sendTtsSubscription();
                    }
                    
                    // iOS Safari 特殊处理：连接建立后等待一小段时间，确保连接稳定
                    if (this.isIOS) {
                        // 延迟一小段时间再 resolve，确保连接完全稳定
                        setTimeout(() => {
                            resolve();
                        }, 100); // 延迟 100ms
                    } else {
                        resolve();
                    }
                };
                
                this.ws.onmessage = (event) => {
                    this.handleWebSocketMessage(event);
                };
                
                this.ws.onerror = (error) => {
                    clearTimeout(timeout);
                    console.error('WebSocket 错误:', error);
                    this.updateConnectionStatus('Connection Error', false);
                    reject(error);
                };
                
                this.ws.onclose = (event) => {
                    clearTimeout(timeout);
                    console.log('WebSocket 连接已关闭', event.code, event.reason);
                    this.updateConnectionStatus('Disconnected', false);
                    // 尝试重连（仅在非正常关闭且无致命错误时）
                    if (event.code !== 1000 && !this.fatalError) { // 1000 是正常关闭
                        setTimeout(() => {
                            if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
                                console.log('尝试重新连接...');
                                this.connectWebSocketWithRetry(3, 2000);
                            }
                        }, 3000);
                    }
                };
            } catch (error) {
                console.error('创建 WebSocket 连接时出错:', error);
                this.updateConnectionStatus('Connection Failed', false);
                reject(error);
            }
        });
    }
    
    updateConnectionStatus(status, connected) {
        if (this.connectionStatusEl) {
            this.connectionStatusEl.textContent = status;
            if (connected) {
                this.connectionStatusEl.classList.add('connected');
            } else {
                this.connectionStatusEl.classList.remove('connected');
            }
        }
    }
    
    handleWebSocketMessage(event) {
        try {
            const message = JSON.parse(event.data);
            console.log('📨 收到 WebSocket 消息:', message.type);
            
            switch (message.type) {
                case 'connected':
                    console.log('✓ 已连接到查看端服务');
                    this.isTranslationActive = true;
                    this.updateConnectionStatus('Connected', true);
                    break;
                    
                case 'state_sync':
                    // 状态同步
                    console.log('收到状态同步');
                    // 状态同步的数据已经在后端过滤，这里不需要再次过滤
                    this.handleStateSync(message);
                    // 检查是否有内容，如果有内容则说明翻译正在进行
                    this.isTranslationActive = (
                        (message.source_text && message.source_text.trim()) ||
                        (message.target_text && message.target_text.trim()) ||
                        (message.completed_source_lines && message.completed_source_lines.length > 0) ||
                        (message.completed_target_lines && message.completed_target_lines.length > 0)
                    );
                    break;
                    
                case 'translation':
                    // 翻译结果
                    console.log('🌐 收到翻译数据');
                    this.isTranslationActive = true;
                    this.handleTranslationResponse(message.data);
                    break;
                    
                case 'translation_stopped':
                    // 翻译已停止
                    console.log('⏸️ 翻译已停止');
                    this.isTranslationActive = false;
                    this.updateConnectionStatus('Translation Stopped', false);
                    // 清空所有状态：当前句子和历史记录
                    this.currentSourceSentence = '';
                    this.currentTargetSentence = '';
                    this.completedSourceLines = [];
                    this.completedTargetLines = [];
                    this.updateSourceText();
                    this.updateTargetText();
                    if (this.shareToken) this.startMinutesPolling();
                    break;
                    
                case 'auth_error':
                    // 鉴权失败：缺少房间参数/未登录等，提示并停止重连
                    console.error('❌ 鉴权失败:', message.message);
                    this.fatalError = true;
                    this.updateConnectionStatus('Access Denied', false);
                    this.showFatalError(message.message || '无权访问，请从控制端分享的链接进入');
                    break;

                case 'error':
                    console.error('❌ 收到错误:', message.message);
                    this.updateConnectionStatus('Connection Error', false);
                    // 房间不存在等致命错误：停止自动重连，提示重新进入
                    if (message.message && message.message.includes('房间')) {
                        this.fatalError = true;
                        this.updateConnectionStatus('Room Closed', false);
                        this.showFatalError(message.message);
                    }
                    break;

                case 'room_closed':
                    // 本场翻译已结束（房间被服务端回收）
                    console.log('⏹️ 本场已结束');
                    this.fatalError = true;
                    this.isTranslationActive = false;
                    this.updateConnectionStatus('Ended', false);
                    if (this.shareToken) this.startMinutesPolling();
                    else this.showFatalError('本场翻译已结束');
                    break;

                default:
                    console.warn('⚠️ 未知消息类型:', message.type);
            }
        } catch (error) {
            console.error('❌ 处理 WebSocket 消息失败:', error);
        }
    }

    async loadMinutes() {
        if (!this.shareToken) return false;
        const panel = document.getElementById('minutesPanel');
        const status = document.getElementById('minutesStatus');
        const content = document.getElementById('minutesContent');
        try {
            const response = await fetch(`/api/share/${encodeURIComponent(this.shareToken)}`, {cache: 'no-store'});
            if (!response.ok) throw new Error('纪要链接无效或已撤销');
            const data = await response.json();
            const meeting = data.meeting;
            if (!meeting.ended_at) return false;
            panel.hidden = false;
            const pendingText = meeting.status === 'failed' || meeting.status === 'needs_config'
                ? '纪要暂不可用，请联系会议管理员。'
                : '会议已结束，纪要生成或审核中，请稍后查看。';
            status.textContent = meeting.published_at ? `${meeting.title} · 已发布` : pendingText;
            content.textContent = meeting.minutes_text || '';
            if (meeting.published_at && this.minutesPoll) {
                clearInterval(this.minutesPoll);
                this.minutesPoll = null;
            }
            if (!meeting.published_at) this.startMinutesPolling();
            return true;
        } catch (error) {
            panel.hidden = false;
            status.textContent = error.message;
            content.textContent = '';
            return true;
        }
    }

    startMinutesPolling() {
        if (this.minutesPoll) return;
        this.minutesPoll = setInterval(() => this.loadMinutes(), 10000);
        this.loadMinutes();
    }

    showFatalError(message) {
        /** 覆盖层提示（不弹 alert，适合投影场景） */
        let overlay = document.getElementById('fatalOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'fatalOverlay';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(20,20,30,.88);' +
                'display:flex;align-items:center;justify-content:center;z-index:9999;' +
                'color:#fff;font-size:22px;text-align:center;line-height:1.8;padding:24px;';
            document.body.appendChild(overlay);
        }
        overlay.innerHTML = `${message.replace(/</g, '&lt;')}<br>` +
            '<a href="/" style="color:#8ab4ff;font-size:16px;">返回首页</a>';
    }
    
    handleStateSync(message) {
        // 同步当前状态
        if (message.completed_source_lines) {
            this.completedSourceLines = message.completed_source_lines;
        }
        if (message.completed_target_lines) {
            this.completedTargetLines = message.completed_target_lines;
        }
        if (message.source_text) {
            this.currentSourceSentence = message.source_text;
        }
        if (message.target_text) {
            this.currentTargetSentence = message.target_text;
        }
        this.updateSourceText();
        this.updateTargetText();
    }
    
    handleTranslationResponse(data) {
        const event = data.event;
        const text = data.text || '';
        
        const EventType = {
            SourceSubtitleStart: 650,
            SourceSubtitleResponse: 651,
            SourceSubtitleEnd: 652,
            TranslationSubtitleStart: 653,
            TranslationSubtitleResponse: 654,
            TranslationSubtitleEnd: 655,
            TTSSentenceStart: 350,
            TTSSentenceEnd: 351,
            TTSResponse: 352
        };
        
        // 处理原文
        if (event === EventType.SourceSubtitleStart) {
            this.currentSourceSentence = '';
        } else if (event === EventType.SourceSubtitleResponse) {
            if (text) {
                // 前端双重过滤（后端已经过滤，这里是额外保障）
                const filteredText = this.filterSensitiveWords(text);
                this.currentSourceSentence = filteredText;
                this.updateSourceText();
            }
        } else if (event === EventType.SourceSubtitleEnd) {
            if (text) {
                // 过滤后再添加到历史记录
                const filteredText = this.filterSensitiveWords(text);
                this.completedSourceLines.push(filteredText);
                if (this.completedSourceLines.length > this.maxHistoryLines) {
                    this.completedSourceLines.shift();
                }
                this.currentSourceSentence = '';
                this.updateSourceText();
            }
        }
        
        // 处理译文
        if (event === EventType.TranslationSubtitleStart) {
            this.currentTargetSentence = '';
        } else if (event === EventType.TranslationSubtitleResponse) {
            if (text) {
                // 前端双重过滤（后端已经过滤，这里是额外保障）
                const filteredText = this.filterSensitiveWords(text);
                this.currentTargetSentence = filteredText;
                this.updateTargetText();
            }
        } else if (event === EventType.TranslationSubtitleEnd) {
            if (text) {
                // 过滤后再添加到历史记录
                const filteredText = this.filterSensitiveWords(text);
                this.completedTargetLines.push(filteredText);
                if (this.completedTargetLines.length > this.maxHistoryLines) {
                    this.completedTargetLines.shift();
                }
                this.currentTargetSentence = '';
                this.updateTargetText();
            }
        }
        
        // 处理 TTS 音频
        if (event === EventType.TTSSentenceStart) {
            this.ttsAudioBuffer = [];
        } else if (event === EventType.TTSResponse) {
            // 接收音频数据
            if (data.data && this.ttsEnabled) {
                this.ttsAudioBuffer.push(data.data);
            }
        } else if (event === EventType.TTSSentenceEnd) {
            // 播放累积的音频
            if (this.ttsAudioBuffer.length > 0 && this.ttsEnabled) {
                this.playAccumulatedTTSAudio(this.ttsAudioBuffer);
                this.ttsAudioBuffer = [];
            }
        }
    }
    
    updateSourceText() {
        if (!this.sourceTextEl) return;
        
        let displayHTML = '';
        
        if (this.completedSourceLines.length > 0) {
            const completedText = this.completedSourceLines.map(line => 
                this.escapeHtml(line)
            ).join('\n');
            displayHTML = completedText;
        }
        
        if (this.currentSourceSentence) {
            const currentText = this.escapeHtml(this.currentSourceSentence);
            if (displayHTML) {
                displayHTML += '\n<span class="current-text">' + currentText + '</span>';
            } else {
                displayHTML = '<span class="current-text">' + currentText + '</span>';
            }
        }
        
        if (!displayHTML) {
            displayHTML = 'Waiting to start...';
        }
        
        // 直接同步更新 innerHTML，确保实时显示
        this.sourceTextEl.innerHTML = displayHTML.replace(/\n/g, '<br>');
        // 使用 scrollTop 而不是 scrollIntoView，避免滚动干扰
        this.sourceTextEl.scrollTop = this.sourceTextEl.scrollHeight;
    }
    
    updateTargetText() {
        if (!this.targetTextEl) return;
        
        let displayHTML = '';
        
        if (this.completedTargetLines.length > 0) {
            const completedText = this.completedTargetLines.map(line => 
                this.escapeHtml(line)
            ).join('\n');
            displayHTML = completedText;
        }
        
        if (this.currentTargetSentence) {
            const currentText = this.escapeHtml(this.currentTargetSentence);
            if (displayHTML) {
                displayHTML += '\n<span class="current-text">' + currentText + '</span>';
            } else {
                displayHTML = '<span class="current-text">' + currentText + '</span>';
            }
        }
        
        if (!displayHTML) {
            displayHTML = 'Waiting to start...';
        }
        
        // 直接同步更新 innerHTML，确保实时显示
        this.targetTextEl.innerHTML = displayHTML.replace(/\n/g, '<br>');
        // 使用 scrollTop 而不是 scrollIntoView，避免滚动干扰
        this.targetTextEl.scrollTop = this.targetTextEl.scrollHeight;
    }
    
    escapeHtml(text) {
            // 统一使用 shared.js 的转义实现
            return Shared.esc(text);
        }
    
    filterSensitiveWords(text) {
        /**
         * 过滤敏感词（前端双重保障）
         * @param {string} text - 要过滤的文本
         * @returns {string} - 过滤后的文本
         */
        if (!this.enableTextFilter || !text || !this.sensitiveWords || this.sensitiveWords.length === 0) {
            return text;
        }
        
        let filteredText = text;
        const replacement = this.filterReplacement || "***";
        
        // 遍历敏感词列表，替换敏感词
        for (const word of this.sensitiveWords) {
            if (word && word.trim()) {
                // 使用正则表达式进行匹配，支持中文和英文
                // 使用词边界或直接匹配
                const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                filteredText = filteredText.replace(regex, replacement);
            }
        }
        
        return filteredText;
    }
    
    async playAccumulatedTTSAudio(audioDataArray) {
        try {
            console.log(`准备播放 ${audioDataArray.length} 个 TTS 音频片段`);
            
            // 合并所有 base64 字符串为二进制数据
            const allChunks = [];
            let totalSize = 0;
            
            for (let i = 0; i < audioDataArray.length; i++) {
                const base64Data = audioDataArray[i];
                const binaryString = atob(base64Data);
                const chunk = new Uint8Array(binaryString.length);
                for (let j = 0; j < binaryString.length; j++) {
                    chunk[j] = binaryString.charCodeAt(j);
                }
                allChunks.push(chunk);
                totalSize += chunk.length;
            }
            
            // 合并所有片段
            const mergedData = new Uint8Array(totalSize);
            let offset = 0;
            for (const chunk of allChunks) {
                mergedData.set(chunk, offset);
                offset += chunk.length;
            }
            
            // 如果正在播放，将音频加入队列
            if (this.isPlayingTTS) {
                if (this.ttsAudioQueue.length >= this.maxTTSQueueSize) {
                    console.warn(`⚠️ TTS 音频队列已满，丢弃最旧的音频`);
                    this.ttsAudioQueue.shift();
                }
                this.ttsAudioQueue.push(mergedData);
                return;
            }
            
            // 播放音频
            await this.playOggOpusAudio(mergedData, true);
            
        } catch (error) {
            console.error('播放累积 TTS 音频失败:', error);
        }
    }
    
    async playOggOpusAudio(opusData, isLastChunk = false) {
        if (this.ttsPlayTimeout) {
            clearTimeout(this.ttsPlayTimeout);
            this.ttsPlayTimeout = null;
        }
        
        console.log('准备播放 OGG Opus 音频，数据大小:', opusData.length, '字节');
        
        // 移动设备：检查音频是否已解锁
        if (this.isMobile && !this.audioUnlocked) {
            console.log('⚠️ 音频未解锁，尝试通过播放静音媒体解锁...');
            // 尝试再次解锁
            if (this.unlockAudioElement) {
                try {
                    await this.unlockAudioElement.play();
                    this.audioUnlocked = true;
                    console.log('✓ 音频已解锁');
                    this.unlockAudioElement.pause();
                    this.unlockAudioElement.currentTime = 0;
                } catch (error) {
                    console.warn('⚠️ 音频解锁失败，等待用户交互:', error);
                    // 将音频加入等待队列
                    if (this.pendingAudioQueue.length < this.maxTTSQueueSize) {
                        this.pendingAudioQueue.push(opusData);
                    } else {
                        console.warn('等待队列已满，丢弃音频');
                    }
                    return;
                }
            } else {
                // 如果没有解锁元素，将音频加入等待队列
                if (this.pendingAudioQueue.length < this.maxTTSQueueSize) {
                    this.pendingAudioQueue.push(opusData);
                } else {
                    console.warn('等待队列已满，丢弃音频');
                }
                return;
            }
        }
        
        // 检查用户交互（iOS 和部分 Android 浏览器需要）
        if (!this.hasUserInteracted && (this.isIOS || this.isMobile)) {
            console.log('⚠️ 等待用户交互后才能播放音频（移动设备限制）');
            // 将音频加入等待队列
            if (this.pendingAudioQueue.length < this.maxTTSQueueSize) {
                this.pendingAudioQueue.push(opusData);
            } else {
                console.warn('等待队列已满，丢弃音频');
            }
            return;
        }
        
        // 优先尝试使用 Web Audio API 播放（移动端兼容性更好）
        if (this.useWebAudioAPI && this.ttsAudioContext && this.opusDecoder) {
            try {
                await this.playAudioWithWebAudioAPI(opusData);
                return;
            } catch (error) {
                console.warn('⚠️ Web Audio API 播放失败，降级到 HTML5 Audio:', error);
                // 降级到 HTML5 Audio
            }
        }
        
        // iOS 使用专门的播放方法
        if (this.isIOS) {
            await this.playAudioOnIOS(opusData);
            return;
        }
        
        // Android 和其他设备使用 HTML5 Audio 播放
        try {
            const blob = new Blob([opusData], { type: 'audio/ogg; codecs=opus' });
            const url = URL.createObjectURL(blob);
            
            const audio = new Audio(url);
            audio.preload = 'auto';
            audio.volume = 1.0;
            
            this.isPlayingTTS = true;
            this.currentTTSAudio = audio;
            
            // 设置超时检测（30秒）
            this.ttsPlayTimeout = setTimeout(() => {
                if (this.isPlayingTTS && this.currentTTSAudio === audio) {
                    console.warn('⚠️ TTS 音频播放超时（30秒），强制重置状态');
                    this.isPlayingTTS = false;
                    this.currentTTSAudio = null;
                    URL.revokeObjectURL(url);
                    this.playNextQueuedTTS();
                }
            }, 30000);
            
            audio.onplay = () => {
                console.log('✓ 音频开始播放');
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }
            };
            
            audio.onended = () => {
                console.log('✓ 音频播放完成');
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;
                URL.revokeObjectURL(url);
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }
                // 播放下一个队列中的音频
                this.playNextQueuedTTS();
            };
            
            audio.onerror = (error) => {
                console.error('❌ 音频播放错误:', error, audio.error);
                console.error('错误详情:', {
                    code: audio.error?.code,
                    message: audio.error?.message,
                    type: audio.error?.name
                });
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;
                URL.revokeObjectURL(url);
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }
                this.playNextQueuedTTS();
            };
            
            // 尝试播放音频
            try {
                await audio.play();
            } catch (playError) {
                // 如果播放失败，可能是用户交互问题或格式不支持
                console.error('❌ 音频播放失败:', {
                    name: playError.name,
                    message: playError.message,
                    stack: playError.stack
                });
                if (playError.name === 'NotAllowedError' || playError.name === 'NotSupportedError') {
                    console.warn('⚠️ 音频播放被阻止，可能需要用户交互或格式不支持');
                    if (!this.hasUserInteracted) {
                        this.hasUserInteracted = false; // 重置，等待下次交互
                        if (this.pendingAudioQueue.length < this.maxTTSQueueSize) {
                            this.pendingAudioQueue.push(opusData);
                        }
                    }
                }
                throw playError;
            }
            
        } catch (error) {
            console.error('❌ 播放音频失败:', error);
            this.isPlayingTTS = false;
            this.currentTTSAudio = null;
            if (this.ttsPlayTimeout) {
                clearTimeout(this.ttsPlayTimeout);
                this.ttsPlayTimeout = null;
            }
            this.playNextQueuedTTS();
        }
    }
    
    async playAudioWithWebAudioAPI(opusData) {
        /**
         * 使用 Web Audio API 播放 Opus 解码后的 PCM 数据
         * 这是移动端的最佳方案，因为可以绕过格式兼容性问题
         */
        if (!this.ttsAudioContext || !this.opusDecoder) {
            throw new Error('Web Audio API 或 Opus 解码器未初始化');
        }
        
        try {
            // 1. 解码 Opus 数据为 PCM
            console.log('开始解码 Opus 数据...');
            let decodedData = null;
            
            // 尝试不同的解码方法（OpusDecoder 的 API 可能不同）
            if (typeof this.opusDecoder.decodeFrame === 'function') {
                decodedData = await this.opusDecoder.decodeFrame(opusData);
            } else if (typeof this.opusDecoder.decodeFrames === 'function') {
                decodedData = await this.opusDecoder.decodeFrames(opusData);
            } else if (typeof this.opusDecoder.decode === 'function') {
                decodedData = await this.opusDecoder.decode(opusData);
            } else {
                // 检查可用的方法
                const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(this.opusDecoder));
                throw new Error(`OpusDecoder 没有找到解码方法。可用方法: ${methods.join(', ')}`);
            }
            
            console.log('✓ Opus 解码完成，PCM 数据大小:', decodedData?.length || 0, '样本');
            
            if (!decodedData || decodedData.length === 0) {
                throw new Error('解码后的 PCM 数据为空');
            }
            
            // 2. 创建 AudioBuffer
            const sampleRate = 24000; // Opus 解码器配置的采样率
            const audioBuffer = this.ttsAudioContext.createBuffer(
                1, // 单声道
                decodedData.length,
                sampleRate
            );
            
            // 3. 将 PCM 数据复制到 AudioBuffer
            const channelData = audioBuffer.getChannelData(0);
            for (let i = 0; i < decodedData.length; i++) {
                channelData[i] = decodedData[i];
            }
            
            // 4. 创建播放源并播放
            const source = this.ttsAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.ttsAudioContext.destination);
            
            this.isPlayingTTS = true;
            this.currentTTSAudio = source;
            
            // 设置超时检测（30秒）
            this.ttsPlayTimeout = setTimeout(() => {
                if (this.isPlayingTTS && this.currentTTSAudio === source) {
                    console.warn('⚠️ Web Audio API 播放超时（30秒），强制重置状态');
                    this.isPlayingTTS = false;
                    this.currentTTSAudio = null;
                    try {
                        source.stop();
                    } catch (e) {
                        // 忽略停止错误
                    }
                    this.playNextQueuedTTS();
                }
            }, 30000);
            
            // 播放完成回调
            source.onended = () => {
                console.log('✓ Web Audio API 播放完成');
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }
                this.playNextQueuedTTS();
            };
            
            // 开始播放
            source.start(0);
            console.log('✓ Web Audio API 开始播放');
            
        } catch (error) {
            console.error('❌ Web Audio API 播放失败:', error);
            this.isPlayingTTS = false;
            this.currentTTSAudio = null;
            if (this.ttsPlayTimeout) {
                clearTimeout(this.ttsPlayTimeout);
                this.ttsPlayTimeout = null;
            }
            throw error;
        }
    }
    
    async playAudioOnIOS(opusData) {
        /**
         * iOS 专用音频播放方法
         * iOS 对自动播放有严格限制，必须使用简单的 HTML5 Audio
         */
        try {
            // 检查数据是否是有效的 OGG 格式
            const isOGG = opusData.length >= 4 &&
                          opusData[0] === 0x4F && // 'O'
                          opusData[1] === 0x67 && // 'g'
                          opusData[2] === 0x67 && // 'g'
                          opusData[3] === 0x53;   // 'S'

            if (!isOGG && opusData.length > 0) {
                console.warn('⚠️ 数据不是 OGG 格式，但尝试播放');
            }

            const blob = new Blob([opusData], { type: 'audio/ogg; codecs=opus' });
            const url = URL.createObjectURL(blob);
            
            const audio = new Audio(url);
            audio.volume = 1.0;
            audio.preload = 'auto';
            this.isPlayingTTS = true;
            this.currentTTSAudio = audio;
            
            // 设置超时检测（30秒）
            this.ttsPlayTimeout = setTimeout(() => {
                if (this.isPlayingTTS && this.currentTTSAudio === audio) {
                    console.warn('⚠️ iOS TTS 音频播放超时（30秒），强制重置状态');
                    this.isPlayingTTS = false;
                    this.currentTTSAudio = null;
                    URL.revokeObjectURL(url);
                    this.playNextQueuedTTS();
                }
            }, 30000);
            
            audio.onplay = () => {
                console.log('✓ iOS 音频开始播放');
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }
            };
            
            audio.onended = () => {
                console.log('✓ iOS 音频播放完成');
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;
                URL.revokeObjectURL(url);
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }
                this.playNextQueuedTTS();
            };
            
            audio.onerror = (error) => {
                console.error('iOS 音频播放错误:', error, audio.error);
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;
                URL.revokeObjectURL(url);
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }
                this.playNextQueuedTTS();
            };
            
            // iOS 特殊处理：检查音频是否已解锁和用户交互
            if (!this.audioUnlocked) {
                console.warn('⚠️ iOS 音频未解锁，尝试解锁...');
                // 尝试通过播放静音媒体解锁
                if (this.unlockAudioElement) {
                    try {
                        await this.unlockAudioElement.play();
                        this.audioUnlocked = true;
                        console.log('✓ iOS 音频已解锁');
                        this.unlockAudioElement.pause();
                        this.unlockAudioElement.currentTime = 0;
                    } catch (error) {
                        console.warn('⚠️ iOS 音频解锁失败，等待用户交互:', error);
                        // 将音频加入等待队列
                        if (this.pendingAudioQueue.length < this.maxTTSQueueSize) {
                            this.pendingAudioQueue.push(opusData);
                        }
                        this.isPlayingTTS = false;
                        this.currentTTSAudio = null;
                        URL.revokeObjectURL(url);
                        if (this.ttsPlayTimeout) {
                            clearTimeout(this.ttsPlayTimeout);
                            this.ttsPlayTimeout = null;
                        }
                        return;
                    }
                }
            }
            
            if (!this.hasUserInteracted) {
                console.warn('⚠️ iOS 需要用户交互才能播放音频，等待用户点击...');
                // 将音频加入等待队列
                if (this.pendingAudioQueue.length < this.maxTTSQueueSize) {
                    this.pendingAudioQueue.push(opusData);
                }
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;
                URL.revokeObjectURL(url);
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }
                return;
            }
            
            // 尝试播放
            try {
                await audio.play();
            } catch (playError) {
                if (playError.name === 'NotAllowedError') {
                    console.warn('⚠️ iOS 音频播放被阻止，可能需要用户交互');
                    this.hasUserInteracted = false; // 重置
                    if (this.pendingAudioQueue.length < this.maxTTSQueueSize) {
                        this.pendingAudioQueue.push(opusData);
                    }
                }
                throw playError;
            }
            
        } catch (error) {
            console.error('iOS 音频播放失败:', error);
            this.isPlayingTTS = false;
            this.currentTTSAudio = null;
            if (this.ttsPlayTimeout) {
                clearTimeout(this.ttsPlayTimeout);
                this.ttsPlayTimeout = null;
            }
        }
    }
    
    async playNextQueuedTTS() {
        if (this.ttsAudioQueue.length > 0 && !this.isPlayingTTS) {
            const nextAudio = this.ttsAudioQueue.shift();
            console.log(`▶️ 播放队列中的下一个TTS音频，剩余队列长度: ${this.ttsAudioQueue.length}`);
            try {
                await this.playOggOpusAudio(nextAudio, true);
            } catch (error) {
                console.error('播放队列中的TTS音频失败:', error);
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;
                setTimeout(() => this.playNextQueuedTTS(), 100);
            }
        }
    }
    
    async toggleSourceFullscreen() {
        const section = document.getElementById('sourceTextSection');
        if (!section) return;
        
        // 检查当前全屏状态
        const isCurrentlyFullscreen = document.fullscreenElement || 
                                     document.webkitFullscreenElement || 
                                     document.mozFullScreenElement || 
                                     document.msFullscreenElement;
        
        if (!this.isSourceFullscreen && !isCurrentlyFullscreen) {
            // 进入全屏
            // 移动设备（包括iOS和Android）优先使用CSS模拟全屏，因为移动浏览器对全屏API支持有限
            if (this.isMobile) {
                console.log('移动设备，使用CSS模拟全屏');
                this.enterCSSFullscreen(section, 'source');
                return;
            }
            
            try {
                if (section.requestFullscreen) {
                    await section.requestFullscreen();
                } else if (section.webkitRequestFullscreen) {
                    await section.webkitRequestFullscreen();
                } else if (section.mozRequestFullScreen) {
                    await section.mozRequestFullScreen();
                } else if (section.msRequestFullscreen) {
                    await section.msRequestFullscreen();
                } else {
                    // 不支持全屏API，使用CSS模拟全屏
                    console.log('浏览器不支持全屏API，使用CSS模拟全屏');
                    this.enterCSSFullscreen(section, 'source');
                    return;
                }
                this.isSourceFullscreen = true;
            } catch (error) {
                console.error('进入全屏失败:', error);
                // 如果全屏API失败，尝试CSS模拟
                this.enterCSSFullscreen(section, 'source');
            }
        } else {
            // 退出全屏
            try {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    await document.webkitExitFullscreen();
                } else if (document.mozCancelFullScreen) {
                    await document.mozCancelFullScreen();
                } else if (document.msExitFullscreen) {
                    await document.msExitFullscreen();
                } else {
                    // 使用CSS退出全屏
                    this.exitCSSFullscreen('source');
                }
                this.isSourceFullscreen = false;
            } catch (error) {
                console.error('退出全屏失败:', error);
                this.exitCSSFullscreen('source');
            }
        }
    }
    
    async toggleTargetFullscreen() {
        const section = document.getElementById('targetTextSection');
        if (!section) return;
        
        // 检查当前全屏状态
        const isCurrentlyFullscreen = document.fullscreenElement || 
                                     document.webkitFullscreenElement || 
                                     document.mozFullScreenElement || 
                                     document.msFullscreenElement;
        
        if (!this.isTargetFullscreen && !isCurrentlyFullscreen) {
            // 进入全屏
            // 移动设备（包括iOS和Android）优先使用CSS模拟全屏，因为移动浏览器对全屏API支持有限
            if (this.isMobile) {
                console.log('移动设备，使用CSS模拟全屏');
                this.enterCSSFullscreen(section, 'target');
                return;
            }
            
            try {
                if (section.requestFullscreen) {
                    await section.requestFullscreen();
                } else if (section.webkitRequestFullscreen) {
                    await section.webkitRequestFullscreen();
                } else if (section.mozRequestFullScreen) {
                    await section.mozRequestFullScreen();
                } else if (section.msRequestFullscreen) {
                    await section.msRequestFullscreen();
                } else {
                    // 不支持全屏API，使用CSS模拟全屏
                    console.log('浏览器不支持全屏API，使用CSS模拟全屏');
                    this.enterCSSFullscreen(section, 'target');
                    return;
                }
                this.isTargetFullscreen = true;
            } catch (error) {
                console.error('进入全屏失败:', error);
                // 如果全屏API失败，尝试CSS模拟
                this.enterCSSFullscreen(section, 'target');
            }
        } else {
            // 退出全屏
            try {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    await document.webkitExitFullscreen();
                } else if (document.mozCancelFullScreen) {
                    await document.mozCancelFullScreen();
                } else if (document.msExitFullscreen) {
                    await document.msExitFullscreen();
                } else {
                    // 使用CSS退出全屏
                    this.exitCSSFullscreen('target');
                }
                this.isTargetFullscreen = false;
            } catch (error) {
                console.error('退出全屏失败:', error);
                this.exitCSSFullscreen('target');
            }
        }
    }
    
    async togglePageFullscreen() {
        // 检查当前全屏状态
        const isCurrentlyFullscreen = document.fullscreenElement || 
                                     document.webkitFullscreenElement || 
                                     document.mozFullScreenElement || 
                                     document.msFullscreenElement;
        
        if (!this.isPageFullscreen && !isCurrentlyFullscreen) {
            // 进入全屏
            // 移动设备（包括iOS和Android）优先使用CSS模拟全屏，因为移动浏览器对全屏API支持有限
            if (this.isMobile) {
                console.log('移动设备，使用CSS模拟全屏');
                this.enterCSSPageFullscreen();
                return;
            }
            
            try {
                if (document.documentElement.requestFullscreen) {
                    await document.documentElement.requestFullscreen();
                } else if (document.documentElement.webkitRequestFullscreen) {
                    await document.documentElement.webkitRequestFullscreen();
                } else if (document.documentElement.mozRequestFullScreen) {
                    await document.documentElement.mozRequestFullScreen();
                } else if (document.documentElement.msRequestFullscreen) {
                    await document.documentElement.msRequestFullscreen();
                } else {
                    // 不支持全屏API，使用CSS模拟全屏
                    console.log('浏览器不支持全屏API，使用CSS模拟全屏');
                    this.enterCSSPageFullscreen();
                    return;
                }
                this.isPageFullscreen = true;
            } catch (error) {
                console.error('进入全屏失败:', error);
                // 如果全屏API失败，尝试CSS模拟
                this.enterCSSPageFullscreen();
            }
        } else {
            // 退出全屏
            try {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    await document.webkitExitFullscreen();
                } else if (document.mozCancelFullScreen) {
                    await document.mozCancelFullScreen();
                } else if (document.msExitFullscreen) {
                    await document.msExitFullscreen();
                } else {
                    // 使用CSS退出全屏
                    this.exitCSSPageFullscreen();
                }
                this.isPageFullscreen = false;
            } catch (error) {
                console.error('退出全屏失败:', error);
                this.exitCSSPageFullscreen();
            }
        }
    }
    
    enterCSSFullscreen(element, type) {
        /**
         * 使用CSS模拟全屏（用于不支持全屏API的设备，如iOS和Android）
         * @param {HTMLElement} element - 要全屏的元素
         * @param {string} type - 'source' 或 'target'
         */
        // 隐藏其他区域
        const sourceSection = document.getElementById('sourceTextSection');
        const targetSection = document.getElementById('targetTextSection');
        
        if (type === 'source' && targetSection) {
            targetSection.style.display = 'none';
        } else if (type === 'target' && sourceSection) {
            sourceSection.style.display = 'none';
        }
        
        // 隐藏header
        const header = document.querySelector('header');
        if (header) {
            header.style.display = 'none';
        }
        
        // 应用全屏样式
        element.classList.add('css-fullscreen');
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        
        // 确保容器也全屏
        const container = document.querySelector('.container');
        if (container) {
            container.style.padding = '0';
            container.style.borderRadius = '0';
        }
        
        if (type === 'source') {
            this.isSourceFullscreen = true;
        } else {
            this.isTargetFullscreen = true;
        }
        
        // 更新按钮图标
        this.updateFullscreenButtonIcon(type, true);
        
        console.log('已进入CSS模拟全屏模式');
    }
    
    exitCSSFullscreen(type) {
        /**
         * 退出CSS模拟全屏
         * @param {string} type - 'source' 或 'target'
         */
        const section = document.getElementById(type === 'source' ? 'sourceTextSection' : 'targetTextSection');
        if (section) {
            section.classList.remove('css-fullscreen');
        }
        
        // 显示其他区域
        const sourceSection = document.getElementById('sourceTextSection');
        const targetSection = document.getElementById('targetTextSection');
        
        if (sourceSection) {
            sourceSection.style.display = '';
        }
        if (targetSection) {
            targetSection.style.display = '';
        }
        
        // 显示header
        const header = document.querySelector('header');
        if (header) {
            header.style.display = '';
        }
        
        // 恢复容器样式
        const container = document.querySelector('.container');
        if (container) {
            container.style.padding = '';
            container.style.borderRadius = '';
        }
        
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
        
        if (type === 'source') {
            this.isSourceFullscreen = false;
        } else {
            this.isTargetFullscreen = false;
        }
        
        // 更新按钮图标
        this.updateFullscreenButtonIcon(type, false);
        
        console.log('已退出CSS模拟全屏模式');
    }
    
    enterCSSPageFullscreen() {
        /**
         * 使用CSS模拟网页全屏（用于不支持全屏API的设备，如iOS和Android）
         */
        // 隐藏header
        const header = document.querySelector('header');
        if (header) {
            header.style.display = 'none';
        }
        
        document.documentElement.classList.add('css-page-fullscreen');
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        
        // 确保容器全屏
        const container = document.querySelector('.container');
        if (container) {
            container.style.padding = '0';
            container.style.borderRadius = '0';
        }
        
        this.isPageFullscreen = true;
        this.updatePageFullscreenButtonIcon(true);
        
        console.log('已进入CSS模拟网页全屏模式');
    }
    
    exitCSSPageFullscreen() {
        /**
         * 退出CSS模拟网页全屏
         */
        // 显示header
        const header = document.querySelector('header');
        if (header) {
            header.style.display = '';
        }
        
        document.documentElement.classList.remove('css-page-fullscreen');
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
        
        // 恢复容器样式
        const container = document.querySelector('.container');
        if (container) {
            container.style.padding = '';
            container.style.borderRadius = '';
        }
        
        this.isPageFullscreen = false;
        this.updatePageFullscreenButtonIcon(false);
        
        console.log('已退出CSS模拟网页全屏模式');
    }
    
    updateFullscreenButtonIcon(type, isFullscreen) {
        /**
         * 更新全屏按钮图标
         * @param {string} type - 'source' 或 'target'
         * @param {boolean} isFullscreen - 是否全屏
         */
        const btn = type === 'source' ? this.sourceFullscreenBtn : this.targetFullscreenBtn;
        if (!btn) return;
        
        const fullscreenIcon = btn.querySelector('.fullscreen-icon');
        const exitFullscreenIcon = btn.querySelector('.exit-fullscreen-icon');
        
        if (fullscreenIcon && exitFullscreenIcon) {
            if (isFullscreen) {
                fullscreenIcon.style.display = 'none';
                exitFullscreenIcon.style.display = 'block';
            } else {
                fullscreenIcon.style.display = 'block';
                exitFullscreenIcon.style.display = 'none';
            }
        }
    }
    
    updatePageFullscreenButtonIcon(isFullscreen) {
        /**
         * 更新网页全屏按钮图标
         * @param {boolean} isFullscreen - 是否全屏
         */
        if (!this.pageFullscreenBtn) return;
        
        const fullscreenIcon = this.pageFullscreenBtn.querySelector('.page-fullscreen-icon');
        const exitFullscreenIcon = this.pageFullscreenBtn.querySelector('.page-exit-fullscreen-icon');
        
        if (fullscreenIcon && exitFullscreenIcon) {
            if (isFullscreen) {
                fullscreenIcon.style.display = 'none';
                exitFullscreenIcon.style.display = 'block';
            } else {
                fullscreenIcon.style.display = 'block';
                exitFullscreenIcon.style.display = 'none';
            }
        }
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    window.viewerApp = new ViewerApp();
});
