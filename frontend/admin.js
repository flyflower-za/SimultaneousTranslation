let TAB = 'requests';
// 分页状态: 每个 tab 独立 offset / limit, 全局累积 rows
const PAGE = {
    pending:     { offset: 0, limit: 10, total: 0, rows: [], loading: false, q: '' },
    codes:       { offset: 0, limit: 10, total: 0, rows: [], loading: false, q: '', status: '' },
    usageByCode: { offset: 0, limit: 10, total: 0, rows: [], loading: false, days: 30, rendered: false },
    usageByDay:  { offset: 0, limit: 10, total: 0, rows: [], loading: false, days: 30, rendered: false },
    usageByToken:{ offset: 0, limit: 10, total: 0, rows: [], loading: false, days: 30, rendered: false },
    audit:       { offset: 0, limit: 10, total: 0, rows: [], loading: false },
};
// 当前选中的 subtab: 'code' / 'day' / 'token'
let USAGE_VIEW = 'code';
function switchUsageView(v) {
    USAGE_VIEW = v;
    document.querySelectorAll('[data-uview]').forEach(el => el.classList.toggle('active', el.dataset.uview === v));
    document.getElementById('usageViewCode').classList.toggle('hidden', v !== 'code');
    document.getElementById('usageViewDay').classList.toggle('hidden',  v !== 'day');
    document.getElementById('usageViewToken').classList.toggle('hidden', v !== 'token');
    if (v === 'token') {
        // Token 视图独立分页（每页 10 条），与按访问码互不干扰
        if (!PAGE.usageByToken.rendered) {
            loadUsageToken();
        } else {
            renderTokenView();
        }
        return;
    }
    const targetState = (v === 'code') ? PAGE.usageByCode : PAGE.usageByDay;
    if (!targetState.rendered) {
        // 首次切到该 subtab: 只重置这一边, 拉首页 + 渲染, 不动另一边已加载的页
        loadUsage(true, v);
    } else {
        // 已渲染过：仅本地重渲染，绝不追加（否则切一次标签就多加载一页）
        if (v === 'code') renderUsageCodeView();
        else renderUsageDayView();
    }
}
function debounce(fn, ms) {
    let t = null;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
    };
}
function renderLoadMore(state, containerId, onLoad) {
    const c = document.getElementById(containerId);
    if (!c) return;
    const shown = state.rows.length;
    const remaining = state.total - shown;
    if (state.loading) {
        c.innerHTML = '<div class="hint">加载中…</div>';
    } else if (remaining > 0) {
        // 把函数体 stringify 到 onclick 里, 简单可靠
        const body = onLoad.toString();
        c.innerHTML = '<button class="btn sm ghost" onclick="(' + body + ')()">加载更多 · 还剩 ' + remaining + ' 条</button>'
                    + '<span class="hint" style="margin-left:10px;">已显示 ' + shown + ' / ' + state.total + '</span>';
    } else if (state.total > 0) {
        c.innerHTML = '<span class="hint">已显示全部 ' + state.total + ' 条</span>';
    } else {
        c.innerHTML = '';
    }
}
function resetAndLoad(tab) {
    if (tab === 'codes') {
        PAGE.codes.offset = 0; PAGE.codes.rows = [];
        PAGE.codes.q = document.getElementById('codesQ').value.trim();
        PAGE.codes.status = document.getElementById('codesStatus').value;
        document.getElementById('codesTable').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
        loadCodes(true);
    } else if (tab === 'usage') {
        PAGE.usageByCode.offset = 0; PAGE.usageByCode.rows = [];
        PAGE.usageByDay.offset = 0; PAGE.usageByDay.rows = [];
        PAGE.usageByToken.offset = 0; PAGE.usageByToken.rows = []; PAGE.usageByToken.rendered = false;
        const d = parseInt(document.getElementById('usageDays').value, 10);
        PAGE.usageByCode.days = d; PAGE.usageByDay.days = d; PAGE.usageByToken.days = d;
        document.getElementById('usageByCode').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
        document.getElementById('usageByDay').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
        if (USAGE_VIEW === 'token') {
            loadUsageToken();
        } else {
            loadUsage(true);
        }
    } else if (tab === 'pending') {
        PAGE.pending.offset = 0; PAGE.pending.rows = [];
        PAGE.pending.q = (document.getElementById('pendingQ') || {}).value || '';
        PAGE.pending.q = PAGE.pending.q.trim();
        document.getElementById('pendingTable').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
        loadRequests();
    }
}

