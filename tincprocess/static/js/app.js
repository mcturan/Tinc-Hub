let currentMode = 'tree'; // 'tree' or 'flat'
let autoRefresh = true;
let refreshTimer = null;
let collapsedPids = new Set();
let selectedPid = null;
let cachedProcesses = [];

document.addEventListener('DOMContentLoaded', () => {
    loadData();
    startTimer();

    document.getElementById('search-input').addEventListener('input', () => {
        renderTable();
    });
});

function startTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
        if (autoRefresh) {
            loadData(false);
        }
    }, 2500);
}

function toggleAutoRefresh() {
    autoRefresh = !autoRefresh;
    const btn = document.getElementById('btn-auto-refresh');
    if (autoRefresh) {
        btn.innerHTML = '⏸️ Canlı: Açık';
        btn.classList.add('active');
    } else {
        btn.innerHTML = '▶️ Canlı: Duraklatıldı';
        btn.classList.remove('active');
    }
}

function setViewMode(mode) {
    currentMode = mode;
    document.getElementById('btn-mode-tree').classList.toggle('active', mode === 'tree');
    document.getElementById('btn-mode-flat').classList.toggle('active', mode === 'flat');
    loadData(true);
}

async function loadData(showLoading = false) {
    try {
        const [sysRes, procRes] = await Promise.all([
            fetch('/api/system').then(r => r.json()),
            fetch(`/api/processes?mode=${currentMode}`).then(r => r.json())
        ]);

        updateSystemStats(sysRes);
        if (procRes.ok) {
            cachedProcesses = procRes.processes || [];
            renderTable();
        }
    } catch (e) {
        console.error("Veri yüklenemedi:", e);
    }
}

function updateSystemStats(sys) {
    if (!sys || sys.error) return;
    document.getElementById('stat-cpu').innerText = `${sys.cpu_percent}%`;
    document.getElementById('bar-cpu').style.width = `${Math.min(100, sys.cpu_percent)}%`;
    document.getElementById('bar-cpu').style.background = sys.cpu_percent > 80 ? 'var(--danger)' : sys.cpu_percent > 50 ? 'var(--warning)' : 'var(--primary)';

    document.getElementById('stat-ram').innerText = `${sys.ram_used_mb} MB (${sys.ram_percent}%)`;
    document.getElementById('bar-ram').style.width = `${Math.min(100, sys.ram_percent)}%`;
    document.getElementById('bar-ram').style.background = sys.ram_percent > 85 ? 'var(--danger)' : 'var(--purple)';

    document.getElementById('stat-procs').innerText = sys.process_count;
    
    const upHrs = Math.floor(sys.uptime_seconds / 3600);
    const upMins = Math.floor((sys.uptime_seconds % 3600) / 60);
    document.getElementById('stat-uptime').innerText = `${upHrs}s ${upMins}dk`;
}

function renderTable() {
    const tbody = document.getElementById('proc-tbody');
    const query = document.getElementById('search-input').value.trim().toLowerCase();
    tbody.innerHTML = '';

    if (currentMode === 'tree') {
        cachedProcesses.forEach(root => renderTreeNode(root, 0, tbody, query));
    } else {
        const filtered = cachedProcesses.filter(p => matchesQuery(p, query));
        filtered.forEach(p => {
            const tr = createProcessRow(p, 0, false, false);
            tbody.appendChild(tr);
        });
    }
}

function matchesQuery(p, q) {
    if (!q) return true;
    const nameMatch = (p.name || '').toLowerCase().includes(q);
    const pidMatch = String(p.pid).includes(q);
    const userMatch = (p.user || '').toLowerCase().includes(q);
    const portMatch = (p.ports || []).some(pt => String(pt.port).includes(q));
    return nameMatch || pidMatch || userMatch || portMatch;
}

