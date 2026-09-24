/**
 * 同声传译实时翻译系统 - 前端应用
 */

class TranslationApp {
    constructor() {
        // WebSocket 连接
        this.ws = null;
        // 自动检测 WebSocket URL（支持 iPad 访问）
        // 如果使用 HTTPS，WebSocket 也必须使用 WSS
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsHost = window.location.hostname || 'localhost';
        // 使用当前页面的端口，这样WebSocket会使用相同的端口
        const wsPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
        // WebSocket 路径为 /ws，角色为 controller（控制端）
        this.wsBaseUrl = `${wsProtocol}//${wsHost}:${wsPort}/ws?role=controller`;
        this.roomId = null;          // 当前房间 ID（服务端 room_info 下发）
        this.shareToken = null;      // 会后纪要分享凭证
        this.roomResumeWindowMs = 10 * 60 * 1000;  // 断线后可恢复房间的时间窗

        console.log('WebSocket URL 配置:', {
            protocol: window.location.protocol,
            hostname: wsHost,
            wsProtocol: wsProtocol,
            wsUrl: this.wsBaseUrl
        });
        
        // 音频相关
        this.audioContext = null;
        this.mediaStream = null;
        this.audioWorkletNode = null;
        this.isRecording = false;
        this.audioSource = 'microphone';  // 'microphone' 或 'system'
        this.consecutiveSilentChunks = 0;  // 连续静音块计数
        this.maxSilentChunks = 50;  // 最大连续静音块数（约 4 秒，80ms * 50）
        this.lastAudioSendTime = 0;  // 上次发送音频的时间戳
        this.minSendInterval = 50;  // 最小发送间隔（毫秒），确保发送频率足够高
        
        // 音频参数
        this.SAMPLE_RATE = 16000;
        this.CHANNELS = 1;
        this.BITS_PER_SAMPLE = 16;
        this.CHUNK_DURATION_MS = 80;
        
        // TTS 播放
        this.ttsAudioContext = null;
        this.opusDecoder = null;  // Opus 解码器
        this.ttsAudioQueue = [];  // TTS 音频队列（用于流式播放）
        this.isPlayingTTS = false;
        this.currentTTSAudio = null;  // 当前正在播放的 Audio 元素
        this.pendingTTSChunks = [];  // 待播放的 TTS 音频块
        this.currentTTSBuffer = null;  // 当前正在播放的音频缓冲区
        this.ttsAudioBuffer = [];  // 累积当前句子的 TTS 音频片段
        this.ttsPlayTimeout = null;  // TTS 播放超时定时器
        this.ttsPlayStartTime = null;  // TTS 播放开始时间
        this.ttsHealthCheckInterval = null;  // TTS 健康检查定时器
        this.lastTTSPlayTime = null;  // 最后一次 TTS 播放时间
        this.ttsHealthCheckInterval = null;  // TTS 健康检查定时器
        this.lastTTSPlayTime = null;  // 最后一次 TTS 播放时间
        this.maxTTSQueueSize = 10;  // 最大队列长度，防止无限堆积
        this.ttsDropCount = 0;  // 队列连续丢弃计数（用于卡死检测）
        this.lastTTSResetTime = 0;  // 上次强制重置播放状态的时间（防止频繁重置）
        // 复用的音频处理链节点（避免每次创建导致音色变化）
        this.ttsCompressor = null;
        this.ttsLowShelf = null;
        this.ttsMidPeak = null;
        this.ttsGainNode = null;
        
        // UI 元素
        this.startBtn = document.getElementById('startBtn');
        this.stopBtn = document.getElementById('stopBtn');
        this.testMicBtn = document.getElementById('testMicBtn');
        this.stopTestBtn = document.getElementById('stopTestBtn');
        this.audioTestPanel = document.getElementById('audioTestPanel');
        this.volumeBar = document.getElementById('volumeBar');
        this.volumeText = document.getElementById('volumeText');
        this.audioVisualizer = document.getElementById('audioVisualizer');
        // 状态显示已移至左侧控制区域，不再需要header中的status元素
        // this.statusEl = document.getElementById('status');
        this.connectionStatusEl = document.getElementById('connectionStatus');
        this.micStatusEl = document.getElementById('micStatus');
        this.audioSourceSelect = document.getElementById('audioSource');
        this.audioSourceStatusEl = document.getElementById('audioSourceStatus');
        this.sourceLanguageSelect = document.getElementById('sourceLanguage');
        this.targetLanguageSelect = document.getElementById('targetLanguage');
        this.fontSizeSelect = document.getElementById('fontSize');
        this.fontSizeValueEl = document.getElementById('fontSizeValue');
        this.playbackSpeedSelect = document.getElementById('playbackSpeed');
        this.inputGainSelect = document.getElementById('inputGain');
        this.inputGainValueEl = document.getElementById('inputGainValue');
        this.noiseSuppressionToggle = document.getElementById('noiseSuppression');
        this.ttsPlaybackToggle = document.getElementById('ttsPlayback');
        this.silenceThresholdSelect = document.getElementById('silenceThreshold');
        this.silenceThresholdValueEl = document.getElementById('silenceThresholdValue');
        
        // 语言设置（默认中文->英文）
        this.sourceLanguage = 'zh';
        this.targetLanguage = 'en';

        // 播放速度（默认1.0）
        this.playbackSpeed = 1.0;
        // 环境音增益（默认1.0即100%）
        this.inputGain = 1.0;
        // 噪音抑制开关（默认开启）
        this.noiseSuppressionEnabled = true;
        // TTS 播放开关（默认开启）
        this.ttsEnabled = true;
        // 静音阈值（默认0.4%，即0.004）
        this.silenceThreshold = 0.4;
        // 输入增益节点（用于实时调整环境音增益）
        this.inputGainNode = null;
        // TTS音色（后端使用固定音色，前端不再提供选择）
        this.ttsSpeakerId = 'zh_female_shuangkuaisisi'; // 轻快女声 双快
        this.sourceTextEl = document.getElementById('sourceText');
        this.targetTextEl = document.getElementById('targetText');
        this.sourceTextSection = document.getElementById('sourceTextSection');
        this.targetTextSection = document.getElementById('targetTextSection');
        this.textSectionsContainer = document.querySelector('.text-sections-container');
        this.mainLayout = document.querySelector('.main-layout');
        this.controlSection = document.getElementById('controlSection');
        this.sourceFullscreenBtn = document.getElementById('sourceFullscreenBtn');
        this.targetFullscreenBtn = document.getElementById('targetFullscreenBtn');
        this.pageFullscreenBtn = document.getElementById('pageFullscreenBtn');
        
        // 全屏状态
        this.isSourceFullscreen = false;
        this.isTargetFullscreen = false;
        this.isPageFullscreen = false;
        this.singleSectionPageFullscreen = null;  // 'source' 或 'target' 或 null，表示单个区域的网页全屏状态

        // iOS 检测和音频播放标志
        this.isIOS = /iphone|ipad|ipod/i.test((navigator.userAgent || '').toLowerCase());
        // Safari 检测（含 macOS/iOS Safari，不含 Chromium 系浏览器）：
        // Safari 不支持 OGG/Opus 的 HTML5 Audio 播放，需走 opus-decoder 软解码 + Web Audio
        this.isSafari = /safari/i.test(navigator.userAgent || '') &&
                        !/chrome|chromium|crios|edg|android/i.test(navigator.userAgent || '');
        this.hasUserInteracted = false;  // 用户是否有过交互（iOS 需要）
        this.pendingAudioPlay = null;  // 待播放的音频（用于延迟播放）
        
        // 测试相关
        this.isTesting = false;
        this.testAudioContext = null;
        this.testMediaStream = null;
        this.testProcessor = null;
        this.visualizerBars = [];
        this.analyser = null;
        this.dataArray = null;
        this.bufferLength = null;
        this.animationFrameId = null;
        
        // 流式文本累积
        this.currentSourceSentence = '';  // 当前正在构建的原文句子
        this.currentTargetSentence = ''; // 当前正在构建的译文句子
        this.completedSourceLines = [];   // 已完成的原文行
        this.completedTargetLines = [];   // 已完成的译文行
        this.maxHistoryLines = 8;  // 最大保留的历史记录条数（保留最近的N条）
        this.maxHistoryLines = 8;  // 最大保留的历史记录条数
        this.lastSourceText = '';  // 上一条原文文本，用于去重
        
        // 敏感词过滤（前端双重保障）
        this.enableTextFilter = true;
        this.sensitiveWords = [];  // 敏感词列表，可以从配置加载
        this.filterReplacement = "***";
        this.lastTargetText = '';  // 上一条译文文本，用于去重
        this.recentSourceTexts = [];  // 最近接收的原文文本（用于检测重复）
        this.recentTargetTexts = [];  // 最近接收的译文文本（用于检测重复）
        this.maxRecentTexts = 5;  // 保留最近5条文本用于去重对比
        this.filterEnglishInSource = true;  // 是否过滤原文区域中的英文内容（防止误识别）
        
        // 绑定事件
        if (this.startBtn) {
            this.startBtn.addEventListener('click', () => {
                // 标记用户已交互（iOS 需要）
                this.hasUserInteracted = true;
                this.start();
            });
        }
        if (this.stopBtn) {
            this.stopBtn.addEventListener('click', () => this.stop());
        }
        if (this.testMicBtn) {
            this.testMicBtn.addEventListener('click', () => this.testMicrophone());
        }
        if (this.stopTestBtn) {
            this.stopTestBtn.addEventListener('click', () => this.stopTest());
        }
        if (this.audioSourceSelect) {
            this.audioSourceSelect.addEventListener('change', (e) => {
                this.audioSource = e.target.value;
                this.updateAudioSourceStatus();
            });
            // 初始化时也更新状态
            this.updateAudioSourceStatus();
        }
        
        // 初始化语言选择器
        if (this.sourceLanguageSelect) {
            // 从localStorage读取保存的源语言
            const savedSourceLang = localStorage.getItem('sourceLanguage');
            if (savedSourceLang) {
                this.sourceLanguage = savedSourceLang;
                this.sourceLanguageSelect.value = savedSourceLang;
            } else {
                this.sourceLanguage = 'zh';
                this.sourceLanguageSelect.value = 'zh';
            }
            
            this.sourceLanguageSelect.addEventListener('change', (e) => {
                const newLang = e.target.value;
                // 火山引擎 S2S 模式约束：源语言或目标语言至少一个为中文/英语
                if (!this.isLanguagePairValid(newLang, this.targetLanguage)) {
                    e.target.value = this.sourceLanguage;  // 回退选择
                    this.showWarning('源语言和目标语言中至少需要一个是中文或英语');
                    return;
                }
                this.sourceLanguage = newLang;
                localStorage.setItem('sourceLanguage', newLang);
                console.log('源语言已设置为:', this.sourceLanguage);
                this.sendLanguageUpdate();
            });
        }
        
        if (this.targetLanguageSelect) {
            // 从localStorage读取保存的目标语言
            const savedTargetLang = localStorage.getItem('targetLanguage');
            if (savedTargetLang) {
                this.targetLanguage = savedTargetLang;
                this.targetLanguageSelect.value = savedTargetLang;
            } else {
                this.targetLanguage = 'en';
                this.targetLanguageSelect.value = 'en';
            }
            
            this.targetLanguageSelect.addEventListener('change', (e) => {
                const newLang = e.target.value;
                // 火山引擎 S2S 模式约束：源语言或目标语言至少一个为中文/英语
                if (!this.isLanguagePairValid(this.sourceLanguage, newLang)) {
                    e.target.value = this.targetLanguage;  // 回退选择
                    this.showWarning('源语言和目标语言中至少需要一个是中文或英语');
                    return;
                }
                this.targetLanguage = newLang;
                localStorage.setItem('targetLanguage', newLang);
                console.log('目标语言已设置为:', this.targetLanguage);
                this.sendLanguageUpdate();
            });
        }

        // 兜底：恢复的本地存储值若为无效组合（双方都不是中文/英语），重置为 zh -> en
        if (this.sourceLanguageSelect && this.targetLanguageSelect &&
            !this.isLanguagePairValid(this.sourceLanguage, this.targetLanguage)) {
            console.warn('本地存储的语言组合无效，重置为 zh -> en');
            this.sourceLanguage = 'zh';
            this.targetLanguage = 'en';
            this.sourceLanguageSelect.value = 'zh';
            this.targetLanguageSelect.value = 'en';
            localStorage.setItem('sourceLanguage', 'zh');
            localStorage.setItem('targetLanguage', 'en');
        }

        // 初始化字体大小控制（滑块）
        this.updateFontSizeDisplay = () => {
            if (this.fontSizeValueEl) {
                this.fontSizeValueEl.textContent = `${this.fontSize}%`;
            }
        };
        
        if (this.fontSizeSelect) {
            // 从localStorage读取保存的字体大小
            const savedFontSize = localStorage.getItem('fontSize');
            if (savedFontSize) {
                this.fontSize = parseInt(savedFontSize);
                this.fontSizeSelect.value = savedFontSize;
            } else {
                this.fontSize = 100;
                this.fontSizeSelect.value = '100';
            }
            
            // 更新显示值
            this.updateFontSizeDisplay();
            
            // 应用初始字体大小
            this.applyFontSize();
            
            // 监听滑块变化
            this.fontSizeSelect.addEventListener('input', (e) => {
                this.fontSize = parseInt(e.target.value);
                this.updateFontSizeDisplay();
                localStorage.setItem('fontSize', e.target.value);
                console.log('字体大小已设置为:', this.fontSize + '%');
                this.applyFontSize();
            });
        }
        
        // 初始化字体大小控制（滑块）
        this.updateFontSizeDisplay = () => {
            if (this.fontSizeValueEl) {
                this.fontSizeValueEl.textContent = `${this.fontSize}%`;
            }
        };
        
        if (this.fontSizeSelect) {
            // 从localStorage读取保存的字体大小
            const savedFontSize = localStorage.getItem('fontSize');
            if (savedFontSize) {
                this.fontSize = parseInt(savedFontSize);
                this.fontSizeSelect.value = savedFontSize;
            } else {
                this.fontSize = 100;
                this.fontSizeSelect.value = '100';
            }
            
            // 更新显示值
            this.updateFontSizeDisplay();
            
            // 应用初始字体大小
            this.applyFontSize();
            
            // 监听滑块变化
            this.fontSizeSelect.addEventListener('input', (e) => {
                this.fontSize = parseInt(e.target.value);
                this.updateFontSizeDisplay();
                localStorage.setItem('fontSize', e.target.value);
                console.log('字体大小已设置为:', this.fontSize + '%');
                this.applyFontSize();
            });
        }
        
        // 初始化播放速度控制（滑块）
        this.playbackSpeedValueEl = document.getElementById('playbackSpeedValue');
        
        // 更新播放速度显示方法（需要在调用前定义）
        this.updatePlaybackSpeedDisplay = () => {
            if (this.playbackSpeedValueEl) {
                // 四舍五入到两位小数
                const rounded = Math.round(this.playbackSpeed * 100) / 100;
                // 如果小数点后第二位为0，显示一位小数；否则显示两位小数
                const secondDecimal = Math.round((rounded * 100) % 10);
                if (secondDecimal === 0) {
                    this.playbackSpeedValueEl.textContent = `${rounded.toFixed(1)}x`;
                } else {
                    this.playbackSpeedValueEl.textContent = `${rounded.toFixed(2)}x`;
                }
            }
        };
        
        if (this.playbackSpeedSelect) {
            // 从localStorage读取保存的播放速度
            const savedSpeed = localStorage.getItem('playbackSpeed');
            if (savedSpeed) {
                this.playbackSpeed = parseFloat(savedSpeed);
                this.playbackSpeedSelect.value = savedSpeed;
            } else {
                this.playbackSpeed = 1.0;
                this.playbackSpeedSelect.value = '1.0';
            }
            
            // 更新显示值
            this.updatePlaybackSpeedDisplay();
            
            // 监听滑块变化
            this.playbackSpeedSelect.addEventListener('input', (e) => {
                this.playbackSpeed = parseFloat(e.target.value);
                this.updatePlaybackSpeedDisplay();
                localStorage.setItem('playbackSpeed', e.target.value);
                console.log('播放速度已设置为:', this.playbackSpeed);
                
                // 如果当前正在播放音频，立即应用新的播放速度
                if (this.currentTTSAudio && !this.currentTTSAudio.paused) {
                    // HTML5 Audio
                    this.currentTTSAudio.playbackRate = this.playbackSpeed;
                    console.log('已更新当前播放音频的速度为:', this.playbackSpeed);
                }
                
                // 如果使用Web Audio API播放，也需要更新（如果有当前播放的source）
                // 注意：Web Audio API的playbackRate需要在创建source时设置，无法动态修改
                // 所以这里只处理HTML5 Audio的情况
            });
        }

        // 初始化环境音增益控制（滑块）
        this.updateInputGainDisplay = () => {
            if (this.inputGainValueEl) {
                const percentage = Math.round(this.inputGain * 100);
                this.inputGainValueEl.textContent = `${percentage}%`;
            }
        };

        if (this.inputGainSelect) {
            // 从localStorage读取保存的增益值
            const savedGain = localStorage.getItem('inputGain');
            if (savedGain) {
                this.inputGain = parseFloat(savedGain) / 100; // 转换为0.5-2.0的范围
                this.inputGainSelect.value = savedGain;
            } else {
                this.inputGain = 1.0;
                this.inputGainSelect.value = '100';
            }

            // 更新显示值
            this.updateInputGainDisplay();

            // 监听滑块变化
            this.inputGainSelect.addEventListener('input', (e) => {
                const percentage = parseInt(e.target.value);
                this.inputGain = percentage / 100; // 转换为0.5-2.0的范围
                this.updateInputGainDisplay();
                localStorage.setItem('inputGain', e.target.value);
                console.log('环境音增益已设置为:', this.inputGain);

                // 实时更新增益节点的音量
                if (this.inputGainNode) {
                    this.inputGainNode.gain.setValueAtTime(
                        this.inputGain,
                        this.audioContext.currentTime
                    );
                    console.log('已实时更新输入增益节点音量为:', this.inputGain);
                }
            });
        }

        // 初始化噪音抑制开关
        if (this.noiseSuppressionToggle) {
            // 从localStorage读取保存的噪音抑制状态
            const savedNoiseSuppression = localStorage.getItem('noiseSuppression');
            if (savedNoiseSuppression !== null) {
                this.noiseSuppressionEnabled = savedNoiseSuppression === 'true';
                this.noiseSuppressionToggle.checked = this.noiseSuppressionEnabled;
            } else {
                this.noiseSuppressionEnabled = true;
                this.noiseSuppressionToggle.checked = true;
            }

            // 监听开关变化
            this.noiseSuppressionToggle.addEventListener('change', (e) => {
                this.noiseSuppressionEnabled = e.target.checked;
                localStorage.setItem('noiseSuppression', e.target.checked);
                console.log('噪音抑制已:', this.noiseSuppressionEnabled ? '开启' : '关闭');

                // 提示用户需要重新开始翻译才能应用更改
                if (this.isRecording) {
                    this.showWarning('噪音抑制设置将在下次开始翻译时生效');
                }
            });
        }

        // 初始化 TTS 播放开关
        if (this.ttsPlaybackToggle) {
            // 从localStorage读取保存的TTS播放状态
            const savedTtsPlayback = localStorage.getItem('ttsPlayback');
            if (savedTtsPlayback !== null) {
                this.ttsEnabled = savedTtsPlayback === 'true';
                this.ttsPlaybackToggle.checked = this.ttsEnabled;
            } else {
                this.ttsEnabled = true;
                this.ttsPlaybackToggle.checked = true;
            }

            // 监听开关变化
            this.ttsPlaybackToggle.addEventListener('change', (e) => {
                this.ttsEnabled = e.target.checked;
                localStorage.setItem('ttsPlayback', e.target.checked);
                console.log('语音播放已:', this.ttsEnabled ? '开启' : '关闭');
                
                // 如果关闭时正在播放，停止当前播放
                if (!this.ttsEnabled && this.isPlayingTTS) {
                    this.stopTTSPlayback();
                }
            });
        }

        // 初始化静音阈值控制（滑块）
        this.updateSilenceThresholdDisplay = () => {
            if (this.silenceThresholdValueEl) {
                this.silenceThresholdValueEl.textContent = `${this.silenceThreshold.toFixed(1)}%`;
            }
        };

        if (this.silenceThresholdSelect) {
            // 从localStorage读取保存的静音阈值
            const savedThreshold = localStorage.getItem('silenceThreshold');
            if (savedThreshold) {
                this.silenceThreshold = parseFloat(savedThreshold);
                this.silenceThresholdSelect.value = savedThreshold;
            } else {
                this.silenceThreshold = 0.4;  // 默认0.4%
                this.silenceThresholdSelect.value = '0.4';
            }

            // 更新显示值
            this.updateSilenceThresholdDisplay();

            // 监听滑块变化
            this.silenceThresholdSelect.addEventListener('input', (e) => {
                this.silenceThreshold = parseFloat(e.target.value);
                this.updateSilenceThresholdDisplay();
                localStorage.setItem('silenceThreshold', e.target.value);
                console.log('静音阈值已设置为:', this.silenceThreshold + '%');
            });
        }

        // 初始化高级设置折叠功能
        this.initAdvancedSettingsCollapse();
        
        // 初始化全屏按钮
        if (this.sourceFullscreenBtn) {
            this.sourceFullscreenBtn.addEventListener('click', () => {
                this.toggleFullscreen('source');
            });
        }
        
        if (this.targetFullscreenBtn) {
            this.targetFullscreenBtn.addEventListener('click', () => {
                this.toggleFullscreen('target');
            });
        }
        
        // 初始化网页全屏按钮
        if (this.pageFullscreenBtn) {
            this.pageFullscreenBtn.addEventListener('click', () => {
                this.togglePageFullscreen();
            });
        }
        
        // 监听全屏变化事件
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
        
        // 初始化
        this.init();
    }
    