// api/post/esc/toast/fmtInt/fmtMin/fmtDT 由 shared.js 提供（401 时回到登录框）
const { esc, toast, fmtInt, fmtMin, fmtDT } = Shared;
async function api(path, opts) {
    const resp = await fetch(path, opts);
    if (resp.status === 401 && !path.includes('login')) {
        document.getElementById('loginWrap').classList.remove('hidden');
        document.getElementById('adminApp').classList.add('hidden');
        throw new Error('未登录');
    }
    let data = {};
    try { data = await resp.json(); } catch (e) {}
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
}
async function post(path, body) {
    return api(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
}

// ---------- 登录 ----------
async function adminLogin() {
    const pwd = document.getElementById('adminPwd').value;
    try {
        await post('/api/admin/login', {password: pwd});
        enterAdmin();
    } catch (e) {
        document.getElementById('loginErr').textContent = e.message;
    }
}
document.getElementById('adminPwd').addEventListener('keydown', e => { if (e.key === 'Enter') adminLogin(); });

async function enterAdmin() {
    document.getElementById('loginWrap').classList.add('hidden');
    document.getElementById('adminApp').classList.remove('hidden');
    switchTab('requests');
}

// ---------- Tab ----------
function switchTab(tab) {
    TAB = tab;
    document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(el => el.classList.add('hidden'));
    document.getElementById('panel-' + tab).classList.remove('hidden');
    refreshAll();
}
async function refreshAll() {
    if (TAB === 'requests') await loadRequests();
    else if (TAB === 'codes') await loadCodes(true);
    else if (TAB === 'usage') await loadUsage(true);
    else if (TAB === 'audit') await loadAudit();
    else if (TAB === 'rooms') await loadRooms();
    else if (TAB === 'meetings') await loadMeetings();
    else if (TAB === 'minutes-model') await loadMinutesModelSettings();
}

let selectedMeeting = null;
async function loadMeetings() {
    try {
        const data = await api('/api/admin/meetings');
        const root = document.getElementById('meetingsTable');
        root.replaceChildren();
        const table = document.createElement('table');
        table.innerHTML = '<tr><th>会议</th><th>申请人</th><th>开始</th><th>状态</th><th>发布</th><th>操作</th></tr>';
        for (const m of data.meetings) {
            const tr = document.createElement('tr');
            for (const value of [m.title || '未命名会议', m.applicant, fmtDT(m.started_at),
                    m.status, m.published_at ? '已发布' : '未发布']) {
                const td = document.createElement('td');
                td.textContent = value;
                tr.appendChild(td);
            }
            const td = document.createElement('td');
            const button = document.createElement('button');
            button.className = 'btn sm ghost';
            button.textContent = '查看与编辑';
            button.onclick = () => openMeeting(m.id);
            td.appendChild(button);
            tr.appendChild(td);
            table.appendChild(tr);
        }
        root.appendChild(table);
    } catch (e) { toast(e.message, false); }
}
async function openMeeting(id) {
    try {
        const data = await api(`/api/admin/meetings/${id}`);
        selectedMeeting = data.meeting;
        document.getElementById('meetingDetail').classList.remove('hidden');
        document.getElementById('meetingTitle').textContent = `${selectedMeeting.title || '会议'} · #${id} · ${selectedMeeting.status}`;
        document.getElementById('meetingGenerationInfo').textContent = [
            selectedMeeting.error || '',
            selectedMeeting.retry_count ? `已尝试 ${selectedMeeting.retry_count} 次` : '',
            selectedMeeting.next_retry_at ? `下次重试：${fmtDT(selectedMeeting.next_retry_at)}` : ''
        ].filter(Boolean).join(' · ');
        document.getElementById('meetingMinutes').value = selectedMeeting.minutes_text || '';
        const versions = document.getElementById('meetingVersionSelect');
        versions.replaceChildren();
        for (const version of data.versions || []) {
            const option = document.createElement('option');
            option.value = version.id;
            option.textContent = `v${version.version_no} · ${version.source} · ${fmtDT(version.created_at)}${version.published_at ? ' · 曾发布' : ''}`;
            versions.appendChild(option);
        }
        if (versions.value) await previewMeetingVersion();
        else document.getElementById('meetingVersionPreview').textContent = '暂无历史版本';
        const totals = data.model_totals || {};
        const calls = (data.model_calls || []).map(c =>
            `${fmtDT(c.created_at)} · 第 ${c.attempt_no} 次 · ${c.stage} · 输入 ${c.input_tokens ?? '未知'} / 输出 ${c.output_tokens ?? '未知'} Token · 成本 ${c.cost == null ? '未知' : `${c.cost.toFixed(4)} ${c.currency || 'CNY'}`}`);
        const costSummary = (totals.costs || []).map(c => `${c.cost.toFixed(4)} ${c.currency}`).join(' + ') || '未知';
        document.getElementById('meetingModelUsage').textContent =
            `调用 ${totals.calls || 0} 次；输入 ${totals.input_tokens ?? '未知'} / 输出 ${totals.output_tokens ?? '未知'} Token；累计成本 ${costSummary}\n` + calls.join('\n');
        document.getElementById('meetingTranscript').textContent = data.segments.map(s =>
            `[${fmtDT(s.occurred_at)}] ${s.kind === 'source' ? '原文' : '译文'}：${s.text}`).join('\n');
    } catch (e) { toast(e.message, false); }
}
async function previewMeetingVersion() {
    if (!selectedMeeting) return;
    const id = document.getElementById('meetingVersionSelect').value;
    if (!id) return;
    try {
        const data = await api(`/api/admin/meetings/${selectedMeeting.id}/versions/${id}`);
        document.getElementById('meetingVersionPreview').textContent = data.version.content;
    } catch (e) { toast(e.message, false); }
}
async function meetingAction(action) {
    if (!selectedMeeting) return;
    if (action === 'revoke_share' && !confirm('撤销后原分享链接将无法查看纪要，确定？')) return;
    if (action === 'delete' && !confirm('永久删除本场纪要和字幕，确定？')) return;
    try {
        const body = {action};
        if (action === 'save') body.minutes_text = document.getElementById('meetingMinutes').value;
        if (action === 'restore') body.version_id = Number(document.getElementById('meetingVersionSelect').value);
        await post(`/api/admin/meetings/${selectedMeeting.id}`, body);
        toast(action === 'generate' ? '已开始生成，请稍后刷新' : '操作成功');
        if (action === 'delete') {
            selectedMeeting = null;
            document.getElementById('meetingDetail').classList.add('hidden');
        } else await openMeeting(selectedMeeting.id);
        await loadMeetings();
    } catch (e) { toast(e.message, false); }
}
function downloadMeetingMinutes() {
    if (!selectedMeeting) return;
    location.href = `/api/admin/meetings/${selectedMeeting.id}/download?format=md`;
}
function downloadMeetingPdf() {
    if (!selectedMeeting) return;
    location.href = `/api/admin/meetings/${selectedMeeting.id}/download?format=pdf`;
}
async function copyMeetingLink() {
    if (!selectedMeeting || selectedMeeting.share_revoked_at) return toast('分享已撤销', false);
    const url = `${location.origin}/viewer?room=${encodeURIComponent(selectedMeeting.room_id)}&share=${encodeURIComponent(selectedMeeting.share_token)}`;
    try { await navigator.clipboard.writeText(url); toast('链接已复制'); }
    catch (e) { toast('复制失败', false); }
}

async function loadMinutesModelSettings() {
    try {
        const data = await api('/api/admin/minutes-settings');
        const settings = data.settings;
        const form = document.getElementById('minutesModelForm');
        for (const name of ['base_url','model','output_language','timeout_sec','chunk_chars',
                            'max_tokens','max_attempts','retry_delay_sec','input_per_million',
                            'output_per_million','currency']) {
            form.elements[name].value = settings[name] ?? form.elements[name].defaultValue;
        }
        form.elements.api_key.value = '';
        form.elements.clear_api_key.checked = false;
        const statusEl = document.getElementById('minutesModelStatus');
        const keyText = `API Key：${settings.api_key_set ? '已配置' : '未配置'}${settings.api_key_from_env ? '（由环境变量提供）' : ''}`;
        const modelText = settings.model ? ` · 模型：${settings.model}` : '';
        statusEl.textContent = keyText + modelText;
        statusEl.className = 'mm-status ' + (settings.api_key_set ? 'ok' : 'err');
        statusEl.style.display = 'inline-flex';
    } catch (e) { toast(e.message, false); }
}
async function saveMinutesModelSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {};
    for (const name of ['base_url','model','output_language','timeout_sec','chunk_chars',
                        'max_tokens','max_attempts','retry_delay_sec','input_per_million',
                        'output_per_million','currency']) body[name] = form.elements[name].value;
    if (form.elements.api_key.value) body.api_key = form.elements.api_key.value;
    body.clear_api_key = form.elements.clear_api_key.checked;
    try {
        await post('/api/admin/minutes-settings', body);
        toast('模型配置已保存');
        await loadMinutesModelSettings();
    } catch (e) { toast(e.message, false); }
}