function renderTreeNode(node, depth, tbody, query) {
    const hasChildren = node.children && node.children.length > 0;
    const isCollapsed = collapsedPids.has(node.pid);
    const isMatched = matchesQuery(node, query);

    // If querying, check if any descendant matches
    const hasMatchingDescendant = query ? checkDescendantMatch(node, query) : true;

    if (!query || isMatched || hasMatchingDescendant) {
        const tr = createProcessRow(node, depth, hasChildren, isCollapsed);
        tbody.appendChild(tr);

        if (hasChildren && !isCollapsed) {
            node.children.forEach(child => renderTreeNode(child, depth + 1, tbody, query));
        }
    }
}

function checkDescendantMatch(node, q) {
    if (!node.children) return false;
    for (let c of node.children) {
        if (matchesQuery(c, q) || checkDescendantMatch(c, q)) return true;
    }
    return false;
}

function toggleCollapse(pid, event) {
    event.stopPropagation();
    if (collapsedPids.has(pid)) {
        collapsedPids.delete(pid);
    } else {
        collapsedPids.add(pid);
    }
    renderTable();
}

function createProcessRow(p, depth, hasChildren, isCollapsed) {
    const tr = document.createElement('tr');
    tr.className = 'proc-row';
    if (selectedPid === p.pid) tr.classList.add('selected');
    tr.onclick = () => selectRow(p.pid, tr);

    // Tree cell (Name with indentation & toggle)
    const tdName = document.createElement('td');
    tdName.className = 'tree-cell';
    
    // Indent spacer
    const indent = document.createElement('span');
    indent.className = 'tree-indent';
    indent.style.width = `${depth * 20}px`;
    tdName.appendChild(indent);

    // Toggle button
    if (hasChildren) {
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle';
        toggle.innerText = isCollapsed ? '▶' : '▼';
        toggle.onclick = (e) => toggleCollapse(p.pid, e);
        tdName.appendChild(toggle);
    } else {
        const leaf = document.createElement('span');
        leaf.className = 'tree-toggle';
        leaf.innerText = '•';
        leaf.style.color = '#94a3b8';
        tdName.appendChild(leaf);
    }

    // Name text
    const nameSpan = document.createElement('span');
    nameSpan.className = 'proc-name';
    nameSpan.innerText = p.name;
    tdName.appendChild(nameSpan);

    // Ports badge if listening
    if (p.ports && p.ports.length > 0) {
        p.ports.forEach(pt => {
            const portBadge = document.createElement('span');
            portBadge.className = 'port-badge';
            portBadge.innerText = `:${pt.port}`;
            portBadge.title = `Dinlenen Port (${pt.family}): ${pt.ip}:${pt.port}`;
            tdName.appendChild(portBadge);
        });
    }

    tr.appendChild(tdName);

    // PID
    const tdPid = document.createElement('td');
    tdPid.className = 'pid-badge';
    tdPid.innerText = p.pid;
    tr.appendChild(tdPid);

    // CPU %
    const tdCpu = document.createElement('td');
    tdCpu.style.fontFamily = 'var(--font-mono)';
    tdCpu.style.fontWeight = p.cpu > 0 ? '700' : '400';
    tdCpu.style.color = p.cpu > 50 ? 'var(--danger)' : p.cpu > 10 ? 'var(--warning)' : 'inherit';
    tdCpu.innerText = `${p.cpu.toFixed(1)}%`;
    tr.appendChild(tdCpu);

    // RAM RSS
    const tdRam = document.createElement('td');
    tdRam.style.fontFamily = 'var(--font-mono)';
    tdRam.innerText = `${p.ram_mb} MB`;
    tr.appendChild(tdRam);

    // User
    const tdUser = document.createElement('td');
    tdUser.innerText = p.user;
    tdUser.style.color = p.user === 'root' ? '#f43f5e' : 'var(--text-muted)';
    tr.appendChild(tdUser);

    // Threads
    const tdThreads = document.createElement('td');
    tdThreads.style.fontFamily = 'var(--font-mono)';
    tdThreads.innerText = p.threads;
    tr.appendChild(tdThreads);

    // Nice (Priority)
    const tdNice = document.createElement('td');
    tdNice.style.fontFamily = 'var(--font-mono)';
    tdNice.innerText = p.nice;
    tr.appendChild(tdNice);

    // Actions button
    const tdAction = document.createElement('td');
    tdAction.style.textAlign = 'right';
    tdAction.innerHTML = `
        <button class="btn" style="padding:2px 8px; font-size:0.75rem;" onclick="openDetailModal(${p.pid}, event)" title="Detayları İncele">🔍 İncele</button>
        <button class="btn btn-danger" style="padding:2px 8px; font-size:0.75rem;" onclick="confirmKill(${p.pid}, '${p.name}', event)" title="Süreci Sonlandır (Kill)">✕</button>
    `;
    tr.appendChild(tdAction);

    return tr;
}

