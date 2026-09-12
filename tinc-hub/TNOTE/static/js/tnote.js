/**
 * TNOTE — Dinamik İstemci Scripti
 */

let currentPageId = null;
let currentPageData = null;
let currentItems = [];
let currentFilter = 'all'; // 'all', 'pending', 'done'
let isDraggingAny = false;
let draggedPage = null;
let draggedCat = null;
let sourceCatId = null;

document.addEventListener('DOMContentLoaded', () => {
    // Sol Kenar Çubuğu Manuel Daraltma (« / ») durumunu yükle
    initSidebarToggleState();

    // Akordeon durumlarını geri yükle
    restoreCategoryCollapsedState();

    // Sürükle ve Bırak (Drag & Drop) Dinleyicileri
    initSidebarDragAndDrop();

    // Uygulama varsayılan açılış sayfası: Genel Bakış & Özet
    loadOverviewPage();

    // Klavye kısayolları (Ctrl+K, Ctrl+Z, Escape)
    initGlobalKeyboardShortcuts();

    // Çöp kutusu rozetini güncelle
    updateTrashBadgeCount();

    // Hızlı ekleme inputunda Enter tuşu
    const quickInput = document.getElementById('quick-item-title');
    if (quickInput) {
        quickInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitQuickItem();
            }
        });

        // URL Yapıştırıldığında otomatik tarama (Scraper)
        quickInput.addEventListener('paste', (e) => {
            setTimeout(() => {
                const text = quickInput.value.trim();
                if (text.startsWith('http://') || text.startsWith('https://')) {
                    autoScrapeUrl(text);
                }
            }, 50);
        });
    }
});

// ─────────────────────────────────────────────────────────────
// Kategori & Sayfa Sürükle Bırak (Drag & Drop)
// ─────────────────────────────────────────────────────────────

function initSidebarDragAndDrop() {
    // 1. Sayfa Sürükleme (Yukarı/Aşağı ve Kategoriler Arası)
    const pageItems = document.querySelectorAll('.page-item');
    pageItems.forEach(item => {
        item.setAttribute('draggable', 'true');

        item.addEventListener('dragstart', (e) => {
            isDraggingAny = true;
            draggedPage = item;
            draggedCat = null;
            sourceCatId = item.dataset.categoryId;
            item.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.dataset.pageId);
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('is-dragging');
            clearDropIndicators();
            draggedPage = null;
            draggedCat = null;
            sourceCatId = null;
            setTimeout(() => { isDraggingAny = false; }, 150);
        });

        item.addEventListener('dragover', (e) => {
            if (!draggedPage || draggedPage === item) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';

            const rect = item.getBoundingClientRect();
            const relY = e.clientY - rect.top;
            clearDropIndicators();
            if (relY < rect.height / 2) {
                item.classList.add('drop-target-above');
            } else {
                item.classList.add('drop-target-below');
            }
        });

        item.addEventListener('dragleave', () => {
            item.classList.remove('drop-target-above', 'drop-target-below');
        });

        item.addEventListener('drop', async (e) => {
            if (!draggedPage || draggedPage === item) return;
            e.preventDefault();
            e.stopPropagation();

            const isAbove = item.classList.contains('drop-target-above');
            clearDropIndicators();

            const targetPageList = item.closest('.page-list');
            const targetCatId = targetPageList ? targetPageList.dataset.categoryId : item.dataset.categoryId;

            // DOM üzerinde taşı
            if (isAbove) {
                item.parentNode.insertBefore(draggedPage, item);
            } else {
                item.parentNode.insertBefore(draggedPage, item.nextSibling);
            }

            const isCatChanged = (sourceCatId != targetCatId);
            draggedPage.dataset.categoryId = targetCatId;

            // Sıralamayı sunucuya kaydet
            await persistPageOrder(targetCatId);
            if (isCatChanged) {
                await persistPageOrder(sourceCatId);
                updateCategoryBadges(sourceCatId, targetCatId);
                showToast("Sayfa yeni kategoriye aktarıldı!");
            } else {
                showToast("Sayfa sırası güncellendi!");
            }
        });
    });

    // 2. Kategori Başlığına Bırakma (Sayfayı Doğrudan Kategoriye Aktarma)
    const catHeaders = document.querySelectorAll('.category-header');
    catHeaders.forEach(catHeader => {
        catHeader.addEventListener('dragover', (e) => {
            if (!draggedPage) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            catHeader.classList.add('cat-drop-hover');
        });

        catHeader.addEventListener('dragleave', () => {
            catHeader.classList.remove('cat-drop-hover');
        });

        catHeader.addEventListener('drop', async (e) => {
            if (!draggedPage) return;
            e.preventDefault();
            e.stopPropagation();
            catHeader.classList.remove('cat-drop-hover');

            const targetCatId = catHeader.dataset.categoryId;
            const targetPageList = document.getElementById(`cat-pages-${targetCatId}`);
            if (!targetPageList) return;

            // Kategori kapalıysa aç
            const group = document.getElementById(`cat-group-${targetCatId}`);
            if (group && group.classList.contains('collapsed')) {
                group.classList.remove('collapsed');
                saveCategoryCollapsedState(targetCatId, false);
            }

            // Sayfayı bu kategorinin sonuna ekle
            targetPageList.appendChild(draggedPage);
            const isCatChanged = (sourceCatId != targetCatId);
            draggedPage.dataset.categoryId = targetCatId;

            await persistPageOrder(targetCatId);
            if (isCatChanged) {
                await persistPageOrder(sourceCatId);
                updateCategoryBadges(sourceCatId, targetCatId);
                showToast("Sayfa kategoriye aktarıldı!");
            }
        });
    });

    // 3. Kategori Sıralama (Kategorileri yukarı/aşağı taşıma)
    const catGroups = document.querySelectorAll('.category-group');
    catGroups.forEach(group => {
        const handle = group.querySelector('.cat-drag-handle');
        if (!handle) return;

        handle.addEventListener('mousedown', () => {
            group.setAttribute('draggable', 'true');
        });

        group.addEventListener('dragstart', (e) => {
            if (draggedPage) return;
            isDraggingAny = true;
            draggedCat = group;
            group.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', group.dataset.categoryId);
        });

        group.addEventListener('dragend', () => {
            group.removeAttribute('draggable');
            group.classList.remove('is-dragging');
            clearDropIndicators();
            draggedCat = null;
            setTimeout(() => { isDraggingAny = false; }, 150);
        });

        group.addEventListener('dragover', (e) => {
            if (!draggedCat || draggedCat === group) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';

            const rect = group.getBoundingClientRect();
            const relY = e.clientY - rect.top;
            clearDropIndicators();
            if (relY < rect.height / 2) {
                group.classList.add('drop-target-above');
            } else {
                group.classList.add('drop-target-below');
            }
        });

        group.addEventListener('dragleave', () => {
            group.classList.remove('drop-target-above', 'drop-target-below');
        });

        group.addEventListener('drop', async (e) => {
            if (!draggedCat || draggedCat === group) return;
            e.preventDefault();
            e.stopPropagation();

            const isAbove = group.classList.contains('drop-target-above');
            clearDropIndicators();

            if (isAbove) {
                group.parentNode.insertBefore(draggedCat, group);
            } else {
                group.parentNode.insertBefore(draggedCat, group.nextSibling);
            }

            await persistCategoryOrder();
            showToast("Kategori sırası güncellendi!");
        });
    });
}

function clearDropIndicators() {
    document.querySelectorAll('.drop-target-above, .drop-target-below, .cat-drop-hover').forEach(el => {
        el.classList.remove('drop-target-above', 'drop-target-below', 'cat-drop-hover');
    });
}

async function persistPageOrder(categoryId) {
    const pageList = document.getElementById(`cat-pages-${categoryId}`);
    if (!pageList) return;
    const pageIds = Array.from(pageList.querySelectorAll('.page-item')).map(el => parseInt(el.dataset.pageId)).filter(Boolean);
    try {
        await fetch('/notes/api/pages/reorder', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({category_id: parseInt(categoryId), page_ids: pageIds})
        });
    } catch (e) {
        console.error("Sayfa sırası kaydetme hatası:", e);
    }
}

async function persistCategoryOrder() {
    const container = document.getElementById('sidebar-categories');
    if (!container) return;
    const catIds = Array.from(container.querySelectorAll('.category-group')).map(el => parseInt(el.dataset.categoryId)).filter(Boolean);
    try {
        await fetch('/notes/api/categories/reorder', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({category_ids: catIds})
        });
    } catch (e) {
        console.error("Kategori sırası kaydetme hatası:", e);
    }
}