    initAdvancedSettingsCollapse() {
        /**
         * 初始化高级设置折叠功能
         */
        const toggleBtn = document.getElementById('advancedSettingsToggle');
        const collapsible = document.querySelector('.advanced-settings-collapsible');
        
        if (!toggleBtn || !collapsible) {
            return;
        }
        
        // 从localStorage读取折叠状态（默认折叠）
        const savedState = localStorage.getItem('advancedSettingsCollapsed');
        // 如果没有保存的状态，默认折叠；如果有保存的状态，使用保存的状态
        const isCollapsed = savedState === null ? true : savedState === 'true';
        
        if (isCollapsed) {
            collapsible.classList.add('collapsed');
        }
        
        // 点击切换折叠状态
        toggleBtn.addEventListener('click', () => {
            const isCurrentlyCollapsed = collapsible.classList.contains('collapsed');
            
            if (isCurrentlyCollapsed) {
                collapsible.classList.remove('collapsed');
                localStorage.setItem('advancedSettingsCollapsed', 'false');
            } else {
                collapsible.classList.add('collapsed');
                localStorage.setItem('advancedSettingsCollapsed', 'true');
            }
        });
    }
    
    async init() {
        // 检查浏览器支持并添加 polyfill
        this.setupMediaDevicesPolyfill();
        
        // 检查是否在安全上下文中（HTTPS 或 localhost）
        const isSecureContext = window.isSecureContext || 
                               location.protocol === 'https:' || 
                               location.hostname === 'localhost' || 
                               location.hostname === '127.0.0.1';
        
        const userAgent = navigator.userAgent || navigator.vendor || window.opera;
        const isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent.toLowerCase());
        