function selectRow(pid, tr) {
    selectedPid = pid;
    document.querySelectorAll('.proc-row').forEach(r => r.classList.remove('selected'));
    if (tr) tr.classList.add('selected');
}

async function openDetailModal(pid, event) {
    if (event) event.stopPropagation();
    selectedPid = pid;
    const modal = document.getElementById('modal-proc-detail');
    const title = document.getElementById('detail-modal-title');
    const body = document.getElementById('detail-modal-body');

    title.innerText = `🔍 Süreç İnceleme: PID ${pid}`;
    body.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted);">Yükleniyor...</div>`;
    modal.style.display = 'flex';

    try {
        const res = await fetch(`/api/process/${pid}`);
        const data = await res.json();
        if (!data.ok) {
            body.innerHTML = `<div style="color:var(--danger);">${data.error}</div>`;
            return;
        }

        renderProcessDetailBody(data, body);
    } catch (e) {
        body.innerHTML = `<div style="color:var(--danger);">Detaylar alınamadı: ${e.message}</div>`;
    }
}

function renderProcessDetailBody(p, container) {
    let filesHtml = (p.open_files && p.open_files.length > 0)
        ? p.open_files.map(f => `<div style="font-size:0.75rem; color:#cbd5e1;">📄 ${f}</div>`).join('')
        : `<span style="color:var(--text-muted);">Açık dosya yok</span>`;

    let connsHtml = (p.connections && p.connections.length > 0)
        ? p.connections.map(c => `<div style="font-size:0.75rem; color:#60a5fa;">🌐 [${c.family}] ${c.laddr} ➔ ${c.raddr || 'LISTEN'} (${c.status})</div>`).join('')
        : `<span style="color:var(--text-muted);">Ağ bağlantısı yok</span>`;

    container.innerHTML = `
        <div class="detail-grid">
            <div class="detail-label">Süreç Adı:</div>
            <div class="detail-value" style="font-weight:700; color:var(--primary);">${p.name}</div>

            <div class="detail-label">PID / PPID:</div>
            <div class="detail-value">${p.pid} (Üst PID: ${p.ppid})</div>

            <div class="detail-label">Kullanıcı:</div>
            <div class="detail-value">${p.username}</div>

            <div class="detail-label">Durum:</div>
            <div class="detail-value">${p.status}</div>

            <div class="detail-label">CPU / Bellek:</div>
            <div class="detail-value">${p.cpu_percent}% CPU | ${p.ram_rss_mb} MB RSS (${p.ram_vms_mb} MB Sanal)</div>

            <div class="detail-label">Thread / FD:</div>
            <div class="detail-value">${p.num_threads} Threads | ${p.num_fds} Dosya Tanıtıcısı</div>

            <div class="detail-label">Öncelik (Nice):</div>
            <div class="detail-value" style="display:flex; align-items:center; gap:8px;">
                <span>${p.nice}</span>
                <button class="btn btn-sm" onclick="promptSetNice(${p.pid}, ${p.nice})">Değiştir</button>
            </div>

            <div class="detail-label">Yürütülebilir Yol:</div>
            <div class="detail-value" style="font-size:0.78rem;">${p.exe || 'N/A'}</div>

            <div class="detail-label">Komut Satırı:</div>
            <div class="detail-value" style="font-size:0.78rem; background:rgba(0,0,0,0.3); padding:4px 6px; border-radius:4px;">${p.cmdline}</div>
        </div>

        <div style="margin-top:10px;">
            <div style="font-weight:700; margin-bottom:6px; color:var(--text-muted); font-size:0.8rem; text-transform:uppercase;">🌐 Ağ Soketleri & Dinlenen Portlar</div>
            <div style="background:rgba(0,0,0,0.2); padding:8px; border-radius:6px; max-height:120px; overflow-y:auto;">
                ${connsHtml}
            </div>
        </div>

        <div style="margin-top:10px;">
            <div style="font-weight:700; margin-bottom:6px; color:var(--text-muted); font-size:0.8rem; text-transform:uppercase;">📂 Açık Dosyalar & Tanıtıcılar (Handles)</div>
            <div style="background:rgba(0,0,0,0.2); padding:8px; border-radius:6px; max-height:120px; overflow-y:auto;">
                ${filesHtml}
            </div>
        </div>
    `;

    // Footer actions
    const footer = document.getElementById('detail-modal-footer');
    footer.innerHTML = `
        <button class="btn" onclick="execAction(${p.pid}, 'suspend')">⏸️ Dondur (SIGSTOP)</button>
        <button class="btn" onclick="execAction(${p.pid}, 'resume')">▶️ Devam (SIGCONT)</button>
        <button class="btn" onclick="execAction(${p.pid}, 'terminate')">⏹️ Nazik Kapat (SIGTERM)</button>
        <button class="btn btn-danger" onclick="execAction(${p.pid}, 'kill')">🛑 Öldür (SIGKILL)</button>
        <button class="btn" onclick="closeModal('modal-proc-detail')">Kapat</button>
    `;
}