function updateCategoryBadges(sourceCatId, targetCatId) {
    if (sourceCatId) {
        const sList = document.getElementById(`cat-pages-${sourceCatId}`);
        const sBadge = document.getElementById(`cat-badge-${sourceCatId}`);
        if (sList && sBadge) {
            sBadge.textContent = sList.querySelectorAll('.page-item').length;
        }
    }
    if (targetCatId) {
        const tList = document.getElementById(`cat-pages-${targetCatId}`);
        const tBadge = document.getElementById(`cat-badge-${targetCatId}`);
        if (tList && tBadge) {
            tBadge.textContent = tList.querySelectorAll('.page-item').length;
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Kategori Akordeon Aç / Kapa
// ─────────────────────────────────────────────────────────────

function toggleCategoryGroup(catId) {
    const container = document.querySelector('.tnote-container');
    if (container && container.classList.contains('sidebar-collapsed')) {
        // Daraltılmış kenar çubuğundan kategoriye tıklandığında menüyü aç ve kategoriyi göster
        setSidebarState(false);
        const group = document.getElementById(`cat-group-${catId}`);
        if (group) {
            group.classList.remove('collapsed');
            saveCategoryCollapsedState(catId, false);
        }
        return;
    }
    const group = document.getElementById(`cat-group-${catId}`);
    if (!group) return;
    const isCollapsed = group.classList.toggle('collapsed');
    saveCategoryCollapsedState(catId, isCollapsed);
}

function saveCategoryCollapsedState(catId, isCollapsed) {
    try {
        const map = JSON.parse(localStorage.getItem('tnote_collapsed_cats') || '{}');
        map[catId] = isCollapsed;
        localStorage.setItem('tnote_collapsed_cats', JSON.stringify(map));
    } catch (e) {}
}

function restoreCategoryCollapsedState() {
    try {
        const map = JSON.parse(localStorage.getItem('tnote_collapsed_cats') || '{}');
        for (const [catId, isCollapsed] of Object.entries(map)) {
            const group = document.getElementById(`cat-group-${catId}`);
            if (group) {
                if (isCollapsed) {
                    group.classList.add('collapsed');
                } else {
                    group.classList.remove('collapsed');
                }
            }
        }
    } catch (e) {}
}

// ─────────────────────────────────────────────────────────────
// Sol Kenar Çubuğu (Sidebar) Manuel Daraltma / Genişletme (« / »)
// ─────────────────────────────────────────────────────────────

function initSidebarToggleState() {
    const saved = localStorage.getItem('tnote_sidebar_collapsed');
    // Eğer önceden daraltılmışsa true, varsayılan açık (false)
    const isCollapsed = (saved === 'true');
    setSidebarState(isCollapsed);
}

function toggleSidebarManual() {
    const container = document.querySelector('.tnote-container');
    if (!container) return;
    const isCurrentlyCollapsed = container.classList.contains('sidebar-collapsed');
    setSidebarState(!isCurrentlyCollapsed);
}

function setSidebarState(collapsed) {
    const container = document.querySelector('.tnote-container');
    const toggleBtn = document.getElementById('sidebar-toggle-btn');
    if (!container) return;

    if (collapsed) {
        container.classList.add('sidebar-collapsed');
        if (toggleBtn) {
            toggleBtn.textContent = '»';
            toggleBtn.title = 'Menüyü Genişlet ( » )';
        }
        localStorage.setItem('tnote_sidebar_collapsed', 'true');
    } else {
        container.classList.remove('sidebar-collapsed');
        if (toggleBtn) {
            toggleBtn.textContent = '«';
            toggleBtn.title = 'Menüyü Daralt ( « )';
        }
        localStorage.setItem('tnote_sidebar_collapsed', 'false');
    }
}

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// HIZLI NOTLAR & GÖREVLER (HIZLI ALAN & BİRLEŞİK GÖREVLER)
// ─────────────────────────────────────────────────────────────

let webQuickNotesDebounce = null;

async function loadQuickTasksPage() {
    currentPageId = null;
    currentPageData = null;

    // Sidebar aktiflikleri
    const ovBtn = document.getElementById('sidebar-overview-btn');
    const quickBtn = document.getElementById('sidebar-quick-btn');
    const vaultBtn = document.getElementById('sidebar-vault-btn');
    const trashBtn = document.getElementById('sidebar-trash-btn');
    if (ovBtn) ovBtn.classList.remove('active');
    if (quickBtn) quickBtn.classList.add('active');
    if (vaultBtn) vaultBtn.classList.remove('active');
    if (trashBtn) trashBtn.classList.remove('active');

    document.querySelectorAll('.page-item').forEach(el => el.classList.remove('active'));

    // Header güncelle
    const titleEl = document.getElementById('current-page-title');
    const iconEl = document.getElementById('current-page-icon');
    const badgeEl = document.getElementById('current-page-badge');
    if (titleEl) titleEl.textContent = 'Hızlı Notlar & Görevler';
    if (iconEl) iconEl.textContent = '⚡';
    if (badgeEl) badgeEl.textContent = 'Hızlı Alan & Birleşik Görevler';

    // Header aksiyonları
    const pageActions = document.getElementById('page-header-actions');
    const ovActions = document.getElementById('overview-header-actions');
    const vaultActions = document.getElementById('vault-header-actions');
    const trashActions = document.getElementById('trash-header-actions');
    if (pageActions) pageActions.style.display = 'none';
    if (ovActions) ovActions.style.display = 'none';
    if (vaultActions) vaultActions.style.display = 'none';
    if (trashActions) trashActions.style.display = 'none';

    // Alanları gizle / göster
    const checklistArea = document.getElementById('checklist-view');
    const noteArea = document.getElementById('note-view');
    const financeArea = document.getElementById('finance-view');
    const projectArea = document.getElementById('project-view');
    const vaultArea = document.getElementById('vault-view');
    const trashArea = document.getElementById('trash-view');
    const quickAddBox = document.getElementById('quick-add-container');
    const overviewArea = document.getElementById('overview-view');
    const quickArea = document.getElementById('quick-tasks-view');

    if (checklistArea) checklistArea.style.display = 'none';
    if (noteArea) noteArea.style.display = 'none';
    if (financeArea) financeArea.style.display = 'none';
    if (projectArea) projectArea.style.display = 'none';
    if (vaultArea) vaultArea.style.display = 'none';
    if (trashArea) trashArea.style.display = 'none';
    if (quickAddBox) quickAddBox.style.display = 'none';
    if (overviewArea) overviewArea.style.display = 'none';
    if (quickArea) quickArea.style.display = 'flex';

    await renderWebQuickTasks();
}

async function renderWebQuickTasks() {
    // 1. Hızlı Notları Sunucudan Çek ve Listele
    try {
        const qnRes = await fetch('/notes/api/quick-notes');
        const qnData = await qnRes.json();
        if (qnData.ok) {
            const notes = qnData.notes || [];
            const notesCountEl = document.getElementById('web-quick-notes-count');
            if (notesCountEl) notesCountEl.textContent = notes.length;

            const notesListEl = document.getElementById('web-quick-notes-list');
            if (notesListEl) {
                if (notes.length === 0) {
                    notesListEl.innerHTML = `<div style="padding:14px; text-align:center; color:var(--muted); font-size:0.82rem;">Henüz hızlı not yok. Yukarıdan ekleyebilirsiniz.</div>`;
                } else {
                    notesListEl.innerHTML = notes.map(n => {
                        const dateStr = n.created_at ? n.created_at.slice(5, 16) : '';
                        return `
                            <div class="ov-item-row" style="background:var(--surface, #fff); border:1px solid var(--border); border-radius:8px; padding:10px 12px; display:flex; flex-direction:column; gap:6px;">
                                <div style="font-size:0.9rem; color:var(--text); white-space:pre-wrap; word-break:break-word; line-height:1.4;">${escapeHtml(n.content)}</div>
                                <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px dashed var(--border); padding-top:6px; margin-top:2px;">
                                    <span style="font-size:0.75rem; color:var(--muted);">🕒 ${escapeHtml(dateStr)}</span>
                                    <div style="display:flex; gap:6px;">
                                        <button class="btn btn-xs btn-outline" onclick="openTransferQuickNoteModal(${n.id}, ${JSON.stringify(n.content).replace(/"/g, '&quot;')})" title="Bu notu bir sayfaya veya klasöre taşı">
                                            📁 Aktar
                                        </button>
                                        <button class="btn btn-xs btn-ghost" onclick="deleteWebQuickNote(${n.id})" title="Sil" style="color:var(--danger, #ef4444);">
                                            🗑️
                                        </button>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }
        }
    } catch (e) {
        console.warn("renderWebQuickNotes error:", e);
    }

    // 2. Birleşik Görevler (Tüm Sayfalar + Ödemeler - Tarih Sıralı)
    try {
        const res = await fetch('/notes/api/unified-tasks');
        const data = await res.json();
        if (!data.ok) return;

        const tasks = data.tasks || [];
        const container = document.getElementById('web-unified-tasks-container');
        const badge = document.getElementById('web-unified-tasks-count');
        const sideBadge = document.getElementById('quick-tasks-badge-count');
        const directListEl = document.getElementById('web-quick-direct-list');
        const directCountEl = document.getElementById('web-quick-direct-count');

        // Hızlı doğrudan görevler ile genel görevleri ayır
        const directTasks = tasks.filter(t => t.due_urgency === 2.5 || (t.due_badge && t.due_badge.includes('Hızlı Görev')));
        const generalTasks = tasks.filter(t => t.due_urgency !== 2.5 && (!t.due_badge || !t.due_badge.includes('Hızlı Görev')));

        if (directCountEl) directCountEl.textContent = directTasks.length;
        if (badge) badge.textContent = `${generalTasks.length} Görev / Ödeme`;
        if (sideBadge) sideBadge.textContent = tasks.length;

        // A) Doğrudan Hızlı Görevler Listesi
        if (directListEl) {
            if (directTasks.length === 0) {
                directListEl.innerHTML = `<div style="padding:14px; text-align:center; color:var(--muted); font-size:0.82rem;">Henüz doğrudan hızlı görev yok.</div>`;
            } else {
                directListEl.innerHTML = directTasks.map(t => `
                    <div class="ov-item-row" id="web-unified-task-${t.id}">
                        <div class="ov-item-left">
                            <input type="checkbox" ${t.is_done ? 'checked' : ''} onchange="toggleWebUnifiedTask('${t.type}', ${t.raw_id}, this)" style="cursor:pointer; width:16px; height:16px;">
                            <span class="ov-item-text" style="font-weight:600; ${t.is_done ? 'text-decoration:line-through; opacity:0.5;' : ''}" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
                        </div>
                        <div class="ov-item-meta">
                            <span style="background:#e0f2fe; color:#0284c7; font-size:0.72rem; font-weight:700; padding:2px 6px; border-radius:4px;">⚡ Hızlı</span>
                            <button class="btn-icon-subtle" onclick="deleteWebQuickTask(${t.raw_id})" title="Görevi Sil" style="color:var(--danger, #ef4444); font-size:0.8rem;">✕</button>
                        </div>
                    </div>
                `).join('');
            }
        }

        // B) Diğer Sayfa ve Kategorilerden Gelen Görevler & Ödemeler
        if (container) {
            if (generalTasks.length === 0) {
                container.innerHTML = `<div style="padding:16px; text-align:center; color:var(--muted); font-size:0.82rem;">🎉 Harika! Bekleyen başka görev veya ödeme yok.</div>`;
            } else {
                container.innerHTML = generalTasks.map(t => {
                    let badgeBg = '#f1f5f9';
                    let badgeColor = '#475569';
                    if (t.due_badge && t.due_badge.includes('Gecikmiş')) {
                        badgeBg = '#fee2e2';
                        badgeColor = '#ef4444';
                    } else if (t.due_badge && (t.due_badge.includes('Yarın') || t.due_badge.includes('Bugün'))) {
                        badgeBg = '#fef3c7';
                        badgeColor = '#d97706';
                    }

                    return `
                        <div class="ov-item-row" id="web-unified-task-${t.id}">
                            <div class="ov-item-left">
                                <input type="checkbox" ${t.is_done ? 'checked' : ''} onchange="toggleWebUnifiedTask('${t.type}', ${t.raw_id}, this)" style="cursor:pointer; width:16px; height:16px;">
                                <span class="ov-item-text" style="font-weight:600; ${t.is_done ? 'text-decoration:line-through; opacity:0.5;' : ''}" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
                            </div>
                            <div class="ov-item-meta">
                                ${t.due_badge ? `<span style="background:${badgeBg}; color:${badgeColor}; font-size:0.72rem; font-weight:700; padding:2px 6px; border-radius:4px;">${escapeHtml(t.due_badge)}</span>` : ''}
                                <span class="ov-page-tag" onclick="loadPage(${t.page_id})" title="${escapeHtml(t.page_title)} sayfasına git">📁 ${escapeHtml(t.page_title)}</span>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }
    } catch (e) {
        console.error("renderWebQuickTasks error:", e);
    }
}

async function addWebQuickNote() {
    const input = document.getElementById('web-quick-note-input');
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;

    try {
        const res = await fetch('/notes/api/quick-notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        });
        const data = await res.json();
        if (data.ok) {
            input.value = '';
            await renderWebQuickTasks();
        } else {
            alert(data.error || 'Not eklenemedi');
        }
    } catch (e) {
        console.error("addWebQuickNote error:", e);
    }
}

async function deleteWebQuickNote(noteId) {
    if (!confirm('Bu hızlı notu silmek istediğinize emin misiniz?')) return;
    try {
        const res = await fetch(`/notes/api/quick-notes/${noteId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
            await renderWebQuickTasks();
        }
    } catch (e) {
        console.error("deleteWebQuickNote error:", e);
    }
}

let activeTransferNoteId = null;

async function openTransferQuickNoteModal(noteId, content) {
    activeTransferNoteId = noteId;
    const idEl = document.getElementById('transfer-note-id');
    const prevEl = document.getElementById('transfer-note-preview');
    if (idEl) idEl.value = noteId;
    if (prevEl) prevEl.textContent = content;

    // Hedef Sayfaları Doldur
    try {
        const pRes = await fetch('/notes/api/pages');
        const pData = await pRes.json();
        const pages = pData.pages || [];

        const pageSelect = document.getElementById('transfer-target-page');
        if (pageSelect) {
            pageSelect.innerHTML = pages.map(p => `
                <option value="${p.id}">📄 ${escapeHtml(p.title)} (${p.category_name || 'Genel'})</option>
            `).join('');
        }

        const catRes = await fetch('/notes/api/categories');
        const catData = await catRes.json();
        const cats = catData.categories || [];

        const catSelect = document.getElementById('transfer-target-category');
        if (catSelect) {
            catSelect.innerHTML = cats.map(c => `
                <option value="${c.id}">📁 ${escapeHtml(c.name)}</option>
            `).join('');
        }
    } catch (e) {
        console.warn("Transfer seçenekleri yüklenirken hata:", e);
    }

    toggleTransferMode('existing');
    openModal('modal-transfer-quick-note');
}

function toggleTransferMode(mode) {
    const existingBox = document.getElementById('transfer-mode-existing');
    const newBox = document.getElementById('transfer-mode-new');
    if (mode === 'new') {
        if (existingBox) existingBox.style.display = 'none';
        if (newBox) newBox.style.display = 'block';
    } else {
        if (existingBox) existingBox.style.display = 'block';
        if (newBox) newBox.style.display = 'none';
    }
}

async function submitTransferQuickNote() {
    const noteId = activeTransferNoteId || document.getElementById('transfer-note-id')?.value;
    if (!noteId) return;

    const mode = document.querySelector('input[name="transfer-mode"]:checked')?.value || 'existing';
    let payload = {};

    if (mode === 'new') {
        const catId = document.getElementById('transfer-target-category')?.value;
        const pageTitle = document.getElementById('transfer-new-page-title')?.value.trim();
        if (!pageTitle) {
            alert('Lütfen yeni sayfa başlığını girin');
            return;
        }
        payload = { target_category_id: parseInt(catId), new_page_title: pageTitle };
    } else {
        const pageId = document.getElementById('transfer-target-page')?.value;
        if (!pageId) {
            alert('Lütfen bir hedef sayfa seçin');
            return;
        }
        payload = { target_page_id: parseInt(pageId) };
    }

    try {
        const res = await fetch(`/notes/api/quick-notes/${noteId}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.ok) {
            closeModal('modal-transfer-quick-note');
            await renderWebQuickTasks();
            await reloadCategories();
            if (data.target_page_id && confirm('Not başarıyla aktarıldı! İlgili sayfayı açmak ister misiniz?')) {
                loadPage(data.target_page_id);
            }
        } else {
            alert(data.error || 'Aktarım başarısız');
        }
    } catch (e) {
        console.error("submitTransferQuickNote error:", e);
    }
}

async function addWebQuickTask() {
    const input = document.getElementById('web-quick-task-input');
    if (!input) return;
    const title = input.value.trim();
    if (!title) return;

    try {
        const res = await fetch('/notes/api/quick-tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title })
        });
        const data = await res.json();
        if (data.ok) {
            input.value = '';
            await renderWebQuickTasks();
        } else {
            alert(data.error || 'Görev eklenemedi');
        }
    } catch (e) {
        console.error("addWebQuickTask error:", e);
    }
}

async function deleteWebQuickTask(rawId) {
    if (!confirm('Bu hızlı görevi silmek istediğinize emin misiniz?')) return;
    try {
        await fetch(`/notes/api/items/${rawId}`, { method: 'DELETE' });
        await renderWebQuickTasks();
    } catch (e) {
        console.error("deleteWebQuickTask error:", e);
    }
}

async function toggleWebUnifiedTask(taskType, rawId, checkboxEl) {
    try {
        await fetch('/notes/api/toggle-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: taskType, raw_id: rawId })
        });
        const row = checkboxEl.closest('.ov-item-row');
        if (row) {
            row.style.opacity = '0.4';
            row.style.textDecoration = 'line-through';
        }
        setTimeout(() => {
            renderWebQuickTasks();
        }, 600);
    } catch (e) {
        console.error("toggleWebUnifiedTask error:", e);
    }
}

// ─────────────────────────────────────────────────────────────
// GENEL BAKIŞ & ÖZET (ANA SAYFA)
// ─────────────────────────────────────────────────────────────

let currentOverviewData = null;

async function loadOverviewPage() {
    currentPageId = null;
    currentPageData = null;

    // Sidebar'da Genel Bakış butonunu aktif yap, sayfaların aktifliğini kaldır
    const ovBtn = document.getElementById('sidebar-overview-btn');
    const quickBtn = document.getElementById('sidebar-quick-btn');
    const vaultBtn = document.getElementById('sidebar-vault-btn');
    const trashBtn = document.getElementById('sidebar-trash-btn');
    if (ovBtn) ovBtn.classList.add('active');
    if (quickBtn) quickBtn.classList.remove('active');
    if (vaultBtn) vaultBtn.classList.remove('active');
    if (trashBtn) trashBtn.classList.remove('active');

    document.querySelectorAll('.page-item').forEach(el => el.classList.remove('active'));

    // Header güncelle
    const titleEl = document.getElementById('current-page-title');
    const iconEl = document.getElementById('current-page-icon');
    const badgeEl = document.getElementById('current-page-badge');
    if (titleEl) titleEl.textContent = 'Genel Bakış & Durum';
    if (iconEl) iconEl.textContent = '🏠';
    if (badgeEl) badgeEl.textContent = 'Özet Paneli';

    // Header aksiyonları
    const pageActions = document.getElementById('page-header-actions');
    const ovActions = document.getElementById('overview-header-actions');
    const vaultActions = document.getElementById('vault-header-actions');
    const trashActions = document.getElementById('trash-header-actions');
    if (pageActions) pageActions.style.display = 'none';
    if (ovActions) ovActions.style.display = 'flex';
    if (vaultActions) vaultActions.style.display = 'none';
    if (trashActions) trashActions.style.display = 'none';

    // Diğer görünümleri gizle
    const checklistArea = document.getElementById('checklist-view');
    const noteArea = document.getElementById('note-view');
    const financeArea = document.getElementById('finance-view');
    const projectArea = document.getElementById('project-view');
    const vaultArea = document.getElementById('vault-view');
    const trashArea = document.getElementById('trash-view');
    const quickAddBox = document.getElementById('quick-add-container');
    const overviewArea = document.getElementById('overview-view');
    const quickArea = document.getElementById('quick-tasks-view');

    if (checklistArea) checklistArea.style.display = 'none';
    if (noteArea) noteArea.style.display = 'none';
    if (financeArea) financeArea.style.display = 'none';
    if (projectArea) projectArea.style.display = 'none';
    if (vaultArea) vaultArea.style.display = 'none';
    if (trashArea) trashArea.style.display = 'none';
    if (quickAddBox) quickAddBox.style.display = 'none';
    if (quickArea) quickArea.style.display = 'none';
    if (overviewArea) overviewArea.style.display = 'flex';

    // Tarih metnini güncelle
    const dateEl = document.getElementById('overview-date-str');
    if (dateEl) {
        const today = new Date();
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        dateEl.textContent = today.toLocaleDateString('tr-TR', options);
    }

    try {
        const res = await fetch('/notes/api/overview');
        const data = await res.json();
        if (!data.ok) return;

        currentOverviewData = data.overview;
        renderOverview(data.overview);
    } catch (e) {
        console.error("Genel bakış yükleme hatası:", e);
    }
}

function renderOverview(ov) {
    // 1. KPI Kartları
    // Görevler
    const totalItems = ov.total_items || 0;
    const completedItems = ov.completed_items || 0;
    const pendingItems = ov.pending_items || 0;
    const taskPct = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

    const tasksTotalEl = document.getElementById('ov-tasks-total');
    const tasksSubEl = document.getElementById('ov-tasks-sub');
    const tasksBadgeEl = document.getElementById('ov-tasks-badge');
    const tasksBarEl = document.getElementById('ov-tasks-bar');

    if (tasksTotalEl) tasksTotalEl.textContent = totalItems;
    if (tasksSubEl) tasksSubEl.textContent = `${pendingItems} bekleyen, ${completedItems} bitti`;
    if (tasksBadgeEl) tasksBadgeEl.textContent = `%${taskPct} Bitti`;
    if (tasksBarEl) tasksBarEl.style.width = `${taskPct}%`;

    // Finans
    const f = ov.finance || {};
    const net = f.net || 0;
    const income = f.income || 0;
    const expense = f.expense || 0;
    const unpaid = f.unpaid_expense || 0;
    const unpaidCount = f.unpaid_count || 0;

    const fNetEl = document.getElementById('ov-finance-net');
    const fSubEl = document.getElementById('ov-finance-sub');
    const fBarEl = document.getElementById('ov-finance-bar');
    const fPeriodEl = document.getElementById('ov-finance-period');

    if (fNetEl) {
        fNetEl.textContent = (net >= 0 ? '+' : '') + net.toLocaleString('tr-TR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' TL';
        fNetEl.style.color = net >= 0 ? '#10b981' : '#ef4444';
    }
    if (fSubEl) fSubEl.textContent = `Gelir: ${income.toLocaleString('tr-TR')} TL | Gider: ${expense.toLocaleString('tr-TR')} TL`;
    if (fPeriodEl) fPeriodEl.textContent = f.period || 'Bu Ay';
    if (fBarEl) {
        const fRatio = (income + expense) > 0 ? Math.min(100, Math.round((expense / (income || 1)) * 100)) : 0;
        fBarEl.style.width = `${Math.min(100, fRatio)}%`;
        fBarEl.style.background = net >= 0 ? '#10b981' : '#ef4444';
    }

    // Bekleyen Faturalar
    const billsTotalEl = document.getElementById('ov-bills-total');
    const billsSubEl = document.getElementById('ov-bills-sub');
    const billsTagEl = document.getElementById('ov-bills-count-tag');
    const billsBarEl = document.getElementById('ov-bills-bar');

    if (billsTotalEl) billsTotalEl.textContent = unpaid.toLocaleString('tr-TR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' TL';
    if (billsSubEl) billsSubEl.textContent = unpaidCount > 0 ? `${unpaidCount} bekleyen ödeme var` : 'Tüm faturalar ödendi 👍';
    if (billsTagEl) billsTagEl.textContent = `${unpaidCount} Bekleyen`;
    if (billsBarEl) billsBarEl.style.width = unpaidCount > 0 ? '70%' : '0%';

    // Projeler
    const projects = ov.projects || [];
    const projTotalEl = document.getElementById('ov-projects-total');
    const projSubEl = document.getElementById('ov-projects-sub');
    const projTagEl = document.getElementById('ov-proj-count-tag');

    if (projTotalEl) projTotalEl.textContent = projects.length;
    if (projSubEl) projSubEl.textContent = projects.length > 0 ? `${projects.length} proje yürütülüyor` : 'Henüz proje eklenmedi';
    if (projTagEl) projTagEl.textContent = `${projects.length} Proje`;

    // 2. Bekleyen Görevler Listesi
    const pendingContainer = document.getElementById('ov-pending-items-container');
    const pendingBadge = document.getElementById('ov-pending-count-badge');
    if (pendingBadge) pendingBadge.textContent = `${(ov.pending_tasks || []).length} görev`;

    if (pendingContainer) {
        if (!ov.pending_tasks || ov.pending_tasks.length === 0) {
            pendingContainer.innerHTML = `<div style="padding:16px; text-align:center; color:var(--muted); font-size:0.82rem;">🎉 Harika! Bekleyen görev veya yapılacak madde yok.</div>`;
        } else {
            pendingContainer.innerHTML = ov.pending_tasks.map(it => `
                <div class="ov-item-row" id="ov-task-${it.id}">
                    <div class="ov-item-left">
                        <input type="checkbox" onchange="toggleTaskFromOverview(${it.id}, this)" style="cursor:pointer; width:16px; height:16px;">
                        <span class="ov-item-text" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</span>
                    </div>
                    <div class="ov-item-meta">
                        ${it.quantity ? `<span style="color:var(--muted); font-size:0.72rem;">${escapeHtml(it.quantity)}</span>` : ''}
                        ${it.price ? `<span style="color:#0284c7; font-size:0.72rem; font-weight:600;">${escapeHtml(it.price)}</span>` : ''}
                        <span class="ov-page-tag" onclick="loadPage(${it.page_id})" title="${escapeHtml(it.page_title)} sayfasına git">${it.page_icon || '📝'} ${escapeHtml(it.page_title)}</span>
                    </div>
                </div>
            `).join('');
        }
    }

    // 3. Vadesi Yaklaşan Faturalar & Ödemeler
    const billsContainer = document.getElementById('ov-upcoming-bills-container');
    if (billsContainer) {
        if (!ov.upcoming_bills || ov.upcoming_bills.length === 0) {
            billsContainer.innerHTML = `<div style="padding:16px; text-align:center; color:var(--muted); font-size:0.82rem;">✅ Bu ay için bekleyen fatura veya düzenli ödeme yok.</div>`;
        } else {
            billsContainer.innerHTML = ov.upcoming_bills.map(b => `
                <div class="ov-bill-row" onclick="loadPage(${b.page_id})" title="Finans sayfasına git">
                    <div class="ov-bill-left">
                        <span class="ov-bill-day">Gün ${b.due_day}</span>
                        <div>
                            <div class="ov-bill-title">${escapeHtml(b.title)}</div>
                            <div style="font-size:0.70rem; color:var(--muted);">${escapeHtml(b.category || 'Genel')} • ${escapeHtml(b.page_title)}</div>
                        </div>
                    </div>
                    <div class="ov-bill-amount">-${parseFloat(b.amount).toLocaleString('tr-TR', {minimumFractionDigits:2})} TL</div>
                </div>
            `).join('');
        }
    }

    // 4. Aktif Projeler Listesi
    const projContainer = document.getElementById('ov-projects-container');
    if (projContainer) {
        if (projects.length === 0) {
            projContainer.innerHTML = `
                <div style="padding:16px; text-align:center; color:var(--muted); font-size:0.82rem;">
                    Henüz proje oluşturulmadı.
                    <div style="margin-top:6px;">
                        <button class="btn btn-sm btn-outline" onclick="openAddProjectModal()">➕ İlk Projeyi Başlat</button>
                    </div>
                </div>`;
        } else {
            projContainer.innerHTML = projects.map(p => `
                <div class="ov-project-row" onclick="loadPage(${p.id})">
                    <div class="ov-proj-header">
                        <span class="ov-proj-title">${p.icon || '⚡'} ${escapeHtml(p.title)}</span>
                        <span class="ov-proj-pct">%${p.progress || 0}</span>
                    </div>
                    <div class="ov-progress-track">
                        <div class="ov-progress-fill" style="width:${p.progress || 0}%; background:#8b5cf6;"></div>
                    </div>
                </div>
            `).join('');
        }
    }

    // 5. Son Kullanılan Sayfalar
    const recentContainer = document.getElementById('ov-recent-pages-container');
    if (recentContainer) {
        const pages = ov.recent_pages || [];
        if (pages.length === 0) {
            recentContainer.innerHTML = `<div style="padding:16px; text-align:center; color:var(--muted); font-size:0.82rem;">Henüz sayfa yok.</div>`;
        } else {
            recentContainer.innerHTML = pages.map(p => `
                <div class="ov-recent-row" onclick="loadPage(${p.id})">
                    <div class="ov-recent-left">
                        <span style="font-size:0.95rem;">${p.icon || '📝'}</span>
                        <span class="ov-recent-title">${escapeHtml(p.title)}</span>
                    </div>
                    <span class="ov-recent-badge">${escapeHtml(p.category_name || '')} ${p.type === 'checklist' ? `(${p.item_count || 0})` : ''}</span>
                </div>
            `).join('');
        }
    }
}

async function toggleTaskFromOverview(itemId, checkboxEl) {
    try {
        const res = await fetch(`/notes/api/items/${itemId}/toggle`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            const row = document.getElementById(`ov-task-${itemId}`);
            if (row) {
                row.style.opacity = '0.4';
                row.style.textDecoration = 'line-through';
                setTimeout(() => {
                    row.remove();
                    // Sayacı ve KPI'yi güncelle
                    loadOverviewPage();
                }, 350);
            }
        }
    } catch (e) {
        console.error("Görev güncelleme hatası:", e);
    }
}

function jumpToFirstChecklist() {
    if (currentOverviewData && currentOverviewData.first_checklist_page) {
        loadPage(currentOverviewData.first_checklist_page);
    }
}

function jumpToFinancePage() {
    if (currentOverviewData && currentOverviewData.first_finance_page) {
        loadPage(currentOverviewData.first_finance_page);
    }
}

function jumpToFirstProject() {
    if (currentOverviewData && currentOverviewData.first_project_page) {
        loadPage(currentOverviewData.first_project_page);
    }
}

// ─────────────────────────────────────────────────────────────
// Sayfa Yükleme & Render
// ─────────────────────────────────────────────────────────────

async function loadPage(pageId) {
    if (isDraggingAny) return;
    currentPageId = pageId;

    // Genel Bakış, Hızlı Görevler, Kasa ve Çöp Kutusu butonlarını pasifleştir
    const ovBtn = document.getElementById('sidebar-overview-btn');
    const quickBtn = document.getElementById('sidebar-quick-btn');
    const vaultBtn = document.getElementById('sidebar-vault-btn');
    const trashBtn = document.getElementById('sidebar-trash-btn');
    if (ovBtn) ovBtn.classList.remove('active');
    if (quickBtn) quickBtn.classList.remove('active');
    if (vaultBtn) vaultBtn.classList.remove('active');
    if (trashBtn) trashBtn.classList.remove('active');

    const ovArea = document.getElementById('overview-view');
    const quickArea = document.getElementById('quick-tasks-view');
    const vaultArea = document.getElementById('vault-view');
    const trashArea = document.getElementById('trash-view');
    if (ovArea) ovArea.style.display = 'none';
    if (quickArea) quickArea.style.display = 'none';
    if (vaultArea) vaultArea.style.display = 'none';
    if (trashArea) trashArea.style.display = 'none';

    const pageActions = document.getElementById('page-header-actions');
    const ovActions = document.getElementById('overview-header-actions');
    const vaultActions = document.getElementById('vault-header-actions');
    const trashActions = document.getElementById('trash-header-actions');
    if (pageActions) pageActions.style.display = 'flex';
    if (ovActions) ovActions.style.display = 'none';
    if (vaultActions) vaultActions.style.display = 'none';
    if (trashActions) trashActions.style.display = 'none';

    // Menü aktif sınıfını güncelle ve bağlı kategoriyi açık tut
    document.querySelectorAll('.page-item').forEach(el => {
        const isActive = (el.dataset.pageId == pageId);
        el.classList.toggle('active', isActive);
        if (isActive) {
            const parentGroup = el.closest('.category-group');
            if (parentGroup && parentGroup.classList.contains('collapsed')) {
                parentGroup.classList.remove('collapsed');
                const catId = parentGroup.dataset.categoryId;
                if (catId) saveCategoryCollapsedState(catId, false);
            }
        }
    });

    try {
        const res = await fetch(`/notes/api/pages/${pageId}`);
        const data = await res.json();
        if (!data.ok) {
            console.error(data.error);
            return;
        }

        currentPageData = data.page;
        currentItems = data.items || [];

        renderPageHeader();
        if (currentPageData.type === 'notes') {
            renderNoteEditor();
        } else if (currentPageData.type === 'finance') {
            loadFinanceData(currentFinancePeriod);
        } else if (currentPageData.type === 'project') {
            loadProjectData(pageId);
        } else {
            renderChecklist();
        }
    } catch (e) {
        console.error("Sayfa yükleme hatası:", e);
    }
}

function renderPageHeader() {
    const titleEl = document.getElementById('current-page-title');
    const iconEl = document.getElementById('current-page-icon');
    const badgeEl = document.getElementById('current-page-badge');

    if (titleEl) titleEl.textContent = currentPageData.title;
    if (iconEl) iconEl.textContent = currentPageData.icon || '📝';

    const checklistArea = document.getElementById('checklist-view');
    const noteArea = document.getElementById('note-view');
    const financeArea = document.getElementById('finance-view');
    const projectArea = document.getElementById('project-view');
    const quickAddBox = document.getElementById('quick-add-container');

    const btnBulkAdd = document.getElementById('btn-bulk-add');
    const btnClearDone = document.getElementById('btn-clear-done');
    const btnResetList = document.getElementById('btn-reset-list');

    if (currentPageData.type === 'notes') {
        if (checklistArea) checklistArea.style.display = 'none';
        if (financeArea) financeArea.style.display = 'none';
        if (projectArea) projectArea.style.display = 'none';
        if (quickAddBox) quickAddBox.style.display = 'none';
        if (noteArea) noteArea.style.display = 'block';
        if (btnBulkAdd) btnBulkAdd.style.display = 'none';
        if (btnClearDone) btnClearDone.style.display = 'none';
        if (btnResetList) btnResetList.style.display = 'none';
        if (badgeEl) badgeEl.textContent = 'Serbest Metin / Not';
    } else if (currentPageData.type === 'finance') {
        if (checklistArea) checklistArea.style.display = 'none';
        if (noteArea) noteArea.style.display = 'none';
        if (projectArea) projectArea.style.display = 'none';
        if (quickAddBox) quickAddBox.style.display = 'none';
        if (financeArea) financeArea.style.display = 'flex';
        if (btnBulkAdd) btnBulkAdd.style.display = 'none';
        if (btnClearDone) btnClearDone.style.display = 'none';
        if (btnResetList) btnResetList.style.display = 'none';
        if (badgeEl) badgeEl.textContent = 'Finans & Fatura Tablosu';
    } else if (currentPageData.type === 'project') {
        if (checklistArea) checklistArea.style.display = 'none';
        if (noteArea) noteArea.style.display = 'none';
        if (financeArea) financeArea.style.display = 'none';
        if (quickAddBox) quickAddBox.style.display = 'none';
        if (projectArea) projectArea.style.display = 'flex';
        if (btnBulkAdd) btnBulkAdd.style.display = 'none';
        if (btnClearDone) btnClearDone.style.display = 'none';
        if (btnResetList) btnResetList.style.display = 'none';
        if (badgeEl) badgeEl.textContent = 'Proje / İnşa & Atölye';
    } else {
        if (noteArea) noteArea.style.display = 'none';
        if (financeArea) financeArea.style.display = 'none';
        if (projectArea) projectArea.style.display = 'none';
        if (checklistArea) checklistArea.style.display = 'block';
        if (quickAddBox) quickAddBox.style.display = 'flex';
        if (btnBulkAdd) btnBulkAdd.style.display = 'inline-block';
        if (btnClearDone) btnClearDone.style.display = 'inline-block';
        if (btnResetList) btnResetList.style.display = 'inline-block';
        const pendingCount = currentItems.filter(i => !i.is_done).length;
        if (badgeEl) badgeEl.textContent = `${pendingCount} bekleyen / ${currentItems.length} toplam`;
    }
}

function renderChecklist() {
    const listEl = document.getElementById('items-container');
    if (!listEl) return;
    listEl.innerHTML = '';

    const query = (document.getElementById('items-search')?.value || '').toLowerCase().trim();

    const filtered = currentItems.filter(item => {
        if (currentFilter === 'pending' && item.is_done) return false;
        if (currentFilter === 'done' && !item.is_done) return false;
        if (query && !item.title.toLowerCase().includes(query) && !(item.description || '').toLowerCase().includes(query)) return false;
        return true;
    });

    if (filtered.length === 0) {
        listEl.innerHTML = `<li class="item-card" style="justify-content:center; color:var(--muted); padding:24px;">Bu görünümde madde bulunamadı.</li>`;
        return;
    }

    filtered.forEach(item => {
        const li = document.createElement('li');
        li.className = `item-card ${item.is_done ? 'done' : ''}`;
        li.dataset.itemId = item.id;

        let metaHtml = '';
        if (item.price) metaHtml += `<span class="tag-price">💰 ${escapeHtml(item.price)}</span>`;
        if (item.quantity) metaHtml += `<span class="tag-qty">📦 ${escapeHtml(item.quantity)}</span>`;
        if (item.remind_at) {
            metaHtml += `<span class="tag-reminder">⏰ ${item.remind_at.substring(5, 16)}</span>`;
        }
        if (item.url) {
            metaHtml += `<a href="${escapeHtml(item.url)}" target="_blank" class="tag-link">🔗 Link</a>`;
        }

        let actionsHtml = `
            <button class="btn-icon-subtle" title="Maddeyi Düzenle" onclick="openEditItemModal(${item.id})">✏️</button>
            <button class="btn-icon-subtle" title="Hatırlatıcı Kur" onclick="openReminderModal(${item.id}, '${escapeHtml(item.title)}')">⏰</button>
        `;
        if (item.url) {
            actionsHtml += `<a href="${escapeHtml(item.url)}" target="_blank" class="btn-icon-subtle" title="Ürün Linkini Aç">🔗</a>`;
        }
        actionsHtml += `<button class="btn-icon-subtle btn-danger-hover" title="Maddeyi Sil" onclick="deleteItem(${item.id})">🗑️</button>`;

        const thumbHtml = item.image_url ? `<img src="${escapeHtml(item.image_url)}" class="item-thumb" alt="thumb">` : '';

        li.setAttribute('draggable', 'true');

        li.addEventListener('dragstart', (e) => {
            window.draggedChecklistItem = li;
            isDraggingAny = true;
            li.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.id);
        });

        li.addEventListener('dragend', () => {
            li.classList.remove('is-dragging');
            clearDropIndicators();
            window.draggedChecklistItem = null;
            setTimeout(() => { isDraggingAny = false; }, 150);
        });

        li.addEventListener('dragover', (e) => {
            if (!window.draggedChecklistItem || window.draggedChecklistItem === li) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';

            const rect = li.getBoundingClientRect();
            const relY = e.clientY - rect.top;
            clearDropIndicators();
            if (relY < rect.height / 2) {
                li.classList.add('drop-target-above');
            } else {
                li.classList.add('drop-target-below');
            }
        });

        li.addEventListener('dragleave', () => {
            li.classList.remove('drop-target-above', 'drop-target-below');
        });

        li.addEventListener('drop', async (e) => {
            if (!window.draggedChecklistItem || window.draggedChecklistItem === li) return;
            e.preventDefault();
            e.stopPropagation();

            const isAbove = li.classList.contains('drop-target-above');
            clearDropIndicators();

            if (isAbove) {
                li.parentNode.insertBefore(window.draggedChecklistItem, li);
            } else {
                li.parentNode.insertBefore(window.draggedChecklistItem, li.nextSibling);
            }

            // Yeni madde sırasını topla ve sunucuya gönder
            const allItemEls = Array.from(listEl.querySelectorAll('.item-card'));
            const newIds = allItemEls.map(el => parseInt(el.dataset.itemId)).filter(Boolean);
            try {
                await fetch(`/notes/api/pages/${currentPageId}/reorder`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({item_ids: newIds})
                });
                showToast("Madde sırası güncellendi!");
            } catch (err) {
                console.error("Madde sırası kaydetme hatası:", err);
            }
        });

        li.innerHTML = `
            <div class="item-left">
                <span class="drag-handle item-drag-handle" title="Maddeyi taşımak için sürükleyin" onclick="event.stopPropagation()">⋮⋮</span>
                <input type="checkbox" class="item-checkbox" ${item.is_done ? 'checked' : ''} onchange="toggleItemDone(${item.id}, this.checked)">
                ${thumbHtml}
                <div class="item-content">
                    <div class="item-title">${escapeHtml(item.title)}</div>
                    ${metaHtml ? `<div class="item-meta">${metaHtml}</div>` : ''}
                </div>
            </div>
            <div class="item-actions">
                ${actionsHtml}
            </div>
        `;
        listEl.appendChild(li);
    });
}

function renderNoteEditor() {
    const textarea = document.getElementById('note-content-textarea');
    if (textarea && currentPageData) {
        textarea.value = currentPageData.content || '';
    }
}

async function saveNoteContent() {
    const textarea = document.getElementById('note-content-textarea');
    if (!textarea || !currentPageId) return;

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({content: textarea.value})
        });
        const data = await res.json();
        if (data.ok) {
            showToast("Not kaydedildi!");
        }
    } catch (e) {
        console.error("Not kaydetme hatası:", e);
    }
}

// ─────────────────────────────────────────────────────────────
// Madde Ekleme & Düzenleme
// ─────────────────────────────────────────────────────────────

async function submitQuickItem() {
    const titleInput = document.getElementById('quick-item-title');
    const title = titleInput.value.trim();
    if (!title || !currentPageId) return;

    const qtyInput = document.getElementById('quick-item-qty');
    const priceInput = document.getElementById('quick-item-price');
    const urlInput = document.getElementById('quick-item-url');

    const payload = {
        title: title,
        quantity: qtyInput ? qtyInput.value.trim() : '',
        price: priceInput ? priceInput.value.trim() : '',
        url: urlInput ? urlInput.value.trim() : ''
    };

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/items`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.ok) {
            titleInput.value = '';
            if (qtyInput) qtyInput.value = '';
            if (priceInput) priceInput.value = '';
            if (urlInput) urlInput.value = '';
            closeQuickDetails();
            loadPage(currentPageId);
        }
    } catch (e) {
        console.error("Madde eklenemedi:", e);
    }
}

async function autoScrapeUrl(url) {
    const titleInput = document.getElementById('quick-item-title');
    const priceInput = document.getElementById('quick-item-price');
    const urlInput = document.getElementById('quick-item-url');
    const detailsBox = document.getElementById('quick-details-box');

    if (detailsBox) detailsBox.classList.add('open');
    if (urlInput) urlInput.value = url;

    titleInput.placeholder = "Ürün bilgileri çekiliyor...";

    try {
        const res = await fetch('/notes/api/scrape', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({url: url})
        });
        const data = await res.json();
        if (data.ok && data.metadata) {
            titleInput.value = data.metadata.title || url;
            if (priceInput && data.metadata.price) priceInput.value = data.metadata.price;
        }
    } catch (e) {
        console.error("Scraper hatası:", e);
    } finally {
        titleInput.placeholder = "Yeni bir madde veya ürün linki yazın...";
    }
}

function toggleQuickDetails() {
    const box = document.getElementById('quick-details-box');
    if (box) box.classList.toggle('open');
}

function closeQuickDetails() {
    const box = document.getElementById('quick-details-box');
    if (box) box.classList.remove('open');
}

async function toggleItemDone(itemId, isDone) {
    try {
        await fetch(`/notes/api/items/${itemId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({is_done: isDone ? 1 : 0})
        });
        // Güncel veriyi localde güncelle
        const it = currentItems.find(i => i.id === itemId);
        if (it) it.is_done = isDone ? 1 : 0;
        renderPageHeader();
        renderChecklist();
    } catch (e) {
        console.error("Durum güncellenemedi:", e);
    }
}

async function deleteItem(itemId) {
    if (!confirm("Bu maddeyi silmek istediğinize emin misiniz?")) return;
    try {
        await fetch(`/notes/api/items/${itemId}`, { method: 'DELETE' });
        currentItems = currentItems.filter(i => i.id !== itemId);
        renderPageHeader();
        renderChecklist();
    } catch (e) {
        console.error("Silinemedi:", e);
    }
}

async function clearCompleted() {
    if (!currentPageId) return;
    if (!confirm("Tamamlanmış tüm maddeler temizlensin mi?")) return;
    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/clear_completed`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            loadPage(currentPageId);
        }
    } catch (e) {
        console.error("Temizleme hatası:", e);
    }
}

// ─────────────────────────────────────────────────────────────
// Panoya Kopyalama & Paylaşma
// ─────────────────────────────────────────────────────────────

function copyListToClipboard() {
    if (!currentPageData) return;

    let text = `${currentPageData.icon || '📝'} ${currentPageData.title}\n`;
    text += `━━━━━━━━━━━━━━━━━━━\n`;

    if (currentPageData.type === 'notes') {
        text += document.getElementById('note-content-textarea')?.value || '';
    } else if (currentPageData.type === 'finance') {
        if (currentFinanceData && currentFinanceData.summary) {
            const sum = currentFinanceData.summary;
            const entries = currentFinanceData.entries || [];
            text += `📅 Dönem: ${sum.period}\n`;
            text += `📈 Toplam Gelir: ${formatCurrency(sum.total_income)}\n`;
            text += `📉 Toplam Gider: ${formatCurrency(sum.total_expense)}\n`;
            text += `💵 Net Bakiye: ${formatCurrency(sum.net_balance)}\n\n`;

            const unpaid = entries.filter(e => e.entry_type === 'expense' && !e.is_paid);
            if (unpaid.length > 0) {
                text += `⏳ Bekleyen Faturalar & Ödemeler:\n`;
                unpaid.forEach(e => {
                    const due = e.due_day ? ` (Ayın ${e.due_day}. günü)` : '';
                    text += `• ▫️ ${e.title} - ${formatCurrency(e.amount)}${due}\n`;
                });
            }
            const paid = entries.filter(e => e.entry_type === 'expense' && e.is_paid);
            if (paid.length > 0) {
                text += `\n✓ Ödenenler:\n`;
                paid.forEach(e => {
                    text += `• ~${e.title}~ (${formatCurrency(e.amount)})\n`;
                });
            }
        }
    } else {
        const pending = currentItems.filter(i => !i.is_done);
        const done = currentItems.filter(i => i.is_done);

        if (pending.length > 0) {
            text += `Alınacaklar / Yapılacaklar:\n`;
            pending.forEach(i => {
                text += `• ▫️ ${i.title}${i.quantity ? ' (' + i.quantity + ')' : ''}${i.price ? ' - ' + i.price : ''}\n`;
            });
        }

        if (done.length > 0) {
            text += `\nTamamlananlar:\n`;
            done.forEach(i => {
                text += `• ~${i.title}~ ✓\n`;
            });
        }
    }

    navigator.clipboard.writeText(text).then(() => {
        showToast("Liste panoya kopyalandı!");
    }).catch(() => {
        prompt("Listeyi kopyalayın:", text);
    });
}

// ─────────────────────────────────────────────────────────────
// Filtreleme & Arama
// ─────────────────────────────────────────────────────────────

function setFilter(filterType) {
    currentFilter = filterType;
    document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.filter === filterType);
    });
    renderChecklist();
}

function onSearchItems() {
    renderChecklist();
}

// ─────────────────────────────────────────────────────────────
// Modallar (Kategori, Sayfa, Toplu Ekleme, Hatırlatıcı)
// ─────────────────────────────────────────────────────────────

function openModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('open');
}

function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove('open');
}

// Kategori Ekleme
async function submitAddCategory() {
    const name = document.getElementById('new-cat-name').value.trim();
    const icon = document.getElementById('new-cat-icon').value.trim() || '📁';
    const color = document.getElementById('new-cat-color').value || '#3b82f6';
    if (!name) return;

    const res = await fetch('/notes/api/categories', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name, icon, color})
    });
    const data = await res.json();
    if (data.ok) {
        closeModal('modal-add-category');
        window.location.reload();
    }
}

// Sayfa Ekleme
function openAddPageForCat(catId, catName) {
    const sel = document.getElementById('new-page-cat');
    if (sel) sel.value = catId;
    openModal('modal-add-page');
}

async function submitAddPage() {
    const catId = document.getElementById('new-page-cat').value;
    const title = document.getElementById('new-page-title').value.trim();
    const type = document.getElementById('new-page-type').value;
    const icon = document.getElementById('new-page-icon').value.trim() || '📝';
    if (!title || !catId) return;

    const res = await fetch('/notes/api/pages', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({category_id: parseInt(catId), title, type, icon})
    });
    const data = await res.json();
    if (data.ok) {
        closeModal('modal-add-page');
        window.location.reload();
    }
}

// Kategori Düzenleme & Silme
function openEditCategoryModal(catId, name, icon, color) {
    document.getElementById('edit-cat-id').value = catId;
    document.getElementById('edit-cat-name').value = name;
    document.getElementById('edit-cat-icon').value = icon || '📁';
    document.getElementById('edit-cat-color').value = color || '#3b82f6';
    openModal('modal-edit-category');
}

async function submitEditCategory() {
    const catId = document.getElementById('edit-cat-id').value;
    const name = document.getElementById('edit-cat-name').value.trim();
    const icon = document.getElementById('edit-cat-icon').value.trim() || '📁';
    const color = document.getElementById('edit-cat-color').value || '#3b82f6';
    if (!name || !catId) return;

    const res = await fetch(`/notes/api/categories/${catId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name, icon, color})
    });
    const data = await res.json();
    if (data.ok) {
        closeModal('modal-edit-category');
        window.location.reload();
    }
}