// ---------- 活跃房间 ----------
async function loadRooms() {
    const data = await api('/api/admin/rooms');
    const rooms = data.rooms || [];
    const html = rooms.length ? `<table>
        <tr><th>房间</th><th>访问码</th><th>申请人</th><th>主题</th><th>运行时长</th><th>控制端</th><th>查看端数</th><th>创建时间</th><th>查看端链接</th></tr>
        ${rooms.map(r => `<tr>
            <td class="code-val">${esc(r.room_id)}</td>
            <td class="code-val">${esc(r.code) || '-'}</td>
            <td>${esc(r.applicant) || '-'}${r.department ? `<br><span style="color:#9aa0b5;font-size:12px;">${esc(r.department)}</span>` : ''}</td>
            <td>${esc(r.topic) || '-'}</td>
            <td>${Math.floor(r.uptime_sec / 60)} 分钟</td>
            <td>${r.has_controller
                ? '<span class="tag active">在线</span>'
                : '<span class="tag pending">等待重连</span>'}</td>
            <td>${r.viewer_count}</td>
            <td>${fmtDT(new Date(r.created_at * 1000).toISOString())}</td>
            <td><button class="btn sm ghost" onclick="navigator.clipboard.writeText(location.origin + '/viewer?room=' + '${esc(r.room_id)}' + '&share=' + '${esc(r.share_token || '')}').then(() => toast('链接已复制'))">复制链接</button></td>
        </tr>`).join('')}</table>`
        : '<div class="empty">当前没有进行中的房间</div>';
    document.getElementById('roomsTable').innerHTML = html;
}