async function execAction(pid, action, niceVal = null) {
    if (action === 'kill' && !confirm(`PID ${pid} sürecini zorla sonlandırmak (SIGKILL) istediğinize emin misiniz?`)) {
        return;
    }
    try {
        const res = await fetch(`/api/process/${pid}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: action, nice: niceVal })
        });
        const data = await res.json();
        alert(data.message || (data.ok ? 'İşlem başarılı' : data.error));
        closeModal('modal-proc-detail');
        loadData(false);
    } catch (e) {
        alert("İşlem başarısız: " + e.message);
    }
}

function promptSetNice(pid, currentNice) {
    const val = prompt(`PID ${pid} için yeni Nice öncelik değerini girin (-20 en yüksek, 19 en düşük):`, currentNice);
    if (val !== null && val.trim() !== '') {
        execAction(pid, 'nice', parseInt(val.trim()));
    }
}

function confirmKill(pid, name, event) {
    if (event) event.stopPropagation();
    if (confirm(`"${name}" (PID ${pid}) sürecini derhal sonlandırmak istiyor musunuz?`)) {
        execAction(pid, 'kill');
    }
}

async function openPortsModal() {
    const modal = document.getElementById('modal-ports');
    const tbody = document.getElementById('ports-tbody');
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:15px; color:var(--text-muted);">Portlar taranıyor...</td></tr>`;
    modal.style.display = 'flex';

    try {
        const res = await fetch('/api/ports');
        const data = await res.json();
        if (data.ok && data.ports) {
            tbody.innerHTML = '';
            data.ports.forEach(pt => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="font-family:var(--font-mono); font-weight:700; color:#60a5fa;">:${pt.port}</td>
                    <td style="font-family:var(--font-mono); font-size:0.75rem;">${pt.ip} (${pt.family})</td>
                    <td style="font-family:var(--font-mono);">${pt.pid}</td>
                    <td style="font-weight:600;">${pt.name}</td>
                    <td style="color:var(--text-muted);">${pt.user}</td>
                    <td>
                        <button class="btn btn-sm" onclick="closeModal('modal-ports'); openDetailModal(${pt.pid})">🔍 İncele</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" style="color:var(--danger); padding:15px;">Hata: ${e.message}</td></tr>`;
    }
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}