async function deleteCategory(catId, name) {
    if (!confirm(`"${name}" kategorisini ve içindeki tüm sayfaları silmek istediğinize emin misiniz?`)) return;
    const res = await fetch(`/notes/api/categories/${catId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
        window.location.reload();
    }
}

// Sayfa Düzenleme
function openEditPageModal(pageId, title, catId, icon, type) {
    document.getElementById('edit-page-id').value = pageId;
    document.getElementById('edit-page-title').value = title;
    document.getElementById('edit-page-cat').value = catId;
    document.getElementById('edit-page-icon').value = icon || '📝';
    openModal('modal-edit-page');
}

function openEditCurrentPageModal() {
    if (!currentPageData) return;
    openEditPageModal(
        currentPageData.id,
        currentPageData.title,
        currentPageData.category_id,
        currentPageData.icon,
        currentPageData.type
    );
}

async function submitEditPage() {
    const pageId = document.getElementById('edit-page-id').value;
    const title = document.getElementById('edit-page-title').value.trim();
    const catId = document.getElementById('edit-page-cat').value;
    const icon = document.getElementById('edit-page-icon').value.trim() || '📝';
    if (!title || !pageId) return;

    const res = await fetch(`/notes/api/pages/${pageId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({title, category_id: parseInt(catId), icon})
    });
    const data = await res.json();
    if (data.ok) {
        closeModal('modal-edit-page');
        window.location.reload();
    }
}