// ---------- 申请 ----------
// loadRequests(append): undefined/false=从头加载, true=加载下一页
async function loadRequests(append = false) {
    const P = PAGE.pending;
    if (!append) { P.offset = 0; P.rows = []; P.q = (document.getElementById('pendingQ')?.value || '').trim(); }

    // tab 角标: 始终显示总待审批数(不受搜索影响)
    const badge = document.getElementById('tabBadgeRequests');
    if (badge) {
      const allPending = await api('/api/admin/requests?status=pending&limit=1');
      const n = allPending.total || 0;
      badge.textContent = n;
      badge.style.display = n > 0 ? '' : 'none';
    }

    P.loading = true;
    renderLoadMore(P, 'pendingMore', () => loadRequests(true));
    const qs = new URLSearchParams({ status: 'pending', q: P.q, limit: P.limit, offset: P.offset });
    const data = await api('/api/admin/requests?' + qs.toString());
    P.total = data.total || 0;
    P.rows = append ? P.rows.concat(data.requests || []) : (data.requests || []);
    P.offset = P.rows.length;
    P.loading = false;

    const info = document.getElementById('pendingInfo');
    if (info) info.innerHTML = P.q ? `匹配 <b>${P.total}</b> 条` : `共 <b>${P.total}</b> 条`;

    const pHtml = P.rows.length ? `<table><tr><th>申请人</th><th>部门</th><th>主题</th><th>使用时间</th><th>时长</th><th>申请时间</th><th>操作</th></tr>
        ${P.rows.map(r => `<tr>
            <td><div class="applicant"><div class="name">${esc(r.applicant)}</div><div class="email">${esc(r.email)}</div></div></td>
            <td>${esc(r.department) || '-'}</td><td>${esc(r.topic) || '-'}</td>
            <td>${fmtDT(r.planned_start)}</td><td>${r.planned_duration_min} 分钟</td>
            <td class="muted">${fmtDT(r.created_at)}</td>
            <td style="white-space:nowrap;">
                <button class="btn sm ok" onclick="approve(${r.id})">通过</button>
                <button class="btn sm danger" onclick="reject(${r.id})">拒绝</button>
            </td></tr>`).join('')}</table>`
        : (P.q ? '<div class="empty"><div class="icon">🔍</div>没有匹配的申请</div>'
               : '<div class="empty"><div class="icon">✓</div>暂无待审批申请</div>');
    document.getElementById('pendingTable').innerHTML = pHtml;
    renderLoadMore(P, 'pendingMore', () => loadRequests(true));
}

async function approve(id) {
    if (!confirm(`通过申请 #${id}？将自动生成访问码并邮件通知申请人。`)) return;
    try {
        const r = await post('/api/admin/approve', {request_id: id});
        toast(r.message + (r.code ? `（访问码: ${r.code}）` : ''));
        await loadRequests();
    } catch (e) { toast(e.message, false); }
}
async function reject(id) {
    const reason = prompt('拒绝原因（可留空）：') ?? '';
    try {
        await post('/api/admin/reject', {request_id: id, reason});
        toast('已拒绝');
        await loadRequests();
    } catch (e) { toast(e.message, false); }
}

