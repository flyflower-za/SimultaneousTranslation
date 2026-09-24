const listEl = document.getElementById('list');
const detailEl = document.getElementById('detail');
let selectedId = null;

async function request(path) {
    const response = await fetch(path, {cache: 'no-store'});
    if (response.status === 401) { location.href = '/'; throw new Error('请先登录'); }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载失败');
    return data;
}

function element(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
}

async function loadList() {
    try {
        const {meetings} = await request('/api/my/meetings');
        listEl.replaceChildren();
        if (!meetings.length) listEl.appendChild(element('p', '还没有会议记录。', 'muted'));
        for (const meeting of meetings) {
            const button = element('button', `${meeting.title || '未命名会议'}\n${meeting.started_at.replace('T', ' ')} · ${meeting.status}`, 'meeting');
            button.onclick = () => openMeeting(meeting.id);
            listEl.appendChild(button);
        }
    } catch (error) { listEl.textContent = error.message; }
}

async function openMeeting(id) {
    try {
        const {meeting, segments, versions} = await request(`/api/my/meetings/${id}`);
        selectedId = id;
        detailEl.replaceChildren();
        detailEl.appendChild(element('h2', meeting.title || `会议 #${id}`));
        detailEl.appendChild(element('p', `${meeting.started_at.replace('T',' ')} · ${meeting.ended_at ? '已结束' : '进行中'} · 纪要状态：${meeting.status}`, 'muted'));
        const toolbar = element('div', '', 'toolbar');
        if (meeting.minutes_text) {
            for (const format of ['md', 'pdf']) {
                const link = element('a', `下载 ${format.toUpperCase()}`, 'download');
                link.href = `/api/my/meetings/${id}/download?format=${format}`;
                toolbar.appendChild(link);
            }
        }
        detailEl.appendChild(toolbar);
        detailEl.appendChild(element('h3', `纪要${versions.length ? ` · ${versions.length} 个版本` : ''}`));
        detailEl.appendChild(element('pre', meeting.minutes_text || '纪要尚未生成。'));
        detailEl.appendChild(element('h3', '逐字稿'));
        detailEl.appendChild(element('pre', segments.map(s =>
            `[${s.occurred_at.replace('T',' ')}] ${s.kind === 'source' ? '原文' : '译文'}：${s.text}`).join('\n') || '暂无定稿字幕。'));
    } catch (error) { detailEl.textContent = error.message; }
}

loadList();