// Madde / Öğe Düzenleme
function openEditItemModal(itemId) {
    const item = currentItems.find(i => i.id === itemId);
    if (!item) return;

    document.getElementById('edit-item-id').value = item.id;
    document.getElementById('edit-item-title').value = item.title || '';
    document.getElementById('edit-item-qty').value = item.quantity || '';
    document.getElementById('edit-item-price').value = item.price || '';
    document.getElementById('edit-item-url').value = item.url || '';
    document.getElementById('edit-item-desc').value = item.description || '';
    openModal('modal-edit-item');
}

async function submitEditItem() {
    const itemId = document.getElementById('edit-item-id').value;
    const title = document.getElementById('edit-item-title').value.trim();
    const qty = document.getElementById('edit-item-qty').value.trim();
    const price = document.getElementById('edit-item-price').value.trim();
    const url = document.getElementById('edit-item-url').value.trim();
    const desc = document.getElementById('edit-item-desc').value.trim();

    if (!title || !itemId) return;

    const res = await fetch(`/notes/api/items/${itemId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            title: title,
            quantity: qty,
            price: price,
            url: url,
            description: desc
        })
    });
    const data = await res.json();
    if (data.ok) {
        closeModal('modal-edit-item');
        showToast("Madde güncellendi!");
        loadPage(currentPageId);
    }
}

async function deletePage(pageId, title) {
    const label = title ? `"${title}" listesini` : "Bu listeyi";
    if (!confirm(`${label} ve içindeki tüm maddeleri silmek istediğinize emin misiniz?`)) return;
    const res = await fetch(`/notes/api/pages/${pageId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
        window.location.reload();
    }
}

// Toplu Madde Ekleme
async function submitBulkItems() {
    const text = document.getElementById('bulk-items-text').value.trim();
    if (!text || !currentPageId) return;

    const res = await fetch(`/notes/api/pages/${currentPageId}/items`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({bulk_text: text})
    });
    const data = await res.json();
    if (data.ok) {
        document.getElementById('bulk-items-text').value = '';
        closeModal('modal-bulk-add');
        loadPage(currentPageId);
    }
}

// Hatırlatıcı Ayarlama
let activeReminderItemId = null;
function openReminderModal(itemId, title) {
    activeReminderItemId = itemId;
    document.getElementById('rem-item-title').textContent = title;
    const now = new Date();
    now.setHours(now.getHours() + 1);
    const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('rem-datetime').value = localIso;
    openModal('modal-reminder');
}

async function submitReminder() {
    if (!activeReminderItemId) return;
    const dt = document.getElementById('rem-datetime').value;
    const recurrence = document.getElementById('rem-recurrence').value;

    if (!dt) {
        alert("Lütfen tarih ve saat seçin");
        return;
    }

    const formattedDt = dt.replace('T', ' ') + ':00';

    const res = await fetch(`/notes/api/items/${activeReminderItemId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({remind_at: formattedDt, recurrence})
    });
    const data = await res.json();
    if (data.ok) {
        closeModal('modal-reminder');
        showToast("Hatırlatıcı kuruldu!");
        loadPage(currentPageId);
    }
}

function showToast(msg) {
    let t = document.getElementById('tnote-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'tnote-toast';
        t.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1e293b;color:#fff;padding:10px 18px;border-radius:8px;font-size:0.9rem;box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:9999;transition:opacity 0.3s;';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────
// Finans & Düzenli Ödeme Yönetimi
// ─────────────────────────────────────────────────────────────

let currentFinancePeriod = new Date().toISOString().slice(0, 7);
let currentFinanceData = null;

async function loadFinanceData(period) {
    if (!currentPageId) return;
    if (!period) period = currentFinancePeriod;
    currentFinancePeriod = period;

    const periodDisp = document.getElementById('finance-period-display');
    if (periodDisp) periodDisp.textContent = period;

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/finance?period=${period}`);
        const data = await res.json();
        if (!data.ok) return;

        currentFinanceData = data;
        const sum = data.summary || {};
        const entries = data.entries || [];

        // KPI kartlarını güncelle
        document.getElementById('kpi-income-val').textContent = formatCurrency(sum.total_income || 0);
        document.getElementById('kpi-income-count').textContent = `${sum.income_count || 0} kalem`;

        document.getElementById('kpi-expense-val').textContent = formatCurrency(sum.total_expense || 0);
        document.getElementById('kpi-expense-count').textContent = `${sum.expense_count || 0} fatura / ödeme`;

        const netEl = document.getElementById('kpi-balance-val');
        const netVal = sum.net_balance || 0;
        netEl.textContent = formatCurrency(netVal);
        netEl.style.color = netVal >= 0 ? '#16a34a' : '#dc2626';

        document.getElementById('kpi-unpaid-val').textContent = formatCurrency(sum.unpaid_expense || 0);
        const unpaidCount = entries.filter(e => e.entry_type === 'expense' && !e.is_paid).length;
        document.getElementById('kpi-unpaid-count').textContent = `${unpaidCount} ödenmemiş fatura`;

        // Tabloyu render et
        renderFinanceTable(entries);
    } catch (err) {
        console.error("Finans verisi yükleme hatası:", err);
    }
}

function renderFinanceTable(entries) {
    const tbody = document.getElementById('finance-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!entries || entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--muted); padding:16px; font-size:0.8rem;">Bu dönem için kayıt yok.</td></tr>`;
        return;
    }

    entries.forEach(e => {
        const tr = document.createElement('tr');
        if (e.is_paid) tr.className = 'row-paid';

        const isInc = e.entry_type === 'income';
        const typeIcon = isInc ? '<span class="tag-income-type" title="Gelir">📈 Gelir</span>' : '<span class="tag-expense-type" title="Gider">📉 Gider</span>';
        const dueText = e.due_day ? `<span class="tag-due">Ayın ${e.due_day}. günü</span>` : '<span class="tag-due">-</span>';
        const notesHtml = e.notes ? `<div style="font-size:0.72rem; color:var(--muted); margin-top:2px;">${escapeHtml(e.notes)}</div>` : '';
        const amountColor = isInc ? '#16a34a' : '#dc2626';
        const amountPrefix = isInc ? '+' : '-';

        // Tekrarlama & Bitiş
        let recurHtml = '<span style="font-size:0.75rem; color:var(--muted);">-</span>';
        if (e.is_recurring) {
            if (e.end_period) {
                recurHtml = `<span style="font-size:0.75rem; background:#eff6ff; color:#2563eb; padding:2px 6px; border-radius:4px; font-weight:600;" title="Bitiş Ayı">⏳ Bit: ${escapeHtml(e.end_period)}</span>`;
            } else {
                recurHtml = '<span style="font-size:0.75rem; color:var(--muted); font-weight:600;">🔄 Sürekli</span>';
            }
        }

        // Alarm / Hatırlatıcı
        let alarmHtml = '<span style="color:var(--muted); font-size:0.75rem;">-</span>';
        if (!isInc) {
            const rDays = (e.reminder_days !== undefined && e.reminder_days !== null) ? parseInt(e.reminder_days) : 0;
            if (rDays === -1) {
                alarmHtml = '<span title="Hatırlatma Kapalı" style="opacity:0.45; cursor:help;">🔕</span>';
            } else if (rDays === 0) {
                alarmHtml = '<span title="Son Gün Sabahı 09:00" style="color:#d97706; font-weight:700; font-size:0.75rem; cursor:help;">🔔 Son Gün</span>';
            } else {
                alarmHtml = `<span title="${rDays} gün önce" style="color:#2563eb; font-weight:700; font-size:0.75rem; cursor:help;">🔔 -${rDays}g</span>`;
            }
        }

        let statusBtn = '';
        if (isInc) {
            statusBtn = e.is_paid ?
                `<button class="btn-status-toggle is-paid" onclick="toggleFinancePaid(${e.id})">✓ Alındı</button>` :
                `<button class="btn-status-toggle is-pending" onclick="toggleFinancePaid(${e.id})">⏳ Bekliyor</button>`;
        } else {
            statusBtn = e.is_paid ?
                `<button class="btn-status-toggle is-paid" onclick="toggleFinancePaid(${e.id})">✓ Ödendi</button>` :
                `<button class="btn-status-toggle is-pending" onclick="toggleFinancePaid(${e.id})">⏳ Bekliyor</button>`;
        }

        tr.innerHTML = `
            <td>${typeIcon}</td>
            <td>${dueText}</td>
            <td>
                <strong>${escapeHtml(e.title)}</strong>
                ${notesHtml}
            </td>
            <td><span style="font-size:0.78rem; background:var(--surface3); padding:2px 6px; border-radius:4px;">${escapeHtml(e.category || 'Genel')}</span></td>
            <td>${recurHtml}</td>
            <td style="text-align:right; font-weight:700; color:${amountColor};">
                ${amountPrefix}${formatCurrency(e.amount)}
            </td>
            <td style="text-align:center;">${statusBtn}</td>
            <td style="text-align:center;">${alarmHtml}</td>
            <td style="text-align:right;">
                <button class="btn-icon-subtle" onclick="openEditFinanceModal(${e.id})" title="Düzenle">✏️</button>
                <button class="btn-icon-subtle btn-danger-hover" onclick="deleteFinanceEntry(${e.id}, '${escapeHtml(e.title)}')" title="Sil">🗑️</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function formatCurrency(val) {
    const num = parseFloat(val) || 0;
    return num.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
}

function navigateFinancePeriod(delta) {
    const [yearStr, monthStr] = currentFinancePeriod.split('-');
    let y = parseInt(yearStr);
    let m = parseInt(monthStr) - 1;
    const dt = new Date(y, m + delta, 1);
    const newY = dt.getFullYear();
    const newM = String(dt.getMonth() + 1).padStart(2, '0');
    currentFinancePeriod = `${newY}-${newM}`;
    loadFinanceData(currentFinancePeriod);
}

function resetFinancePeriodToCurrent() {
    currentFinancePeriod = new Date().toISOString().slice(0, 7);
    loadFinanceData(currentFinancePeriod);
}

function openAddFinanceModal() {
    document.getElementById('fin-add-title').value = '';
    document.getElementById('fin-add-amount').value = '';
    document.getElementById('fin-add-cat').value = 'Fatura';
    document.getElementById('fin-add-dueday').value = '15';
    document.getElementById('fin-add-notes').value = '';
    document.getElementById('fin-add-endperiod').value = '';
    document.getElementById('fin-add-reminder').value = '0';
    document.getElementById('fin-add-recurring').checked = true;
    openModal('modal-add-finance');
}

async function submitAddFinance() {
    const title = document.getElementById('fin-add-title').value.trim();
    const amount = parseFloat(document.getElementById('fin-add-amount').value);
    const entry_type = document.getElementById('fin-add-type').value;
    const category = document.getElementById('fin-add-cat').value.trim() || 'Genel';
    const due_day = parseInt(document.getElementById('fin-add-dueday').value) || 1;
    const is_recurring = document.getElementById('fin-add-recurring').checked;
    const end_period = document.getElementById('fin-add-endperiod').value.trim();
    const reminder_days = parseInt(document.getElementById('fin-add-reminder').value) || 0;
    const notes = document.getElementById('fin-add-notes').value.trim();

    if (!title || !amount || amount <= 0) {
        alert("Lütfen geçerli bir başlık ve tutar girin.");
        return;
    }

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/finance`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                title, amount, entry_type, category, due_day, is_recurring, end_period, reminder_days, notes,
                period: currentFinancePeriod
            })
        });
        const data = await res.json();
        if (data.ok) {
            closeModal('modal-add-finance');
            showToast("Kalem başarıyla eklendi!");
            loadFinanceData(currentFinancePeriod);
        }
    } catch (e) {
        console.error("Finans kalemi ekleme hatası:", e);
    }
}

async function toggleFinancePaid(entryId) {
    try {
        const res = await fetch(`/notes/api/finance/${entryId}/toggle`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            loadFinanceData(currentFinancePeriod);
        }
    } catch (e) {
        console.error("Ödeme durumu değiştirme hatası:", e);
    }
}

async function deleteFinanceEntry(entryId, title) {
    if (!confirm(`"${title}" kalemini silmek istediğinize emin misiniz?`)) return;
    try {
        const res = await fetch(`/notes/api/finance/${entryId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
            showToast("Kalem silindi!");
            loadFinanceData(currentFinancePeriod);
        }
    } catch (e) {
        console.error("Finans kalemi silme hatası:", e);
    }
}

function openEditFinanceModal(entryId) {
    if (!currentFinanceData || !currentFinanceData.entries) return;
    const item = currentFinanceData.entries.find(e => e.id === entryId);
    if (!item) return;

    document.getElementById('fin-edit-id').value = item.id;
    document.getElementById('fin-edit-title').value = item.title || '';
    document.getElementById('fin-edit-amount').value = item.amount || '';
    document.getElementById('fin-edit-dueday').value = item.due_day || 1;
    document.getElementById('fin-edit-cat').value = item.category || '';
    document.getElementById('fin-edit-endperiod').value = item.end_period || '';
    document.getElementById('fin-edit-reminder').value = (item.reminder_days !== undefined && item.reminder_days !== null) ? item.reminder_days : '0';
    document.getElementById('fin-edit-recurring').checked = (item.is_recurring === 1);
    document.getElementById('fin-edit-notes').value = item.notes || '';
    openModal('modal-edit-finance');
}

async function submitEditFinance() {
    const entryId = document.getElementById('fin-edit-id').value;
    const title = document.getElementById('fin-edit-title').value.trim();
    const amount = parseFloat(document.getElementById('fin-edit-amount').value);
    const due_day = parseInt(document.getElementById('fin-edit-dueday').value) || 1;
    const category = document.getElementById('fin-edit-cat').value.trim() || 'Genel';
    const is_recurring = document.getElementById('fin-edit-recurring').checked ? 1 : 0;
    const end_period = document.getElementById('fin-edit-endperiod').value.trim();
    const reminder_days = parseInt(document.getElementById('fin-edit-reminder').value) || 0;
    const notes = document.getElementById('fin-edit-notes').value.trim();

    if (!title || !amount || amount <= 0) {
        alert("Lütfen geçerli başlık ve tutar girin.");
        return;
    }

    try {
        const res = await fetch(`/notes/api/finance/${entryId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({title, amount, due_day, category, is_recurring, end_period, reminder_days, notes})
        });
        const data = await res.json();
        if (data.ok) {
            closeModal('modal-edit-finance');
            showToast("Kalem güncellendi!");
            loadFinanceData(currentFinancePeriod);
        }
    } catch (e) {
        console.error("Finans güncelleme hatası:", e);
    }
}

async function copyRecurringFinance() {
    const [yearStr, monthStr] = currentFinancePeriod.split('-');
    let y = parseInt(yearStr);
    let m = parseInt(monthStr) - 1;
    const dt = new Date(y, m - 1, 1);
    const prevPeriod = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;

    if (!confirm(`${prevPeriod} dönemindeki düzenli (tekrarlayan) ödemeler bu aya (${currentFinancePeriod}) aktarılacak. Onaylıyor musunuz?`)) return;

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/finance/copy_recurring`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({source_period: prevPeriod, target_period: currentFinancePeriod})
        });
        const data = await res.json();
        if (data.ok) {
            showToast(`${data.copied_count} düzenli ödeme bu aya aktarıldı!`);
            loadFinanceData(currentFinancePeriod);
        } else {
            alert(data.error || "Aktarım başarısız oldu.");
        }
    } catch (e) {
        console.error("Düzenli ödeme kopyalama hatası:", e);
    }
}

// ── Liste Sıfırlama (Baştan Başlatma) ──
async function resetCurrentList() {
    if (!currentPageId) return;
    if (!confirm("Bu listedeki tüm tamamlanmış maddelerin tikleri kaldırılacak ve liste baştan başlatılacak. Onaylıyor musunuz?")) return;

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/reset`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            showToast("Liste sıfırlandı!");
            loadPage(currentPageId);
        }
    } catch (e) {
        console.error("Liste sıfırlama hatası:", e);
    }
}

// ── Telegram ile Gönder Modal ve Eylemi ──
async function openSendTelegramModal() {
    if (!currentPageId) return;
    const selectEl = document.getElementById('tg-send-recipient');
    if (!selectEl) return;
    selectEl.innerHTML = '<option value="">Yükleniyor...</option>';

    try {
        const res = await fetch('/notes/api/telegram/users');
        const data = await res.json();
        const users = data.users || [];
        const allowed = users.filter(u => u.is_allowed);

        selectEl.innerHTML = '';
        if (allowed.length === 0) {
            selectEl.innerHTML = '<option value="">İzinli Telegram kullanıcısı yok</option>';
        } else {
            allowed.forEach(u => {
                const opt = document.createElement('option');
                opt.value = u.chat_id;
                const name = u.first_name || u.username || u.chat_id;
                opt.textContent = `${name} (${u.chat_id})`;
                selectEl.appendChild(opt);
            });
        }
        openModal('modal-send-telegram');
    } catch (e) {
        console.error("Telegram kullanıcıları yükleme hatası:", e);
    }
}