// loadCodes(reset): true=从头加载, false=加载下一页
async function loadCodes(reset = true) {
    const C = PAGE.codes;
    if (reset) { C.offset = 0; C.rows = []; }
    C.loading = true;
    renderLoadMore(C, 'codesMore', () => loadCodes(false));
    const qs = new URLSearchParams({ q: C.q, status: C.status, limit: C.limit, offset: C.offset });
    const data = await api('/api/admin/codes?' + qs.toString());
    C.total = data.total || 0;
    C.rows = C.rows.concat(data.codes || []);
    C.offset = C.rows.length;
    C.loading = false;
    const info = document.getElementById('codesInfo');
    if (info) info.innerHTML = C.q || C.status ? `匹配 <b>${C.total}</b> 条` : `共 <b>${C.total}</b> 条`;
    const html = C.rows.length ? `<table><tr><th>访问码</th><th>申请人</th><th>主题</th><th>状态</th><th>使用时长 / 预计</th><th>生效时间</th><th>邮件</th><th>操作</th></tr>
        ${C.rows.map(c => {
            return `<tr>
            <td class="code-val">${esc(c.code)}</td>
            <td><div class="applicant"><div class="name">${esc(c.applicant)}</div><div class="email">${esc(c.email)}</div></div></td>
            <td>${esc(c.topic) || '-'}</td>
            <td><span class="tag ${c.status}">${{active:'有效', revoked:'已撤销'}[c.status] || c.status}</span></td>
            <td>${fmtMin(c.used_sec)} / 预计 ${c.quota_min} 分钟</td>
            <td>${fmtDT(c.valid_from)} 起</td>
            <td>${c.email_status ? `<span class="tag ${c.email_status}">${{sent:'已发送',failed:'失败'}[c.email_status] || c.email_status}</span>` : '-'}</td>
            <td style="white-space:nowrap;">
                ${c.status === 'active' ? `<button class="btn sm danger" onclick="revokeCode(${c.id})">撤销</button>` : ''}
                <button class="btn sm ghost" onclick="resend(${c.id})">重发邮件</button>
            </td></tr>`;
        }).join('')}</table>`
        : (C.q || C.status ? '<div class="empty"><div class="icon">🔍</div>没有匹配的访问码</div>'
                            : '<div class="empty"><div class="icon">🔑</div>暂无访问码</div>');
    document.getElementById('codesTable').innerHTML = html;
    renderLoadMore(C, 'codesMore', () => loadCodes(false));
}
async function revokeCode(id) {
    if (!confirm('撤销后该访问码立即失效，确定？')) return;
    try { await post('/api/admin/revoke', {code_id: id}); toast('已撤销'); await loadCodes(true); }
    catch (e) { toast(e.message, false); }
}
async function resend(id) {
    try { const r = await post('/api/admin/resend', {code_id: id}); toast(r.email_sent ? '邮件已发送' : '发送失败，请检查 SMTP 配置', r.email_sent); }
    catch (e) { toast(e.message, false); }
}

// 把毫秒时长格式化成 "Xh Ym" / "Ym" / "X秒"
function fmtDur(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + '秒';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + '分钟';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? h + 'h ' + m + 'm' : h + 'h';
}
// 根据值的相对位置返回 bar 的热度等级 (cool/warm/hot)
function heatClass(ratio) {
    if (ratio >= 0.66) return 'hot';
    if (ratio >= 0.33) return 'warm';
    return 'cool';
}

// 用量页渲染与拉取分离：切换 subtab 只重渲染（不追加），点"加载更多"才拉下一页
let USAGE_CURRENCY = 'CNY';
let USAGE_PRICING_CONFIGURED = false;

// loadUsage(reset, view):
//   reset=true, view=null -> 重置两边 + 拉首页 + 两边都渲染 (首次进入 / 范围变化)
//   reset=true, view='code'|'day' -> 只重置 view 一边 + 拉首页 + 渲染 view (切换 subtab 首次补渲染)
//   reset=false, view='code'|'day' -> 只为 view 这一边拉取并追加下一页 (另一边不动)
async function loadUsage(reset = true, view = null) {
    const days = parseInt(document.getElementById('usageDays').value, 10);
    const A = PAGE.usageByCode;
    const B = PAGE.usageByDay;
    const target = view || USAGE_VIEW;       // 不传 view 时按当前 subtab 决定
    const renderAll = reset && !view;         // 首次进入 / 范围变化 -> 两边都渲染
    if (reset) {
        if (renderAll || target === 'code') { A.offset = 0; A.rows = []; A.days = days; A.rendered = false; }
        if (renderAll || target === 'day')  { B.offset = 0; B.rows = []; B.days = days; B.rendered = false; }
    }
    const state = (target === 'day') ? B : A;
    state.loading = true;
    renderUsageCodeView();
    renderUsageDayView();
    // 只拉 target 这一边；另一边的数据保持原样，切换回去时本地重渲染即可
    const qs = new URLSearchParams({
        days,
        code_limit: (target === 'day') ? 1 : A.limit,
        code_offset: (target === 'day') ? 0 : A.offset,
        day_limit:  (target === 'day') ? B.limit : 1,
        day_offset: (target === 'day') ? B.offset : 0,
    });
    const data = await api('/api/admin/usage?' + qs.toString());
    const p = data.pricing || {};
    USAGE_CURRENCY = data.currency || 'CNY';
    USAGE_PRICING_CONFIGURED = !!(p.input_audio_per_ktoken || p.output_audio_per_ktoken || p.output_text_per_ktoken);
    document.getElementById('pricingInfo').textContent = USAGE_PRICING_CONFIGURED
        ? `单价（每千 token，${USAGE_CURRENCY}）：输入音频 ${p.input_audio_per_ktoken} / 输出音频 ${p.output_audio_per_ktoken} / 输出文本 ${p.output_text_per_ktoken}`
        : '未配置 token 单价（config.json pricing 节），成本列显示为 0';

    if (target === 'day') {
        B.total = (data.by_day && data.by_day.total) || 0;
        B.rows = B.rows.concat((data.by_day && data.by_day.rows) || []);
        B.offset = B.rows.length;
        B.loading = false;
        B.rendered = true;
    } else {
        A.total = (data.by_code && data.by_code.total) || 0;
        A.rows = A.rows.concat((data.by_code && data.by_code.rows) || []);
        A.offset = A.rows.length;
        A.loading = false;
        A.rendered = true;
    }

    if (renderAll || target === 'code') renderUsageCodeView();
    if (renderAll || target === 'day')  renderUsageDayView();
    renderUsageKpi();
}