        if (!isSecureContext && isMobile) {
            this.showError('移动设备需要 HTTPS 连接才能使用麦克风功能。\n\n解决方案：\n1. 在电脑上访问 http://localhost:8080\n2. 或配置 HTTPS 服务器');
            return;
        }
        
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            if (isMobile) {
                this.showError('您的移动浏览器不支持音频采集功能。\n\n请尝试：\n1. 使用 Safari（iOS）或 Chrome（Android）\n2. 确保使用 HTTPS 连接\n3. 在电脑上使用 Chrome 或 Edge 浏览器');
            } else {
                this.showError('您的浏览器不支持音频采集功能，请使用 Chrome、Firefox、Edge 或 Safari 浏览器。');
            }
            return;
        }
        
        // 检查系统音频捕获支持
        this.checkSystemAudioSupport();
        
               // 创建 TTS 音频上下文
               try {
                   this.ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)();
               } catch (e) {
                   console.error('无法创建音频上下文:', e);
               }
               
               // 初始化 Opus 解码器
               this.initOpusDecoder();

        // 查看端链接 gating：房间未就绪前点击给引导提示，不跳转到缺参数的页面
        const viewerLink = document.querySelector('.viewer-link-btn');
        if (viewerLink) {
            viewerLink.addEventListener('click', (e) => {
                if (!this.roomId) {
                    e.preventDefault();
                    this.showWarning('查看端链接在本场翻译开始后生成。\n\n请先点击「开始翻译」，链接就绪后此按钮将直接打开本场查看端页面。');
                }
            });
            this.updateViewerLink();
        }

        // 分享卡：复制链接 / 二维码
        const copyBtn = document.getElementById('copyViewerLinkBtn');
        if (copyBtn) copyBtn.addEventListener('click', () => this.copyViewerLink());
        const qrBtn = document.getElementById('showQrBtn');
        if (qrBtn) qrBtn.addEventListener('click', () => this.showQrOverlay());
        const shareUrlEl = document.getElementById('viewerShareUrl');
        if (shareUrlEl) shareUrlEl.addEventListener('click', () => this.copyViewerLink());

        // 加载当前访问码信息（使用人/主题），展示在页面上方
        this.loadCodeInfo();
    }

    async loadCodeInfo() {
        /** 从 /api/me 拉取当前访问码的申请信息，展示在页面上方 */
        const metaEl = document.getElementById('headerRoomMeta');
        try {
            const resp = await fetch('/api/me');
            const data = await resp.json();
            if (resp.ok && data.ok) {
                this.codeInfo = data;
                const name = data.applicant + (data.department ? `（${data.department}）` : '');
                if (metaEl) {
                    metaEl.textContent = data.topic ? `${data.topic} · ${name}` : name;
                }
                document.title = data.topic
                    ? `${data.topic} · 同声传译`
                    : '同声传译 · 实时翻译系统';
            }
        } catch (e) {
            console.warn('加载访问码信息失败:', e);
        }
    }
    
    setupMediaDevicesPolyfill() {
        // 为旧版浏览器添加 polyfill
        if (!navigator.mediaDevices) {
            navigator.mediaDevices = {};
        }
        
        if (!navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia = function(constraints) {
                // 使用旧版 API
                const getUserMedia = navigator.getUserMedia || 
                                    navigator.webkitGetUserMedia || 
                                    navigator.mozGetUserMedia || 
                                    navigator.msGetUserMedia;
                
                if (!getUserMedia) {
                    return Promise.reject(new Error('getUserMedia is not supported in this browser'));
                }
                
                return new Promise(function(resolve, reject) {
                    getUserMedia.call(navigator, constraints, resolve, reject);
                });
            };
        }
    }
    
    checkSystemAudioSupport() {
        /**
         * 检查浏览器是否支持系统音频捕获
         * 如果不支持，禁用系统音频选项并显示提示
         */
        const supportsSystemAudio = navigator.mediaDevices && 
                                   typeof navigator.mediaDevices.getDisplayMedia === 'function';
        
        if (!supportsSystemAudio && this.audioSourceSelect) {
            // 禁用系统音频选项
            const systemOption = this.audioSourceSelect.querySelector('option[value="system"]');
            if (systemOption) {
                systemOption.disabled = true;
                systemOption.textContent = '系统音频（不支持）';
            }
            
            // 如果当前选择的是系统音频，切换回麦克风
            if (this.audioSource === 'system') {
                this.audioSource = 'microphone';
                this.audioSourceSelect.value = 'microphone';
                this.updateAudioSourceStatus();
            }
            
            console.warn('当前浏览器不支持系统音频捕获功能');
        } else {
            console.log('✓ 浏览器支持系统音频捕获功能');
        }
    }
    
    async start() {
        try {
            // 1. 获取麦克风权限并开始采集
            await this.startAudioCapture();
            
            // 2. 连接到 WebSocket 服务器
            await this.connectWebSocket();
            
            // 3. 更新 UI 和重置状态
            if (this.startBtn) this.startBtn.disabled = true;
            if (this.stopBtn) this.stopBtn.disabled = false;
            this.isRecording = true;
            this.consecutiveSilentChunks = 0;
            this.lastAudioSendTime = 0;
            this.updateStatus('已连接', 'connected');
            this.updateMicStatus('已启用', 'active');
            this.updateConnectionStatus('已连接', 'connected');
            this.updateAudioSourceStatus();
            
        } catch (error) {
            console.error('启动失败:', error);
            this.showError(`启动失败: ${error.message}`);
            await this.stop();
        }
    }
    
    async stop() {
        this.isRecording = false;
        // 注意：停止翻译不清除房间——中途停止再开始时恢复同一房间，
        // 观众已拿到的链接/二维码继续有效（房间在服务端保留 5 分钟，超时或刷新页面才开新场）
        
        // 发送停止消息给后端（通知查看端）
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({
                    "type": "stop"
                }));
                console.log('已发送停止翻译消息');
            } catch (error) {
                console.error('发送停止消息失败:', error);
            }
        }
        
        // 停止音频采集
        await this.stopAudioCapture();
        
        // 关闭 WebSocket 连接
        this.disconnectWebSocket();
        
        // 重置连续静音计数和发送时间
        this.consecutiveSilentChunks = 0;
        this.lastAudioSendTime = 0;
        
        // 更新 UI
        if (this.startBtn) this.startBtn.disabled = false;
        if (this.stopBtn) this.stopBtn.disabled = true;
        this.updateStatus('未连接', 'disconnected');
        this.updateMicStatus('未启用', '');
        this.updateConnectionStatus('未连接', 'disconnected');
        if (this.audioSourceStatusEl) {
            this.audioSourceStatusEl.textContent = '未选择';
        }
        
        // 重置当前正在构建的句子（但保留已完成的历史记录）
        this.currentSourceSentence = '';
        this.currentTargetSentence = '';
        // 注意：不清空 completedSourceLines 和 completedTargetLines，保留历史记录
        // 注意：不清空 lastSourceText 和 lastTargetText，保留用于去重
        // 注意：不清空 recentSourceTexts 和 recentTargetTexts，保留用于去重
        
        // 更新文本显示（不清空，只清除当前正在构建的句子）
        this.updateSourceText();
        this.updateTargetText();
    }
    
    _setupAudioProcessing(mediaStream) {
        /**
         * 设置音频处理链（麦克风和系统音频共用）
         * @param {MediaStream} mediaStream - 音频流
         */
        // 创建音频上下文
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: this.SAMPLE_RATE
        });
        
        // 创建音频源
        const source = this.audioContext.createMediaStreamSource(mediaStream);

        // 创建输入增益节点（用于实时调整环境音增益）
        this.inputGainNode = this.audioContext.createGain();
        this.inputGainNode.gain.value = this.inputGain;
        console.log('创建输入增益节点，初始音量:', this.inputGain);
        
        // 使用 ScriptProcessorNode 处理音频（兼容性更好）
        // buffer size 必须是 2 的幂次方，在 256 到 16384 之间
        // 计算最接近目标时长的 2 的幂次方
        const targetSamples = Math.floor(this.SAMPLE_RATE * this.CHUNK_DURATION_MS / 1000);
        const bufferSize = this.getNearestPowerOfTwo(targetSamples, 256, 16384);
        const processor = this.audioContext.createScriptProcessor(bufferSize, this.CHANNELS, this.CHANNELS);
        
        processor.onaudioprocess = (e) => {
            if (!this.isRecording) {
                return;
            }
            
            // 检查 WebSocket 连接
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                if (!this._wsWarningShown) {
                    console.warn('WebSocket 未连接，无法发送音频数据');
                    this._wsWarningShown = true;
                }
                return;
            }
            
            // 获取音频数据
            const inputData = e.inputBuffer.getChannelData(0);
            
            // 检查是否有声音（计算音量）
            const sum = inputData.reduce((acc, val) => acc + Math.abs(val), 0);
            const average = sum / inputData.length;
            const volume = average * 200; // 放大音量显示（与测试功能一致）
            
            // 根据音频源和用户设置使用不同的静音阈值
            // 系统音频通常有更多的背景噪声，需要更高的阈值
            // 用户设置的阈值是百分比形式，需要转换为实际阈值（除以100）
            const silenceThreshold = (this.audioSource === 'system' ? 1.0 : 0.5) * (this.silenceThreshold / 100);
            
            // 完全取消静音跳过和时间间隔检查，确保每个音频块都发送
            // 火山引擎API要求非常高的发送频率，静音时也必须保持发送
            // 音频块间隔是80ms，正常情况下不会发送过快，浏览器和WebSocket会自己处理缓冲
            // 检查是否静音（仅用于统计）
            if (volume < silenceThreshold) {
                // 静音，增加连续静音计数（仅用于统计）
                this.consecutiveSilentChunks++;
            } else {
                // 有声音，重置连续静音计数
                this.consecutiveSilentChunks = 0;
            }
            
            // 转换为 16-bit PCM
            const pcmData = this.convertFloat32ToPCM16(inputData);
            
            // 发送到服务器
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(pcmData);
                    // 每 100 次发送记录一次日志（避免日志过多）
                    if (!this._audioSendCount) this._audioSendCount = 0;
                    this._audioSendCount++;
                    if (this._audioSendCount === 1) {
                        console.log('开始发送音频数据到服务器...');
                    }
                    if (this._audioSendCount % 100 === 0) {
                        console.log(`已发送 ${this._audioSendCount} 个音频包，当前音量: ${volume.toFixed(2)}%`);
                    }
                } catch (error) {
                    console.error('发送音频数据失败:', error);
                }
            }
        };
        
        // 连接音频处理链：source -> gainNode -> processor -> destination
        source.connect(this.inputGainNode);
        this.inputGainNode.connect(processor);
        processor.connect(this.audioContext.destination);
        
        this.audioWorkletNode = processor;
    }
    
    async startMicrophoneCapture() {
        /**
         * 开始麦克风音频捕获
         */
        try {
            console.log('开始获取麦克风权限...');
            console.log('浏览器信息:', navigator.userAgent);
            console.log('mediaDevices 支持:', !!navigator.mediaDevices);
            console.log('getUserMedia 支持:', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
            
            // 获取麦克风权限（移动设备上不强制指定采样率）
            const audioConstraints = {
                channelCount: this.CHANNELS,
                echoCancellation: true,
                noiseSuppression: this.noiseSuppressionEnabled,
                autoGainControl: true
            };
            
            // 只在桌面浏览器上指定采样率（移动设备可能不支持）
            const isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
                (navigator.userAgent || navigator.vendor || window.opera || '').toLowerCase()
            );
            
            if (!isMobile) {
                audioConstraints.sampleRate = this.SAMPLE_RATE;
            }
            
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints
            });
            
            // 设置音频处理链
            this._setupAudioProcessing(this.mediaStream);
            
        } catch (error) {
            console.error('麦克风音频采集失败:', error);
            let errorMessage = '无法访问麦克风';
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                errorMessage = '麦克风权限被拒绝，请在浏览器设置中允许访问麦克风';
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                errorMessage = '未找到麦克风设备，请检查设备连接';
            } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                errorMessage = '麦克风被其他应用占用，请关闭其他应用后重试';
            } else if (error.message) {
                errorMessage = `音频采集失败: ${error.message}`;
            }
            throw new Error(errorMessage);
        }
    }
    
    async startSystemAudioCapture() {
        /**
         * 开始系统音频捕获（使用 getDisplayMedia API）
         * 注意：某些浏览器不支持只请求音频，需要同时请求视频和音频，然后停止视频轨道
         */
        try {
            console.log('开始获取系统音频权限...');
            
            // 检查浏览器是否支持 getDisplayMedia
            if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
                throw new Error('您的浏览器不支持系统音频捕获功能。请使用 Chrome、Edge 或 Firefox 浏览器。');
            }
            
            // 获取系统音频流
            // 注意：某些浏览器不支持 video: false，需要同时请求视频和音频
            // 然后停止视频轨道，只使用音频轨道
            let stream;
            try {
                // 首先尝试只请求音频（某些浏览器支持）
                stream = await navigator.mediaDevices.getDisplayMedia({
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: this.noiseSuppressionEnabled,
                        autoGainControl: false
                    },
                    video: false
                });
            } catch (audioOnlyError) {
                // 如果只请求音频失败，尝试同时请求视频和音频
                console.log('只请求音频失败，尝试同时请求视频和音频...', audioOnlyError);
                stream = await navigator.mediaDevices.getDisplayMedia({
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: this.noiseSuppressionEnabled,
                        autoGainControl: false
                    },
                    video: true  // 同时请求视频（即使我们不需要）
                });
                
                // 检查获取到的轨道
                const videoTracks = stream.getVideoTracks();
                const audioTracks = stream.getAudioTracks();
                console.log('获取到的轨道:', {
                    videoTracks: videoTracks.length,
                    audioTracks: audioTracks.length,
                    allTracks: stream.getTracks().length
                });
                
                // 检查是否有音频轨道（用户可能选择了不包含音频的选项）
                if (audioTracks.length === 0) {
                    // 停止所有轨道并清理
                    stream.getTracks().forEach(track => track.stop());
                    throw new Error('未检测到系统音频。\n\n请确保：\n1. 选择"共享标签页"或"共享窗口"（不是"共享屏幕"）\n2. 在共享选项中勾选"共享音频"\n3. 某些应用可能不支持音频共享');
                }
                
                // 停止所有视频轨道（我们只需要音频）
                // 注意：不要使用 removeTrack，因为它可能在某些浏览器中不可用
                videoTracks.forEach(track => {
                    track.stop();
                    console.log('已停止视频轨道:', track.label);
                });
                console.log('已停止视频轨道，仅保留音频，音频轨道数:', audioTracks.length);
            }
            
            this.mediaStream = stream;
            
            // 再次检查用户是否取消了选择或没有音频轨道
            const audioTracks = this.mediaStream.getAudioTracks();
            if (!this.mediaStream || audioTracks.length === 0) {
                // 清理所有轨道
                if (this.mediaStream) {
                    this.mediaStream.getTracks().forEach(track => track.stop());
                }
                throw new Error('未检测到系统音频。\n\n请确保：\n1. 选择"共享标签页"或"共享窗口"（不是"共享屏幕"）\n2. 在共享选项中勾选"共享音频"\n3. 某些应用可能不支持音频共享');
            }
            
            // 监听音频轨道结束事件（用户可能停止共享）
            this.mediaStream.getAudioTracks().forEach(track => {
                track.onended = () => {
                    console.log('系统音频轨道已结束');
                    if (this.isRecording) {
                        this.showError('系统音频捕获已停止，请重新开始翻译');
                        this.stop();
                    }
                };
            });
            
            console.log('系统音频捕获已启动，音频轨道数:', this.mediaStream.getAudioTracks().length);
            
            // 设置音频处理链
            this._setupAudioProcessing(this.mediaStream);
            
        } catch (error) {
            console.error('系统音频采集失败:', error);
            let errorMessage = '无法访问系统音频';
            
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                errorMessage = '系统音频权限被拒绝，请在浏览器设置中允许屏幕共享';
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                errorMessage = '未找到系统音频源';
            } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                errorMessage = '系统音频被其他应用占用，请关闭其他应用后重试';
            } else if (error.name === 'NotSupportedError') {
                errorMessage = '您的浏览器不支持系统音频捕获功能。请使用 Chrome 96+、Edge 96+ 或 Firefox 浏览器。';
            } else if (error.message) {
                errorMessage = error.message;
            }
            
            throw new Error(errorMessage);
        }
    }
    
    async startAudioCapture() {
        /**
         * 根据选择的音频源开始音频捕获
         */
        if (this.audioSource === 'system') {
            await this.startSystemAudioCapture();
        } else {
            await this.startMicrophoneCapture();
        }
    }
    
    async stopAudioCapture() {
        if (this.audioWorkletNode) {
            this.audioWorkletNode.disconnect();
            this.audioWorkletNode = null;
        }
        
        if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
        }
        
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        // 停止 TTS 音频播放并清理状态
        this.stopTTSPlayback();
    }
    
    stopTTSPlayback() {
        /**
         * 停止 TTS 音频播放并清理状态
         */
        // 停止当前播放的音频
        if (this.currentTTSAudio) {
            this.currentTTSAudio.pause();
            this.currentTTSAudio = null;
        }

        // 清除超时定时器
        if (this.ttsPlayTimeout) {
            clearTimeout(this.ttsPlayTimeout);
            this.ttsPlayTimeout = null;
        }

        // 重置播放状态
        this.isPlayingTTS = false;
        this.ttsPlayStartTime = null;

        // 清空音频队列
        this.ttsAudioQueue = [];
        this.ttsAudioBuffer = [];
    }
    
    getNearestPowerOfTwo(value, min, max) {
        // 找到最接近 value 的 2 的幂次方
        // 如果 value 已经是 2 的幂次方且在范围内，直接返回
        if (value >= min && value <= max && (value & (value - 1)) === 0) {
            return value;
        }
        
        // 找到最接近的 2 的幂次方
        let power = Math.floor(Math.log2(value));
        let lower = Math.pow(2, power);
        let upper = Math.pow(2, power + 1);
        
        // 如果 lower 小于 min，使用 min
        if (lower < min) {
            lower = min;
        }
        // 如果 upper 大于 max，使用 max
        if (upper > max) {
            upper = max;
        }
        
        // 选择更接近的值
        let result = (value - lower < upper - value) ? lower : upper;
        
        // 最终确保在范围内
        if (result < min) return min;
        if (result > max) return max;
        
        return result;
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
    
    convertFloat32ToPCM16(float32Array) {
        const buffer = new ArrayBuffer(float32Array.length * 2);
        const view = new DataView(buffer);
        let offset = 0;
        
        for (let i = 0; i < float32Array.length; i++, offset += 2) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        
        return buffer;
    }
    
    isLanguagePairValid(sourceLang, targetLang) {
        /**
         * 校验语言组合是否满足火山引擎 S2S 模式约束：
         * 源语言或目标语言至少一个为中文（zh）或英语（en）
         */
        return sourceLang === 'zh' || sourceLang === 'en' ||
               targetLang === 'zh' || targetLang === 'en';
    }

    sendLanguageUpdate() {
        /**
         * 发送语言更新请求到后端
         */
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const message = {
                type: "update_language",
                source_language: this.sourceLanguage,
                target_language: this.targetLanguage
            };
            this.ws.send(JSON.stringify(message));
            console.log('已发送语言更新请求:', message);
        } else {
            console.log('WebSocket 未连接，语言设置将在连接时应用');
        }
    }
    
    buildWsUrl() {
        /**
         * 构建 WS 地址：恢复窗口内携带房间 ID，服务端据此恢复本场上下文
         */
        const saved = this.getSavedRoom();
        const room = this.roomId || (saved ? saved.roomId : null);
        return room ? `${this.wsBaseUrl}&room=${encodeURIComponent(room)}` : this.wsBaseUrl;
    }

    getSavedRoom() {
        /** 从 sessionStorage 读取可恢复的房间（10 分钟窗口内有效） */
        try {
            const raw = sessionStorage.getItem('st_room');
            if (!raw) return null;
            const saved = JSON.parse(raw);
            if (Date.now() - saved.ts > this.roomResumeWindowMs) {
                sessionStorage.removeItem('st_room');
                return null;
            }
            return saved;
        } catch (e) {
            return null;
        }
    }

    saveRoom(roomId) {
        this.roomId = roomId;
        try {
            sessionStorage.setItem('st_room', JSON.stringify({roomId, ts: Date.now()}));
        } catch (e) {}
        this.updateViewerLink();
        this.updateShareCard();
    }

    clearRoom() {
        /** 强制清除房间状态（当前无调用方；停止翻译已改为保留房间以便恢复本场，
         *  预留给将来"结束本场/开新场"按钮使用） */
        this.roomId = null;
        try {
            sessionStorage.removeItem('st_room');
        } catch (e) {}
        this.updateViewerLink();
        this.updateShareCard();
    }

    getViewerUrl() {
        /** 本场查看端完整链接 */
        if (!this.roomId) return '';
        const share = this.shareToken ? `&share=${encodeURIComponent(this.shareToken)}` : '';
        return `${window.location.origin}/viewer?room=${encodeURIComponent(this.roomId)}${share}`;
    }

    updateShareCard() {
        /** 分享卡：房间就绪后显示，含完整链接 + 复制/二维码入口 */
        const card = document.getElementById('viewerShareCard');
        const urlEl = document.getElementById('viewerShareUrl');
        if (!card || !urlEl) return;
        const url = this.getViewerUrl();
        if (url) {
            urlEl.textContent = url;
            card.classList.remove('hidden');
        } else {
            card.classList.add('hidden');
        }
    }

    showToast(text) {
        /** 轻量提示（不打断操作） */
        let t = document.querySelector('.app-toast');
        if (!t) {
            t = document.createElement('div');
            t.className = 'app-toast';
            document.body.appendChild(t);
        }
        t.textContent = text;
        t.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
    }

    async copyViewerLink() {
        /** 复制查看端链接（clipboard API 不可用时回退 execCommand） */
        const url = this.getViewerUrl();
        if (!url) return;
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(url);
            } else {
                const ta = document.createElement('textarea');
                ta.value = url;
                ta.style.cssText = 'position:fixed;opacity:0;';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
            this.showToast('查看端链接已复制，去分享吧');
        } catch (e) {
            this.showToast('复制失败，请长按链接手动复制');
        }
    }

    showQrOverlay() {
        /** 二维码浮层：扫码进入本场查看端 */
        if (!this.roomId) return;
        if (typeof window.qrcode !== 'function') {
            this.showToast('二维码组件加载失败，请使用复制链接');
            return;
        }
        const url = this.getViewerUrl();
        // 访问码来自 /api/me（loadCodeInfo 已缓存），供无法扫码的观众手动输入
        const accessCode = this.codeInfo ? (this.codeInfo.code || '') : '';
        let overlay = document.getElementById('qrOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'qrOverlay';
            overlay.className = 'qr-overlay';
            overlay.innerHTML = `
                <div class="qr-panel">
                    <h3>扫码进入本场查看端</h3>
                    <div class="qr-hint">观众用手机相机/微信扫码即可打开</div>
                    ${accessCode ? '<div class="qr-access-code">访问码：<span></span></div>' : ''}
                    <div class="qr-img" id="qrImg"></div>
                    <br>
                    <button type="button" class="qr-close">关闭</button>
                </div>`;
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay || e.target.classList.contains('qr-close')) {
                    overlay.remove();
                }
            });
            document.body.appendChild(overlay);
        }
        const codeEl = overlay.querySelector('.qr-access-code span');
        if (codeEl && accessCode) codeEl.textContent = accessCode;
        const img = overlay.querySelector('#qrImg');
        try {
            const qr = window.qrcode(0, 'M');
            qr.addData(url);
            qr.make();
            img.innerHTML = qr.createSvgTag({cellSize: 9, margin: 3});
        } catch (e) {
            console.error('生成二维码失败:', e);
            this.showToast('二维码生成失败，请使用复制链接');
            overlay.remove();
        }
    }

    updateViewerLink() {
        /** 更新顶部查看端链接：有房间时指向本场并可点击，无房间时禁用并回到通用入口 */
        const link = document.querySelector('.viewer-link-btn');
        if (!link) return;
        if (this.roomId) {
            link.href = this.getViewerUrl();
            link.title = `本场查看端链接（房间 ${this.roomId}）`;
            link.classList.remove('disabled');
        } else {
            link.href = '/viewer';
            link.title = '开始翻译后生成查看端链接';
            link.classList.add('disabled');
        }
    }

    connectWebSocket() {
        return new Promise((resolve, reject) => {
            try {
                const wsUrl = this.buildWsUrl();
                console.log('正在连接 WebSocket:', wsUrl);
                console.log('当前页面协议:', window.location.protocol);
                console.log('当前页面主机:', window.location.hostname);

                this.ws = new WebSocket(wsUrl);

                this.ws.onopen = () => {
                    console.log('WebSocket 连接已建立:', wsUrl);
                    this.updateConnectionStatus('已连接', 'connected');

                    // 连接成功后发送当前语言设置
                    this.sendLanguageUpdate();

                    // 启动 TTS 健康检查
                    this.startTTSHealthCheck();

                    resolve();
                };

                this.ws.onmessage = (event) => {
                    this.handleWebSocketMessage(event);
                };

                this.ws.onerror = (error) => {
                    console.error('WebSocket 错误:', error);
                    console.error('WebSocket URL:', wsUrl);
                    console.error('WebSocket readyState:', this.ws.readyState);

                    let errorMsg = 'WebSocket 连接错误';
                    if (this.ws.readyState === WebSocket.CLOSED) {
                        errorMsg = '无法连接到服务器，请检查服务器是否运行';
                    } else if (this.ws.readyState === WebSocket.CONNECTING) {
                        errorMsg = '正在连接服务器...';
                    }

                    this.showError(errorMsg);
                    this.updateConnectionStatus('连接失败', 'disconnected');
                    reject(error);
                };

                this.ws.onclose = (event) => {
                    console.log('WebSocket 连接已关闭');
                    console.log('关闭代码:', event.code);
                    console.log('关闭原因:', event.reason);
                    console.log('是否正常关闭:', event.wasClean);

                    this.updateConnectionStatus('未连接', 'disconnected');

                    // 停止 TTS 健康检查
                    this.stopTTSHealthCheck();

                    // 如果不是正常关闭，尝试重连
                    if (this.isRecording && !event.wasClean) {
                        console.log('连接异常关闭，3秒后尝试重连...');
                        setTimeout(() => {
                            if (this.isRecording) {
                                this.connectWebSocket().catch(console.error);
                            }
                        }, 3000);
                    }
                };

            } catch (error) {
                console.error('创建 WebSocket 连接时出错:', error);
                this.showError(`WebSocket 连接失败: ${error.message}`);
                reject(error);
            }
        });
    }
    
    disconnectWebSocket() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    
    handleWebSocketMessage(event) {
        try {
            const message = JSON.parse(event.data);
            console.log('📨 收到 WebSocket 消息:', message.type);
            console.log('完整消息内容:', JSON.stringify(message, null, 2));
            
            switch (message.type) {
                case 'connected':
                    console.log('✓ 翻译服务已连接');
                    break;

                case 'room_info':
                    // 房间就绪：记录房间 ID 并更新查看端链接
                    console.log(`🏠 ${message.message}`);
                    this.shareToken = message.share_token || null;
                    this.saveRoom(message.room_id);
                    break;
                    
                case 'translation':
                    console.log('🌐 收到翻译数据');
                    console.log('事件类型:', message.data?.event);
                    console.log('文本内容:', message.data?.text);
                    console.log('完整数据:', message.data);
                    this.handleTranslationResponse(message.data);
                    break;
                    
                case 'error':
                    console.error('❌ 收到错误:', message.message);
                    this.showError(message.message);
                    break;

                case 'auth_error':
                    // 访问码鉴权失败：登录态无效，跳回首页重新验证
                    console.error('❌ 鉴权失败:', message.message);
                    this.showError(message.message || '访问码无效，请重新验证');
                    setTimeout(() => { window.location.href = '/'; }, 2000);
                    break;

                case 'tts_reconnecting':
                    // 服务端检测到 TTS 停流，正在自动重建火山引擎会话
                    console.warn('🔄 TTS 停流，服务端自动恢复中:', message.message);
                    this.updateConnectionStatus('语音恢复中…', 'warning');
                    break;

                case 'tts_reconnected':
                    // 会话重建成功，语音输出恢复
                    console.log('✓ 语音输出已恢复（服务端已重建会话）');
                    this.updateConnectionStatus('已连接', 'connected');
                    break;

                default:
                    console.warn('⚠️ 未知消息类型:', message.type, message);
            }
        } catch (error) {
            console.error('❌ 处理 WebSocket 消息失败:', error);
            console.error('原始数据:', event.data);
        }
    }
    
    handleTranslationResponse(data) {
        // 根据 protobuf 事件类型处理响应
        // 事件类型是数字枚举值（来自 common.events_pb2.Type）
        const event = data.event;
        let text = data.text || '';
        
        // 前端双重过滤（后端已经过滤，这里是额外保障）
        if (this.enableTextFilter && text) {
            text = this.filterSensitiveWords(text);
            data.text = text;  // 更新数据中的文本
        }
        
        console.log('处理翻译响应，事件类型:', event, '数据:', data);

        // 检测异常：原文事件但包含英文
        if ([650, 651, 652].includes(event)) {
            // 检查是否包含英文字符（超过30%的英文字母）
            const englishChars = text.match(/[a-zA-Z]/g);
            const totalChars = text.replace(/\s/g, '').length;
            if (totalChars > 0 && englishChars && englishChars.length / totalChars > 0.3) {
                console.warn('⚠️ 检测到异常：原文事件包含大量英文！');
                console.warn(`  事件类型: ${event} (应该是原文)`);
                console.warn(`  文本内容: "${text}"`);
                console.warn(`  英文字符占比: ${(englishChars.length / totalChars * 100).toFixed(1)}%`);
            }
        }

        // 检测异常：译文事件但包含中文
        if ([653, 654, 655].includes(event)) {
            // 检查是否包含中文字符
            const chineseChars = text.match(/[\u4e00-\u9fa5]/g);
            if (chineseChars && chineseChars.length > 0) {
                console.warn('⚠️ 检测到异常：译文事件包含中文字符！');
                console.warn(`  事件类型: ${event} (应该是译文)`);
                console.warn(`  文本内容: "${text}"`);
                console.warn(`  中文字符数量: ${chineseChars.length}`);
            }
        }
        
        // 事件类型常量（来自 protobuf 定义）
        // 注意：实际的事件类型值与注释中的十六进制值不同
        const EventType = {
            SessionStarted: 150,      // 0x96
            SessionFinished: 152,     // 0x98
            SessionFailed: 153,       // 0x99
            UsageResponse: 154,       // 0x9a
            TaskRequest: 200,         // 0xc8
            AudioMuted: 250,          // 0xfa
            TTSSentenceStart: 350,    // 实际值（不是 478！）
            TTSSentenceEnd: 351,      // 实际值（不是 479！）
            TTSResponse: 352,         // 实际值（不是 480！）
            SourceSubtitleStart: 650, // 实际值
            SourceSubtitleResponse: 651, // 实际值
            SourceSubtitleEnd: 652,   // 实际值
            TranslationSubtitleStart: 653, // 实际值
            TranslationSubtitleResponse: 654, // 实际值
            TranslationSubtitleEnd: 655, // 实际值
        };
        
        // 处理会话开始
        if (event === EventType.SessionStarted) {
            console.log('会话已开始');
            return;
        }
        
        // 处理原文相关事件
        if (event === EventType.SourceSubtitleStart) {
            console.log('原文开始');
            // 重置当前句子（开始新句子）
            this.currentSourceSentence = '';
            return;
        }
        
        if (event === EventType.SourceSubtitleResponse) {
            // 原文数据（流式片段）
            console.log('收到原文响应:', data.text);
            if (data.text) {
                // 只在源语言是中文时过滤英文内容（防止误识别）
                // 如果源语言是英文，应该显示英文原文
                if (this.filterEnglishInSource && this.sourceLanguage === 'zh' && this.isMostlyEnglish(data.text)) {
                    console.warn('🚫 过滤原文区域中的英文内容（源语言为中文）:', data.text);
                    return;
                }

                // 使用智能去重检查
                if (!this.isTextDuplicate(data.text, this.recentSourceTexts)) {
                    // 前端双重过滤（后端已经过滤，这里是额外保障）
                    const filteredText = this.filterSensitiveWords(data.text);
                    this.currentSourceSentence = filteredText;
                    this.updateSourceText();
                } else {
                    console.log('⏭️ 跳过重复的原文文本:', data.text);
                }
            } else {
                console.warn('原文响应中没有文本内容:', data);
            }
            return;
        }
        
        if (event === EventType.SourceSubtitleEnd) {
            // 原文结束（完整句子）
            console.log('原文结束:', data.text);
            // 确保数组已初始化
            if (!this.completedSourceLines) {
                this.completedSourceLines = [];
            }
            if (data.text) {
                // 只在源语言是中文时过滤英文内容（防止误识别）
                // 如果源语言是英文，应该显示英文原文
                if (this.filterEnglishInSource && this.sourceLanguage === 'zh' && this.isMostlyEnglish(data.text)) {
                    console.warn('🚫 过滤原文区域中的英文内容（End，源语言为中文）:', data.text);
                    this.currentSourceSentence = '';
                    this.updateSourceText();
                    return;
                }

                // 使用智能去重检查
                if (!this.isTextDuplicate(data.text, this.recentSourceTexts)) {
                // 使用 End 事件中的完整文本
                this.completedSourceLines.push(data.text);
                    this.lastSourceText = data.text;  // 更新上一条文本
                    // 添加到最近文本列表
                    this.recentSourceTexts.push(data.text);
                    if (this.recentSourceTexts.length > this.maxRecentTexts) {
                        this.recentSourceTexts.shift();
                    }
                    // 限制历史记录数量，保留最近的N条
                    if (this.completedSourceLines.length > this.maxHistoryLines) {
                        this.completedSourceLines.shift();  // 移除最旧的记录
                    }
                    console.log('✓ 添加原文到历史记录:', data.text);
                } else {
                    console.log('⏭️ 跳过重复的原文（End）:', data.text);
                }
                this.currentSourceSentence = '';
                this.updateSourceText();
            } else if (this.currentSourceSentence) {
                // 如果没有 End 文本，使用累积的文本
                // 只在源语言是中文时过滤英文内容（防止误识别）
                // 如果源语言是英文，应该显示英文原文
                if (this.filterEnglishInSource && this.sourceLanguage === 'zh' && this.isMostlyEnglish(this.currentSourceSentence)) {
                    console.warn('🚫 过滤原文区域中的英文内容（累积，源语言为中文）:', this.currentSourceSentence);
                    this.currentSourceSentence = '';
                    this.updateSourceText();
                    return;
                }

                if (!this.isTextDuplicate(this.currentSourceSentence, this.recentSourceTexts)) {
                this.completedSourceLines.push(this.currentSourceSentence);
                    this.lastSourceText = this.currentSourceSentence;
                    // 添加到最近文本列表
                    this.recentSourceTexts.push(this.currentSourceSentence);
                    if (this.recentSourceTexts.length > this.maxRecentTexts) {
                        this.recentSourceTexts.shift();
                    }
                    // 限制历史记录数量，保留最近的N条
                    if (this.completedSourceLines.length > this.maxHistoryLines) {
                        this.completedSourceLines.shift();  // 移除最旧的记录
                    }
                    console.log('✓ 添加累积原文到历史记录:', this.currentSourceSentence);
                } else {
                    console.log('⏭️ 跳过重复的累积原文:', this.currentSourceSentence);
                }
                this.currentSourceSentence = '';
                this.updateSourceText();
            }
            return;
        }
        
        // 处理译文相关事件
        if (event === EventType.TranslationSubtitleStart) {
            console.log('译文开始');
            // 重置当前句子（开始新句子）
            this.currentTargetSentence = '';
            return;
        }
        
        if (event === EventType.TranslationSubtitleResponse) {
            // 译文数据（流式片段）
            console.log('收到译文响应:', data.text);
            if (data.text) {
                // 使用智能去重检查
                if (!this.isTextDuplicate(data.text, this.recentTargetTexts)) {
                this.currentTargetSentence = data.text;
                this.updateTargetText();
                } else {
                    console.log('⏭️ 跳过重复的译文文本:', data.text);
                }
            } else {
                console.warn('译文响应中没有文本内容:', data);
            }
            return;
        }
        
        if (event === EventType.TranslationSubtitleEnd) {
            // 译文结束（完整句子）
            console.log('译文结束:', data.text);
            // 确保数组已初始化
            if (!this.completedTargetLines) {
                this.completedTargetLines = [];
            }
            
            // 确定要添加的文本（优先使用 End 事件中的完整文本，否则使用累积的文本）
            const textToAdd = data.text || this.currentTargetSentence;
            
            if (textToAdd) {
                // 分割文本为多个句子（按句号、问号、感叹号等分割）
                // 但保留句子结束标点
                const sentences = this.splitIntoSentences(textToAdd);
                
                // 逐个添加句子
                for (const sentence of sentences) {
                    const trimmedSentence = sentence.trim();
                    if (trimmedSentence && !this.isTextDuplicate(trimmedSentence, this.recentTargetTexts)) {
                        this.completedTargetLines.push(trimmedSentence);
                        this.lastTargetText = trimmedSentence;  // 更新上一条文本
                        // 添加到最近文本列表
                        this.recentTargetTexts.push(trimmedSentence);
                        if (this.recentTargetTexts.length > this.maxRecentTexts) {
                            this.recentTargetTexts.shift();
                        }
                        // 限制历史记录数量，保留最近的N条
                        if (this.completedTargetLines.length > this.maxHistoryLines) {
                            this.completedTargetLines.shift();  // 移除最旧的记录
                        }
                        console.log('✓ 添加译文句子到历史记录:', trimmedSentence);
                    } else if (trimmedSentence) {
                        console.log('⏭️ 跳过重复的译文句子:', trimmedSentence);
                    }
                }
            }
            
            // 清空当前正在构建的句子
                this.currentTargetSentence = '';
                this.updateTargetText();
            return;
        }
        
        // 处理 TTS 相关事件
        if (event === EventType.TTSSentenceStart) {
            // TTS 句子开始，清空累积的音频数据
            console.log('🔊 TTS 句子开始');
            this.ttsAudioBuffer = [];
            return;
        }
        
        if (event === EventType.TTSResponse) {
            // TTS 音频数据（流式片段）- 累积但不立即播放
            const audioSize = data.data_length || (data.data ? data.data.length : 0);
            console.log('🔊 收到 TTS 音频数据，长度:', audioSize, '字节');
            
            if (data.data && data.data.length > 0) {
                // 累积音频片段
                this.ttsAudioBuffer.push(data.data);
                console.log(`累积 TTS 音频片段，当前片段数: ${this.ttsAudioBuffer.length}`);
            } else {
                console.warn('⚠️ TTS 响应中没有音频数据');
            }
            return;
        }
        
        if (event === EventType.TTSSentenceEnd) {
            // TTS 句子结束，播放累积的所有音频
            const audioSize = data.data_length || (data.data ? data.data.length : 0);
            console.log('🔊 TTS 句子结束，累积片段数:', this.ttsAudioBuffer.length, '，最后片段大小:', audioSize, '字节');
            
            // 如果有最后的音频数据，也加入累积
            if (data.data && data.data.length > 0) {
                this.ttsAudioBuffer.push(data.data);
            }
            
            // 如果有累积的音频数据，合并后播放（如果TTS播放已启用）
            if (this.ttsAudioBuffer.length > 0) {
                if (this.ttsEnabled) {
                console.log(`开始播放累积的 TTS 音频，共 ${this.ttsAudioBuffer.length} 个片段`);
                this.playAccumulatedTTSAudio(this.ttsAudioBuffer);
                } else {
                    console.log('TTS 播放已禁用，跳过音频播放');
                }
                this.ttsAudioBuffer = [];  // 清空累积
            } else {
                console.log('TTS 句子结束但没有累积的音频数据');
            }
            return;
        }
        
        // 处理会话结束事件
        if (event === EventType.SessionFinished) {
            console.log('会话已结束');
            return;
        }
        
        if (event === EventType.SessionFailed) {
            this.showError(`翻译会话失败: ${data.message || '未知错误'}`);
            return;
        }
        
        // 处理使用量响应
        if (event === EventType.UsageResponse) {
            console.log('使用量信息:', data.usage || data);
            return;
        }
        
        // 处理静音事件
        if (event === EventType.AudioMuted) {
            console.log('检测到静音');
            return;
        }
        
        // 未知事件类型，记录日志
        console.log('未知事件类型:', event, data);
    }
    
    updateSourceText() {
        // 构建完整的显示文本：已完成的行 + 当前正在构建的句子
        let displayHTML = '';
        
        // 添加已完成的行
        if (this.completedSourceLines.length > 0) {
            // 转义HTML特殊字符
            const completedText = this.completedSourceLines.map(line => 
                this.escapeHtml(line)
            ).join('\n');
            displayHTML = completedText;
        }
        
        // 添加当前正在构建的句子（如果有），使用加粗和更大的字体
        if (this.currentSourceSentence) {
            const currentText = this.escapeHtml(this.currentSourceSentence);
            if (displayHTML) {
                displayHTML += '\n<span class="current-text">' + currentText + '</span>';
            } else {
                displayHTML = '<span class="current-text">' + currentText + '</span>';
            }
        }
        
        // 如果没有内容，显示默认文本
        if (!displayHTML) {
            displayHTML = '等待开始...';
        }
        
        // 更新显示（使用innerHTML以支持HTML格式）
        this.sourceTextEl.innerHTML = displayHTML.replace(/\n/g, '<br>');
        
        // 自动滚动到底部
        this.sourceTextEl.scrollTop = this.sourceTextEl.scrollHeight;
    }
    
    updateTargetText() {
        // 确保数组已初始化
        if (!this.completedTargetLines) {
            this.completedTargetLines = [];
        }
        if (this.currentTargetSentence === undefined) {
            this.currentTargetSentence = '';
        }
        
        // 构建完整的显示文本：已完成的行 + 当前正在构建的句子（与原文显示方式一致）
        let displayHTML = '';
        
        // 添加已完成的行
        if (this.completedTargetLines.length > 0) {
            // 转义HTML特殊字符
            const completedText = this.completedTargetLines.map(line => 
                this.escapeHtml(line)
            ).join('\n');
            displayHTML = completedText;
        }
        
        // 添加当前正在构建的句子（如果有），使用加粗和更大的字体
        if (this.currentTargetSentence) {
            const currentText = this.escapeHtml(this.currentTargetSentence);
            if (displayHTML) {
                displayHTML += '\n<span class="current-text">' + currentText + '</span>';
            } else {
                displayHTML = '<span class="current-text">' + currentText + '</span>';
            }
        }
        
        // 如果没有内容，显示默认文本
        if (!displayHTML) {
            displayHTML = '等待开始...';
        }
        
        // 更新显示（使用innerHTML以支持HTML格式，与原文显示方式一致）
        this.targetTextEl.innerHTML = displayHTML.replace(/\n/g, '<br>');
        
        // 自动滚动到底部
        this.targetTextEl.scrollTop = this.targetTextEl.scrollHeight;
    }
    
    escapeHtml(text) {
            // 统一使用 shared.js 的转义实现
            return Shared.esc(text);
        }
    
    splitIntoSentences(text) {
        /**
         * 将文本分割为多个句子
         * 按句号、问号、感叹号等分割，但保留标点符号
         * @param {string} text - 要分割的文本
         * @returns {Array<string>} - 句子数组
         */
        if (!text || !text.trim()) {
            return [];
        }
        
        // 先按换行符分割（如果文本中已有换行）
        const lines = text.split(/\n+/).map(line => line.trim()).filter(line => line);
        if (lines.length > 1) {
            // 如果有多行，直接返回（每行可能已经是一个句子）
            return lines;
        }
        
        // 如果没有换行，按标点符号分割
        // 匹配句号、问号、感叹号，以及可能的引号、括号等
        // 保留标点符号在句子末尾
        const sentenceRegex = /([^.!?]+[.!?]+["'")]*)\s*/g;
        const sentences = [];
        let match;
        let lastIndex = 0;
        
        while ((match = sentenceRegex.exec(text)) !== null) {
            const sentence = match[1].trim();
            if (sentence) {
                sentences.push(sentence);
            }
            lastIndex = sentenceRegex.lastIndex;
        }
        
        // 如果没有匹配到句子（可能没有标点），返回整个文本
        if (sentences.length === 0) {
            return [text.trim()];
        }
        
        // 处理剩余文本（如果正则没有完全匹配）
        if (lastIndex < text.length) {
            const remaining = text.substring(lastIndex).trim();
            if (remaining) {
                sentences.push(remaining);
            }
        }
        
        return sentences;
    }

    isTextDuplicate(text, recentTexts) {
        /**
         * 检查文本是否与最近的文本重复
         *
         * 检测策略：
         * 1. 完全相同
         * 2. 相似度超过80%（基于编辑距离）
         * 3. 包含关系（A是B的子集或反之）
         *
         * @param {string} text - 要检查的文本
         * @param {Array} recentTexts - 最近的文本列表
         * @returns {boolean} - 是否重复
         */
        if (!text || !recentTexts || recentTexts.length === 0) {
            return false;
        }

        // 检查完全相同
        if (recentTexts.includes(text)) {
            return true;
        }

        // 检查与最近文本的相似度
        for (const recentText of recentTexts) {
            if (this.calculateSimilarity(text, recentText) > 0.85) {
                console.log(`🔍 检测到相似文本 (相似度: ${(this.calculateSimilarity(text, recentText) * 100).toFixed(1)}%)`);
                console.log(`  原文: "${recentText}"`);
                console.log(`  新文: "${text}"`);
                return true;
            }

            // 检查包含关系
            if (text.includes(recentText) && recentText.length > 10) {
                console.log(`🔍 检测到包含关系: "${text}" 包含 "${recentText}"`);
                return true;
            }
            if (recentText.includes(text) && text.length > 10) {
                console.log(`🔍 检测到包含关系: "${recentText}" 包含 "${text}"`);
                return true;
            }
        }

        return false;
    }

    calculateSimilarity(str1, str2) {
        /**
         * 计算两个字符串的相似度（基于编辑距离）
         *
         * @param {string} str1 - 第一个字符串
         * @param {string} str2 - 第二个字符串
         * @returns {number} - 相似度（0-1之间）
         */
        if (!str1 || !str2) {
            return 0;
        }

        const len1 = str1.length;
        const len2 = str2.length;
        const maxLen = Math.max(len1, len2);

        if (maxLen === 0) {
            return 1;
        }

        // 动态规划计算编辑距离
        const matrix = [];
        for (let i = 0; i <= len1; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= len2; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                if (str1[i - 1] === str2[j - 1]) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,  // 替换
                        matrix[i][j - 1] + 1,     // 插入
                        matrix[i - 1][j] + 1      // 删除
                    );
                }
            }
        }

        const editDistance = matrix[len1][len2];
        return 1 - editDistance / maxLen;
    }

    isMostlyEnglish(text) {
        /**
         * 检测文本是否主要为英文（用于过滤原文区域中的误识别英文）
         *
         * @param {string} text - 要检测的文本
         * @returns {boolean} - 是否主要为英文
         */
        if (!text || text.length < 10) {
            return false;
        }

        // 移除空格和标点符号
        const cleanText = text.replace(/[\s\p{P}\p{S}]/gu, '');
        if (cleanText.length === 0) {
            return false;
        }

        // 统计英文字符
        const englishChars = cleanText.match(/[a-zA-Z]/g);
        const englishCount = englishChars ? englishChars.length : 0;

        // 统计中文字符
        const chineseChars = cleanText.match(/[\u4e00-\u9fa5]/g);
        const chineseCount = chineseChars ? chineseChars.length : 0;

        // 统计数字
        const digitChars = cleanText.match(/\d/g);
        const digitCount = digitChars ? digitChars.length : 0;

        // 计算英文字符占比
        const totalRelevantChars = englishCount + chineseCount + digitCount;
        if (totalRelevantChars === 0) {
            return false;
        }

        const englishRatio = englishCount / totalRelevantChars;

        // 判断：英文占比超过40%，且英文字符数量大于中文字符数量
        const isMostlyEnglish = englishRatio > 0.4 && englishCount > chineseCount;

        if (isMostlyEnglish) {
            console.log(`🔍 英文检测: ${englishRatio.toFixed(1)}% 英文 (${englishCount}英/${chineseCount}中/${digitCount}数)`);
        }

        return isMostlyEnglish;
    }
    
    async initOpusDecoder() {
        // 等待 Opus 解码器库加载
        console.log('开始初始化 Opus 解码器...');
        let retries = 0;
        const maxRetries = 100; // 最多等待 10 秒
        
        // 方法1：等待 OpusDecoderReady 事件
        const waitForEvent = new Promise((resolve) => {
            if (window.OpusDecoderReady) {
                resolve(true);
                return;
            }
            window.addEventListener('opusDecoderReady', () => resolve(true), { once: true });
            // 超时处理
            setTimeout(() => resolve(false), 10000);
        });
        
        await waitForEvent;
        
        // 方法2：轮询检查
        while (retries < maxRetries) {
            if (typeof OpusDecoder !== 'undefined' && window.OpusDecoderReady) {
                try {
                    console.log('尝试创建 OpusDecoder 实例...');
                    console.log('OpusDecoder 类型:', typeof OpusDecoder);
                    console.log('OpusDecoder 构造函数:', OpusDecoder);
                    
                    // 检查 OpusDecoder 的可用方法
                    if (typeof OpusDecoder === 'function') {
                        this.opusDecoder = new OpusDecoder({
                            sampleRate: 24000,  // 火山引擎 TTS 使用 24kHz
                            channels: 1,        // 单声道
                            useWorker: false    // 不使用 Worker（简化实现）
                        });
                        console.log('✓ OpusDecoder 实例创建成功');
                        const proto = Object.getPrototypeOf(this.opusDecoder);
                        const methods = Object.getOwnPropertyNames(proto).filter(name => name !== 'constructor');
                        const props = Object.keys(this.opusDecoder);
                        console.log('OpusDecoder 实例方法:', methods);
                        console.log('OpusDecoder 实例属性:', props);
                        console.log('OpusDecoder 完整对象:', this.opusDecoder);
                        return;
                    } else {
                        console.error('❌ OpusDecoder 不是构造函数');
                    }
                } catch (error) {
                    console.error('❌ 初始化 Opus 解码器失败:', error);
                    console.error('错误详情:', error.message, error.stack);
                    break;
                }
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            retries++;
            if (retries % 10 === 0) {
                console.log(`等待 Opus 解码器库加载... (${retries * 100}ms)`);
            }
        }
        
        if (!this.opusDecoder) {
            console.warn('⚠️ Opus 解码器库未加载');
            console.warn('检查信息:', {
                'typeof OpusDecoder': typeof OpusDecoder,
                'window.OpusDecoderReady': window.OpusDecoderReady,
                'window.OpusDecoder': typeof window.OpusDecoder
            });
        }
    }
    
    async playAccumulatedTTSAudio(audioDataArray) {
        // 播放累积的多个 TTS 音频片段
        // 每个片段都是 base64 编码的 OGG Opus 数据
        try {
            console.log(`准备播放 ${audioDataArray.length} 个 TTS 音频片段`);
            
            // 合并所有 base64 字符串为二进制数据
            // 注意：每个片段可能是独立的 OGG 文件，需要分别处理
            // 但为了简化，我们尝试合并所有片段为一个 Blob
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
            
            console.log(`合并 ${audioDataArray.length} 个片段，总大小: ${totalSize} 字节`);
            
            // 合并所有片段
            const mergedData = new Uint8Array(totalSize);
            let offset = 0;
            for (const chunk of allChunks) {
                mergedData.set(chunk, offset);
                offset += chunk.length;
            }
            
            // 如果正在播放，将音频加入队列等待播放
            if (this.isPlayingTTS) {
                // 检查队列大小，防止无限堆积
                if (this.ttsAudioQueue.length >= this.maxTTSQueueSize) {
                    console.warn(`⚠️ TTS 音频队列已满（${this.maxTTSQueueSize}），丢弃最旧的音频`);
                    this.ttsAudioQueue.shift();  // 移除最旧的音频
                    this.ttsDropCount++;
                }
                console.log(`⏸️ 当前正在播放TTS音频，将新音频加入队列（队列长度: ${this.ttsAudioQueue.length + 1}/${this.maxTTSQueueSize}）`);
                this.ttsAudioQueue.push(mergedData);
                return;
            }
            
            // 使用 HTML5 Audio 播放（最可靠的方法）
            await this.playOggOpusAudio(mergedData, true);
            
        } catch (error) {
            console.error('播放累积 TTS 音频失败:', error);
        }
    }
    
    async playNextQueuedTTS() {
        // 播放下一个队列中的TTS音频
        if (this.ttsAudioQueue.length > 0 && !this.isPlayingTTS) {
            const nextAudio = this.ttsAudioQueue.shift();
            console.log(`▶️ 播放队列中的下一个TTS音频，剩余队列长度: ${this.ttsAudioQueue.length}`);
            try {
                // 确保 AudioContext 处于运行状态
                await this.ensureAudioContextRunning();
                await this.playOggOpusAudio(nextAudio, true);
            } catch (error) {
                console.error('播放队列中的TTS音频失败:', error);
                // 即使播放失败，也继续播放下一个
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;
                // 尝试恢复 AudioContext
                await this.ensureAudioContextRunning();
                setTimeout(() => this.playNextQueuedTTS(), 100);
            }
        }
    }
    
    async ensureAudioContextRunning() {
        /**
         * 确保 AudioContext 处于运行状态
         */
        if (!this.ttsAudioContext) {
            return;
        }
        
        try {
            if (this.ttsAudioContext.state === 'suspended' || this.ttsAudioContext.state === 'interrupted') {
                console.log(`⚠️ AudioContext 状态为 ${this.ttsAudioContext.state}，尝试恢复...`);
                await this.ttsAudioContext.resume();
                console.log(`✓ AudioContext 已恢复，当前状态: ${this.ttsAudioContext.state}`);
            }
        } catch (error) {
            console.error('恢复 AudioContext 失败:', error);
            // 如果恢复失败，尝试重新创建
            try {
                const sampleRate = this.ttsAudioContext.sampleRate || 24000;
                await this.ttsAudioContext.close();
                this.ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: sampleRate
                });
                // 重置处理链节点
                this.ttsCompressor = null;
                this.ttsLowShelf = null;
                this.ttsMidPeak = null;
                this.ttsGainNode = null;
                console.log('✓ AudioContext 已重新创建');
            } catch (recreateError) {
                console.error('重新创建 AudioContext 失败:', recreateError);
            }
        }
    }
    
    startTTSHealthCheck() {
        /**
         * 启动 TTS 健康检查，定期检查音频播放状态
         */
        if (this.ttsHealthCheckInterval) {
            return;  // 已经启动
        }
        
        this.ttsHealthCheckInterval = setInterval(() => {
            this.checkTTSHealth();
        }, 5000);  // 每5秒检查一次
        
        console.log('✓ TTS 健康检查已启动');
    }
    
    stopTTSHealthCheck() {
        /**
         * 停止 TTS 健康检查
         */
        if (this.ttsHealthCheckInterval) {
            clearInterval(this.ttsHealthCheckInterval);
            this.ttsHealthCheckInterval = null;
            console.log('✓ TTS 健康检查已停止');
        }
    }
    
    async checkTTSHealth() {
        /**
         * 检查 TTS 播放健康状态
         */
        try {
            // 1. 检查 AudioContext 状态
            if (this.ttsAudioContext) {
                if (this.ttsAudioContext.state === 'suspended' || this.ttsAudioContext.state === 'interrupted') {
                    console.warn(`⚠️ AudioContext 状态异常: ${this.ttsAudioContext.state}，尝试恢复...`);
                    await this.ensureAudioContextRunning();
                }
            }
            
            // 2. 检查当前音频播放状态
            if (this.isPlayingTTS && this.currentTTSAudio) {
                // 检查音频元素是否处于错误状态
                if (this.currentTTSAudio.error) {
                    console.error('⚠️ 当前音频元素处于错误状态:', this.currentTTSAudio.error);
                    // 重置播放状态
                    this.isPlayingTTS = false;
                    this.currentTTSAudio = null;
                    // 尝试播放下一个
                    this.playNextQueuedTTS();
                    return;
                }
                
                // 检查音频是否真的在播放
                if (this.currentTTSAudio.paused && !this.currentTTSAudio.ended) {
                    console.warn('⚠️ 音频元素处于暂停状态但未结束，尝试恢复播放...');
                    try {
                        await this.currentTTSAudio.play();
                    } catch (error) {
                        console.error('恢复播放失败:', error);
                        // 重置状态并播放下一个
                        this.isPlayingTTS = false;
                        this.currentTTSAudio = null;
                        this.playNextQueuedTTS();
                    }
                }
            }
            
            // 3. 检查是否有队列但未播放（可能是 isPlayingTTS 标志异常）
            if (this.ttsAudioQueue.length > 0 && !this.isPlayingTTS && !this.currentTTSAudio) {
                console.warn(`⚠️ 检测到队列中有 ${this.ttsAudioQueue.length} 个待播放音频，但播放状态异常，尝试恢复...`);
                // 重置状态并尝试播放
                this.isPlayingTTS = false;
                this.playNextQueuedTTS();
            }
            
            // 4. 检查播放超时（如果设置了开始时间但超过30秒未完成）
            if (this.ttsPlayStartTime && this.isPlayingTTS) {
                const elapsed = Date.now() - this.ttsPlayStartTime;
                if (elapsed > 30000) {  // 30秒超时
                    console.warn('⚠️ TTS 播放超时（超过30秒），重置状态...');
                    this.isPlayingTTS = false;
                    if (this.currentTTSAudio) {
                        try {
                            this.currentTTSAudio.pause();
                        } catch (e) {}
                        this.currentTTSAudio = null;
                    }
                    this.ttsPlayStartTime = null;
                    // 尝试播放下一个
                    this.playNextQueuedTTS();
                }
            }

            // 5. 兜底：既没在真正播放，队列又在持续丢弃 → 播放器已卡死，强制重置
            //    触发条件：连续丢弃 >= 3 个音频，且距上次成功开始播放超过 20 秒
            //    （说明 isPlayingTTS 卡在 true，新音频全被丢弃，需重建整个播放状态）
            const DROP_COUNT_THRESHOLD = 3;      // 连续丢弃阈值
            const STALL_DURATION_MS = 20000;     // 判定卡死的无播放时长
            const RESET_COOLDOWN_MS = 30000;     // 两次强制重置之间的最小间隔

            if (this.ttsDropCount >= DROP_COUNT_THRESHOLD) {
                const timeSinceLastPlay = this.lastTTSPlayTime ? Date.now() - this.lastTTSPlayTime : Infinity;
                const timeSinceLastReset = Date.now() - this.lastTTSResetTime;
                const notReallyPlaying = !this.lastTTSPlayTime || timeSinceLastPlay > STALL_DURATION_MS;

                if (notReallyPlaying && timeSinceLastReset >= RESET_COOLDOWN_MS) {
                    console.error(`🚨 检测到 TTS 播放器卡死（连续丢弃 ${this.ttsDropCount} 个音频，距上次成功播放 ${this.lastTTSPlayTime ? Math.round(timeSinceLastPlay / 1000) + ' 秒' : '从未播放'}），强制重置播放状态并重建 AudioContext`);
                    await this.forceResetTTSPlayer();
                }
            }

        } catch (error) {
            console.error('TTS 健康检查失败:', error);
        }
    }

    async forceResetTTSPlayer() {
        /**
         * 强制重置整个 TTS 播放状态
         * 清除卡死的播放标志、当前音频和队列，并重建 AudioContext
         */
        this.lastTTSResetTime = Date.now();
        this.ttsDropCount = 0;

        // 清除超时定时器
        if (this.ttsPlayTimeout) {
            clearTimeout(this.ttsPlayTimeout);
            this.ttsPlayTimeout = null;
        }

        // 停止当前音频
        if (this.currentTTSAudio) {
            try {
                this.currentTTSAudio.pause();
            } catch (e) {}
            this.currentTTSAudio = null;
        }

        // 清空队列和播放状态
        const droppedCount = this.ttsAudioQueue.length;
        this.ttsAudioQueue = [];
        this.isPlayingTTS = false;
        this.ttsPlayStartTime = null;
        this.ttsAudioBuffer = [];

        // 重建 AudioContext（关闭旧的，创建新的，重置处理链节点）
        if (this.ttsAudioContext && this.ttsAudioContext.state !== 'closed') {
            const oldContext = this.ttsAudioContext;
            this.ttsAudioContext = null;
            try {
                await oldContext.close();
            } catch (e) {
                console.warn('关闭旧 AudioContext 失败:', e);
            }
        }
        this.ttsAudioContext = null;
        this.ttsCompressor = null;
        this.ttsLowShelf = null;
        this.ttsMidPeak = null;
        this.ttsGainNode = null;

        // 直接创建新的 AudioContext（ensureAudioContextRunning 在 context 为 null 时不会创建）
        try {
            this.ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 24000
            });
            console.log('✓ 强制重置：已重建 AudioContext，状态:', this.ttsAudioContext.state);
        } catch (e) {
            console.error('重建 AudioContext 失败:', e);
        }

        console.warn(`🚨 TTS 播放器已强制重置（丢弃了 ${droppedCount} 个排队音频），后续句子的 TTS 将恢复正常播放`);
    }
    
    async playTTSAudio(audioData, isComplete = false) {
        // 单个音频片段播放（已废弃，保留用于兼容）
        try {
            // 将 base64 字符串转换为 Uint8Array
            let opusData;
            if (typeof audioData === 'string') {
                // Base64 编码的音频数据
                const binaryString = atob(audioData);
                opusData = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    opusData[i] = binaryString.charCodeAt(i);
                }
            } else if (audioData instanceof ArrayBuffer) {
                opusData = new Uint8Array(audioData);
            } else if (audioData instanceof Uint8Array) {
                opusData = audioData;
            } else {
                console.error('不支持的音频数据格式:', typeof audioData);
                return;
            }
            
            if (opusData.length === 0) {
                console.warn('TTS 音频数据为空');
                return;
            }
            
            // 使用 HTML5 Audio 元素播放 OGG Opus 音频
            // 现代浏览器（Chrome、Firefox、Edge）原生支持 OGG Opus 格式
            await this.playOggOpusAudio(opusData, isComplete);
            
        } catch (error) {
            console.error('播放 TTS 音频失败:', error);
        }
    }
    
    async playOggOpusAudio(opusData, isLastChunk = false) {
        // 清除之前的超时定时器
        if (this.ttsPlayTimeout) {
            clearTimeout(this.ttsPlayTimeout);
            this.ttsPlayTimeout = null;
        }

        console.log('准备播放 OGG Opus 音频，数据大小:', opusData.length, '字节');
        console.log('iOS 检测:', this.isIOS);

        // iOS：优先走 Opus 软解码 + Web Audio（iOS Safari 同样不支持 OGG 的 HTML5 播放）；
        // 解码器不可用时才回退到专门的 iOS HTML5 处理
        if (this.isIOS && !this.opusDecoder) {
            console.log('📱 iOS 设备且解码器不可用，使用 HTML5 Audio 播放（跳过 Web Audio API）');
            await this.playAudioOnIOS(opusData);
            return;
        }

        // 优先使用 Opus 解码器 + Web Audio API
        // 如果解码器不可用，回退到 HTML5 Audio 元素
        try {
            
            // 方法1：使用 Opus 解码器 + Web Audio API（推荐）
            console.log('检查 Opus 解码器状态:', {
                'this.opusDecoder': !!this.opusDecoder,
                'opusData.length': opusData.length
            });
            // 由于 Opus 解码器在处理完整 OGG Opus 文件时可能出错，
            // 而浏览器原生支持 OGG Opus，我们直接使用 HTML5 Audio
            // 这样可以避免解码错误，并且性能更好
            // Safari 不支持 OGG/Opus 的 HTML5 播放，走 opus-decoder 软解码 + Web Audio；
            // Chrome/Edge/Firefox 原生支持 OGG，继续用 HTML5 Audio（更简单可靠）
            if (this.isSafari && this.opusDecoder) {
                try {
                    console.log('使用 Opus 解码器解码音频，数据大小:', opusData.length, '字节');
                    console.log('OpusDecoder 实例类型:', typeof this.opusDecoder);
                    console.log('OpusDecoder 可用方法:', Object.getOwnPropertyNames(Object.getPrototypeOf(this.opusDecoder)));
                    
                    // 检查数据是否是 OGG 格式（包含 OGG 容器）
                    const isOGG = opusData.length >= 4 && 
                                  opusData[0] === 0x4F && // 'O'
                                  opusData[1] === 0x67 && // 'g'
                                  opusData[2] === 0x67 && // 'g'
                                  opusData[3] === 0x53;   // 'S'
                    
                    if (isOGG) {
                        // OGG 容器格式，Opus 解码器可能无法直接处理
                        // 直接跳过，使用 HTML5 Audio
                        console.log('检测到 OGG 容器格式，使用 HTML5 Audio 播放');
                        throw new Error('OGG 容器格式，使用 HTML5 Audio');
                    }
                    
                    // 使用 decodeFrame 方法（OpusDecoder 的实际方法名）
                    let decodedAudio;
                    if (typeof this.opusDecoder.decodeFrame === 'function') {
                        console.log('使用 decodeFrame 方法解码音频...');
                        decodedAudio = await this.opusDecoder.decodeFrame(opusData);
                    } else if (typeof this.opusDecoder.decodeFrames === 'function') {
                        console.log('使用 decodeFrames 方法解码音频...');
                        decodedAudio = await this.opusDecoder.decodeFrames(opusData);
                    } else {
                        const props = Object.keys(this.opusDecoder);
                        console.error('❌ OpusDecoder 没有找到 decodeFrame 或 decodeFrames 方法');
                        console.error('可用属性:', props);
                        throw new Error(`OpusDecoder 没有找到解码方法。可用属性: ${props.join(', ')}`);
                    }
                    console.log('✓ Opus 解码成功');
                    console.log('解码结果类型:', typeof decodedAudio);
                    console.log('解码结果:', decodedAudio);
                    
                    // 检查解码结果的格式
                    // decodeFrame 可能返回 Float32Array 或包含 channelData 的对象
                    let pcmData;
                    let sampleRate = 24000;
                    
                    if (decodedAudio instanceof Float32Array) {
                        // 如果直接返回 Float32Array
                        pcmData = decodedAudio;
                        console.log('解码结果为 Float32Array，长度:', pcmData.length);
                    } else if (decodedAudio && decodedAudio.channelData && decodedAudio.channelData[0]) {
                        // 如果返回包含 channelData 的对象
                        pcmData = decodedAudio.channelData[0];
                        sampleRate = decodedAudio.sampleRate || 24000;
                        console.log('解码结果为对象，样本数:', pcmData.length, '采样率:', sampleRate);
                    } else if (decodedAudio && Array.isArray(decodedAudio)) {
                        // 如果返回数组
                        pcmData = new Float32Array(decodedAudio);
                        console.log('解码结果为数组，长度:', pcmData.length);
                    } else {
                        throw new Error('未知的解码结果格式: ' + JSON.stringify(decodedAudio));
                    }
                    
                    // 创建 AudioContext（如果还没有），使用固定采样率确保一致性
                    const fixedSampleRate = 24000;  // 固定采样率，避免变化
                    if (!this.ttsAudioContext || this.ttsAudioContext.state === 'closed') {
                        this.ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)({
                            sampleRate: fixedSampleRate
                        });
                        // 重置处理链节点
                        this.ttsCompressor = null;
                        this.ttsLowShelf = null;
                        this.ttsMidPeak = null;
                        this.ttsGainNode = null;
                    }
                    
                    // 确保音频上下文已激活
                    if (this.ttsAudioContext.state === 'suspended') {
                        await this.ttsAudioContext.resume();
                    }
                    
                    // 将解码后的 PCM 数据转换为 AudioBuffer（使用固定采样率）
                    const length = pcmData.length;
                    const audioBuffer = this.ttsAudioContext.createBuffer(
                        1,  // 单声道
                        length,
                        fixedSampleRate
                    );
                    
                    // 复制 PCM 数据到 AudioBuffer
                    const channelData = audioBuffer.getChannelData(0);
                    for (let i = 0; i < length; i++) {
                        channelData[i] = pcmData[i];
                    }
                    
                    // 创建音频源
                    const source = this.ttsAudioContext.createBufferSource();
                    source.buffer = audioBuffer;
                    source.playbackRate.value = this.playbackSpeed;  // 设置播放速度
                    
                    // 复用音频处理链节点（避免每次创建导致音色变化）
                    if (!this.ttsCompressor) {
                    // 1. 动态范围压缩器 - 让音频更平滑，减少生硬感
                        this.ttsCompressor = this.ttsAudioContext.createDynamicsCompressor();
                        this.ttsCompressor.threshold.value = -24;  // 阈值
                        this.ttsCompressor.knee.value = 30;        // 膝点
                        this.ttsCompressor.ratio.value = 12;       // 压缩比
                        this.ttsCompressor.attack.value = 0.003;   // 启动时间（3ms）
                        this.ttsCompressor.release.value = 0.25;   // 释放时间（250ms）
                    
                    // 2. 均衡器 - 优化音色，增强中频和低频
                        this.ttsLowShelf = this.ttsAudioContext.createBiquadFilter();
                        this.ttsLowShelf.type = 'lowshelf';
                        this.ttsLowShelf.frequency.value = 200;    // 低频增强
                        this.ttsLowShelf.gain.value = 2;           // 2dB 增益
                    
                        this.ttsMidPeak = this.ttsAudioContext.createBiquadFilter();
                        this.ttsMidPeak.type = 'peaking';
                        this.ttsMidPeak.frequency.value = 2000;    // 中频优化
                        this.ttsMidPeak.Q.value = 1;
                        this.ttsMidPeak.gain.value = 1.5;          // 1.5dB 增益
                    
                    // 3. 音量控制（GainNode）- 用于淡入淡出效果
                        this.ttsGainNode = this.ttsAudioContext.createGain();
                    
                        // 连接音频处理链：compressor -> lowShelf -> midPeak -> gainNode -> destination
                        this.ttsCompressor.connect(this.ttsLowShelf);
                        this.ttsLowShelf.connect(this.ttsMidPeak);
                        this.ttsMidPeak.connect(this.ttsGainNode);
                        this.ttsGainNode.connect(this.ttsAudioContext.destination);
                    }
                    
                    // 连接音频源到处理链
                    source.connect(this.ttsCompressor);
                    
                    // 淡出效果（仅当音频足够长时应用，不应用淡入以确保音频一开始就有声音）
                    const currentTime = this.ttsAudioContext.currentTime;
                    const fadeOutDuration = 0.05; // 50ms 淡出
                    
                    // 初始音量设置为1.0，确保音频一开始就有声音且音色一致
                    this.ttsGainNode.gain.setValueAtTime(1.0, currentTime);
                    
                    if (audioBuffer.duration > fadeOutDuration + 0.1) {
                        // 音频足够长，应用淡出效果
                        const fadeOutStart = currentTime + audioBuffer.duration - fadeOutDuration;
                        this.ttsGainNode.gain.setValueAtTime(1.0, fadeOutStart);
                        this.ttsGainNode.gain.linearRampToValueAtTime(0, currentTime + audioBuffer.duration);
                    }
                    
                    source.onended = () => {
                        console.log('✓ TTS 音频播放完成（Web Audio API）');
                        this.isPlayingTTS = false;
                        // 播放下一个队列中的音频
                        this.playNextQueuedTTS();
                    };
                    
                    source.start(0);
                    this.isPlayingTTS = true;
                    console.log(`▶️ 开始播放 TTS 音频（Web Audio API，已优化），时长: ${audioBuffer.duration.toFixed(2)} 秒`);
                    return;
                    
                } catch (decodeError) {
                    // Opus 解码失败，静默回退到 HTML5 Audio
                    // 不输出错误日志，因为这是预期的回退行为
                    console.log('使用 HTML5 Audio 播放（Opus 解码器不可用或数据格式不兼容）');
                }
            }
            
            // 方法2：使用 HTML5 Audio 元素（最可靠的方法）
            // 直接使用 Blob URL 播放 OGG Opus 文件
            console.log('使用 HTML5 Audio 元素播放 OGG Opus 音频...');
            
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
            audio.volume = 1.0;  // 设置最大音量
            audio.preload = 'auto';
            audio.playbackRate = this.playbackSpeed;  // 设置播放速度
            this.currentTTSAudio = audio;  // 保存当前音频引用，以便动态调整速度
            
            // 为 HTML5 Audio 添加音频处理链（通过 Web Audio API）
            // 如果可能，使用 Web Audio API 处理 HTML5 Audio 以优化音质
            let audioSourceNode = null;
            let gainNode = null;
            
            // 为 HTML5 Audio 创建或复用 AudioContext
            if (!this.ttsAudioContext || this.ttsAudioContext.state === 'closed') {
                this.ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: 24000  // 固定采样率
                });
                // 重置处理链节点
                this.ttsCompressor = null;
                this.ttsLowShelf = null;
                this.ttsMidPeak = null;
                this.ttsGainNode = null;
            }
            
            if (this.ttsAudioContext && this.ttsAudioContext.state !== 'closed') {
                try {
                    // 确保 AudioContext 处于运行状态
                    if (this.ttsAudioContext.state === 'suspended') {
                        await this.ttsAudioContext.resume();
                        console.log('✓ AudioContext 已恢复运行状态');
                    }
                    
                    // 创建 MediaElementSourceNode 来处理 HTML5 Audio
                    audioSourceNode = this.ttsAudioContext.createMediaElementSource(audio);
                    
                    // 简化音频处理链：只使用 gainNode 控制音量，避免复杂的处理链导致问题
                    if (!this.ttsGainNode) {
                        this.ttsGainNode = this.ttsAudioContext.createGain();
                        this.ttsGainNode.gain.value = 1.0;
                        this.ttsGainNode.connect(this.ttsAudioContext.destination);
                        console.log('✓ 创建 gainNode，初始音量:', this.ttsGainNode.gain.value);
                    }
                    
                    // 连接音频源到 gainNode（简化处理链，直接连接）
                    audioSourceNode.connect(this.ttsGainNode);
                    gainNode = this.ttsGainNode;  // 用于后续的淡出效果
                    
                    // 确保 gainNode 音量正确设置（取消之前可能残留的调度值）
                    const currentTime = this.ttsAudioContext.currentTime;
                    gainNode.gain.cancelScheduledValues(currentTime);
                    gainNode.gain.setValueAtTime(1.0, currentTime);
                    console.log('✓ 重置 gainNode 音量为 1.0');
                    
                    console.log('✓ 已为 HTML5 Audio 添加音频处理链，AudioContext 状态:', this.ttsAudioContext.state);
                } catch (error) {
                    console.warn('⚠️ 无法为 HTML5 Audio 添加处理链，使用默认播放:', error);
                    audioSourceNode = null;
                    gainNode = null;
                }
            }
            
            // 等待音频元数据加载
            await new Promise((resolve, reject) => {
                audio.onloadedmetadata = () => {
                    console.log(`✓ 音频元数据加载完成，时长: ${audio.duration.toFixed(2)} 秒`);
                    resolve();
                };
                
                // 如果元数据已经加载，立即解析
                if (audio.readyState >= 1) {
                    resolve();
                }
                audio.onerror = (error) => {
                    console.error('❌ HTML5 Audio 加载失败:', error);
                    if (audio.error) {
                        console.error('错误代码:', audio.error.code, '错误消息:', audio.error.message);
                    }
                    URL.revokeObjectURL(url);
                    reject(new Error(`音频加载失败: ${audio.error ? audio.error.message : '未知错误'}`));
                };
                
                // 超时处理
                setTimeout(() => {
                    if (audio.readyState < 2) {  // HAVE_CURRENT_DATA
                        console.warn('⚠️ 音频加载超时，尝试直接播放');
                        resolve();  // 继续尝试播放
                    }
                }, 2000);
            });
            
            audio.onplay = () => {
                console.log('▶️ TTS 音频开始播放（HTML5 Audio）');
                console.log('AudioContext 状态:', this.ttsAudioContext ? this.ttsAudioContext.state : 'N/A');
                console.log('gainNode 音量:', gainNode ? gainNode.gain.value : 'N/A');
                this.isPlayingTTS = true;
                this.ttsPlayStartTime = Date.now();
                this.lastTTSPlayTime = Date.now();
                this.ttsDropCount = 0;  // 播放正常，清除丢弃计数

                // 设置超时检测（如果音频播放超过 30 秒还没结束，强制重置状态）
                this.ttsPlayTimeout = setTimeout(() => {
                    if (this.isPlayingTTS && this.currentTTSAudio === audio) {
                        console.warn('⚠️ TTS 音频播放超时（30秒），强制重置状态');
                        this.isPlayingTTS = false;
                        this.currentTTSAudio = null;
                        URL.revokeObjectURL(url);
                        // 继续播放队列中的下一个
                        this.playNextQueuedTTS();
                    }
                }, 30000);  // 30秒超时
                
                // 确保 gainNode 在播放开始时设置为最大值
                if (gainNode) {
                    const currentTime = this.ttsAudioContext.currentTime;
                    gainNode.gain.cancelScheduledValues(currentTime);  // 取消所有已调度的值
                    gainNode.gain.setValueAtTime(1.0, currentTime);  // 设置为最大音量
                    
                    // 在音频开始播放时应用淡出效果（仅在音频结束时）
                    if (audio.duration > 0 && !isNaN(audio.duration)) {
                    const fadeOutDuration = 0.05; // 50ms 淡出
                    
                    // 仅当音频足够长时才应用淡出
                    if (audio.duration > fadeOutDuration + 0.1) {
                        // 淡出效果（在音频结束前开始）
                        const fadeOutStart = currentTime + audio.duration - fadeOutDuration;
                            gainNode.gain.setValueAtTime(1.0, fadeOutStart);
                        gainNode.gain.linearRampToValueAtTime(0, currentTime + audio.duration);
                        }
                    }
                }
            };
            
            audio.onended = () => {
                const playDuration = this.ttsPlayStartTime ? Date.now() - this.ttsPlayStartTime : 0;
                console.log(`✓ TTS 音频播放完成（HTML5 Audio），播放时长: ${playDuration}ms`);

                // 清除超时定时器
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }

                URL.revokeObjectURL(url);
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;  // 清除当前音频引用
                this.ttsPlayStartTime = null;

                // 播放下一个队列中的音频
                this.playNextQueuedTTS();
            };
            
            audio.onerror = (error) => {
                console.error('❌ HTML5 Audio 播放失败:', error);
                if (audio.error) {
                    console.error('错误代码:', audio.error.code, '错误消息:', audio.error.message);
                }

                // 清除超时定时器
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }

                URL.revokeObjectURL(url);
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;  // 清除当前音频引用
                this.ttsPlayStartTime = null;
                
                // 如果 HTML5 Audio 也失败，提示用户
                console.error('❌ 浏览器不支持 OGG Opus 格式');
                console.error('建议：使用 Chrome、Firefox 或 Edge 浏览器');

                // 即使播放失败，也尝试播放下一个队列中的音频
                this.playNextQueuedTTS();
            };
            
            try {
                // 如果使用了 Web Audio API 处理链，确保 AudioContext 处于运行状态
                if (audioSourceNode && this.ttsAudioContext) {
                    if (this.ttsAudioContext.state === 'suspended') {
                    await this.ttsAudioContext.resume();
                    console.log('✓ 播放前恢复 AudioContext 状态');
                    }
                    
                    // 确保 gainNode 在播放前设置为最大值（取消之前可能残留的淡出效果）
                    if (gainNode) {
                        const currentTime = this.ttsAudioContext.currentTime;
                        gainNode.gain.cancelScheduledValues(currentTime);
                        gainNode.gain.setValueAtTime(1.0, currentTime);
                        console.log('✓ 设置 gainNode 音量为 1.0（播放前）');
                    }
                }
                
                await audio.play();
                console.log(`▶️ 音频播放命令已发送（HTML5 Audio），时长: ${audio.duration ? audio.duration.toFixed(2) : '未知'} 秒，播放速度: ${this.playbackSpeed}x`);
                console.log(`音频音量: ${audio.volume}, 播放速度: ${audio.playbackRate}, gainNode 音量: ${gainNode ? gainNode.gain.value : 'N/A'}, AudioContext 状态: ${this.ttsAudioContext ? this.ttsAudioContext.state : 'N/A'}`);
            } catch (playError) {
                console.error('❌ 播放失败:', playError);
                URL.revokeObjectURL(url);
                throw playError;
            }
            
        } catch (error) {
            console.error('❌ 播放 TTS 音频失败:', error);
            console.error('错误堆栈:', error.stack);
            this.isPlayingTTS = false;
        }
    }
 
    updateStatus(text, className) {
        // 状态显示已移至左侧控制区域，此方法保留用于兼容性但不执行任何操作
        // this.statusEl.textContent = text;
        // this.statusEl.className = `status ${className}`;
    }
    
    updateConnectionStatus(text, className) {
        this.connectionStatusEl.textContent = text;
        this.connectionStatusEl.className = `info-value ${className}`;
    }
    
    updateMicStatus(text, className) {
        this.micStatusEl.textContent = text;
        this.micStatusEl.className = `info-value ${className}`;
    }
    
    updateAudioSourceStatus() {
        /**
         * 更新音频源状态显示
         */
        if (this.audioSourceStatusEl) {
            const sourceName = this.audioSource === 'system' ? '系统音频' : '麦克风';
            this.audioSourceStatusEl.textContent = sourceName;
            this.audioSourceStatusEl.className = 'info-value';
        }
    }
    
    showError(message) {
        console.error(message);
        alert(message);
    }

    showWarning(message) {
        console.warn(message);
        alert(message);
    }
    
    async testMicrophone() {
        if (this.isTesting) {
            return;
        }
        
        try {
            console.log('开始测试麦克风...');
            this.isTesting = true;
            if (this.testMicBtn) this.testMicBtn.disabled = true;
            if (this.audioTestPanel) this.audioTestPanel.style.display = 'block';
            
            // 获取麦克风权限
            this.testMediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,  // 测试时关闭，以便更准确地检测音量
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            
            console.log('麦克风权限已获取');
            this.updateMicStatus('测试中', 'active');
            
            // 创建音频上下文
            this.testAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = this.testAudioContext.createMediaStreamSource(this.testMediaStream);
            
            // 创建音频分析器
            const analyser = this.testAudioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            
            // 创建可视化条
            if (this.audioVisualizer) {
                const barCount = 32;
                this.audioVisualizer.innerHTML = '';
                this.visualizerBars = [];
                for (let i = 0; i < barCount; i++) {
                    const bar = document.createElement('div');
                    bar.className = 'visualizer-bar';
                    this.audioVisualizer.appendChild(bar);
                    this.visualizerBars.push(bar);
                }
            }
            
            // 使用 ScriptProcessorNode 获取实时音频数据
            const bufferSize = 4096;
            const processor = this.testAudioContext.createScriptProcessor(bufferSize, 1, 1);
            
            processor.onaudioprocess = (e) => {
                if (!this.isTesting) {
                    return;
                }
                
                const inputData = e.inputBuffer.getChannelData(0);
                
                // 计算音量
                let sum = 0;
                for (let i = 0; i < inputData.length; i++) {
                    sum += Math.abs(inputData[i]);
                }
                const average = sum / inputData.length;
                const volume = Math.min(average * 200, 100); // 放大并限制在 100%
                
                // 更新音量条
                if (this.volumeBar) {
                    this.volumeBar.style.width = volume + '%';
                }
                if (this.volumeText) {
                    this.volumeText.textContent = `音量: ${volume.toFixed(1)}%`;
                }
                
                // 更新可视化
                if (this.visualizerBars.length > 0) {
                    const dataArray = new Uint8Array(analyser.frequencyBinCount);
                    analyser.getByteFrequencyData(dataArray);
                    
                    const barCount = this.visualizerBars.length;
                    const step = Math.floor(dataArray.length / barCount);
                    
                    for (let i = 0; i < barCount; i++) {
                        const value = dataArray[i * step] || 0;
                        const height = (value / 255) * 100;
                        this.visualizerBars[i].style.height = Math.max(height, 2) + '%';
                    }
                }
            };
            
            source.connect(processor);
            processor.connect(this.testAudioContext.destination);
            this.testProcessor = processor;
            
            console.log('麦克风测试已启动，请说话测试...');
            
        } catch (error) {
            console.error('麦克风测试失败:', error);
            let errorMessage = '无法访问麦克风';
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                errorMessage = '麦克风权限被拒绝，请在浏览器设置中允许访问麦克风';
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                errorMessage = '未找到麦克风设备，请检查设备连接';
            } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                errorMessage = '麦克风被其他应用占用，请关闭其他应用后重试';
            } else if (error.message) {
                errorMessage = `麦克风测试失败: ${error.message}`;
            }
            this.showError(errorMessage);
            this.stopTest();
        }
    }
    
    stopTest() {
        this.isTesting = false;
        if (this.testMicBtn) this.testMicBtn.disabled = false;
        if (this.audioTestPanel) this.audioTestPanel.style.display = 'none';
        if (this.volumeBar) this.volumeBar.style.width = '0%';
        if (this.volumeText) this.volumeText.textContent = '音量: 0%';
        
        // 清理可视化
        if (this.visualizerBars.length > 0) {
            this.visualizerBars.forEach(bar => {
                bar.style.height = '2px';
            });
            this.visualizerBars = [];
        }
        
        // 停止音频处理
        if (this.testProcessor) {
            this.testProcessor.disconnect();
            this.testProcessor = null;
        }
        
        if (this.testAudioContext) {
            this.testAudioContext.close();
            this.testAudioContext = null;
        }
        
        if (this.testMediaStream) {
            this.testMediaStream.getTracks().forEach(track => track.stop());
            this.testMediaStream = null;
        }
        
        this.updateMicStatus('未启用', '');
        console.log('麦克风测试已停止');
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
            audio.playbackRate = this.playbackSpeed;
            this.currentTTSAudio = audio;

            // iOS 特殊处理：等待用户交互后再播放
            if (!this.hasUserInteracted) {
                console.warn('⚠️ iOS 需要用户交互才能播放音频，等待用户点击...');
                // 暂时不播放，等待用户交互
                // 实际音频会在用户下次点击按钮时播放
                this.pendingAudioPlay = audio;
                return;
            }

            // 设置超时检测
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
                console.log('▶️ iOS TTS 音频开始播放');
                this.isPlayingTTS = true;
                this.ttsPlayStartTime = Date.now();
                this.lastTTSPlayTime = Date.now();
                this.ttsDropCount = 0;  // 播放正常，清除丢弃计数
            };

            audio.onended = () => {
                const playDuration = this.ttsPlayStartTime ? Date.now() - this.ttsPlayStartTime : 0;
                console.log(`✓ iOS TTS 音频播放完成，播放时长: ${playDuration}ms`);

                // 清除超时定时器
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }

                URL.revokeObjectURL(url);
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;
                this.ttsPlayStartTime = null;

                // 播放下一个队列中的音频
                this.playNextQueuedTTS();
            };

            audio.onerror = (error) => {
                console.error('❌ iOS HTML5 Audio 播放失败:', error);
                if (audio.error) {
                    console.error('错误代码:', audio.error.code, '错误消息:', audio.error.message);
                }

                // 清除超时定时器
                if (this.ttsPlayTimeout) {
                    clearTimeout(this.ttsPlayTimeout);
                    this.ttsPlayTimeout = null;
                }

                URL.revokeObjectURL(url);
                this.isPlayingTTS = false;
                this.currentTTSAudio = null;
                this.ttsPlayStartTime = null;

                // 即使播放失败，也尝试播放下一个队列中的音频
                this.playNextQueuedTTS();
            };

            // 尝试播放
            try {
                await audio.play();
                console.log(`▶️ iOS 音频播放命令已发送，时长: ${audio.duration ? audio.duration.toFixed(2) : '未知'} 秒`);
            } catch (playError) {
                console.error('❌ iOS 播放失败:', playError);
                URL.revokeObjectURL(url);
                throw playError;
            }

        } catch (error) {
            console.error('❌ iOS 播放 TTS 音频失败:', error);
            console.error('错误堆栈:', error.stack);
            this.isPlayingTTS = false;
        }
    }

    triggerPendingAudioPlay() {
        /**
         * 触发待播放的音频（用户交互后调用）
         */
        if (this.pendingAudioPlay && this.hasUserInteracted) {
            console.log('▶️ 触发待播放的音频');
            const audio = this.pendingAudioPlay;
            this.pendingAudioPlay = null;

            audio.play().catch(error => {
                console.error('播放待播放音频失败:', error);
            });
        }
    }
    
    applyFontSize() {
        /**
         * 应用字体大小设置
         */
        const fontSizeMultiplier = this.fontSize / 100; // 转换为倍数，如 100% = 1.0
        
        // 设置文本显示区域的字体大小
        if (this.sourceTextEl) {
            this.sourceTextEl.style.fontSize = `${1.3 * fontSizeMultiplier}em`;
        }
        if (this.targetTextEl) {
            this.targetTextEl.style.fontSize = `${1.3 * fontSizeMultiplier}em`;
        }
        
        // 设置当前文本的字体大小（相对于基础字体）
        const currentTextElements = document.querySelectorAll('.text-display .current-text');
        currentTextElements.forEach(el => {
            el.style.fontSize = `${1.5 * fontSizeMultiplier}em`;
        });
        
        console.log('字体大小已应用:', this.fontSize + '%', '倍数:', fontSizeMultiplier);
    }
    
    toggleFullscreen(type) {
        /**
         * 切换全屏显示（支持浏览器原生全屏和网页全屏两种模式）
         * @param {string} type - 'source' 或 'target'
         */
        console.log('toggleFullscreen 被调用，类型:', type);
        
        const section = type === 'source' ? this.sourceTextSection : this.targetTextSection;
        const btn = type === 'source' ? this.sourceFullscreenBtn : this.targetFullscreenBtn;
        
        if (!section) {
            console.error('找不到文本区域元素，type:', type);
            return;
        }
        
        if (!btn) {
            console.error('找不到全屏按钮，type:', type);
            return;
        }
        
        // 检查是否已浏览器原生全屏
        const isBrowserFullscreen = document.fullscreenElement || 
                                    document.webkitFullscreenElement || 
                                    document.mozFullScreenElement || 
                                    document.msFullscreenElement;
        
        // 检查是否已网页全屏（单个区域）
        const isPageFullscreen = this.singleSectionPageFullscreen === type;
        
        console.log('当前浏览器全屏状态:', isBrowserFullscreen, '当前网页全屏状态:', isPageFullscreen);
        
        if (isBrowserFullscreen === section) {
            // 退出浏览器原生全屏
            console.log('退出浏览器原生全屏');
            this.exitFullscreen();
        } else if (isPageFullscreen) {
            // 退出网页全屏
            console.log('退出网页全屏（单个区域）');
            this.exitSingleSectionPageFullscreen();
        } else {
            // 进入网页全屏（单个区域）
            console.log('进入网页全屏（单个区域）');
            this.enterSingleSectionPageFullscreen(type);
        }
    }
    
    async enterFullscreen(element, type) {
        /**
         * 进入全屏
         * @param {HTMLElement} element - 要全屏的元素
         * @param {string} type - 'source' 或 'target'
         */
        try {
            console.log('尝试进入全屏，元素:', element, '类型:', type);
            
            // 检查浏览器是否支持全屏API
            if (!element.requestFullscreen && 
                !element.webkitRequestFullscreen && 
                !element.mozRequestFullScreen && 
                !element.msRequestFullscreen) {
                console.error('浏览器不支持全屏API');
                this.showError('您的浏览器不支持全屏功能');
                return;
            }
            
            let promise;
            if (element.requestFullscreen) {
                promise = element.requestFullscreen();
            } else if (element.webkitRequestFullscreen) {
                promise = element.webkitRequestFullscreen();
            } else if (element.mozRequestFullScreen) {
                promise = element.mozRequestFullScreen();
            } else if (element.msRequestFullscreen) {
                promise = element.msRequestFullscreen();
            }
            
            if (promise) {
                await promise;
                console.log('全屏请求已发送');
            }
            
            // 注意：全屏状态变化会在 handleFullscreenChange 中处理
            // 这里不立即更新状态，等待 fullscreenchange 事件
        } catch (error) {
            console.error('进入全屏失败:', error);
            this.showError(`无法进入全屏模式: ${error.message || '未知错误'}`);
        }
    }
    
    async exitFullscreen() {
        /**
         * 退出浏览器原生全屏
         */
        try {
            if (document.exitFullscreen) {
                await document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                await document.webkitExitFullscreen();
            } else if (document.mozCancelFullScreen) {
                await document.mozCancelFullScreen();
            } else if (document.msExitFullscreen) {
                await document.msExitFullscreen();
            }
            
            this.isSourceFullscreen = false;
            this.isTargetFullscreen = false;
            
            // 移除全屏样式类
            if (this.sourceTextSection) {
                this.sourceTextSection.classList.remove('fullscreen-active');
                // 只有在不是网页全屏时才更新图标
                if (this.singleSectionPageFullscreen !== 'source') {
                    this.updateFullscreenButtonIcon('source', false);
                }
            }
            if (this.targetTextSection) {
                this.targetTextSection.classList.remove('fullscreen-active');
                // 只有在不是网页全屏时才更新图标
                if (this.singleSectionPageFullscreen !== 'target') {
                    this.updateFullscreenButtonIcon('target', false);
                }
            }
        } catch (error) {
            console.error('退出全屏失败:', error);
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
            
            if (this.sourceTextSection) {
                this.sourceTextSection.classList.remove('fullscreen-active');
                // 只有在不是网页全屏时才更新图标
                if (this.singleSectionPageFullscreen !== 'source') {
                    this.updateFullscreenButtonIcon('source', false);
                }
            }
            if (this.targetTextSection) {
                this.targetTextSection.classList.remove('fullscreen-active');
                // 只有在不是网页全屏时才更新图标
                if (this.singleSectionPageFullscreen !== 'target') {
                    this.updateFullscreenButtonIcon('target', false);
                }
            }
        } else {
            // 已进入浏览器原生全屏
            if (isFullscreen === this.sourceTextSection) {
                this.isSourceFullscreen = true;
                this.sourceTextSection.classList.add('fullscreen-active');
                this.updateFullscreenButtonIcon('source', true);
            } else if (isFullscreen === this.targetTextSection) {
                this.isTargetFullscreen = true;
                this.targetTextSection.classList.add('fullscreen-active');
                this.updateFullscreenButtonIcon('target', true);
            }
        }
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
                btn.title = '退出全屏';
            } else {
                fullscreenIcon.style.display = 'block';
                exitFullscreenIcon.style.display = 'none';
                btn.title = '全屏显示';
            }
        }
    }
    
    enterSingleSectionPageFullscreen(type) {
        /**
         * 进入单个区域的网页全屏（隐藏控制区域，只显示指定的文本区域）
         * @param {string} type - 'source' 或 'target'
         */
        this.singleSectionPageFullscreen = type;
        
        // 隐藏控制区域
        if (this.controlSection) {
            this.controlSection.style.display = 'none';
        }
        
        // 隐藏另一个文本区域
        if (type === 'source') {
            if (this.targetTextSection) {
                this.targetTextSection.style.display = 'none';
            }
        } else {
            if (this.sourceTextSection) {
                this.sourceTextSection.style.display = 'none';
            }
        }
        
        // 添加全屏样式
        if (this.mainLayout) {
            this.mainLayout.classList.add('page-fullscreen-active');
        }
        if (this.textSectionsContainer) {
            this.textSectionsContainer.classList.add('page-fullscreen-active');
            this.textSectionsContainer.classList.add('single-section-mode');  // 标记为单个区域模式
        }
        
        const section = type === 'source' ? this.sourceTextSection : this.targetTextSection;
        if (section) {
            section.classList.add('single-page-fullscreen-active');
        }
        
        // 更新按钮图标
        this.updateFullscreenButtonIcon(type, true);
        
        console.log(`进入单个区域网页全屏模式: ${type}`);
    }
    
    exitSingleSectionPageFullscreen() {
        /**
         * 退出单个区域的网页全屏
         */
        const type = this.singleSectionPageFullscreen;
        if (!type) return;
        
        // 显示控制区域
        if (this.controlSection) {
            this.controlSection.style.display = '';
        }
        
        // 显示所有文本区域
        if (this.sourceTextSection) {
            this.sourceTextSection.style.display = '';
        }
        if (this.targetTextSection) {
            this.targetTextSection.style.display = '';
        }
        
        // 移除全屏样式
        if (this.mainLayout) {
            this.mainLayout.classList.remove('page-fullscreen-active');
        }
        if (this.textSectionsContainer) {
            this.textSectionsContainer.classList.remove('page-fullscreen-active');
            this.textSectionsContainer.classList.remove('single-section-mode');  // 移除单个区域模式标记
        }
        
        const section = type === 'source' ? this.sourceTextSection : this.targetTextSection;
        if (section) {
            section.classList.remove('single-page-fullscreen-active');
        }
        
        // 更新按钮图标
        this.updateFullscreenButtonIcon(type, false);
        
        this.singleSectionPageFullscreen = null;
        console.log(`退出单个区域网页全屏模式: ${type}`);
    }
    
    togglePageFullscreen() {
        /**
         * 切换网页全屏（隐藏控制区域，文本区域全屏到浏览器窗口大小）
         */
        // 如果当前是单个区域网页全屏，先退出
        if (this.singleSectionPageFullscreen) {
            this.exitSingleSectionPageFullscreen();
        }
        
        this.isPageFullscreen = !this.isPageFullscreen;
        
        if (this.isPageFullscreen) {
            // 进入网页全屏：隐藏控制区域，文本区域占据整个窗口
            if (this.controlSection) {
                this.controlSection.style.display = 'none';
            }
            if (this.mainLayout) {
                this.mainLayout.classList.add('page-fullscreen-active');
            }
            if (this.textSectionsContainer) {
                this.textSectionsContainer.classList.add('page-fullscreen-active');
            }
            this.updatePageFullscreenButtonIcon(true);
            console.log('进入网页全屏模式');
        } else {
            // 退出网页全屏：显示控制区域
            if (this.controlSection) {
                this.controlSection.style.display = '';
            }
            if (this.mainLayout) {
                this.mainLayout.classList.remove('page-fullscreen-active');
            }
            if (this.textSectionsContainer) {
                this.textSectionsContainer.classList.remove('page-fullscreen-active');
            }
            this.updatePageFullscreenButtonIcon(false);
            console.log('退出网页全屏模式');
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
                this.pageFullscreenBtn.title = '退出网页全屏';
            } else {
                fullscreenIcon.style.display = 'block';
                exitFullscreenIcon.style.display = 'none';
                this.pageFullscreenBtn.title = '网页全屏';
            }
        }
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    window.app = new TranslationApp();

    // iOS 音频播放：添加全局点击监听器，确保用户交互后能播放音频
    document.addEventListener('click', () => {
        if (window.app && window.app.isIOS) {
            window.app.hasUserInteracted = true;
            window.app.triggerPendingAudioPlay();
        }
    }, { once: false });
});
