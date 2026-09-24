const $ = (id) => document.getElementById(id);

function showMsg(el, text, ok) {
    el.textContent = text;
    el.className = 'msg ' + (ok ? 'ok' : 'err');
}

async function postJSON(url, body) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    });
    let data = {};
    try { data = await resp.json(); } catch (e) {}
    return {status: resp.status, ok: resp.ok && data.ok !== false, data};
}

$('requestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('submitBtn');
    btn.disabled = true; btn.textContent = '提交中...';
    try {
        const r = await postJSON('/api/request', {
            applicant: $('applicant').value.trim(),
            email: $('email').value.trim(),
            department: $('department').value.trim(),
            topic: $('topic').value.trim(),
            planned_start: $('planned_start').value,
            planned_duration_min: parseInt($('planned_duration_min').value, 10)
        });
        if (r.ok) {
            showMsg($('requestMsg'), '✓ ' + (r.data.message || '申请已提交'), true);
            e.target.reset();
        } else {
            showMsg($('requestMsg'), r.data.error || '提交失败，请稍后再试', false);
        }
    } catch (err) {
        showMsg($('requestMsg'), '网络错误，请稍后再试', false);
    } finally {
        btn.disabled = false; btn.textContent = '提交申请';
    }
});

async function verifyCode(target) {
    const code = $('code').value.trim().toUpperCase();
    if (!code) { showMsg($('verifyMsg'), '请输入访问码', false); return; }
    const btn = $('verifyBtn');
    btn.disabled = true; btn.textContent = '验证中...';
    try {
        const r = await postJSON('/api/verify', {code, target});
        if (r.ok) {
            window.location.href = r.data.redirect || '/app';
        } else {
            showMsg($('verifyMsg'), r.data.error || '访问码验证失败', false);
            btn.disabled = false; btn.textContent = '进入控制端';
        }
    } catch (err) {
        showMsg($('verifyMsg'), '网络错误，请稍后再试', false);
        btn.disabled = false; btn.textContent = '进入控制端';
    }
}

$('verifyForm').addEventListener('submit', (e) => { e.preventDefault(); verifyCode('app'); });
function enterViewer() { verifyCode('viewer'); }

// 申请卡片展开/收起
const requestCard = $('requestCard');
const applyToggle = $('applyToggle');
applyToggle.addEventListener('click', () => {
    const collapsed = requestCard.classList.contains('hidden');
    requestCard.classList.toggle('hidden', !collapsed);
    $('cardsWrap').classList.toggle('single', !collapsed);
    applyToggle.textContent = collapsed ? '收起申请表单 ⌃' : '还没有访问码？提交使用申请 ›';
    if (collapsed) {
        // 展开后聚焦第一个必填项，移动端自动滚动到表单
        requestCard.scrollIntoView({behavior: 'smooth', block: 'nearest'});
        setTimeout(() => $('applicant').focus(), 300);
    }
});

// 默认使用时间填明天 9:00
(function () {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    $('planned_start').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
})();