function renderUsageCodeView() {
    const A = PAGE.usageByCode;
    const currency = USAGE_CURRENCY;
    const byCode = A.rows.filter(r => r.session_count > 0 || r.used_sec > 0);
    byCode.sort((a, b) => b.cost - a.cost);
    const maxCost = Math.max(1, ...byCode.map(r => r.cost));
    const maxDur = Math.max(1, ...byCode.map(r => r.duration_msec));
    const sumCost = byCode.reduce((s, r) => s + r.cost, 0);
    const sumDur = byCode.reduce((s, r) => s + r.duration_msec, 0);
    const sumSessions = byCode.reduce((s, r) => s + r.session_count, 0);

    const infoA = document.getElementById('usageByCodeInfo');
    if (infoA) infoA.innerHTML = A.total ? `共 <b>${A.rows.length}</b> / ${A.total} 个访问码` : '';
    document.getElementById('usageByCode').innerHTML = byCode.length ? `<table>
        <tr><th>访问码</th><th>申请人</th><th class="num">会话</th><th>时长</th><th>成本热度</th><th class="num">成本(${currency})</th></tr>
        ${byCode.map(r => {
            const cRatio = r.cost / maxCost;
            const dRatio = r.duration_msec / maxDur;
            return `<tr>
            <td class="code-val">${esc(r.code)}</td>
            <td><div class="applicant"><div class="name">${esc(r.applicant)}</div><div class="email">${esc(r.email || '')}</div></div></td>
            <td class="num">${r.session_count}</td>
            <td>${fmtDur(r.duration_msec)}</td>
            <td><div class="h-bar-wrap">
                <div class="h-bar ${heatClass(cRatio)}"><span style="width:${(cRatio*100).toFixed(0)}%"></span></div>
                <span class="v">${fmtDur(dRatio * maxDur)}</span>
            </div></td>
            <td class="num"><b>${r.cost.toFixed(2)}</b></td></tr>`;
        }).join('')}
        <tr class="totals-row">
            <td colspan="2">总计 / 平均</td>
            <td class="num">${sumSessions}</td>
            <td>${fmtDur(sumDur)}</td>
            <td class="muted" style="font-weight:normal;font-size:12px;">活跃 ${byCode.length} 码 / 平均 ${byCode.length ? (sumCost/byCode.length).toFixed(2) : '0.00'}</td>
            <td class="num"><b>${sumCost.toFixed(2)}</b></td>
        </tr>
        </table>`
        : '<div class="empty"><div class="icon">📊</div>所选时间范围内暂无用量</div>';
    renderLoadMore(A, 'usageByCodeMore', () => loadUsage(false, 'code'));
}

