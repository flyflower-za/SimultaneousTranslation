// 共享工具函数（经典脚本，挂载到 window，供各页面脚本直接使用）
// 去重来源：admin.html 内联脚本、app.js、viewer.js、my_meetings.js
(function () {
    'use strict';

    // HTML 转义（防 XSS）
    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // 通用 fetch 封装：401 时回调（默认跳转首页），非 2xx 抛出 data.error
    async function apiFetch(path, opts, onUnauthorized, unauthorizedMessage = '未登录') {
        const resp = await fetch(path, opts);
        if (resp.status === 401) {
            if (onUnauthorized) onUnauthorized();
            throw new Error(unauthorizedMessage);
        }
        let data = {};
        try { data = await resp.json(); } catch (e) {}
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
    }

    // POST JSON 快捷封装
    function postJSON(path, body, onUnauthorized) {
        return apiFetch(path, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body || {}),
        }, onUnauthorized);
    }

    // 轻量 toast 提示
    function toast(text, ok = true) {
        const t = document.createElement('div');
        t.className = 'toast';
        t.style.background = ok ? '#24243e' : '#c0392b';
        t.textContent = text;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2600);
    }

    // 格式化工具
    function fmtInt(n) { return Number(n || 0).toLocaleString('zh-CN'); }
    function fmtMin(sec) { return (sec / 60).toFixed(0) + ' 分钟'; }
    function fmtDT(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : '-'; }

    window.Shared = { esc, apiFetch, postJSON, toast, fmtInt, fmtMin, fmtDT };
})();