async function submitSendTelegram() {
    const selectEl = document.getElementById('tg-send-recipient');
    const chatId = selectEl ? selectEl.value : '';
    if (!chatId) {
        alert("Lütfen bir alıcı seçin veya Ayarlar sayfasından izinli kullanıcı ekleyin.");
        return;
    }

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/send_telegram`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({chat_id: chatId})
        });
        const data = await res.json();
        if (data.ok) {
            closeModal('modal-send-telegram');
            showToast("İçerik Telegram'a başarıyla gönderildi!");
        } else {
            alert(data.error || "Telegram mesajı gönderilemedi. Bot ayarlarını kontrol edin.");
        }
    } catch (e) {
        console.error("Telegram gönderme hatası:", e);
    }
}

// ─────────────────────────────────────────────────────────────
// Proje Yönetim & Atölye / İnşa / Bilimsel Çalışma Modülü
// ─────────────────────────────────────────────────────────────

let currentProjectData = null;
let selectedMilestoneId = null;

async function loadProjectData(pageId) {
    try {
        const res = await fetch(`/notes/api/pages/${pageId}/project`);
        const data = await res.json();
        if (!data.ok) return;

        currentProjectData = data.project;
        selectedMilestoneId = null;

        renderProjectOverview();
        renderTimeline();
        renderConcept();
        renderBOM();
        renderLogs();
    } catch (e) {
        console.error("Proje verisi yükleme hatası:", e);
    }
}

function renderProjectOverview() {
    if (!currentProjectData) return;
    const { details, stats } = currentProjectData;

    const statusSel = document.getElementById('proj-status-select');
    if (statusSel) statusSel.value = details.status || 'planning';

    const pFill = document.getElementById('proj-progress-fill');
    if (pFill) pFill.style.width = `${stats.progress_pct}%`;

    const kpiProg = document.getElementById('proj-kpi-progress');
    if (kpiProg) kpiProg.textContent = `${stats.progress_pct}%`;

    const kpiMiles = document.getElementById('proj-kpi-milestones');
    if (kpiMiles) kpiMiles.textContent = `${stats.completed_milestones}/${stats.total_milestones}`;

    const kpiNeeded = document.getElementById('proj-kpi-needed');
    if (kpiNeeded) kpiNeeded.textContent = `${stats.needed_materials} adet`;

    const kpiCost = document.getElementById('proj-kpi-cost');
    if (kpiCost) kpiCost.textContent = formatCurrency(stats.total_mat_cost);
}

async function updateProjectStatus() {
    const newStatus = document.getElementById('proj-status-select').value;
    try {
        await fetch(`/notes/api/pages/${currentPageId}/project`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ status: newStatus })
        });
        showToast("Proje durumu güncellendi!");
    } catch (e) {
        console.error("Durum güncelleme hatası:", e);
    }
}

function switchProjectTab(tabName) {
    document.querySelectorAll('.project-tab-pane').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.project-tab-btn').forEach(el => el.classList.remove('active'));

    const activePane = document.getElementById(`ptab-${tabName}`);
    if (activePane) activePane.style.display = 'block';

    const activeBtn = document.getElementById(`tab-btn-${tabName}`);
    if (activeBtn) activeBtn.classList.add('active');
}

// ── Timeline & Milestones ──
function renderTimeline() {
    const track = document.getElementById('timeline-track-container');
    if (!track) return;
    track.innerHTML = '';

    const milestones = currentProjectData?.milestones || [];
    if (milestones.length === 0) {
        track.innerHTML = '<div style="padding:6px; color:var(--muted); font-size:0.8rem;">Henüz aşama eklenmedi.</div>';
        closeMilestoneDetail();
        return;
    }

    milestones.forEach((m, idx) => {
        const node = document.createElement('div');
        node.className = `timeline-node status-${m.status}`;
        if (m.id === selectedMilestoneId) node.classList.add('active');

        const statusIcon = m.status === 'completed' ? '✓' : (m.status === 'in_progress' ? '⚙' : (idx + 1));
        const dateHtml = m.target_date ? `<div class="timeline-node-date">📅 ${escapeHtml(m.target_date)}</div>` : '';

        node.innerHTML = `
            <div class="timeline-node-circle">${statusIcon}</div>
            <div class="timeline-node-content">
                <div class="timeline-node-title">${escapeHtml(m.title)}</div>
                ${dateHtml}
            </div>
        `;

        node.onclick = () => selectMilestone(m.id);
        track.appendChild(node);
    });

    if (selectedMilestoneId) {
        selectMilestone(selectedMilestoneId);
    }
}

function selectMilestone(mId) {
    selectedMilestoneId = mId;
    document.querySelectorAll('.timeline-node').forEach(n => n.classList.remove('active'));

    const milestones = currentProjectData?.milestones || [];
    const m = milestones.find(item => item.id === mId);
    if (!m) {
        closeMilestoneDetail();
        return;
    }

    // Node aktifliği
    const track = document.getElementById('timeline-track-container');
    if (track) {
        const idx = milestones.findIndex(item => item.id === mId);
        if (track.children[idx]) track.children[idx].classList.add('active');
    }

    const panel = document.getElementById('milestone-detail-panel');
    if (!panel) return;
    panel.style.display = 'block';

    const titleEl = document.getElementById('detail-milestone-title');
    if (titleEl) titleEl.textContent = m.title;

    const dateEl = document.getElementById('detail-milestone-date');
    if (dateEl) dateEl.textContent = m.target_date ? `(Hedef: ${m.target_date})` : '';

    const badgeEl = document.getElementById('detail-milestone-status-badge');
    if (badgeEl) {
        if (m.status === 'completed') {
            badgeEl.className = 'badge is-paid';
            badgeEl.textContent = '✅ Tamamlandı';
        } else if (m.status === 'in_progress') {
            badgeEl.className = 'badge is-pending';
            badgeEl.textContent = '⚙️ Devam Ediyor';
        } else {
            badgeEl.className = 'badge';
            badgeEl.style.background = '#f1f5f9';
            badgeEl.style.color = '#64748b';
            badgeEl.textContent = '⏳ Bekliyor';
        }
    }

    const descEl = document.getElementById('detail-milestone-desc');
    if (descEl) descEl.textContent = m.description || 'Ek açıklama bulunmuyor.';

    const reqsEl = document.getElementById('detail-milestone-reqs');
    if (reqsEl) {
        if (!m.requirements) {
            reqsEl.innerHTML = '<span style="color:var(--muted); font-style:italic;">Belirtilmemiş.</span>';
        } else {
            const lines = m.requirements.split('\n').filter(l => l.trim());
            reqsEl.innerHTML = lines.map(l => `<div style="margin:2px 0;">• ${escapeHtml(l)}</div>`).join('');
        }
    }
}

function closeMilestoneDetail() {
    selectedMilestoneId = null;
    const panel = document.getElementById('milestone-detail-panel');
    if (panel) panel.style.display = 'none';
    document.querySelectorAll('.timeline-node').forEach(n => n.classList.remove('active'));
}

async function toggleSelectedMilestoneStatus() {
    if (!selectedMilestoneId) return;
    try {
        const res = await fetch(`/notes/api/milestones/${selectedMilestoneId}/toggle`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            loadProjectData(currentPageId);
        }
    } catch (e) {
        console.error(e);
    }
}

function openAddMilestoneModal() {
    document.getElementById('milestone-modal-title').textContent = '➕ Yeni Proje Aşaması Ekle';
    document.getElementById('milestone-edit-id').value = '';
    document.getElementById('milestone-title').value = '';
    document.getElementById('milestone-target-date').value = '';
    document.getElementById('milestone-status').value = 'pending';
    document.getElementById('milestone-desc').value = '';
    document.getElementById('milestone-reqs').value = '';
    openModal('modal-add-milestone');
}

function openEditSelectedMilestone() {
    if (!selectedMilestoneId || !currentProjectData) return;
    const m = currentProjectData.milestones.find(item => item.id === selectedMilestoneId);
    if (!m) return;

    document.getElementById('milestone-modal-title').textContent = '✏️ Aşamayı Düzenle';
    document.getElementById('milestone-edit-id').value = m.id;
    document.getElementById('milestone-title').value = m.title || '';
    document.getElementById('milestone-target-date').value = m.target_date || '';
    document.getElementById('milestone-status').value = m.status || 'pending';
    document.getElementById('milestone-desc').value = m.description || '';
    document.getElementById('milestone-reqs').value = m.requirements || '';
    openModal('modal-add-milestone');
}

async function submitMilestoneForm() {
    const mId = document.getElementById('milestone-edit-id').value;
    const title = document.getElementById('milestone-title').value.trim();
    const target_date = document.getElementById('milestone-target-date').value;
    const status = document.getElementById('milestone-status').value;
    const description = document.getElementById('milestone-desc').value.trim();
    const requirements = document.getElementById('milestone-reqs').value.trim();

    if (!title) {
        alert("Lütfen bir aşama başlığı girin.");
        return;
    }

    try {
        if (mId) {
            await fetch(`/notes/api/milestones/${mId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ title, target_date, status, description, requirements })
            });
            showToast("Aşama güncellendi!");
        } else {
            await fetch(`/notes/api/pages/${currentPageId}/project/milestones`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ title, target_date, status, description, requirements })
            });
            showToast("Yeni aşama eklendi!");
        }
        closeModal('modal-add-milestone');
        loadProjectData(currentPageId);
    } catch (e) {
        console.error(e);
    }
}

async function deleteSelectedMilestone() {
    if (!selectedMilestoneId) return;
    if (!confirm("Bu aşamayı silmek istediğinize emin misiniz?")) return;
    try {
        await fetch(`/notes/api/milestones/${selectedMilestoneId}`, { method: 'DELETE' });
        showToast("Aşama silindi!");
        closeMilestoneDetail();
        loadProjectData(currentPageId);
    } catch (e) {
        console.error(e);
    }
}

// ── Fikir & Çizimler / Şemalar ──
function renderConcept() {
    if (!currentProjectData) return;
    const details = currentProjectData.details || {};
    const drawings = currentProjectData.drawings || [];

    const cInput = document.getElementById('proj-concept-input');
    if (cInput) cInput.value = details.concept || '';

    const sInput = document.getElementById('proj-specs-input');
    if (sInput) sInput.value = details.specs || '';

    const grid = document.getElementById('project-gallery-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (drawings.length === 0) {
        grid.innerHTML = '<div style="grid-column:1/-1; color:var(--muted); font-size:0.8rem; padding:6px;">Henüz görsel eklenmedi.</div>';
        return;
    }

    drawings.forEach(d => {
        const card = document.createElement('div');
        card.className = 'gallery-card';
        card.innerHTML = `
            <img src="${escapeHtml(d.url)}" class="gallery-thumb" alt="${escapeHtml(d.title)}" onerror="this.src='/notes/static/icons/notes.svg';">
            <div class="gallery-info">
                <div class="gallery-title">${escapeHtml(d.title)}</div>
                ${d.desc ? `<div class="gallery-desc">${escapeHtml(d.desc)}</div>` : ''}
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                    <span style="font-size:0.68rem; color:var(--muted);">${d.created_at || ''}</span>
                    <button class="btn-icon-subtle btn-danger-hover" onclick="deleteDrawing(${d.id}); event.stopPropagation();" title="Sil">🗑️</button>
                </div>
            </div>
        `;
        card.onclick = () => previewDrawingImage(d.url, d.title);
        grid.appendChild(card);
    });
}

async function saveProjectConcept() {
    const concept = document.getElementById('proj-concept-input').value.trim();
    const specs = document.getElementById('proj-specs-input').value.trim();
    try {
        await fetch(`/notes/api/pages/${currentPageId}/project`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ concept, specs })
        });
        showToast("Fikir ve teknik şartname kaydedildi!");
    } catch (e) {
        console.error(e);
    }
}

function openAddDrawingModal() {
    document.getElementById('drawing-title').value = '';
    document.getElementById('drawing-url').value = '';
    document.getElementById('drawing-desc').value = '';
    openModal('modal-add-drawing');
}

async function submitAddDrawing() {
    const title = document.getElementById('drawing-title').value.trim();
    const url = document.getElementById('drawing-url').value.trim();
    const desc = document.getElementById('drawing-desc').value.trim();
    if (!title || !url) {
        alert("Lütfen başlık ve görsel URL'si girin.");
        return;
    }
    try {
        await fetch(`/notes/api/pages/${currentPageId}/project/drawings`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ title, url, desc })
        });
        closeModal('modal-add-drawing');
        showToast("Çizim / şema eklendi!");
        loadProjectData(currentPageId);
    } catch (e) {
        console.error(e);
    }
}

async function deleteDrawing(dId) {
    if (!confirm("Bu görseli silmek istediğinize emin misiniz?")) return;
    try {
        await fetch(`/notes/api/pages/${currentPageId}/project/drawings/${dId}`, { method: 'DELETE' });
        showToast("Görsel silindi!");
        loadProjectData(currentPageId);
    } catch (e) {
        console.error(e);
    }
}

async function handleProjectFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', file.name);

    try {
        showToast("Görsel yükleniyor...");
        const res = await fetch(`/notes/api/pages/${currentPageId}/project/upload`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.ok) {
            showToast("Dosya başarıyla yüklendi!");
            loadProjectData(currentPageId);
        } else {
            alert(data.error || "Yükleme başarısız oldu.");
        }
    } catch (e) {
        console.error("Yükleme hatası:", e);
    } finally {
        event.target.value = '';
    }
}

function previewDrawingImage(url, title) {
    const imgEl = document.getElementById('preview-image-src');
    const titleEl = document.getElementById('preview-image-title');
    if (imgEl) imgEl.src = url;
    if (titleEl) titleEl.textContent = title;
    openModal('modal-image-preview');
}

// ── BOM (Malzeme & İhtiyaç Listesi) ──
function renderBOM() {
    const tbody = document.getElementById('project-materials-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const materials = currentProjectData?.materials || [];
    if (materials.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:16px; color:var(--muted); font-size:0.8rem;">Henüz malzeme eklenmedi.</td></tr>';
        renderBOMSummary();
        return;
    }

    materials.forEach(m => {
        const tr = document.createElement('tr');
        const qtyNum = parseFloat(m.quantity) || 1;
        const lineTotal = (m.unit_price || 0.0) * qtyNum;

        let statusClass = 'is-needed';
        let statusLabel = '🔍 Aranıyor';
        if (m.status === 'ordered') {
            statusClass = 'is-ordered';
            statusLabel = '📦 Sipariş Edildi';
        } else if (m.status === 'available') {
            statusClass = 'is-available';
            statusLabel = '✅ Elde Var';
        }

        const statusBtn = `<button class="btn-bom-status ${statusClass}" onclick="toggleMaterialStatus(${m.id})">${statusLabel}</button>`;
        const linkHtml = m.url ? `<a href="${escapeHtml(m.url)}" target="_blank" rel="noopener" style="color:var(--accent); font-size:0.8rem; text-decoration:none;">🔗 Bağlantı</a>` : '<span style="color:var(--muted); font-size:0.75rem;">-</span>';

        tr.innerHTML = `
            <td>${statusBtn}</td>
            <td><strong>${escapeHtml(m.name)}</strong></td>
            <td style="text-align:center;">${escapeHtml(m.quantity || '1')}</td>
            <td style="text-align:right;">${formatCurrency(m.unit_price || 0)}</td>
            <td style="text-align:right; font-weight:600;">${formatCurrency(lineTotal)}</td>
            <td>${linkHtml}</td>
            <td><span style="font-size:0.75rem; color:var(--muted);">${escapeHtml(m.notes || '')}</span></td>
            <td style="text-align:right;">
                <button class="btn-icon-subtle" onclick="openEditMaterialModal(${m.id})" title="Düzenle">✏️</button>
                <button class="btn-icon-subtle btn-danger-hover" onclick="deleteMaterial(${m.id}, '${escapeHtml(m.name)}')" title="Sil">🗑️</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    renderBOMSummary();
}

function renderBOMSummary() {
    const bar = document.getElementById('bom-summary-bar');
    if (!bar) return;
    const stats = currentProjectData?.stats || {};
    bar.innerHTML = `
        <div>Toplam Kalem: <strong>${stats.total_materials || 0}</strong></div>
        <div>Eksik / Aranıyor: <strong style="color:#ef4444;">${stats.needed_materials || 0}</strong></div>
        <div>Temin Edilen Tutar: <strong style="color:#10b981;">${formatCurrency(stats.available_mat_cost || 0)}</strong></div>
        <div>Toplam Proje Maliyeti: <strong style="color:#2563eb;">${formatCurrency(stats.total_mat_cost || 0)}</strong></div>
    `;
}

async function toggleMaterialStatus(matId) {
    try {
        const res = await fetch(`/notes/api/materials/${matId}/toggle`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            loadProjectData(currentPageId);
        }
    } catch (e) {
        console.error(e);
    }
}

function openAddMaterialModal() {
    document.getElementById('material-modal-title').textContent = '➕ Malzeme / Parça Ekle';
    document.getElementById('material-edit-id').value = '';
    document.getElementById('material-name').value = '';
    document.getElementById('material-qty').value = '1';
    document.getElementById('material-price').value = '';
    document.getElementById('material-status').value = 'needed';
    document.getElementById('material-url').value = '';
    document.getElementById('material-notes').value = '';
    openModal('modal-add-material');
}

function openEditMaterialModal(matId) {
    if (!currentProjectData) return;
    const m = currentProjectData.materials.find(item => item.id === matId);
    if (!m) return;

    document.getElementById('material-modal-title').textContent = '✏️ Malzemeyi Düzenle';
    document.getElementById('material-edit-id').value = m.id;
    document.getElementById('material-name').value = m.name || '';
    document.getElementById('material-qty').value = m.quantity || '1';
    document.getElementById('material-price').value = m.unit_price || '';
    document.getElementById('material-status').value = m.status || 'needed';
    document.getElementById('material-url').value = m.url || '';
    document.getElementById('material-notes').value = m.notes || '';
    openModal('modal-add-material');
}

async function submitMaterialForm() {
    const mId = document.getElementById('material-edit-id').value;
    const name = document.getElementById('material-name').value.trim();
    const quantity = document.getElementById('material-qty').value.trim() || '1';
    const unit_price = parseFloat(document.getElementById('material-price').value) || 0.0;
    const status = document.getElementById('material-status').value;
    const url = document.getElementById('material-url').value.trim();
    const notes = document.getElementById('material-notes').value.trim();

    if (!name) {
        alert("Lütfen malzeme adını girin.");
        return;
    }

    try {
        if (mId) {
            await fetch(`/notes/api/materials/${mId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ name, quantity, unit_price, status, url, notes })
            });
            showToast("Malzeme güncellendi!");
        } else {
            await fetch(`/notes/api/pages/${currentPageId}/project/materials`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ name, quantity, unit_price, status, url, notes })
            });
            showToast("Malzeme listeye eklendi!");
        }
        closeModal('modal-add-material');
        loadProjectData(currentPageId);
    } catch (e) {
        console.error(e);
    }
}

async function deleteMaterial(matId, name) {
    if (!confirm(`"${name}" malzemesini silmek istediğinize emin misiniz?`)) return;
    try {
        await fetch(`/notes/api/materials/${matId}`, { method: 'DELETE' });
        showToast("Malzeme silindi!");
        loadProjectData(currentPageId);
    } catch (e) {
        console.error(e);
    }
}

// ── Yapım & Gelişim Günlüğü (Logs) ──
function renderLogs() {
    const container = document.getElementById('project-logs-container');
    if (!container) return;
    container.innerHTML = '';

    const logs = currentProjectData?.logs || [];
    if (logs.length === 0) {
        container.innerHTML = '<div style="color:var(--muted); font-size:0.8rem; padding:8px;">Henüz günlük kaydı yok.</div>';
        return;
    }

    const typeLabels = {
        'progress': 'İlerleme',
        'issue': 'Karşılaşılan Sorun',
        'solution': 'Çözüm / Keşif',
        'milestone': 'Önemli Aşama'
    };

    logs.forEach(log => {
        const card = document.createElement('div');
        card.className = `log-card type-${log.log_type}`;

        const imgHtml = log.image_url ? `<div style="margin-top:6px;"><img src="${escapeHtml(log.image_url)}" style="max-height:160px; border-radius:6px; cursor:pointer;" onclick="previewDrawingImage('${escapeHtml(log.image_url)}', '${escapeHtml(log.title)}')"></div>` : '';

        card.innerHTML = `
            <div class="log-card-header">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="log-badge type-${log.log_type}">${typeLabels[log.log_type] || log.log_type}</span>
                    <strong style="font-size:0.95rem;">${escapeHtml(log.title)}</strong>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:0.75rem; color:var(--muted);">${log.log_date || ''}</span>
                    <button class="btn-icon-subtle btn-danger-hover" onclick="deleteProjectLog(${log.id})" title="Sil">🗑️</button>
                </div>
            </div>
            <div style="font-size:0.88rem; color:var(--text); white-space:pre-wrap; margin-top:4px;">${escapeHtml(log.content)}</div>
            ${imgHtml}
        `;
        container.appendChild(card);
    });
}

function openAddLogModal() {
    document.getElementById('proj-log-type').value = 'progress';
    document.getElementById('proj-log-title').value = '';
    document.getElementById('proj-log-content').value = '';
    document.getElementById('proj-log-image').value = '';
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById('proj-log-date').value = now.toISOString().slice(0, 16);
    openModal('modal-add-log');
}

async function submitAddProjectLog() {
    const log_type = document.getElementById('proj-log-type').value;
    const title = document.getElementById('proj-log-title').value.trim();
    const content = document.getElementById('proj-log-content').value.trim();
    const image_url = document.getElementById('proj-log-image').value.trim();
    const log_date = document.getElementById('proj-log-date').value;

    if (!title || !content) {
        alert("Lütfen başlık ve içerik girin.");
        return;
    }

    try {
        await fetch(`/notes/api/pages/${currentPageId}/project/logs`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ log_type, title, content, image_url, log_date: log_date ? log_date.replace('T', ' ') : null })
        });
        closeModal('modal-add-log');
        showToast("Günlük girişi eklendi!");
        loadProjectData(currentPageId);
    } catch (e) {
        console.error(e);
    }
}

async function deleteProjectLog(logId) {
    if (!confirm("Bu günlük girişini silmek istediğinize emin misiniz?")) return;
    try {
        await fetch(`/notes/api/logs/${logId}`, { method: 'DELETE' });
        showToast("Günlük girişi silindi!");
        loadProjectData(currentPageId);
    } catch (e) {
        console.error(e);
    }
}

// ─────────────────────────────────────────────────────────────
// Global Klavye Kısayolları (Ctrl+K, Ctrl+Z, Escape)
// ─────────────────────────────────────────────────────────────

function initGlobalKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

        // Ctrl + K veya Command + K -> Spotlight Arama
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            openGlobalSearchModal();
            return;
        }

        // / (slash) tuşu eğer inputta değilsek -> Spotlight Arama
        if (e.key === '/' && !isInput) {
            e.preventDefault();
            openGlobalSearchModal();
            return;
        }

        // Ctrl + Z -> Son İşlemi Geri Al (Undo) - Sadece text input içinde değilken!
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !isInput) {
            e.preventDefault();
            triggerUndo();
            return;
        }

        // Escape -> Açık modalları kapat
        if (e.key === 'Escape') {
            const openModals = document.querySelectorAll('.tnote-modal-backdrop.active');
            openModals.forEach(m => m.classList.remove('active'));
        }
    });

    // Spotlight Input Dinleyicileri
    const sInput = document.getElementById('spotlight-input');
    if (sInput) {
        sInput.addEventListener('input', debounceSpotlightSearch);
        sInput.addEventListener('keydown', handleSpotlightKeydown);
    }
}

// ─────────────────────────────────────────────────────────────
// Spotlight Global Arama (Search & Quick Finder)
// ─────────────────────────────────────────────────────────────

let spotlightDebounceTimer = null;
let currentSpotlightFilter = 'all';
let currentSpotlightResults = null;
let selectedSpotlightIndex = -1;

function openGlobalSearchModal() {
    openModal('modal-global-search');
    const input = document.getElementById('spotlight-input');
    if (input) {
        input.value = '';
        input.focus();
    }
    currentSpotlightFilter = 'all';
    document.querySelectorAll('.spotlight-tab').forEach(t => t.classList.toggle('active', t.dataset.type === 'all'));
    document.getElementById('spotlight-results').innerHTML = '<div class="spotlight-hint">Aramak için yazmaya başlayın... (Başlık, içerik, kullanıcı adı, notlar taranır)</div>';
}

function setSpotlightFilter(filterType) {
    currentSpotlightFilter = filterType;
    document.querySelectorAll('.spotlight-tab').forEach(t => t.classList.toggle('active', t.dataset.type === filterType));
    renderSpotlightResults();
}

function debounceSpotlightSearch() {
    clearTimeout(spotlightDebounceTimer);
    spotlightDebounceTimer = setTimeout(performSpotlightSearch, 150);
}