function renderUsageDayView() {
    const B = PAGE.usageByDay;
    const currency = USAGE_CURRENCY;
    const byDay = B.rows.slice();
    const infoB = document.getElementById('usageByDayInfo');
    if (infoB) infoB.innerHTML = B.total ? `共 <b>${B.rows.length}</b> / ${B.total} 天` : '';

    // 按日期降序 (后端已经 ORDER BY day DESC, 这里保持)
    const maxDayCost = Math.max(1, ...byDay.map(r => r.cost || 0));
    const sumDayCost = byDay.reduce((s, r) => s + (r.cost || 0), 0);
    const sumDayDur = byDay.reduce((s, r) => s + (r.duration_msec || 0), 0);
    const sumDaySess = byDay.reduce((s, r) => s + (r.session_count || 0), 0);

    document.getElementById('usageByDay').innerHTML = byDay.length ? `<table>
        <tr><th>日期</th><th class="num">会话</th><th>时长</th><th>成本热度</th><th class="num">成本(${currency})</th></tr>
        ${byDay.map(r => {
            const cRatio = (r.cost || 0) / maxDayCost;
            return `<tr>
            <td>${r.day}</td>
            <td class="num">${r.session_count}</td>
            <td>${fmtDur(r.duration_msec)}</td>
            <td><div class="h-bar-wrap">
                <div class="h-bar ${heatClass(cRatio)}"><span style="width:${(cRatio*100).toFixed(0)}%"></span></div>
            </div></td>
            <td class="num"><b>${(r.cost || 0).toFixed(2)}</b></td></tr>`;
        }).join('')}
        <tr class="totals-row">
            <td>总计</td>
            <td class="num">${sumDaySess}</td>
            <td>${fmtDur(sumDayDur)}</td>
            <td class="muted" style="font-weight:normal;font-size:12px;">日均 ${byDay.length ? (sumDayCost/byDay.length).toFixed(2) : '0.00'}</td>
            <td class="num"><b>${sumDayCost.toFixed(2)}</b></td>
        </tr>
        </table>`
        : '<div class="empty"><div class="icon">📊</div>暂无数据</div>';
    renderLoadMore(B, 'usageByDayMore', () => loadUsage(false, 'day'));
}

function renderUsageKpi() {
    const A = PAGE.usageByCode;
    const byCode = A.rows.filter(r => r.session_count > 0 || r.used_sec > 0);
    const sumCost = byCode.reduce((s, r) => s + r.cost, 0);
    const sumDur = byCode.reduce((s, r) => s + r.duration_msec, 0);
    const sumSessions = byCode.reduce((s, r) => s + r.session_count, 0);
    const sumInT = byCode.reduce((s, r) => s + (r.input_audio_tokens || 0), 0);
    const sumOutT = byCode.reduce((s, r) => s + (r.output_audio_tokens || 0), 0);
    const sumTxtT = byCode.reduce((s, r) => s + (r.output_text_tokens || 0), 0);
    const fmtCurrency = (v) => v.toFixed(2);
    const setEl = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
    setEl('kpiCost', USAGE_CURRENCY + ' ' + fmtCurrency(sumCost));
    setEl('kpiCostSub', USAGE_PRICING_CONFIGURED
        ? `${sumInT ? '输入音频 ' + fmtInt(sumInT) : ''}${sumOutT ? ' · 输出音频 ' + fmtInt(sumOutT) : ''}${sumTxtT ? ' · 文本 ' + fmtInt(sumTxtT) : ''}`
        : '未配置 token 单价');
    setEl('kpiDuration', fmtDur(sumDur));
    setEl('kpiDurationSub', '合计 ' + sumSessions + ' 个会话');
    setEl('kpiSessions', fmtInt(sumSessions));
    setEl('kpiSessionsSub', byCode.length + ' 个活跃访问码');
    setEl('kpiCodes', fmtInt(byCode.length));
    setEl('kpiCodesSub', A.total ? '总 ' + A.total + ' 个访问码' : '—');
}


// ---------- Token 消耗视图（独立分页，每页 10 条） ----------
async function loadUsageToken(append = false) {
    const T = PAGE.usageByToken;
    const days = parseInt(document.getElementById('usageDays').value, 10);
    if (!append) { T.offset = 0; T.rows = []; T.days = days; }

    T.loading = true;
    renderTokenView();
    const qs = new URLSearchParams({
        days,
        code_limit: T.limit, code_offset: T.offset,
        day_limit: 1, day_offset: 0,
    });
    const data = await api('/api/admin/usage?' + qs.toString());
    T.total = (data.by_code && data.by_code.total) || 0;
    T.rows = append ? T.rows.concat((data.by_code && data.by_code.rows) || [])
                    : ((data.by_code && data.by_code.rows) || []);
    T.offset = T.rows.length;
    T.loading = false;
    T.rendered = true;
    renderTokenView();
}

function renderTokenView() {
    const T = PAGE.usageByToken;
    const rows = T.rows.filter(r => r.session_count > 0 || r.used_sec > 0).slice();
    const totalOf = r => (r.input_audio_tokens || 0) + (r.output_audio_tokens || 0) + (r.output_text_tokens || 0);
    rows.sort((a, b) => totalOf(b) - totalOf(a));
    const sumIn  = rows.reduce((s, r) => s + (r.input_audio_tokens  || 0), 0);
    const sumOut = rows.reduce((s, r) => s + (r.output_audio_tokens || 0), 0);
    const sumTxt = rows.reduce((s, r) => s + (r.output_text_tokens  || 0), 0);
    const maxTotal = Math.max(1, ...rows.map(totalOf));

    const info = document.getElementById('usageByTokenInfo');
    if (info) info.innerHTML = T.total ? `共 <b>${T.rows.length}</b> / ${T.total} 个访问码` : '';

    document.getElementById('usageByToken').innerHTML = rows.length ? `<table>
        <tr><th>访问码</th><th>申请人</th><th class="num">输入音频 token</th><th class="num">输出音频 token</th><th class="num">输出文本 token</th><th class="num">合计</th><th>占比</th></tr>
        ${rows.map(r => {
            const inT = r.input_audio_tokens || 0, outT = r.output_audio_tokens || 0, txtT = r.output_text_tokens || 0;
            const t = inT + outT + txtT;
            return `<tr>
            <td class="code-val">${esc(r.code)}</td>
            <td><div class="applicant"><div class="name">${esc(r.applicant)}</div><div class="email">${esc(r.email || '')}</div></div></td>
            <td class="num">${fmtInt(inT)}</td>
            <td class="num">${fmtInt(outT)}</td>
            <td class="num">${fmtInt(txtT)}</td>
            <td class="num"><b>${fmtInt(t)}</b></td>
            <td><div class="h-bar-wrap"><div class="h-bar ${heatClass(t / maxTotal)}"><span style="width:${(t / maxTotal * 100).toFixed(0)}%"></span></div></div></td>
            </tr>`;
        }).join('')}
        <tr class="totals-row">
            <td colspan="2">总计</td>
            <td class="num">${fmtInt(sumIn)}</td>
            <td class="num">${fmtInt(sumOut)}</td>
            <td class="num">${fmtInt(sumTxt)}</td>
            <td class="num"><b>${fmtInt(sumIn + sumOut + sumTxt)}</b></td>
            <td></td>
        </tr></table>`
        : (T.loading ? '' : '<div class="empty"><div class="icon">🪙</div>所选时间范围内暂无 token 消耗</div>');
    renderLoadMore(T, 'usageByTokenMore', () => loadUsageToken(true));
}

// ---------- 审计 ----------
async function loadAudit(append = false) {
    const A = PAGE.audit;
    if (!append) { A.offset = 0; A.rows = []; }

    A.loading = true;
    renderLoadMore(A, 'auditMore', () => loadAudit(true));
    const qs = new URLSearchParams({ limit: A.limit, offset: A.offset });
    const data = await api('/api/admin/audit?' + qs.toString());
    A.total = data.total || 0;
    A.rows = append ? A.rows.concat(data.logs || []) : (data.logs || []);
    A.offset = A.rows.length;
    A.loading = false;

    const info = document.getElementById('auditInfo');
    if (info) info.innerHTML = `共 <b>${fmtInt(A.total)}</b> 条`;

    const nameMap = {
        request_submitted: '提交申请', request_approved: '审批通过', request_rejected: '审批拒绝',
        code_revoked: '撤销访问码', code_quota_added: '追加额度', quota_exceeded: '额度用尽',
        session_start: '会话开始', session_end: '会话结束', session_rebuild: '会话重建',
        admin_login: '管理员登录', admin_login_failed: '管理员登录失败',
    };
    document.getElementById('auditTable').innerHTML = A.rows.length ? `<table>
        <tr><th>时间</th><th>操作者</th><th>事件</th><th>详情</th></tr>
        ${A.rows.map(l => `<tr>
            <td>${fmtDT(l.ts)}</td><td>${esc(l.actor)}</td>
            <td>${nameMap[l.action] || l.action}</td><td>${esc(l.detail)}</td></tr>`).join('')}</table>`
        : '<div class="empty"><div class="icon">📜</div>暂无日志</div>';
    renderLoadMore(A, 'auditMore', () => loadAudit(true));
}

function resetAudit() {
    PAGE.audit.offset = 0; PAGE.audit.rows = [];
    document.getElementById('auditTable').innerHTML =
        '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    loadAudit();
}

// ---------- 初始化：探测登录态 ----------
// 搜索框防抖: codes / pending
// 脚本位于 </body> 之前, DOM 已就绪, 直接绑定即可
const _codesQDebounced = debounce(() => resetAndLoad('codes'), 300);
const _pendingQDebounced = debounce(() => resetAndLoad('pending'), 300);
(function bindSearchInputs() {
    const q = document.getElementById('codesQ');
    if (q) q.addEventListener('input', _codesQDebounced);
    const pq = document.getElementById('pendingQ');
    if (pq) pq.addEventListener('input', _pendingQDebounced);
})();
(async function () {
    try {
        await api('/api/admin/codes');
        enterAdmin();
    } catch (e) { /* 未登录，显示登录框 */ }
})();