async function performSpotlightSearch() {
    const q = document.getElementById('spotlight-input').value.trim();
    const container = document.getElementById('spotlight-results');
    if (!q) {
        container.innerHTML = '<div class="spotlight-hint">Aramak için yazmaya başlayın...</div>';
        currentSpotlightResults = null;
        return;
    }

    try {
        const res = await fetch(`/notes/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (data.ok) {
            currentSpotlightResults = data.results;
            renderSpotlightResults();
        }
    } catch (e) {
        console.error("Search error:", e);
    }
}

function renderSpotlightResults() {
    const container = document.getElementById('spotlight-results');
    if (!currentSpotlightResults) return;

    const { pages, items, finance, projects, vault, total_count } = currentSpotlightResults;
    if (total_count === 0) {
        container.innerHTML = '<div class="spotlight-hint">Sonuç bulunamadı.</div>';
        return;
    }

    let html = '';
    let rowIdx = 0;

    // 1. Sayfalar
    if ((currentSpotlightFilter === 'all' || currentSpotlightFilter === 'pages') && pages && pages.length) {
        html += '<div class="spotlight-group-title">📄 Sayfalar & Notlar</div>';
        pages.forEach(p => {
            html += `
                <div class="spotlight-row" data-index="${rowIdx++}" onclick="jumpFromSearch('page', ${p.id})">
                    <div class="spotlight-row-left">
                        <span class="spotlight-row-icon">${p.icon || '📝'}</span>
                        <div class="spotlight-row-text">
                            <span class="spotlight-row-title">${escapeHtml(p.title)}</span>
                            <span class="spotlight-row-sub">${escapeHtml(p.category_name || 'Genel')} • ${p.type === 'notes' ? 'Not' : 'Liste'}</span>
                        </div>
                    </div>
                    <span class="spotlight-badge">${p.type}</span>
                </div>
            `;
        });
    }

    // 2. Maddeler
    if ((currentSpotlightFilter === 'all' || currentSpotlightFilter === 'items') && items && items.length) {
        html += '<div class="spotlight-group-title">📝 Maddeler & Görevler</div>';
        items.forEach(it => {
            const chk = it.is_done ? '✓ ' : '○ ';
            html += `
                <div class="spotlight-row" data-index="${rowIdx++}" onclick="jumpFromSearch('item', ${it.page_id}, ${it.id})">
                    <div class="spotlight-row-left">
                        <span class="spotlight-row-icon">${it.is_done ? '✅' : '⚪'}</span>
                        <div class="spotlight-row-text">
                            <span class="spotlight-row-title">${chk}${escapeHtml(it.title)}</span>
                            <span class="spotlight-row-sub">${escapeHtml(it.page_title)} ${it.price ? '• ' + it.price : ''}</span>
                        </div>
                    </div>
                    <span class="spotlight-badge">Madde</span>
                </div>
            `;
        });
    }

    // 3. Şifre Kasası
    if ((currentSpotlightFilter === 'all' || currentSpotlightFilter === 'vault') && vault && vault.length) {
        html += '<div class="spotlight-group-title">🔐 Şifre & Kimlik Kasası</div>';
        vault.forEach(v => {
            const scopeLabels = { 'personal': 'Kişisel', 'family': 'Aile', 'work': 'İş', 'other': 'Diğer' };
            html += `
                <div class="spotlight-row" data-index="${rowIdx++}" onclick="jumpFromSearch('vault', ${v.id})">
                    <div class="spotlight-row-left">
                        <span class="spotlight-row-icon">${v.icon || '🔐'}</span>
                        <div class="spotlight-row-text">
                            <span class="spotlight-row-title">${escapeHtml(v.title)}</span>
                            <span class="spotlight-row-sub">${escapeHtml(v.username || '')}${v.folder_name ? ` • 📁 ${escapeHtml(v.folder_name)}` : ''}${v.profile_name ? ` • 👤 ${escapeHtml(v.profile_name)}` : ''} • ${scopeLabels[v.scope] || ''}</span>
                        </div>
                    </div>
                    <span class="spotlight-badge" style="background:#e0e7ff; color:#4338ca;">Kasa</span>
                </div>
            `;
        });
    }

    // 4. Finans
    if ((currentSpotlightFilter === 'all' || currentSpotlightFilter === 'finance') && finance && finance.length) {
        html += '<div class="spotlight-group-title">💰 Finans Kalemleri</div>';
        finance.forEach(f => {
            html += `
                <div class="spotlight-row" data-index="${rowIdx++}" onclick="jumpFromSearch('page', ${f.page_id})">
                    <div class="spotlight-row-left">
                        <span class="spotlight-row-icon">${f.entry_type === 'income' ? '📈' : '📉'}</span>
                        <div class="spotlight-row-text">
                            <span class="spotlight-row-title">${escapeHtml(f.title)} (${f.amount} TL)</span>
                            <span class="spotlight-row-sub">${f.period} • ${escapeHtml(f.category || 'Genel')} • ${f.is_paid ? 'Ödendi' : 'Bekliyor'}</span>
                        </div>
                    </div>
                    <span class="spotlight-badge">${f.entry_type === 'income' ? 'Gelir' : 'Gider'}</span>
                </div>
            `;
        });
    }

    // 5. Projeler
    if ((currentSpotlightFilter === 'all' || currentSpotlightFilter === 'projects') && projects && projects.length) {
        html += '<div class="spotlight-group-title">🔨 Proje Aşamaları</div>';
        projects.forEach(pr => {
            html += `
                <div class="spotlight-row" data-index="${rowIdx++}" onclick="jumpFromSearch('page', ${pr.page_id})">
                    <div class="spotlight-row-left">
                        <span class="spotlight-row-icon">🚩</span>
                        <div class="spotlight-row-text">
                            <span class="spotlight-row-title">${escapeHtml(pr.title)}</span>
                            <span class="spotlight-row-sub">${escapeHtml(pr.page_title)} • ${pr.target_date || 'Tarihsiz'}</span>
                        </div>
                    </div>
                    <span class="spotlight-badge">${pr.status || 'Bekliyor'}</span>
                </div>
            `;
        });
    }

    container.innerHTML = html || '<div class="spotlight-hint">Bu filtrede sonuç bulunamadı.</div>';
    selectedSpotlightIndex = -1;
}

function handleSpotlightKeydown(e) {
    const rows = document.querySelectorAll('#spotlight-results .spotlight-row');
    if (!rows.length) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedSpotlightIndex = (selectedSpotlightIndex + 1) % rows.length;
        updateSpotlightSelection(rows);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedSpotlightIndex = (selectedSpotlightIndex - 1 + rows.length) % rows.length;
        updateSpotlightSelection(rows);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedSpotlightIndex >= 0 && selectedSpotlightIndex < rows.length) {
            rows[selectedSpotlightIndex].click();
        } else if (rows.length > 0) {
            rows[0].click();
        }
    }
}

function updateSpotlightSelection(rows) {
    rows.forEach((r, idx) => {
        const isSel = (idx === selectedSpotlightIndex);
        r.classList.toggle('selected', isSel);
        if (isSel) r.scrollIntoView({ block: 'nearest' });
    });
}

function jumpFromSearch(type, pageId, itemId) {
    closeModal('modal-global-search');
    if (type === 'page') {
        loadPage(pageId);
    } else if (type === 'item') {
        loadPage(pageId).then(() => {
            setTimeout(() => {
                const itemEl = document.getElementById(`item-card-${itemId}`);
                if (itemEl) {
                    itemEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    itemEl.style.boxShadow = '0 0 0 2px var(--accent)';
                    setTimeout(() => { itemEl.style.boxShadow = ''; }, 2000);
                }
            }, 300);
        });
    } else if (type === 'vault') {
        loadVaultPage().then(() => {
            setTimeout(() => {
                const card = document.getElementById(`vault-card-${pageId}`);
                if (card) {
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    card.style.borderColor = 'var(--accent)';
                    setTimeout(() => { card.style.borderColor = ''; }, 2500);
                }
            }, 300);
        });
    }
}

// ─────────────────────────────────────────────────────────────
// İşlem Geçmişi & Geri Alma (Action History & Undo)
// ─────────────────────────────────────────────────────────────

async function triggerUndo() {
    try {
        const res = await fetch('/notes/api/undo', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            showToast(`↩️ ${data.message || 'İşlem geri alındı!'}`);
            updateTrashBadgeCount();
            if (currentPageId) {
                loadPage(currentPageId);
            } else {
                loadOverviewPage();
            }
        } else {
            showToast(`ℹ️ ${data.error || 'Geri alınacak bir işlem yok.'}`);
        }
    } catch (e) {
        showToast(`❌ Geri alma hatası: ${e.message}`);
    }
}

async function openHistoryModal() {
    openModal('modal-action-history');
    const container = document.getElementById('history-timeline-list');
    container.innerHTML = '<div style="text-align:center; padding:12px; color:var(--muted);">Yükleniyor...</div>';

    try {
        const res = await fetch('/notes/api/history');
        const data = await res.json();
        if (data.ok) {
            renderHistoryTimeline(data.history || []);
        }
    } catch (e) {
        container.innerHTML = '<div style="color:red; padding:12px;">Geçmiş yüklenemedi.</div>';
    }
}

function renderHistoryTimeline(history) {
    const container = document.getElementById('history-timeline-list');
    if (!history.length) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted); font-size:0.85rem;">Henüz kayıtlı bir işlem yok.</div>';
        return;
    }

    const typeIcons = {
        'create_page': '📄➕',
        'delete_page': '📄🗑️',
        'restore_page': '📄↩️',
        'create_item': '📝➕',
        'delete_item': '📝🗑️',
        'toggle_item': '✅',
        'update_item': '✏️',
        'clear_completed': '🧹',
        'create_vault': '🔐➕',
        'delete_vault': '🔐🗑️',
        'update_vault': '🔐✏️',
        'empty_trash': '🗑️💥'
    };

    let html = '';
    history.forEach(item => {
        const icon = typeIcons[item.action_type] || '⚡';
        html += `
            <div class="history-item-row">
                <div class="history-left">
                    <span style="font-size:1.1rem;">${icon}</span>
                    <div style="display:flex; flex-direction:column; min-width:0;">
                        <span class="history-desc" title="${escapeHtml(item.description)}">${escapeHtml(item.description)}</span>
                        <span class="history-time">${item.created_at || ''}</span>
                    </div>
                </div>
                <button class="btn btn-sm btn-outline" style="font-size:0.75rem; padding:3px 8px; white-space:nowrap;" onclick="undoSpecificAction(${item.id})">
                    ↩️ Geri Al
                </button>
            </div>
        `;
    });
    container.innerHTML = html;
}

async function undoSpecificAction(historyId) {
    try {
        const res = await fetch(`/notes/api/history/${historyId}/undo`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            showToast(`↩️ ${data.message || 'İşlem geri alındı!'}`);
            openHistoryModal();
            updateTrashBadgeCount();
            if (currentPageId) loadPage(currentPageId);
        } else {
            showToast(`❌ ${data.error || 'İşlem geri alınamadı.'}`);
        }
    } catch (e) {
        showToast(`❌ Hata: ${e.message}`);
    }
}

// ─────────────────────────────────────────────────────────────
// Çöp Kutusu (Trash & Restore)
// ─────────────────────────────────────────────────────────────

async function loadTrashPage() {
    currentPageId = null;
    currentPageData = null;

    // Menü aktifliklerini sıfırla, Çöp Kutusunu aktif yap
    document.querySelectorAll('.page-item').forEach(el => el.classList.remove('active'));
    const ovBtn = document.getElementById('sidebar-overview-btn');
    const vaultBtn = document.getElementById('sidebar-vault-btn');
    const trashBtn = document.getElementById('sidebar-trash-btn');
    if (ovBtn) ovBtn.classList.remove('active');
    if (vaultBtn) vaultBtn.classList.remove('active');
    if (trashBtn) trashBtn.classList.add('active');

    // Başlık ve Aksiyonlar
    const titleEl = document.getElementById('current-page-title');
    const iconEl = document.getElementById('current-page-icon');
    const badgeEl = document.getElementById('current-page-badge');
    if (titleEl) titleEl.textContent = 'Çöp Kutusu & Geri Dönüşüm';
    if (iconEl) iconEl.textContent = '🗑️';
    if (badgeEl) badgeEl.textContent = 'Geri Yükleme';

    const pageActions = document.getElementById('page-header-actions');
    const ovActions = document.getElementById('overview-header-actions');
    const vaultActions = document.getElementById('vault-header-actions');
    const trashActions = document.getElementById('trash-header-actions');
    if (pageActions) pageActions.style.display = 'none';
    if (ovActions) ovActions.style.display = 'none';
    if (vaultActions) vaultActions.style.display = 'none';
    if (trashActions) trashActions.style.display = 'flex';

    // Diğer görünümleri gizle, Çöp Kutusunu göster
    document.getElementById('checklist-view').style.display = 'none';
    document.getElementById('note-view').style.display = 'none';
    document.getElementById('finance-view').style.display = 'none';
    document.getElementById('project-view').style.display = 'none';
    document.getElementById('overview-view').style.display = 'none';
    document.getElementById('vault-view').style.display = 'none';
    document.getElementById('quick-add-container').style.display = 'none';
    document.getElementById('trash-view').style.display = 'flex';

    await refreshTrashList();
}

async function refreshTrashList() {
    const container = document.getElementById('trash-list-container');
    container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted);">Yükleniyor...</div>';

    try {
        const res = await fetch('/notes/api/trash');
        const data = await res.json();
        if (data.ok) {
            renderTrashCards(data.trash || []);
            updateTrashBadge(data.count || 0);
        }
    } catch (e) {
        container.innerHTML = '<div style="color:red; padding:12px;">Çöp kutusu yüklenemedi.</div>';
    }
}

function renderTrashCards(trashItems) {
    const container = document.getElementById('trash-list-container');
    const emptyBtn = document.getElementById('btn-empty-trash');
    if (!trashItems.length) {
        container.innerHTML = `
            <div style="text-align:center; padding:40px 16px; color:var(--muted);">
                <div style="font-size:2.2rem; margin-bottom:8px;">🎉</div>
                <div style="font-weight:600; font-size:1rem; color:var(--text);">Çöp kutusu tertemiz!</div>
                <div style="font-size:0.8rem; margin-top:4px;">Silinen hiçbir sayfa veya not bulunmuyor.</div>
            </div>
        `;
        if (emptyBtn) emptyBtn.style.display = 'none';
        return;
    }

    if (emptyBtn) emptyBtn.style.display = 'block';

    let html = '';
    trashItems.forEach(item => {
        html += `
            <div class="trash-card" id="trash-card-${item.id}">
                <div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1;">
                    <span style="font-size:1.4rem;">${item.icon || '📝'}</span>
                    <div style="display:flex; flex-direction:column; min-width:0;">
                        <span style="font-weight:700; font-size:0.92rem; color:var(--text);">${escapeHtml(item.title)}</span>
                        <span style="font-size:0.75rem; color:var(--muted);">
                            Kategori: <strong>${escapeHtml(item.category_name || 'Genel')}</strong> • 
                            ${item.item_count || 0} madde • Silinme: ${item.updated_at || ''}
                        </span>
                    </div>
                </div>
                <div style="display:flex; gap:8px;">
                    <button class="btn btn-sm btn-primary" onclick="restoreTrashPage(${item.id})" style="font-size:0.78rem; padding:4px 10px;">
                        ↩️ Geri Yükle
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="permanentDeleteTrashPage(${item.id})" style="font-size:0.78rem; padding:4px 10px;">
                        🗑️ Kalıcı Sil
                    </button>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

async function restoreTrashPage(pageId) {
    try {
        const res = await fetch(`/notes/api/trash/${pageId}/restore`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            showToast("✓ Sayfa başarıyla geri yüklendi!");
            refreshTrashList();
            updateTrashBadgeCount();
            setTimeout(() => { window.location.reload(); }, 600);
        }
    } catch (e) {
        showToast(`❌ Hata: ${e.message}`);
    }
}

async function permanentDeleteTrashPage(pageId) {
    if (!confirm("Bu sayfayı kalıcı olarak silmek istediğinize emin misiniz? Bu işlem GERİ ALINAMAZ!")) return;
    try {
        const res = await fetch(`/notes/api/trash/${pageId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
            showToast("Sayfa kalıcı olarak silindi.");
            refreshTrashList();
            updateTrashBadgeCount();
        }
    } catch (e) {
        showToast(`❌ Hata: ${e.message}`);
    }
}

async function confirmEmptyTrash() {
    if (!confirm("Çöp kutusundaki TÜM sayfalar kalıcı olarak silinecektir. Emin misiniz?")) return;
    try {
        const res = await fetch('/notes/api/trash/empty', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            showToast("Çöp kutusu tamamen boşaltıldı.");
            refreshTrashList();
            updateTrashBadgeCount();
        }
    } catch (e) {
        showToast(`❌ Hata: ${e.message}`);
    }
}

async function updateTrashBadgeCount() {
    try {
        const res = await fetch('/notes/api/trash');
        const data = await res.json();
        if (data.ok) {
            updateTrashBadge(data.count || 0);
        }
    } catch (e) {}
}

function updateTrashBadge(count) {
    const badge = document.getElementById('sidebar-trash-badge');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

// ─────────────────────────────────────────────────────────────
// Şifreler & Kimlik Bilgileri Kasası (Vault)
// ─────────────────────────────────────────────────────────────

let currentVaultScope = 'all';
let currentVaultCategory = 'all';
let currentVaultProfile = 'all';
let currentVaultFolder = 'all';
let currentVaultTag = 'all';
let vaultSearchDebounceTimer = null;
let currentVaultEntries = [];
let currentVaultFoldersList = [];
let currentVaultProfilesList = [];
let currentVaultTagsList = [];

async function loadVaultPage() {
    currentPageId = null;
    currentPageData = null;

    // Menü aktifliklerini sıfırla, Kasayı aktif yap
    document.querySelectorAll('.page-item').forEach(el => el.classList.remove('active'));
    const ovBtn = document.getElementById('sidebar-overview-btn');
    const vaultBtn = document.getElementById('sidebar-vault-btn');
    const trashBtn = document.getElementById('sidebar-trash-btn');
    if (ovBtn) ovBtn.classList.remove('active');
    if (trashBtn) trashBtn.classList.remove('active');
    if (vaultBtn) vaultBtn.classList.add('active');

    // Başlık ve Aksiyonlar
    const titleEl = document.getElementById('current-page-title');
    const iconEl = document.getElementById('current-page-icon');
    const badgeEl = document.getElementById('current-page-badge');
    if (titleEl) titleEl.textContent = 'Şifre & Kimlik Bilgileri Kasası';
    if (iconEl) iconEl.textContent = '🔐';
    if (badgeEl) badgeEl.textContent = 'Güvenli Kasa';

    const pageActions = document.getElementById('page-header-actions');
    const ovActions = document.getElementById('overview-header-actions');
    const vaultActions = document.getElementById('vault-header-actions');
    const trashActions = document.getElementById('trash-header-actions');
    if (pageActions) pageActions.style.display = 'none';
    if (ovActions) ovActions.style.display = 'none';
    if (trashActions) trashActions.style.display = 'none';
    if (vaultActions) vaultActions.style.display = 'flex';

    // Diğer görünümleri gizle, Kasayı göster
    document.getElementById('checklist-view').style.display = 'none';
    document.getElementById('note-view').style.display = 'none';
    document.getElementById('finance-view').style.display = 'none';
    document.getElementById('project-view').style.display = 'none';
    document.getElementById('overview-view').style.display = 'none';
    document.getElementById('trash-view').style.display = 'none';
    document.getElementById('quick-add-container').style.display = 'none';
    document.getElementById('vault-view').style.display = 'flex';

    await fetchVaultEntries();
}

function setVaultScope(scope) {
    currentVaultScope = scope;
    document.querySelectorAll('.vault-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.scope === scope);
    });
    fetchVaultEntries();
}

function setVaultCategory(category) {
    currentVaultCategory = category;
    const catSelect = document.getElementById('vault-category-filter');
    if (catSelect) catSelect.value = category;
    fetchVaultEntries();
}

function setVaultProfile(profile) {
    currentVaultProfile = profile;
    const profSelect = document.getElementById('vault-profile-filter');
    if (profSelect) profSelect.value = profile;
    fetchVaultEntries();
}

function setVaultFolder(folder) {
    currentVaultFolder = folder;
    const foldSelect = document.getElementById('vault-folder-filter');
    if (foldSelect) foldSelect.value = folder;
    fetchVaultEntries();
}

function setVaultTag(tag) {
    currentVaultTag = tag;
    fetchVaultEntries();
}

function clearAllVaultFilters() {
    currentVaultScope = 'all';
    currentVaultCategory = 'all';
    currentVaultProfile = 'all';
    currentVaultFolder = 'all';
    currentVaultTag = 'all';

    const sInput = document.getElementById('vault-search-input');
    if (sInput) sInput.value = '';
    const profSelect = document.getElementById('vault-profile-filter');
    if (profSelect) profSelect.value = 'all';
    const foldSelect = document.getElementById('vault-folder-filter');
    if (foldSelect) foldSelect.value = 'all';
    const catSelect = document.getElementById('vault-category-filter');
    if (catSelect) catSelect.value = 'all';

    document.querySelectorAll('.vault-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.scope === 'all');
    });

    fetchVaultEntries();
}

function debounceVaultSearch() {
    clearTimeout(vaultSearchDebounceTimer);
    vaultSearchDebounceTimer = setTimeout(fetchVaultEntries, 200);
}

async function fetchVaultEntries() {
    const q = document.getElementById('vault-search-input')?.value.trim() || '';
    const params = new URLSearchParams();
    if (currentVaultScope && currentVaultScope !== 'all') params.append('scope', currentVaultScope);
    if (currentVaultCategory && currentVaultCategory !== 'all') params.append('category', currentVaultCategory);
    if (currentVaultProfile && currentVaultProfile !== 'all') params.append('profile', currentVaultProfile);
    if (currentVaultFolder && currentVaultFolder !== 'all') params.append('folder', currentVaultFolder);
    if (currentVaultTag && currentVaultTag !== 'all') params.append('tag', currentVaultTag);
    if (q) params.append('q', q);

    try {
        const res = await fetch(`/notes/api/vault?${params.toString()}`);
        const data = await res.json();
        if (data.ok) {
            currentVaultEntries = data.entries || [];
            currentVaultProfilesList = data.profiles || [];
            currentVaultFoldersList = data.folders || [];
            currentVaultTagsList = data.tags || [];

            updateVaultFoldersStrip(currentVaultFoldersList, currentVaultEntries.length);
            updateVaultFoldersDropdown(currentVaultFoldersList);
            updateVaultProfilesDropdown(currentVaultProfilesList);
            updateVaultTagsDatalist(currentVaultTagsList);
            updateVaultActiveFilterBar(currentVaultEntries.length);
            renderVaultCards(currentVaultEntries);
        }
    } catch (e) {
        console.error("Vault fetch error:", e);
    }
}

function updateVaultFoldersStrip(folders, matchCount) {
    const strip = document.getElementById('vault-folders-strip');
    if (!strip) return;

    let html = `
        <div class="vault-folder-chip ${currentVaultFolder === 'all' ? 'active' : ''}" onclick="setVaultFolder('all')" title="Tüm klasörlerdeki şifreleri listele">
            <span>📁 Tümü</span>
            <span class="vault-folder-count">${matchCount || currentVaultEntries.length}</span>
        </div>
    `;

    folders.forEach(f => {
        const isActive = currentVaultFolder === f.name;
        html += `
            <div class="vault-folder-chip ${isActive ? 'active' : ''}" onclick="setVaultFolder('${escapeHtml(f.name)}')" title="Klasör: ${escapeHtml(f.name)}">
                <span>${f.icon || '📁'} ${escapeHtml(f.name)}</span>
                <span class="vault-folder-count">${f.count || 0}</span>
                <span style="opacity:0.6; font-size:0.65rem; margin-left:2px;" onclick="event.stopPropagation(); deleteVaultFolderPrompt('${escapeHtml(f.name)}')" title="Klasörü Sil">✕</span>
            </div>
        `;
    });

    strip.innerHTML = html;
}

function updateVaultFoldersDropdown(folders) {
    const filterSelect = document.getElementById('vault-folder-filter');
    const datalist = document.getElementById('vault-folder-datalist');

    if (filterSelect) {
        const curVal = currentVaultFolder;
        let optHtml = '<option value="all">📁 Tüm Klasörler</option>';
        folders.forEach(f => {
            optHtml += `<option value="${escapeHtml(f.name)}" ${curVal === f.name ? 'selected' : ''}>📁 ${escapeHtml(f.name)} (${f.count || 0})</option>`;
        });
        filterSelect.innerHTML = optHtml;
    }

    if (datalist) {
        let dlHtml = '';
        folders.forEach(f => {
            dlHtml += `<option value="${escapeHtml(f.name)}">`;
        });
        datalist.innerHTML = dlHtml;
    }
}

function updateVaultProfilesDropdown(profiles) {
    const filterSelect = document.getElementById('vault-profile-filter');
    const datalist = document.getElementById('vault-profile-datalist');

    if (filterSelect) {
        const curVal = currentVaultProfile;
        let optHtml = '<option value="all">👥 Tüm Kişiler</option>';
        profiles.forEach(p => {
            const pName = typeof p === 'object' ? p.profile_name : p;
            const pCount = typeof p === 'object' ? ` (${p.count})` : '';
            optHtml += `<option value="${escapeHtml(pName)}" ${curVal === pName ? 'selected' : ''}>👤 ${escapeHtml(pName)}${pCount}</option>`;
        });
        filterSelect.innerHTML = optHtml;
    }

    if (datalist) {
        let dlHtml = '';
        profiles.forEach(p => {
            const pName = typeof p === 'object' ? p.profile_name : p;
            dlHtml += `<option value="${escapeHtml(pName)}">`;
        });
        datalist.innerHTML = dlHtml;
    }
}

function updateVaultTagsDatalist(tags) {
    let datalist = document.getElementById('vault-tags-datalist');
    if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = 'vault-tags-datalist';
        document.body.appendChild(datalist);
    }
    let html = '';
    tags.forEach(t => {
        html += `<option value="#${escapeHtml(t.tag)}">`;
    });
    datalist.innerHTML = html;
}

function updateVaultActiveFilterBar(count) {
    const bar = document.getElementById('vault-active-filter-bar');
    const textEl = document.getElementById('vault-active-filter-text');
    if (!bar || !textEl) return;

    const filters = [];
    if (currentVaultProfile && currentVaultProfile !== 'all') {
        filters.push(`👤 Kişi: <b>${escapeHtml(currentVaultProfile)}</b>`);
    }
    if (currentVaultFolder && currentVaultFolder !== 'all') {
        filters.push(`📁 Klasör: <b>${escapeHtml(currentVaultFolder)}</b>`);
    }
    if (currentVaultTag && currentVaultTag !== 'all') {
        filters.push(`🏷️ Etiket: <b>#${escapeHtml(currentVaultTag)}</b>`);
    }
    if (currentVaultCategory && currentVaultCategory !== 'all') {
        filters.push(`📂 Kategori: <b>${escapeHtml(currentVaultCategory)}</b>`);
    }
    const q = document.getElementById('vault-search-input')?.value.trim();
    if (q) {
        filters.push(`🔍 Arama: <i>"${escapeHtml(q)}"</i>`);
    }

    if (filters.length > 0) {
        textEl.innerHTML = `Filtrelendi: ${filters.join(' &nbsp;|&nbsp; ')} &nbsp;·&nbsp; <b>${count} şifre</b>`;
        bar.style.display = 'flex';
    } else {
        bar.style.display = 'none';
    }
}

function renderVaultCards(entries) {
    const grid = document.getElementById('vault-cards-grid');
    if (!entries.length) {
        grid.innerHTML = `
            <div style="grid-column:1/-1; text-align:center; padding:50px 16px; color:var(--muted);">
                <div style="font-size:2.4rem; margin-bottom:8px;">🔐</div>
                <div style="font-weight:700; font-size:1.05rem; color:var(--text);">Kayıt Bulunamadı</div>
                <div style="font-size:0.82rem; margin-top:4px;">Seçilen filtreye uygun şifre veya hesap kaydı yok.</div>
                <div style="margin-top:12px; display:flex; justify-content:center; gap:8px;">
                    <button class="btn btn-sm btn-outline" onclick="clearAllVaultFilters()">Filtreleri Temizle</button>
                    <button class="btn btn-sm btn-primary" onclick="openAddVaultModal()">+ Yeni Kayıt Ekle</button>
                </div>
            </div>
        `;
        return;
    }

    const catLabels = {
        'web': '🌐 Web/Uygulama',
        'bank': '💳 Banka/Finans',
        'wifi': '📶 Wi-Fi/Ağ',
        'device': '📱 Cihaz/PIN',
        'server': '🖥️ Sunucu/API',
        'email': '📧 E-posta',
        'other': '🔒 Diğer'
    };

    const scopeLabels = {
        'personal': '👤 Kişisel',
        'family': '👨‍👩‍👧 Aile',
        'work': '💼 İş/Şirket',
        'other': '🔒 Diğer'
    };

    let html = '';
    entries.forEach(entry => {
        const isFav = entry.is_favorite == 1;
        const maskedPwd = entry.password ? '••••••••••••' : '<span style="color:var(--muted); font-size:0.75rem;">(Şifresiz)</span>';

        // Parse tags
        let tagsHtml = '';
        if (entry.tags) {
            const tagParts = entry.tags.replace(/;/g, ',').split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
            tagsHtml = tagParts.map(t => `<span class="vault-badge vault-badge-tag vault-badge-clickable" onclick="setVaultTag('${escapeHtml(t)}')" title="Bu etikete sahip şifreleri listele">#${escapeHtml(t)}</span>`).join('');
        }

        html += `
            <div class="vault-card ${isFav ? 'is-favorite' : ''}" id="vault-card-${entry.id}">
                <div class="vault-card-header">
                    <div class="vault-card-title-area">
                        <span class="vault-card-icon">${entry.icon || '🔐'}</span>
                        <div style="min-width:0; flex:1;">
                            <div class="vault-card-title" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</div>
                            <div class="vault-card-badges">
                                <span class="vault-badge vault-badge-scope-${entry.scope}">${scopeLabels[entry.scope] || entry.scope}</span>
                                ${entry.folder_name ? `<span class="vault-badge vault-badge-folder vault-badge-clickable" onclick="setVaultFolder('${escapeHtml(entry.folder_name)}')" title="Klasördeki tüm şifreleri listele">📁 ${escapeHtml(entry.folder_name)}</span>` : ''}
                                ${entry.profile_name ? `<span class="vault-badge vault-badge-profile vault-badge-clickable" onclick="setVaultProfile('${escapeHtml(entry.profile_name)}')" title="Bu kişiye ait tüm şifreleri listele">👤 ${escapeHtml(entry.profile_name)}</span>` : ''}
                                <span class="vault-badge vault-badge-cat vault-badge-clickable" onclick="setVaultCategory('${entry.category}')" title="Bu kategorideki şifreleri listele">${catLabels[entry.category] || entry.category}</span>
                                ${tagsHtml}
                            </div>
                        </div>
                    </div>
                    <button class="btn-icon-subtle" onclick="toggleVaultFavorite(${entry.id})" title="${isFav ? 'Favorilerden Çıkar' : 'Favorilere Ekle'}">
                        ${isFav ? '⭐' : '☆'}
                    </button>
                </div>

                ${entry.username ? `
                <div class="vault-field-row">
                    <div>
                        <div class="vault-field-label">Kullanıcı / ID</div>
                        <div class="vault-field-val" id="v-val-user-${entry.id}" title="${escapeHtml(entry.username)}">${escapeHtml(entry.username)}</div>
                    </div>
                    <button class="vault-btn-copy" onclick="copyVaultField('${escapeHtml(entry.username)}', 'Kullanıcı Adı')" title="Kullanıcı Adını Kopyala">📋</button>
                </div>
                ` : ''}

                ${entry.password ? `
                <div class="vault-field-row">
                    <div style="flex:1; min-width:0;">
                        <div class="vault-field-label">Şifre / Parola</div>
                        <div class="vault-field-val" id="v-val-pwd-${entry.id}" data-real="${escapeHtml(entry.password)}">${maskedPwd}</div>
                    </div>
                    <div class="vault-field-actions">
                        <button class="vault-btn-copy" onclick="toggleCardPasswordVisibility(${entry.id})" title="Şifreyi Göster/Gizle">👁️</button>
                        <button class="vault-btn-copy" onclick="copyVaultField('${escapeHtml(entry.password)}', 'Şifre')" title="Şifreyi Kopyala">📋</button>
                    </div>
                </div>
                ` : ''}

                ${entry.secondary_info ? `
                <div style="font-size:0.75rem; background:var(--surface2); padding:4px 8px; border-radius:6px; display:flex; justify-content:space-between; align-items:center;">
                    <span style="color:var(--muted); font-weight:600;">Ek Bilgi:</span>
                    <span style="font-family:monospace; font-weight:600;">${escapeHtml(entry.secondary_info)}</span>
                    <button class="vault-btn-copy" onclick="copyVaultField('${escapeHtml(entry.secondary_info)}', 'Ek Bilgi')" title="Kopyala" style="font-size:0.75rem;">📋</button>
                </div>
                ` : ''}

                ${entry.notes ? `
                <div class="vault-card-notes">${escapeHtml(entry.notes)}</div>
                ` : ''}

                <!-- Kişi / Klasör Hızlı İlişki Bağlantıları -->
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:2px;">
                    ${entry.profile_name ? `
                    <button class="vault-related-link" onclick="setVaultProfile('${escapeHtml(entry.profile_name)}')" title="Bu kişiye ait diğer tüm şifreleri filtrele">
                        👤 ${escapeHtml(entry.profile_name)}'e ait diğerleri ➔
                    </button>` : ''}
                    ${entry.folder_name ? `
                    <button class="vault-related-link" onclick="setVaultFolder('${escapeHtml(entry.folder_name)}')" title="Bu klasördeki tüm kayıtları filtrele">
                        📁 ${escapeHtml(entry.folder_name)} klasörü ➔
                    </button>` : ''}
                    <button class="vault-related-link" style="color:var(--muted); background:var(--surface2);" onclick="openVaultRelatedModal(${entry.id})" title="Bu kayıtla ilişkili diğer şifreleri popup olarak gör">
                        🔗 İlgililer
                    </button>
                </div>

                <div class="vault-card-footer">
                    <div>
                        ${entry.url ? `
                        <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent); text-decoration:none; font-weight:600; display:inline-flex; align-items:center; gap:3px;">
                            🔗 Giriş Yap
                        </a>
                        ` : '<span style="color:var(--muted); font-size:0.72rem;">' + (entry.created_at || '') + '</span>'}
                    </div>
                    <div style="display:flex; gap:4px;">
                        <button class="btn-icon-subtle" onclick="openEditVaultModal(${entry.id})" title="Düzenle">✏️</button>
                        <button class="btn-icon-subtle btn-danger-hover" onclick="deleteVaultEntry(${entry.id}, '${escapeHtml(entry.title)}')" title="Sil">🗑️</button>
                    </div>
                </div>
            </div>
        `;
    });
    grid.innerHTML = html;
}

function toggleCardPasswordVisibility(id) {
    const el = document.getElementById(`v-val-pwd-${id}`);
    if (!el) return;
    const real = el.getAttribute('data-real');
    if (el.textContent === '••••••••••••') {
        el.textContent = real;
    } else {
        el.textContent = '••••••••••••';
    }
}

function copyVaultField(text, label) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        showToast(`📋 ${label} panoya kopyalandı!`);
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(`📋 ${label} panoya kopyalandı!`);
    });
}

// ── Kasa Klasör Modalı & Yönetimi ──
function openNewVaultFolderModal() {
    document.getElementById('vault-folder-modal-title').textContent = '📁 Yeni Kasa Klasörü';
    document.getElementById('v-folder-old-name').value = '';
    document.getElementById('v-folder-input-name').value = '';
    document.getElementById('v-folder-input-icon').value = '📁';
    openModal('modal-vault-folder');
}

async function submitVaultFolder() {
    const name = document.getElementById('v-folder-input-name').value.trim();
    const icon = document.getElementById('v-folder-input-icon').value.trim() || '📁';
    const oldName = document.getElementById('v-folder-old-name').value.trim();

    if (!name) {
        alert("Lütfen klasör adı girin.");
        return;
    }

    try {
        let res;
        if (oldName) {
            res = await fetch('/notes/api/vault/folders/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_name: oldName, new_name: name })
            });
        } else {
            res = await fetch('/notes/api/vault/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name, icon: icon })
            });
        }
        const data = await res.json();
        if (data.ok) {
            closeModal('modal-vault-folder');
            showToast(`✓ "${name}" klasörü hazırlandı!`);
            currentVaultFolder = name;
            fetchVaultEntries();
        } else {
            alert(data.error || "İşlem başarısız.");
        }
    } catch (e) {
        showToast(`❌ Hata: ${e.message}`);
    }
}

async function deleteVaultFolderPrompt(name) {
    if (!confirm(`"${name}" klasörünü silmek istediğinize emin misiniz? (İçindeki şifreler silinmez, klasörsüz hale gelir)`)) return;
    try {
        const res = await fetch('/notes/api/vault/folders/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
        });
        const data = await res.json();
        if (data.ok) {
            showToast(`🗑️ "${name}" klasörü silindi.`);
            if (currentVaultFolder === name) currentVaultFolder = 'all';
            fetchVaultEntries();
        }
    } catch (e) {
        showToast(`❌ Hata: ${e.message}`);
    }
}

// ── İlişkili Şifreler Modalı ──
async function openVaultRelatedModal(entryId) {
    const titleEl = document.getElementById('vault-related-modal-title');
    const bodyEl = document.getElementById('vault-related-modal-body');
    if (!bodyEl) return;

    bodyEl.innerHTML = '<div style="padding:20px; text-align:center; color:var(--muted);">İlişkili şifreler taranıyor...</div>';
    openModal('modal-vault-related');

    try {
        const res = await fetch(`/notes/api/vault/${entryId}/related`);
        const data = await res.json();
        if (!data.ok) {
            bodyEl.innerHTML = '<div style="padding:20px; text-align:center; color:#ef4444;">İlişkili kayıtlar getirilemedi.</div>';
            return;
        }

        titleEl.textContent = `🔗 "${data.current_title}" İle İlişkili Şifreler`;

        let html = '';
        let hasAny = false;

        // 1. Aynı Kişiye Ait Diğer Şifreler
        if (data.by_profile && data.by_profile.length > 0) {
            hasAny = true;
            html += `
                <div style="font-weight:700; font-size:0.86rem; color:var(--text); margin-bottom:4px; display:flex; justify-content:space-between; align-items:center;">
                    <span>👤 ${escapeHtml(data.profile_name)} Kişisine Ait Diğer Şifreler (${data.by_profile.length})</span>
                    <button class="btn btn-xs btn-outline" onclick="closeModal('modal-vault-related'); setVaultProfile('${escapeHtml(data.profile_name)}')">Tümünü Filtrele ➔</button>
                </div>
                <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px;">
                    ${data.by_profile.map(item => `
                        <div class="vault-related-row">
                            <div style="min-width:0; flex:1;">
                                <div style="font-weight:600; font-size:0.83rem;">${item.icon || '🔐'} ${escapeHtml(item.title)}</div>
                                <div style="font-size:0.72rem; color:var(--muted); font-family:monospace;">${escapeHtml(item.username || '(Kullanıcı Adı Yok)')}</div>
                            </div>
                            <div style="display:flex; gap:4px;">
                                ${item.username ? `<button class="vault-btn-copy" onclick="copyVaultField('${escapeHtml(item.username)}', 'Kullanıcı Adı')" title="Kullanıcı Kopyala">👤</button>` : ''}
                                <button class="vault-btn-copy" onclick="copyAndFetchVaultPassword(${item.id})" title="Şifreyi Panoya Kopyala">🔑</button>
                                <button class="btn-icon-subtle" onclick="closeModal('modal-vault-related'); openEditVaultModal(${item.id})" title="Düzenle">✏️</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // 2. Aynı Klasördeki Diğer Şifreler
        if (data.by_folder && data.by_folder.length > 0) {
            hasAny = true;
            html += `
                <div style="font-weight:700; font-size:0.86rem; color:var(--text); margin-bottom:4px; display:flex; justify-content:space-between; align-items:center;">
                    <span>📁 "${escapeHtml(data.folder_name)}" Klasöründeki Diğer Şifreler (${data.by_folder.length})</span>
                    <button class="btn btn-xs btn-outline" onclick="closeModal('modal-vault-related'); setVaultFolder('${escapeHtml(data.folder_name)}')">Tümünü Filtrele ➔</button>
                </div>
                <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px;">
                    ${data.by_folder.map(item => `
                        <div class="vault-related-row">
                            <div style="min-width:0; flex:1;">
                                <div style="font-weight:600; font-size:0.83rem;">${item.icon || '🔐'} ${escapeHtml(item.title)} ${item.profile_name ? `<span style="font-size:0.70rem; color:var(--muted);">(${escapeHtml(item.profile_name)})</span>` : ''}</div>
                                <div style="font-size:0.72rem; color:var(--muted); font-family:monospace;">${escapeHtml(item.username || '(Kullanıcı Adı Yok)')}</div>
                            </div>
                            <div style="display:flex; gap:4px;">
                                ${item.username ? `<button class="vault-btn-copy" onclick="copyVaultField('${escapeHtml(item.username)}', 'Kullanıcı Adı')" title="Kullanıcı Kopyala">👤</button>` : ''}
                                <button class="vault-btn-copy" onclick="copyAndFetchVaultPassword(${item.id})" title="Şifreyi Panoya Kopyala">🔑</button>
                                <button class="btn-icon-subtle" onclick="closeModal('modal-vault-related'); openEditVaultModal(${item.id})" title="Düzenle">✏️</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // 3. Aynı Web Adresi / Domain
        if (data.by_domain && data.by_domain.length > 0) {
            hasAny = true;
            html += `
                <div style="font-weight:700; font-size:0.86rem; color:var(--text); margin-bottom:4px;">
                    🌐 Aynı Servis / Domain (${escapeHtml(data.domain)})
                </div>
                <div style="display:flex; flex-direction:column; gap:6px;">
                    ${data.by_domain.map(item => `
                        <div class="vault-related-row">
                            <div style="min-width:0; flex:1;">
                                <div style="font-weight:600; font-size:0.83rem;">${item.icon || '🔐'} ${escapeHtml(item.title)}</div>
                                <div style="font-size:0.72rem; color:var(--muted); font-family:monospace;">${escapeHtml(item.username || '(Kullanıcı Adı Yok)')}</div>
                            </div>
                            <div style="display:flex; gap:4px;">
                                ${item.username ? `<button class="vault-btn-copy" onclick="copyVaultField('${escapeHtml(item.username)}', 'Kullanıcı Adı')" title="Kullanıcı Kopyala">👤</button>` : ''}
                                <button class="vault-btn-copy" onclick="copyAndFetchVaultPassword(${item.id})" title="Şifreyi Panoya Kopyala">🔑</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        if (!hasAny) {
            html = `
                <div style="text-align:center; padding:30px 10px; color:var(--muted);">
                    <div style="font-size:2rem; margin-bottom:6px;">🔍</div>
                    <div style="font-weight:600;">İlişkili Başka Şifre Bulunamadı</div>
                    <div style="font-size:0.78rem; margin-top:4px;">Bu kişiye veya klasöre ait tanımlanmış başka bir kayıt yok.</div>
                </div>
            `;
        }

        bodyEl.innerHTML = html;
    } catch (e) {
        bodyEl.innerHTML = `<div style="padding:20px; text-align:center; color:#ef4444;">Hata: ${e.message}</div>`;
    }
}

async function copyAndFetchVaultPassword(id) {
    try {
        const res = await fetch(`/notes/api/vault/${id}`);
        const data = await res.json();
        if (data.ok && data.entry && data.entry.password) {
            copyVaultField(data.entry.password, 'Şifre');
        } else {
            showToast("Bu kayıtta şifre bulunmuyor.");
        }
    } catch (e) {
        showToast("Şifre kopyalanamadı.");
    }
}

// ── Kasa Ekleme & Düzenleme ──
function openAddVaultModal() {
    document.getElementById('vault-modal-title').textContent = '🔐 Yeni Şifre / Hesap Kaydı';
    document.getElementById('vault-entry-id').value = '';
    document.getElementById('v-scope').value = (currentVaultScope !== 'all' ? currentVaultScope : 'personal');
    document.getElementById('v-category').value = (currentVaultCategory !== 'all' ? currentVaultCategory : 'web');
    document.getElementById('v-folder').value = (currentVaultFolder !== 'all' ? currentVaultFolder : '');
    document.getElementById('v-profile').value = (currentVaultProfile !== 'all' ? currentVaultProfile : '');
    document.getElementById('v-title').value = '';
    document.getElementById('v-tags').value = (currentVaultTag !== 'all' ? `#${currentVaultTag}` : '');
    document.getElementById('v-username').value = '';
    document.getElementById('v-password').value = '';
    document.getElementById('v-url').value = '';
    document.getElementById('v-secondary').value = '';
    document.getElementById('v-notes').value = '';
    updateVaultFormHints();
    openModal('modal-vault-entry');
}

async function openEditVaultModal(id) {
    try {
        const res = await fetch(`/notes/api/vault/${id}`);
        const data = await res.json();
        if (data.ok && data.entry) {
            const e = data.entry;
            document.getElementById('vault-modal-title').textContent = '✏️ Şifre Kaydını Düzenle';
            document.getElementById('vault-entry-id').value = e.id;
            document.getElementById('v-scope').value = e.scope || 'personal';
            document.getElementById('v-category').value = e.category || 'web';
            document.getElementById('v-folder').value = e.folder_name || '';
            document.getElementById('v-profile').value = e.profile_name || '';
            document.getElementById('v-title').value = e.title || '';
            document.getElementById('v-tags').value = e.tags || '';
            document.getElementById('v-username').value = e.username || '';
            document.getElementById('v-password').value = e.password || '';
            document.getElementById('v-url').value = e.url || '';
            document.getElementById('v-secondary').value = e.secondary_info || '';
            document.getElementById('v-notes').value = e.notes || '';
            updateVaultFormHints();
            openModal('modal-vault-entry');
        }
    } catch (err) {
        showToast("Kayıt bilgileri getirilemedi.");
    }
}

function updateVaultFormHints() {
    const cat = document.getElementById('v-category').value;
    const uLabel = document.getElementById('v-username-label');
    const uInput = document.getElementById('v-username');
    const secLabel = document.getElementById('v-secondary-label');
    const secInput = document.getElementById('v-secondary');

    if (cat === 'bank') {
        uLabel.textContent = 'Müşteri No / T.C. Kimlik';
        uInput.placeholder = 'Örn: 1234567';
        secLabel.textContent = 'IBAN / Kart Son 4 Hane';
        secInput.placeholder = 'TR00 ...';
    } else if (cat === 'wifi') {
        uLabel.textContent = 'Wi-Fi Ağ Adı (SSID)';
        uInput.placeholder = 'Örn: Ev_5GHz';
        secLabel.textContent = 'Router IP / Giriş Adresi';
        secInput.placeholder = '192.168.1.1';
    } else if (cat === 'device') {
        uLabel.textContent = 'Cihaz / Telefon Modeli';
        uInput.placeholder = 'Örn: iPhone 14, Samsung A52';
        secLabel.textContent = 'SIM PIN / PUK Kodu';
        secInput.placeholder = 'PIN: 1234, PUK: 887129...';
    } else if (cat === 'server') {
        uLabel.textContent = 'Kullanıcı Adı (root, admin)';
        uInput.placeholder = 'root';
        secLabel.textContent = 'Port / IP / Host';
        secInput.placeholder = '22 / 10.0.0.1';
    } else {
        uLabel.textContent = 'Kullanıcı Adı / E-posta / ID';
        uInput.placeholder = 'kullanici@mail.com veya username';
        secLabel.textContent = 'Ek Bilgi (PIN / IBAN / Port)';
        secInput.placeholder = 'İsteğe bağlı ek bilgi...';
    }
}

async function submitVaultEntry() {
    const id = document.getElementById('vault-entry-id').value;
    const title = document.getElementById('v-title').value.trim();
    if (!title) {
        alert("Lütfen başlık / hesap adı girin.");
        return;
    }

    const payload = {
        title: title,
        scope: document.getElementById('v-scope').value,
        category: document.getElementById('v-category').value,
        folder_name: document.getElementById('v-folder').value.trim(),
        profile_name: document.getElementById('v-profile').value.trim(),
        tags: document.getElementById('v-tags').value.trim(),
        username: document.getElementById('v-username').value.trim(),
        password: document.getElementById('v-password').value,
        url: document.getElementById('v-url').value.trim(),
        secondary_info: document.getElementById('v-secondary').value.trim(),
        notes: document.getElementById('v-notes').value.trim()
    };

    try {
        let res;
        if (id) {
            res = await fetch(`/notes/api/vault/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            res = await fetch('/notes/api/vault', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }
        const data = await res.json();
        if (data.ok) {
            closeModal('modal-vault-entry');
            showToast(id ? "✓ Kayıt güncellendi!" : "✓ Yeni şifre kaydı eklendi!");
            fetchVaultEntries();
        } else {
            alert(data.error || "İşlem tamamlanamadı.");
        }
    } catch (e) {
        showToast(`❌ Hata: ${e.message}`);
    }
}

async function deleteVaultEntry(id, title) {
    if (!confirm(`"${title}" şifre kaydını silmek istediğinize emin misiniz?`)) return;
    try {
        const res = await fetch(`/notes/api/vault/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
            showToast(`🗑️ "${title}" kaydı silindi (Geri alabilirsiniz).`);
            fetchVaultEntries();
        }
    } catch (e) {
        showToast(`❌ Hata: ${e.message}`);
    }
}

async function toggleVaultFavorite(id) {
    try {
        const res = await fetch(`/notes/api/vault/${id}/favorite`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            fetchVaultEntries();
        }
    } catch (e) {
        console.error(e);
    }
}

function togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.type = (input.type === 'password' ? 'text' : 'password');
}

// ─────────────────────────────────────────────────────────────
// Güçlü Rastgele Şifre Üretici (Password Generator)
// ─────────────────────────────────────────────────────────────

function openPasswordGeneratorModal() {
    generateNewPassword();
    openModal('modal-password-gen');
}

function generatePasswordString(len, upper, lower, digits, symbols) {
    let chars = '';
    if (upper) chars += 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    if (lower) chars += 'abcdefghijkmnpqrstuvwxyz';
    if (digits) chars += '23456789';
    if (symbols) chars += '!@#$%^&*()_+~|}{[]:;?><=';

    if (!chars) chars = 'abcdefghijkmnpqrstuvwxyz23456789';

    let res = '';
    const array = new Uint32Array(len);
    window.crypto.getRandomValues(array);
    for (let i = 0; i < len; i++) {
        res += chars[array[i] % chars.length];
    }
    return res;
}

function generateNewPassword() {
    const len = parseInt(document.getElementById('gen-length-slider')?.value || '16');
    const upper = document.getElementById('gen-opt-upper')?.checked ?? true;
    const lower = document.getElementById('gen-opt-lower')?.checked ?? true;
    const digits = document.getElementById('gen-opt-digits')?.checked ?? true;
    const symbols = document.getElementById('gen-opt-symbols')?.checked ?? true;

    const pwd = generatePasswordString(len, upper, lower, digits, symbols);
    const resultInput = document.getElementById('gen-password-result');
    if (resultInput) resultInput.value = pwd;
    return pwd;
}

function copyGenPassword() {
    const val = document.getElementById('gen-password-result')?.value;
    if (val) {
        copyVaultField(val, "Üretilen Şifre");
    }
}

function generatePasswordIntoField() {
    const pwd = generatePasswordString(16, true, true, true, true);
    const input = document.getElementById('v-password');
    if (input) {
        input.value = pwd;
        input.type = 'text';
        showToast("🎲 16 karakterli güçlü şifre oluşturuldu ve yazıldı!");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Not Defterleri (Notebooks - OneNote) Yönetimi
// ─────────────────────────────────────────────────────────────────────────────

function toggleNotebookDropdown(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('notebook-dropdown-menu');
    if (!menu) return;
    const isVisible = menu.style.display === 'flex';
    menu.style.display = isVisible ? 'none' : 'flex';
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('notebook-dropdown-menu');
    const btn = document.getElementById('notebook-select-btn');
    if (menu && menu.style.display === 'flex') {
        if (!menu.contains(e.target) && (!btn || !btn.contains(e.target))) {
            menu.style.display = 'none';
        }
    }
});

async function switchNotebook(nbId) {
    try {
        const res = await fetch('/notes/api/notebooks/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notebook_id: nbId })
        });
        const data = await res.json();
        if (data.ok) {
            window.location.href = `/notes?notebook_id=${nbId}`;
        }
    } catch (e) {
        window.location.href = `/notes?notebook_id=${nbId}`;
    }
}

async function submitAddNotebook(e) {
    if (e) e.preventDefault();
    const nameInput = document.getElementById('nb-new-name');
    const iconInput = document.getElementById('nb-new-icon');
    const colorInput = document.getElementById('nb-new-color');
    const descInput = document.getElementById('nb-new-desc');

    const name = nameInput ? nameInput.value.trim() : '';
    const icon = iconInput ? (iconInput.value.trim() || '📓') : '📓';
    const color = colorInput ? (colorInput.value || '#3b82f6') : '#3b82f6';
    const description = descInput ? descInput.value.trim() : '';

    if (!name) {
        alert('Lütfen not defteri adını girin.');
        return;
    }

    const res = await fetch('/notes/api/notebooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, icon, color, description })
    });
    const data = await res.json();
    if (data.ok) {
        closeModal('modal-add-notebook');
        window.location.href = `/notes?notebook_id=${data.id}`;
    } else {
        alert(data.error || 'Not defteri oluşturulamadı');
    }
}

function exportNotebook(nbId) {
    window.location.href = `/notes/api/notebooks/${nbId}/export`;
}

function exportCurrentNotebook() {
    const nbId = window.CURRENT_NOTEBOOK_ID || 1;
    exportNotebook(nbId);
}

async function handleNotebookImport(input) {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch('/notes/api/notebooks/import', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.ok) {
            alert('Not defteri başarıyla içe aktarıldı!');
            window.location.href = `/notes?notebook_id=${data.id}`;
        } else {
            alert(data.error || 'İçe aktarma başarısız');
        }
    } catch (err) {
        alert('Dosya yüklenirken hata oluştu: ' + err.message);
    } finally {
        input.value = '';
    }
}

function openUserModal() {
    openModal('modal-user-auth');
}

function switchAuthTab(tab) {
    const loginForm = document.getElementById('form-auth-login');
    const regForm = document.getElementById('form-auth-register');
    const btnLogin = document.getElementById('btn-tab-login');
    const btnReg = document.getElementById('btn-tab-register');

    if (tab === 'login') {
        if (loginForm) loginForm.style.display = 'block';
        if (regForm) regForm.style.display = 'none';
        if (btnLogin) btnLogin.classList.add('btn-primary');
        if (btnReg) btnReg.classList.remove('btn-primary');
    } else {
        if (loginForm) loginForm.style.display = 'none';
        if (regForm) regForm.style.display = 'block';
        if (btnLogin) btnLogin.classList.remove('btn-primary');
        if (btnReg) btnReg.classList.add('btn-primary');
    }
}

async function submitLogin(e) {
    if (e) e.preventDefault();
    const u = document.getElementById('login-username').value.trim();
    const p = document.getElementById('login-password').value.trim();
    const errEl = document.getElementById('auth-login-error');
    if (errEl) errEl.style.display = 'none';

    try {
        const res = await fetch('/notes/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (data.ok) {
            if (data.token) localStorage.setItem('tnote_auth_token', data.token);
            window.location.reload();
        } else {
            if (errEl) {
                errEl.innerText = data.error || 'Giriş yapılamadı';
                errEl.style.display = 'block';
            } else {
                alert(data.error || 'Giriş yapılamadı');
            }
        }
    } catch (err) {
        if (errEl) {
            errEl.innerText = err.message;
            errEl.style.display = 'block';
        }
    }
}

async function submitRegister(e) {
    if (e) e.preventDefault();
    const displayName = document.getElementById('reg-display-name').value.trim();
    const u = document.getElementById('reg-username').value.trim();
    const p = document.getElementById('reg-password').value.trim();
    const errEl = document.getElementById('auth-reg-error');
    if (errEl) errEl.style.display = 'none';

    try {
        const res = await fetch('/notes/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ display_name: displayName, username: u, password: p })
        });
        const data = await res.json();
        if (data.ok) {
            if (data.token) localStorage.setItem('tnote_auth_token', data.token);
            window.location.reload();
        } else {
            if (errEl) {
                errEl.innerText = data.error || 'Kayıt oluşturulamadı';
                errEl.style.display = 'block';
            } else {
                alert(data.error || 'Kayıt oluşturulamadı');
            }
        }
    } catch (err) {
        if (errEl) {
            errEl.innerText = err.message;
            errEl.style.display = 'block';
        }
    }
}

async function logoutUser() {
    try {
        await fetch('/notes/api/auth/logout', { method: 'POST' });
        localStorage.removeItem('tnote_auth_token');
        window.location.reload();
    } catch (err) {
        window.location.reload();
    }
}

