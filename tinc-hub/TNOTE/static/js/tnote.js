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

// PWA & Çevrimdışı (Offline) Kuyruk ve Eşitleme
function enqueueOfflineAction(action) {
    try {
        const q = JSON.parse(localStorage.getItem('tnote_offline_queue') || '[]');
        const existingIdx = q.findIndex(item => item.type === action.type && item.pageId === action.pageId);
        if (existingIdx >= 0) {
            q[existingIdx] = action;
        } else {
            q.push(action);
        }
        localStorage.setItem('tnote_offline_queue', JSON.stringify(q));
    } catch(e) {
        console.warn("enqueueOfflineAction error:", e);
    }
}

async function syncOfflineQueue() {
    try {
        const raw = localStorage.getItem('tnote_offline_queue');
        if (!raw) return;
        const q = JSON.parse(raw);
        if (!Array.isArray(q) || q.length === 0) return;

        const remaining = [];
        for (const item of q) {
            try {
                if (item.type === 'save_note') {
                    const res = await fetch(`/notes/api/pages/${item.pageId}`, {
                        method: 'PUT',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({content: item.content})
                    });
                    if (!res.ok) remaining.push(item);
                } else if (item.type === 'save_project') {
                    const res = await fetch(`/notes/api/pages/${item.pageId}/project`, {
                        method: 'PUT',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({concept: item.concept, specs: item.specs})
                    });
                    if (!res.ok) remaining.push(item);
                }
            } catch(err) {
                remaining.push(item);
            }
        }
        localStorage.setItem('tnote_offline_queue', JSON.stringify(remaining));
        if (remaining.length === 0) {
            showToast("Tüm çevrimdışı değişiklikler eşitlendi ✓");
        }
    } catch(e) {
        console.warn("syncOfflineQueue error:", e);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // PWA Service Worker Kaydı
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/notes/sw.js', { scope: '/notes/' })
            .then(reg => console.log('TincNote SW registered:', reg.scope))
            .catch(err => console.warn('TincNote SW registration failed:', err));
    }

    // Çevrimdışı / Çevrimiçi Dinleyicileri
    window.addEventListener('online', () => {
        showToast("İnternet bağlantısı sağlandı. Eşitleniyor...", "info");
        syncOfflineQueue();
    });
    window.addEventListener('offline', () => {
        showToast("Çevrimdışı moddasınız. Değişiklikler cihazda saklanıyor.", "warning");
    });

    // Sol Kenar Çubuğu Manuel Daraltma (« / ») durumunu yükle
    initSidebarToggleState();

    // Akordeon durumlarını geri yükle
    restoreCategoryCollapsedState();

    // Sürükle ve Bırak (Drag & Drop) Dinleyicileri
    initSidebarDragAndDrop();

    // Uygulama açılış sayfası: URL parametresi veya Genel Bakış
    const urlParams = new URLSearchParams(window.location.search);
    const initialPageId = urlParams.get('page_id') || urlParams.get('page');
    if (initialPageId) {
        loadPage(initialPageId);
    } else if (urlParams.get('tab') === 'quick' || urlParams.get('view') === 'quick') {
        loadQuickTasksPage();
    } else {
        loadOverviewPage();
    }

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

// Sayfadan ayrılırken anında kaydetme garantisi (OneNote davranışı)
window.addEventListener('beforeunload', () => {
    if (currentPageData && currentPageData.page && currentPageData.page.type === 'note') {
        const ta = document.getElementById('note-content-textarea');
        if (ta && currentPageId) {
            try {
                localStorage.setItem(`tnote_draft_${currentPageId}`, ta.value);
            } catch(e) {}
            const blob = new Blob([JSON.stringify({content: ta.value})], {type: 'application/json'});
            if (navigator.sendBeacon) {
                navigator.sendBeacon(`/notes/api/pages/${currentPageId}`, blob);
            }
        }
    }
});

// ─────────────────────────────────────────────────────────────
// Kategori & Sayfa Sürükle Bırak (Drag & Drop)
// ─────────────────────────────────────────────────────────────

function initSidebarDragAndDrop() {
    // 1. Sayfa Sürükleme (Yukarı/Aşağı ve Dosyalar Arası)
    const pageItems = document.querySelectorAll('.page-item');
    pageItems.forEach(item => {
        item.setAttribute('draggable', 'true');

        item.addEventListener('dragstart', (e) => {
            if (e.target.closest('.page-item-actions')) {
                e.preventDefault();
                return;
            }
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
                showToast("Sayfa yeni dosyaya aktarıldı!");
            } else {
                showToast("Sayfa sırası güncellendi!");
            }
        });
    });

    // 2. Dosya Başlığına ve Listesine Bırakma (Sayfayı Doğrudan Dosyaya Aktarma)
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

            // Dosya kapalıysa aç
            const group = document.getElementById(`cat-group-${targetCatId}`);
            if (group && group.classList.contains('collapsed')) {
                group.classList.remove('collapsed');
                saveCategoryCollapsedState(targetCatId, false);
            }

            // Sayfayı bu dosyanın sonuna ekle
            targetPageList.appendChild(draggedPage);
            const isCatChanged = (sourceCatId != targetCatId);
            draggedPage.dataset.categoryId = targetCatId;

            await persistPageOrder(targetCatId);
            if (isCatChanged) {
                await persistPageOrder(sourceCatId);
                updateCategoryBadges(sourceCatId, targetCatId);
                showToast("Sayfa yeni dosyaya aktarıldı!");
            }
        });
    });

    // Boş veya açık liste alanına sayfa bırakma
    const pageLists = document.querySelectorAll('.page-list');
    pageLists.forEach(list => {
        list.addEventListener('dragover', (e) => {
            if (!draggedPage) return;
            if (e.target === list) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            }
        });
        list.addEventListener('drop', async (e) => {
            if (!draggedPage) return;
            if (e.target === list || !e.target.closest('.page-item')) {
                e.preventDefault();
                e.stopPropagation();
                clearDropIndicators();
                const targetCatId = list.dataset.categoryId;
                list.appendChild(draggedPage);
                const isCatChanged = (sourceCatId != targetCatId);
                draggedPage.dataset.categoryId = targetCatId;
                await persistPageOrder(targetCatId);
                if (isCatChanged) {
                    await persistPageOrder(sourceCatId);
                    updateCategoryBadges(sourceCatId, targetCatId);
                    showToast("Sayfa yeni dosyaya aktarıldı!");
                } else {
                    showToast("Sayfa sırası güncellendi!");
                }
            }
        });
    });

    // 3. Dosya & Ayraç Sıralama (Dosyaları ve ayraçları yukarı/aşağı taşıma)
    const catGroups = document.querySelectorAll('.category-group, .category-divider-item');
    catGroups.forEach(group => {
        const handle = group.querySelector('.cat-drag-handle');
        if (handle) {
            handle.addEventListener('mousedown', () => {
                group.setAttribute('draggable', 'true');
            });
        }

        group.addEventListener('dragstart', (e) => {
            if (draggedPage) return;
            if (e.target.closest('.page-list') || e.target.closest('.category-actions')) {
                e.preventDefault();
                return;
            }
            isDraggingAny = true;
            draggedCat = group;
            group.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', group.dataset.categoryId);
        });

        group.addEventListener('dragend', () => {
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
            showToast("Dosya sırası güncellendi!");
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
    const catIds = Array.from(container.querySelectorAll('.category-group, .category-divider-item')).map(el => parseInt(el.dataset.categoryId)).filter(Boolean);
    try {
        await fetch('/notes/api/categories/reorder', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({category_ids: catIds})
        });
    } catch (e) {
        console.error("Dosya sırası kaydetme hatası:", e);
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

// Mobil Çekmece (Drawer) Kontrolleri
function toggleMobileSidebar() {
    const sidebar = document.getElementById('tnote-sidebar');
    if (!sidebar) return;
    if (sidebar.classList.contains('mobile-open')) {
        closeMobileSidebar();
    } else {
        openMobileSidebar();
    }
}

function openMobileSidebar() {
    const sidebar = document.getElementById('tnote-sidebar');
    const backdrop = document.getElementById('tnote-sidebar-backdrop');
    if (sidebar) sidebar.classList.add('mobile-open');
    if (backdrop) backdrop.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeMobileSidebar() {
    const sidebar = document.getElementById('tnote-sidebar');
    const backdrop = document.getElementById('tnote-sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (backdrop) backdrop.classList.remove('active');
    document.body.style.overflow = '';
}

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// HIZLI NOTLAR & GÖREVLER (HIZLI ALAN & BİRLEŞİK GÖREVLER)
// ─────────────────────────────────────────────────────────────

let webQuickNotesDebounce = null;

async function loadQuickTasksPage() {
    closeMobileSidebar();
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
    if (titleEl) titleEl.textContent = 'Hızlı Görevler';
    if (iconEl) iconEl.innerHTML = '<svg class="svg-icon svg-icon-md"><use href="#i-zap"/></svg>';
    if (badgeEl) {
        badgeEl.textContent = '';
        badgeEl.style.display = 'none';
    }

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
                    notesListEl.innerHTML = `<div style="padding:14px; text-align:center; color:var(--muted); font-size:0.82rem;">Not yok</div>`;
                } else {
                    notesListEl.innerHTML = notes.map(n => {
                        const dateStr = n.created_at ? n.created_at.slice(5, 16) : '';
                        return `
                            <div class="ov-item-row" style="background:var(--surface, #fff); border:1px solid var(--border); border-radius:6px; padding:6px 10px; display:flex; flex-direction:column; gap:4px; margin-bottom:4px;">
                                <div style="font-size:0.83rem; color:var(--text); white-space:pre-wrap; word-break:break-word; line-height:1.35; cursor:pointer;" onclick="openQuickNoteDetail(${n.id}, ${JSON.stringify(n.content).replace(/"/g, '&quot;')}, '${dateStr}')">${escapeHtml(n.content)}</div>
                                <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid #f1f5f9; padding-top:4px; margin-top:2px;">
                                    <span style="font-size:0.68rem; color:var(--muted); opacity:0.85;">${escapeHtml(dateStr)}</span>
                                    <div style="display:flex; gap:4px;">
                                        <button class="btn-icon-subtle" onclick="openTransferQuickNoteModal(${n.id}, ${JSON.stringify(n.content).replace(/"/g, '&quot;')})" title="Sayfaya Aktar" style="padding:2px 4px;">
                                            <svg class="svg-icon svg-icon-xs"><use href="#i-folder"/></svg>
                                        </button>
                                        <button class="btn-icon-subtle btn-danger-hover" onclick="deleteWebQuickNote(${n.id})" title="Sil" style="padding:2px 4px; color:var(--danger, #ef4444);">
                                            <svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg>
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
        const directTasks = tasks.filter(t => t.due_urgency === 2.5 || (t.due_badge && t.due_badge.includes('Hızlı')));
        const generalTasks = tasks.filter(t => t.due_urgency !== 2.5 && (!t.due_badge || !t.due_badge.includes('Hızlı')));

        if (directCountEl) directCountEl.textContent = directTasks.length;
        if (badge) badge.textContent = generalTasks.length;
        if (sideBadge) sideBadge.textContent = tasks.length;

        // A) Doğrudan Hızlı Görevler Listesi
        if (directListEl) {
            const activeDirect = directTasks.filter(t => !t.is_done);
            const completedDirect = directTasks.filter(t => t.is_done);

            if (directTasks.length === 0) {
                directListEl.innerHTML = `<div style="padding:14px; text-align:center; color:var(--muted); font-size:0.82rem;">Görev yok</div>`;
            } else {
                let html = '';
                if (activeDirect.length === 0) {
                    html += `<div style="padding:14px; text-align:center; color:var(--muted); font-size:0.82rem;">Tüm aktif görevler tamamlandı 🎉</div>`;
                } else {
                    html += activeDirect.map(t => renderWebDirectTaskRow(t)).join('');
                }

                if (completedDirect.length > 0) {
                    html += `
                        <div class="completed-accordion-header" onclick="toggleWebCompletedTasks()" style="margin-top:10px; cursor:pointer; user-select:none; display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:var(--surface2, #f1f5f9); border:1px solid var(--border); border-radius:6px; font-size:0.78rem; font-weight:700; color:var(--muted);">
                            <span>${window.showWebCompletedTasks ? '▾' : '▸'} ${completedDirect.length} Tamamlanan Görev</span>
                            <span style="font-size:0.72rem; opacity:0.8;">${window.showWebCompletedTasks ? 'Gizle' : 'Göster'}</span>
                        </div>
                        <div id="web-completed-direct-list" style="display:${window.showWebCompletedTasks ? 'block' : 'none'}; margin-top:4px;">
                            ${completedDirect.map(t => renderWebDirectTaskRow(t)).join('')}
                        </div>
                    `;
                }
                directListEl.innerHTML = html;
            }
        }

        // B) Diğer Sayfa ve Kategorilerden Gelen Görevler & Ödemeler
        if (container) {
            if (generalTasks.length === 0) {
                container.innerHTML = `<div style="padding:16px; text-align:center; color:var(--muted); font-size:0.82rem;">Bekleyen görev veya ödeme yok</div>`;
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
                        <div class="ov-item-row" id="web-unified-task-${t.id}" onclick="loadPage(${t.page_id})" style="cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; background:var(--surface, #fff); border:1px solid var(--border, #e2e8f0); border-radius:6px; margin-bottom:4px;" title="${escapeHtml(t.page_title)} sayfasına git">
                            <div class="ov-item-left" style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
                                <input type="checkbox" ${t.is_done ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleWebUnifiedTask('${t.type}', ${t.raw_id}, this)" style="cursor:pointer; width:15px; height:15px; flex-shrink:0;" title="${t.is_done ? 'Tamamlanmadı yap' : 'Tamamla'}">
                                <span class="ov-item-text" style="font-size:0.83rem; font-weight:500; color:var(--text, #1e293b); ${t.is_done ? 'text-decoration:line-through; opacity:0.5;' : ''}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
                            </div>
                            <div class="ov-item-meta" style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                                ${t.due_badge ? `<span style="background:${badgeBg}; color:${badgeColor}; font-size:0.70rem; font-weight:600; padding:2px 6px; border-radius:4px;">${escapeHtml(t.due_badge)}</span>` : ''}
                                <span class="ov-page-tag" onclick="event.stopPropagation(); loadPage(${t.page_id})" title="${escapeHtml(t.page_title)} sayfasına git">${escapeHtml(t.page_title)}</span>
                                <button class="btn-icon-subtle btn-danger-hover" onclick="event.stopPropagation(); deleteUnifiedTask('${t.type}', ${t.raw_id})" title="Sil" style="padding:2px 4px; color:var(--danger, #ef4444);"><svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg></button>
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

window.showWebCompletedTasks = false;

function toggleWebCompletedTasks() {
    window.showWebCompletedTasks = !window.showWebCompletedTasks;
    const container = document.getElementById('web-completed-direct-list');
    const header = document.querySelector('.completed-accordion-header span');
    if (container) {
        container.style.display = window.showWebCompletedTasks ? 'block' : 'none';
    }
    if (header) {
        const count = container ? container.querySelectorAll('.ov-item-row').length : 0;
        header.innerHTML = `${window.showWebCompletedTasks ? '▾' : '▸'} ${count} Tamamlanan Görev`;
    }
}

function renderWebDirectTaskRow(t) {
    return `
        <div class="ov-item-row" id="web-unified-task-${t.id}" style="cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; background:var(--surface, #fff); border:1px solid var(--border, #e2e8f0); border-radius:6px; margin-bottom:4px;" onclick="editUnifiedTask('${t.type}', ${t.raw_id}, ${JSON.stringify(t.title).replace(/"/g, '&quot;')})" title="Düzenlemek için tıklayın">
            <div class="ov-item-left" style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
                <input type="checkbox" ${t.is_done ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleWebUnifiedTask('${t.type}', ${t.raw_id}, this)" style="cursor:pointer; width:15px; height:15px; flex-shrink:0;" title="${t.is_done ? 'Tamamlanmadı yap' : 'Tamamla'}">
                <span class="ov-item-text" style="font-size:0.83rem; font-weight:500; color:var(--text, #1e293b); ${t.is_done ? 'text-decoration:line-through; opacity:0.5;' : ''}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
            </div>
            <div class="ov-item-meta" style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                <span style="background:#e0f2fe; color:#0284c7; font-size:0.70rem; font-weight:600; padding:2px 6px; border-radius:4px;">Hızlı</span>
                <button class="btn-icon-subtle btn-danger-hover" onclick="event.stopPropagation(); deleteUnifiedTask('${t.type}', ${t.raw_id})" title="Sil" style="padding:2px 4px; color:var(--danger, #ef4444);"><svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg></button>
            </div>
        </div>
    `;
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

async function editUnifiedTask(taskType, rawId, currentTitle) {
    const newTitle = prompt('Görevi düzenle:', currentTitle);
    if (!newTitle || newTitle.trim() === '' || newTitle.trim() === currentTitle) return;

    try {
        if (taskType === 'finance') {
            await fetch(`/notes/api/finance/${rawId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: newTitle.trim() })
            });
        } else {
            await fetch(`/notes/api/items/${rawId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: newTitle.trim() })
            });
        }
        await renderWebQuickTasks();
    } catch (e) {
        console.error("editUnifiedTask error:", e);
    }
}

async function deleteUnifiedTask(taskType, rawId) {
    if (!confirm('Bu görevi silmek istediğinize emin misiniz?')) return;
    try {
        if (taskType === 'finance') {
            await fetch(`/notes/api/finance/${rawId}`, { method: 'DELETE' });
        } else {
            await fetch(`/notes/api/items/${rawId}`, { method: 'DELETE' });
        }
        await renderWebQuickTasks();
    } catch (e) {
        console.error("deleteUnifiedTask error:", e);
    }
}

async function deleteWebQuickTask(rawId) {
    await deleteUnifiedTask('checklist', rawId);
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
    closeMobileSidebar();
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
    if (titleEl) titleEl.textContent = 'Genel Bakış';
    if (iconEl) iconEl.innerHTML = '<svg class="svg-icon svg-icon-md"><use href="#i-home"/></svg>';
    if (badgeEl) {
        badgeEl.textContent = '';
        badgeEl.style.display = 'none';
    }

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
        loadOverviewQuickNotes();
    } catch (e) {
        console.error("Genel bakış yükleme hatası:", e);
    }
}

async function loadOverviewQuickNotes() {
    const listEl = document.getElementById('ov-quick-notes-list');
    if (!listEl) return;
    try {
        const res = await fetch('/notes/api/quick-notes');
        const data = await res.json();
        if (!data.ok || !data.notes || data.notes.length === 0) {
            listEl.innerHTML = `<div style="padding:10px; text-align:center; color:var(--muted); font-size:0.78rem;">Kayıtlı hızlı not yok</div>`;
            return;
        }
        listEl.innerHTML = data.notes.slice(0, 5).map(n => {
            const dateStr = n.created_at ? n.created_at.slice(0, 16) : '';
            return `
            <div class="ov-quicknote-row" onclick="openQuickNoteDetail(${n.id}, ${JSON.stringify(n.content).replace(/"/g, '&quot;')}, '${dateStr}')" title="Görüntülemek veya düzenlemek için tıklayın">
                <span class="ov-quicknote-text">${escapeHtml(n.content)}</span>
                <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                    <button class="btn-icon-subtle" onclick="event.stopPropagation(); openQuickNoteDetail(${n.id}, ${JSON.stringify(n.content).replace(/"/g, '&quot;')}, '${dateStr}')" title="Düzenle" style="padding:2px 4px; color:var(--text-muted);">
                        <svg class="svg-icon svg-icon-xs"><use href="#i-edit"/></svg>
                    </button>
                    <button class="btn-icon-subtle" onclick="event.stopPropagation(); openTransferQuickNoteModal(${n.id}, ${JSON.stringify(n.content).replace(/"/g, '&quot;')})" title="Sayfaya Aktar" style="padding:2px 4px; color:var(--text-muted);">
                        <svg class="svg-icon svg-icon-xs"><use href="#i-folder"/></svg>
                    </button>
                    <button class="btn-icon-subtle btn-danger-hover" onclick="event.stopPropagation(); deleteOverviewQuickNote(${n.id})" title="Sil" style="padding:2px 4px; color:var(--danger, #ef4444);">
                        <svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg>
                    </button>
                </div>
            </div>
            `;
        }).join('');
    } catch (e) {
        console.warn("loadOverviewQuickNotes error:", e);
    }
}

async function submitOverviewQuickNote() {
    const input = document.getElementById('ov-quick-note-input');
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;
    try {
        const res = await fetch('/notes/api/quick-notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        const data = await res.json();
        if (data.ok) {
            input.value = '';
            loadOverviewQuickNotes();
            if (typeof renderWebQuickTasks === 'function') renderWebQuickTasks();
            if (typeof showToast === 'function') showToast("Hızlı not kaydedildi");
        }
    } catch (e) {
        console.error("submitOverviewQuickNote error:", e);
    }
}

async function deleteOverviewQuickNote(id) {
    if (!confirm('Bu hızlı notu silmek istediğinize emin misiniz?')) return;
    try {
        const res = await fetch(`/notes/api/quick-notes/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
            loadOverviewQuickNotes();
            if (typeof renderWebQuickTasks === 'function') renderWebQuickTasks();
            if (typeof showToast === 'function') showToast("Not silindi");
        }
    } catch (e) {
        console.error("deleteOverviewQuickNote error:", e);
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
    const tasksBarEl = document.getElementById('ov-tasks-bar-fill') || document.getElementById('ov-tasks-bar');

    if (tasksTotalEl) tasksTotalEl.textContent = totalItems;
    if (tasksSubEl) tasksSubEl.textContent = `${pendingItems} bekleyen`;
    if (tasksBadgeEl) {
        if (totalItems > 0) {
            tasksBadgeEl.textContent = `%${taskPct}`;
            tasksBadgeEl.style.display = 'inline-block';
        } else {
            tasksBadgeEl.style.display = 'none';
        }
    }
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
    const fBarEl = document.getElementById('ov-finance-bar-fill') || document.getElementById('ov-finance-bar');
    const fPeriodEl = document.getElementById('ov-finance-period');

    if (fNetEl) {
        if (net > 0) {
            fNetEl.textContent = '+' + net.toLocaleString('tr-TR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' TL';
            fNetEl.style.color = 'var(--text, #0f172a)';
        } else if (net < 0) {
            fNetEl.textContent = net.toLocaleString('tr-TR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' TL';
            fNetEl.style.color = 'var(--danger, #dc2626)';
        } else {
            fNetEl.textContent = '0,00 TL';
            fNetEl.style.color = 'var(--text-secondary, #64748b)';
        }
    }
    if (fSubEl) {
        if (income === 0 && expense === 0) {
            fSubEl.textContent = 'Kayıt yok';
        } else {
            fSubEl.textContent = `+${income.toLocaleString('tr-TR')} / -${expense.toLocaleString('tr-TR')} TL`;
        }
    }
    if (fPeriodEl) fPeriodEl.textContent = f.period || 'Bu Ay';
    if (fBarEl) {
        const fRatio = (income + expense) > 0 ? Math.min(100, Math.round((expense / (income || 1)) * 100)) : 0;
        fBarEl.style.width = `${Math.min(100, fRatio)}%`;
        if (net > 0) {
            fBarEl.style.background = 'var(--primary, #0284c7)';
        } else if (net < 0) {
            fBarEl.style.background = 'var(--danger, #dc2626)';
        } else {
            fBarEl.style.background = 'var(--border, #e2e8f0)';
        }
    }

    // Bekleyen Faturalar
    const billsTotalEl = document.getElementById('ov-bills-total');
    const billsSubEl = document.getElementById('ov-bills-sub');
    const billsTagEl = document.getElementById('ov-bills-count-tag');

    if (billsTotalEl) billsTotalEl.textContent = unpaid.toLocaleString('tr-TR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' TL';
    if (billsSubEl) billsSubEl.textContent = unpaidCount > 0 ? `${unpaidCount} bekleyen` : 'Bekleyen fatura yok';
    if (billsTagEl) {
        if (unpaidCount > 0) {
            billsTagEl.textContent = unpaidCount;
            billsTagEl.style.display = 'inline-block';
            billsTagEl.className = 'kpi-tag kpi-badge-amber';
            billsTagEl.style.background = '#fef3c7';
            billsTagEl.style.color = '#d97706';
        } else {
            billsTagEl.style.display = 'none';
        }
    }

    // Projeler
    const projects = ov.projects || [];
    const projTotalEl = document.getElementById('ov-projects-total');
    const projSubEl = document.getElementById('ov-projects-sub');
    const projTagEl = document.getElementById('ov-proj-count-tag');

    if (projTotalEl) projTotalEl.textContent = projects.length;
    if (projSubEl) projSubEl.textContent = projects.length > 0 ? `${projects.length} aktif` : 'Aktif proje yok';
    if (projTagEl) {
        if (projects.length > 0) {
            projTagEl.textContent = projects.length;
            projTagEl.style.display = 'inline-block';
            projTagEl.className = 'kpi-tag kpi-badge-purple';
            projTagEl.style.background = '#f3e8ff';
            projTagEl.style.color = '#9333ea';
        } else {
            projTagEl.style.display = 'none';
        }
    }

    // 2. Bekleyen Görevler Listesi (Modern 2-Line Task Cards)
    const pendingContainer = document.getElementById('ov-pending-items-container');
    const pendingBadge = document.getElementById('ov-pending-count-badge');
    if (pendingBadge) pendingBadge.textContent = (ov.pending_tasks || []).length;

    if (pendingContainer) {
        if (!ov.pending_tasks || ov.pending_tasks.length === 0) {
            pendingContainer.innerHTML = `
                <div class="empty-state-modern">
                    <svg class="svg-icon empty-state-icon"><use href="#i-check-square"/></svg>
                    <span class="empty-state-text">Bekleyen görev bulunmuyor</span>
                    <button class="empty-state-action" onclick="openAddPageModal()">
                        <svg class="svg-icon svg-icon-xs"><use href="#i-plus"/></svg> Yeni Liste Başlat
                    </button>
                </div>`;
        } else {
            pendingContainer.innerHTML = ov.pending_tasks.map(it => `
                <div class="ov-item-row" id="ov-task-${it.id}" onclick="loadPage(${it.page_id})" style="cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; background:var(--surface, #fff); border:1px solid var(--border, #e2e8f0); border-radius:6px; margin-bottom:4px;" title="${escapeHtml(it.page_title)} listesine git">
                    <div class="ov-item-left" style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
                        <input type="checkbox" class="ov-task-checkbox" onclick="event.stopPropagation()" onchange="toggleTaskFromOverview(${it.id}, this)" style="cursor:pointer; width:15px; height:15px; flex-shrink:0;">
                        <span class="ov-item-text" style="font-size:0.83rem; font-weight:500; color:var(--text, #1e293b); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</span>
                    </div>
                    <div class="ov-item-meta" style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                        <span class="ov-page-tag" onclick="event.stopPropagation(); loadPage(${it.page_id})" title="${escapeHtml(it.page_title)} listesine git">
                            ${escapeHtml(it.page_title)}
                        </span>
                        <button class="btn-icon-subtle" onclick="event.stopPropagation(); editTaskFromOverview(${it.id}, ${JSON.stringify(it.title).replace(/"/g, '&quot;')})" title="Düzenle" style="padding:2px 4px; color:var(--text-muted);">
                            <svg class="svg-icon svg-icon-xs"><use href="#i-edit"/></svg>
                        </button>
                        <button class="btn-icon-subtle btn-danger-hover" onclick="event.stopPropagation(); deleteTaskFromOverview(${it.id})" title="Sil" style="padding:2px 4px; color:var(--danger, #ef4444);">
                            <svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg>
                        </button>
                    </div>
                </div>
            `).join('');
        }
    }

    // 3. Vadesi Yaklaşan Faturalar & Ödemeler (Modern Empty Notice)
    const billsContainer = document.getElementById('ov-upcoming-bills-container');
    if (billsContainer) {
        if (!ov.upcoming_bills || ov.upcoming_bills.length === 0) {
            billsContainer.innerHTML = `
                <div class="empty-state-modern">
                    <svg class="svg-icon empty-state-icon"><use href="#i-calendar"/></svg>
                    <span class="empty-state-text">Bu ay bekleyen ödeme veya fatura yok</span>
                    <button class="empty-state-action" onclick="jumpToFinancePage()">
                        <svg class="svg-icon svg-icon-xs"><use href="#i-plus"/></svg> Finans Takibine Git
                    </button>
                </div>`;
        } else {
            billsContainer.innerHTML = ov.upcoming_bills.map(b => `
                <div class="ov-bill-row" onclick="loadPage(${b.page_id})" title="${escapeHtml(b.page_title)} sayfasına git" style="cursor:pointer;">
                    <div class="ov-bill-left">
                        <span class="ov-bill-day">Gün ${b.due_day}</span>
                        <div>
                            <div class="ov-bill-title">${escapeHtml(b.title)}</div>
                            <div style="font-size:0.72rem; color:var(--muted);">${escapeHtml(b.category || 'Genel')} • ${escapeHtml(b.page_title)}</div>
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
                <div class="empty-state-modern">
                    <svg class="svg-icon empty-state-icon"><use href="#i-layers"/></svg>
                    <span class="empty-state-text">Henüz aktif bir proje bulunmuyor</span>
                    <button class="empty-state-action" onclick="openAddProjectModal()">
                        <svg class="svg-icon svg-icon-xs"><use href="#i-plus"/></svg> Yeni Proje Başlat
                    </button>
                </div>`;
        } else {
            projContainer.innerHTML = projects.map(p => `
                <div class="ov-project-row" onclick="loadPage(${p.id})">
                    <div class="ov-proj-header">
                        <span class="ov-proj-title"><svg class="svg-icon svg-icon-xs" style="vertical-align:text-bottom; margin-right:4px; color:var(--purple, #8b5cf6);"><use href="#i-layers"/></svg>${escapeHtml(p.title)}</span>
                        <span class="ov-proj-pct">%${p.progress || 0}</span>
                    </div>
                    <div class="ov-progress-track">
                        <div class="ov-progress-fill" style="width:${p.progress || 0}%; background:#8b5cf6;"></div>
                    </div>
                </div>
            `).join('');
        }
    }

    // 5. Son Kullanılan Sayfalar (Opsiyonel)
    const recentContainer = document.getElementById('ov-recent-pages-container');
    if (recentContainer) {
        const pages = ov.recent_pages || [];
        if (pages.length === 0) {
            recentContainer.innerHTML = `<div class="empty-state-slim">Sayfa yok</div>`;
        } else {
            recentContainer.innerHTML = pages.map(p => `
                <div class="ov-recent-row" onclick="loadPage(${p.id})">
                    <div class="ov-recent-left">
                        <svg class="svg-icon svg-icon-xs" style="margin-right:6px; color:var(--muted);"><use href="#i-file-text"/></svg>
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
                    loadOverviewPage();
                    if (typeof renderWebQuickTasks === 'function') renderWebQuickTasks();
                }, 350);
            }
        }
    } catch (e) {
        console.error("Görev güncelleme hatası:", e);
    }
}

async function editTaskFromOverview(itemId, currentTitle) {
    const newTitle = prompt('Görevi düzenle:', currentTitle);
    if (!newTitle || newTitle.trim() === '' || newTitle.trim() === currentTitle) return;
    try {
        const res = await fetch(`/notes/api/items/${itemId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ title: newTitle.trim() })
        });
        const data = await res.json();
        if (data.ok) {
            loadOverviewPage();
            if (typeof renderWebQuickTasks === 'function') renderWebQuickTasks();
        }
    } catch(e) {
        console.error("editTaskFromOverview error:", e);
    }
}

async function deleteTaskFromOverview(itemId) {
    if (!confirm('Bu görevi silmek istediğinize emin misiniz?')) return;
    try {
        const res = await fetch(`/notes/api/items/${itemId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
            const row = document.getElementById(`ov-task-${itemId}`);
            if (row) row.remove();
            loadOverviewPage();
            if (typeof renderWebQuickTasks === 'function') renderWebQuickTasks();
        }
    } catch(e) {
        console.error("deleteTaskFromOverview error:", e);
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
    closeMobileSidebar();
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

        const lockedView = document.getElementById('note-locked-view');
        const unlockedWrap = document.getElementById('note-unlocked-content-wrap');

        if (data.requires_unlock) {
            if (lockedView) lockedView.style.display = 'block';
            if (unlockedWrap) unlockedWrap.style.display = 'none';
            const checklistArea = document.getElementById('checklist-view');
            const noteArea = document.getElementById('note-view');
            const financeArea = document.getElementById('finance-view');
            const projectArea = document.getElementById('project-view');
            const softwareArea = document.getElementById('software-view');
            if (checklistArea) checklistArea.style.display = 'none';
            if (financeArea) financeArea.style.display = 'none';
            if (projectArea) projectArea.style.display = 'none';
            if (softwareArea) softwareArea.style.display = 'none';
            if (noteArea) noteArea.style.display = 'block';
            const pinInp = document.getElementById('locked-page-pin-input');
            if (pinInp) { pinInp.value = ''; pinInp.focus(); }
            return;
        } else {
            if (lockedView) lockedView.style.display = 'none';
            if (unlockedWrap) unlockedWrap.style.display = 'block';
        }

        if (currentPageData.type === 'notes') {
            renderNoteEditor();
            loadAttachmentsList();
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
    if (iconEl) {
        const typeIcons = {
            'checklist': '#i-check-square',
            'notes': '#i-file-text',
            'finance': '#i-credit-card',
            'project': '#i-layers'
        };
        if (currentPageData.icon && currentPageData.icon !== '📝' && currentPageData.icon !== '📄' && currentPageData.icon !== '📋') {
            iconEl.innerHTML = `<span style="font-size:1.15rem;">${escapeHtml(currentPageData.icon)}</span>`;
        } else {
            const svgHref = typeIcons[currentPageData.type] || '#i-file-text';
            iconEl.innerHTML = `<svg class="svg-icon svg-icon-md"><use href="${svgHref}"/></svg>`;
        }
    }

    const pinBtn = document.getElementById('btn-header-pin');
    if (pinBtn) {
        if (currentPageData.is_pinned) {
            pinBtn.style.color = 'var(--warning, #f59e0b)';
            pinBtn.title = 'Sabitlendi (Kaldırmak için tıkla)';
        } else {
            pinBtn.style.color = '';
            pinBtn.title = 'Başa Sabitle';
        }
    }
    const lockBtn = document.getElementById('btn-header-lock');
    if (lockBtn) {
        if (currentPageData.is_locked) {
            lockBtn.style.color = 'var(--danger, #ef4444)';
            lockBtn.title = 'Kilitli (PIN korumalı)';
        } else {
            lockBtn.style.color = '';
            lockBtn.title = 'Kilitle / PIN Belirle';
        }
    }

    const checklistArea = document.getElementById('checklist-view');
    const noteArea = document.getElementById('note-view');
    const financeArea = document.getElementById('finance-view');
    const projectArea = document.getElementById('project-view');
    const softwareArea = document.getElementById('software-view');
    const quickAddBox = document.getElementById('quick-add-container');

    const btnBulkAdd = document.getElementById('btn-bulk-add');
    const btnClearDone = document.getElementById('btn-clear-done');
    const btnResetList = document.getElementById('btn-reset-list');

    if (currentPageData.type === 'notes') {
        if (checklistArea) checklistArea.style.display = 'none';
        if (financeArea) financeArea.style.display = 'none';
        if (projectArea) projectArea.style.display = 'none';
        if (softwareArea) softwareArea.style.display = 'none';
        if (quickAddBox) quickAddBox.style.display = 'none';
        if (noteArea) noteArea.style.display = 'block';
        if (btnBulkAdd) btnBulkAdd.style.display = 'none';
        if (btnClearDone) btnClearDone.style.display = 'none';
        if (btnResetList) btnResetList.style.display = 'none';
        if (badgeEl) badgeEl.textContent = 'Not';
    } else if (currentPageData.type === 'finance') {
        if (checklistArea) checklistArea.style.display = 'none';
        if (noteArea) noteArea.style.display = 'none';
        if (projectArea) projectArea.style.display = 'none';
        if (softwareArea) softwareArea.style.display = 'none';
        if (quickAddBox) quickAddBox.style.display = 'none';
        if (financeArea) financeArea.style.display = 'flex';
        if (btnBulkAdd) btnBulkAdd.style.display = 'none';
        if (btnClearDone) btnClearDone.style.display = 'none';
        if (btnResetList) btnResetList.style.display = 'none';
        if (badgeEl) badgeEl.textContent = 'Finans';
    } else if (currentPageData.type === 'project') {
        if (checklistArea) checklistArea.style.display = 'none';
        if (noteArea) noteArea.style.display = 'none';
        if (financeArea) financeArea.style.display = 'none';
        if (softwareArea) softwareArea.style.display = 'none';
        if (quickAddBox) quickAddBox.style.display = 'none';
        if (projectArea) projectArea.style.display = 'flex';
        if (btnBulkAdd) btnBulkAdd.style.display = 'none';
        if (btnClearDone) btnClearDone.style.display = 'none';
        if (btnResetList) btnResetList.style.display = 'none';
        if (badgeEl) badgeEl.textContent = 'Proje';
    } else if (currentPageData.type === 'software') {
        if (checklistArea) checklistArea.style.display = 'none';
        if (noteArea) noteArea.style.display = 'none';
        if (financeArea) financeArea.style.display = 'none';
        if (projectArea) projectArea.style.display = 'none';
        if (quickAddBox) quickAddBox.style.display = 'none';
        if (softwareArea) softwareArea.style.display = 'flex';
        if (btnBulkAdd) btnBulkAdd.style.display = 'none';
        if (btnClearDone) btnClearDone.style.display = 'none';
        if (btnResetList) btnResetList.style.display = 'none';
        if (badgeEl) badgeEl.textContent = 'Yazılım';
        renderSoftwareViewWeb(currentPageData.id);
    } else {
        if (noteArea) noteArea.style.display = 'none';
        if (financeArea) financeArea.style.display = 'none';
        if (projectArea) projectArea.style.display = 'none';
        if (softwareArea) softwareArea.style.display = 'none';
        if (checklistArea) checklistArea.style.display = 'block';
        if (quickAddBox) quickAddBox.style.display = 'flex';
        if (btnBulkAdd) btnBulkAdd.style.display = 'inline-block';
        if (btnClearDone) btnClearDone.style.display = 'inline-block';
        if (btnResetList) btnResetList.style.display = 'inline-block';
        const pendingCount = currentItems.filter(i => !i.is_done).length;
        if (badgeEl) badgeEl.textContent = `${pendingCount}/${currentItems.length}`;
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

    const pendingItems = filtered.filter(item => !item.is_done);
    const doneItems = filtered.filter(item => item.is_done);

    function createItemElement(item) {
        const li = document.createElement('li');
        li.className = `item-card ${item.is_done ? 'done' : ''}`;
        li.dataset.itemId = item.id;

        let metaHtml = '';
        if (item.price) metaHtml += `<span class="tag-price">${escapeHtml(item.price)}</span>`;
        if (item.quantity) metaHtml += `<span class="tag-qty">${escapeHtml(item.quantity)}</span>`;
        if (item.remind_at) {
            metaHtml += `<span class="tag-reminder">${item.remind_at.substring(5, 16)}</span>`;
        }
        if (item.url) {
            metaHtml += `<a href="${sanitizeUrl(item.url)}" target="_blank" rel="noopener noreferrer" class="tag-link" onclick="event.stopPropagation()">Link</a>`;
        }

        let actionsHtml = `
            <button class="btn-icon-subtle" title="Hatırlatıcı Kur" onclick="event.stopPropagation(); openReminderModalById(${item.id})"><svg class="svg-icon svg-icon-xs"><use href="#i-clock"/></svg></button>
        `;
        if (item.url) {
            actionsHtml += `<a href="${sanitizeUrl(item.url)}" target="_blank" rel="noopener noreferrer" class="btn-icon-subtle" title="Web Linkini Aç" onclick="event.stopPropagation()"><svg class="svg-icon svg-icon-xs"><use href="#i-file-text"/></svg></a>`;
        }
        actionsHtml += `<button class="btn-icon-subtle btn-danger-hover" title="Maddeyi Sil" onclick="event.stopPropagation(); deleteItem(${item.id})"><svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg></button>`;

        const thumbHtml = item.image_url ? `<img src="${sanitizeUrl(item.image_url)}" class="item-thumb" alt="thumb">` : '';

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
                <input type="checkbox" class="item-checkbox" ${item.is_done ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleItemDone(${item.id}, this.checked)">
                ${thumbHtml}
                <div class="item-content" onclick="openEditItemModal(${item.id})" style="cursor:pointer;" title="Düzenlemek için tıklayın">
                    <div class="item-title">${escapeHtml(item.title)}</div>
                    ${metaHtml ? `<div class="item-meta">${metaHtml}</div>` : ''}
                </div>
            </div>
            <div class="item-actions">
                ${actionsHtml}
            </div>
        `;
        return li;
    }

    // Aktif maddeleri ekle
    pendingItems.forEach(item => {
        listEl.appendChild(createItemElement(item));
    });

    // Tamamlanan maddeleri akordeon içine ekle
    if (doneItems.length > 0) {
        const accHeader = document.createElement('li');
        accHeader.className = 'completed-accordion-header';
        accHeader.style.cssText = 'list-style:none; margin:14px 0 6px; padding:8px 12px; background:var(--surface2, #f1f5f9); border:1px solid var(--border, #e2e8f0); border-radius:6px; display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; font-weight:700; color:var(--muted); cursor:pointer; user-select:none;';
        accHeader.innerHTML = `
            <span>${window.showWebPageCompleted ? '▾' : '▸'} ${doneItems.length} Tamamlanan Görev</span>
            <span style="font-size:0.72rem; opacity:0.8;">${window.showWebPageCompleted ? 'Gizle' : 'Göster'}</span>
        `;
        accHeader.onclick = () => {
            window.showWebPageCompleted = !window.showWebPageCompleted;
            renderChecklist();
        };
        listEl.appendChild(accHeader);

        if (window.showWebPageCompleted) {
            doneItems.forEach(item => {
                listEl.appendChild(createItemElement(item));
            });
        }
    }
}

function renderMarkdownToHtml(md) {
    if (!md || !md.trim()) return '<p style="color:var(--muted); font-style:italic;">İçerik boş. Düzenlemek için "Düzenle" moduna geçin.</p>';
    let html = escapeHtml(md);
    html = html.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/g, '<pre class="md-code-block"><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
    html = html.replace(/^### (.*$)/gim, '<h3 class="md-h3">$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2 class="md-h2">$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1 class="md-h1">$1</h1>');
    html = html.replace(/^\> (.*$)/gim, '<blockquote class="md-quote">$1</blockquote>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/^- \[x\] (.*$)/gim, '<div class="md-task-item"><input type="checkbox" checked disabled> <span style="text-decoration:line-through; opacity:0.6;">$1</span></div>');
    html = html.replace(/^- \[ \] (.*$)/gim, '<div class="md-task-item"><input type="checkbox" disabled> <span>$1</span></div>');
    html = html.replace(/^- (.*$)/gim, '<li class="md-li">$1</li>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    return '<div class="md-rendered-body"><p>' + html + '</p></div>';
}

function updateNoteStats() {
    const editor = document.getElementById('note-rich-editor');
    const ta = document.getElementById('note-content-textarea');
    const charEl = document.getElementById('note-char-count');
    const wordEl = document.getElementById('note-word-count');
    const goalStatusEl = document.getElementById('note-word-goal-status');
    const goalWrapEl = document.getElementById('note-word-goal-progress-wrap');
    const goalFillEl = document.getElementById('note-word-goal-progress-fill');
    const goalPercentEl = document.getElementById('note-word-goal-percent');

    const text = editor ? editor.innerText.trim() : (ta ? ta.value.trim() : '');
    const len = text.length;
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;

    if (charEl) charEl.textContent = `${len} karakter`;
    if (wordEl) wordEl.textContent = `${words} kelime`;

    const target = (currentPageData && currentPageData.target_word_count) ? currentPageData.target_word_count : 0;
    if (target > 0) {
        const pct = Math.min(100, Math.round((words / target) * 100));
        if (goalStatusEl) {
            goalStatusEl.textContent = `🎯 ${words} / ${target} kelime (${pct >= 100 ? '🎉 Hedef Tamamlandı' : `%${pct}`})`;
            goalStatusEl.style.color = pct >= 100 ? 'var(--success, #10b981)' : 'var(--primary, #3b82f6)';
        }
        if (goalWrapEl) goalWrapEl.style.display = 'flex';
        if (goalFillEl) {
            goalFillEl.style.width = `${pct}%`;
            goalFillEl.style.backgroundColor = pct >= 100 ? 'var(--success, #10b981)' : 'var(--primary, #3b82f6)';
        }
        if (goalPercentEl) goalPercentEl.textContent = `%${pct}`;
    } else {
        if (goalStatusEl) {
            goalStatusEl.textContent = '🎯 Hedef Belirle';
            goalStatusEl.style.color = 'var(--primary, #3b82f6)';
        }
        if (goalWrapEl) goalWrapEl.style.display = 'none';
    }
}

let noteAutoSaveTimer = null;

function handleRichNoteInput() {
    const editor = document.getElementById('note-rich-editor');
    const ta = document.getElementById('note-content-textarea');
    if (editor && ta) {
        ta.value = editor.innerHTML;
    }
    updateNoteStats();
    const statusEl = document.getElementById('note-save-status');
    if (statusEl) statusEl.textContent = "Kaydediliyor...";
    clearTimeout(noteAutoSaveTimer);
    noteAutoSaveTimer = setTimeout(() => {
        saveNoteContent(true);
    }, 400);
}

function handleNoteInput() {
    handleRichNoteInput();
}

function formatNoteText(command, value = null) {
    const editor = document.getElementById('note-rich-editor');
    if (!editor) return;
    editor.focus();
    document.execCommand(command, false, value);
    handleRichNoteInput();
}

function insertNoteChecklist() {
    const editor = document.getElementById('note-rich-editor');
    if (!editor) return;
    editor.focus();
    const checkHtml = '<div style="margin:4px 0;"><label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" onclick="event.stopPropagation()"> <span>Yeni görev</span></label></div>';
    document.execCommand('insertHTML', false, checkHtml);
    handleRichNoteInput();
}

function insertNoteCode() {
    const editor = document.getElementById('note-rich-editor');
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    const txt = sel && sel.rangeCount ? sel.getRangeAt(0).toString() : 'kod';
    document.execCommand('insertHTML', false, `<code>${escapeHtml(txt)}</code>`);
    handleRichNoteInput();
}

function insertMarkdownSyntax(before, after = '') {
    // Geriye dönük uyumluluk: Doğrudan zengin metin komutlarına yönlendir
    if (before === '**') formatNoteText('bold');
    else if (before === '*') formatNoteText('italic');
    else if (before === '# ') formatNoteText('formatBlock', 'h2');
    else if (before === '## ') formatNoteText('formatBlock', 'h3');
    else if (before === '- ') formatNoteText('insertUnorderedList');
    else if (before.includes('[]')) insertNoteChecklist();
    else if (before === '`') insertNoteCode();
    else if (before === '> ') formatNoteText('formatBlock', 'blockquote');
    else formatNoteText('bold');
}

function toggleNoteEditorMode(mode) {
    // Zengin metin editöründe her zaman canlı düzenleme aktiftir
    const editor = document.getElementById('note-rich-editor');
    if (editor) editor.focus();
}

async function triggerAiActionizeNote() {
    const editor = document.getElementById('note-rich-editor');
    if (!editor) return;
    const text = editor.innerText.trim();
    if (!text) {
        showToast("Dönüştürülecek not metni boş!", "warning");
        return;
    }
    showToast("🤖 AI notu analiz ediyor ve görevleri çıkarıyor...", "info");
    try {
        const res = await fetch('/notes/api/ai/actionize', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({text: text})
        });
        const data = await res.json();
        if (data.ok && data.tasks && data.tasks.length > 0) {
            let tasksHtml = '<div style="margin-top:12px; padding:10px; background:rgba(59,130,246,0.06); border-radius:8px; border-left:3px solid #3b82f6;"><p style="font-weight:700; margin:0 0 6px 0;">☑️ AI Tarafından Çıkarılan Görevler:</p><ul style="margin:0; padding-left:20px;">';
            data.tasks.forEach(t => {
                tasksHtml += `<li>☐ ${escapeHtml(t.title)}</li>`;
            });
            tasksHtml += '</ul></div><br>';
            editor.focus();
            document.execCommand('insertHTML', false, tasksHtml);
            handleRichNoteInput();
            showToast(`✨ ${data.count} görev nota eklendi!`, "success");
        } else {
            showToast("Belirgin bir görev tespit edilemedi", "info");
        }
    } catch (e) {
        showToast("AI isteği sırasında hata oluştu", "error");
    }
}

function sanitizeRichHtml(html) {
    if (!html || typeof html !== 'string') return '';
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const dangerousTags = ['script', 'iframe', 'object', 'embed', 'form', 'link', 'style'];
        dangerousTags.forEach(tag => {
            const elements = doc.querySelectorAll(tag);
            elements.forEach(el => el.remove());
        });
        const allElements = doc.querySelectorAll('*');
        allElements.forEach(el => {
            const attrs = Array.from(el.attributes);
            for (const attr of attrs) {
                const name = attr.name.toLowerCase();
                const val = (attr.value || '').trim().toLowerCase();
                if (name.startsWith('on') || val.startsWith('javascript:') || val.startsWith('data:text/html')) {
                    el.removeAttribute(attr.name);
                }
            }
        });
        return doc.body.innerHTML;
    } catch (e) {
        return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    }
}

async function uploadPastedImage(blob, editor) {
    if (!blob) return;
    const formData = new FormData();
    formData.append('image', blob, 'pasted_' + Date.now() + '.png');
    showToast("📷 Görsel yükleniyor...", "info");
    try {
        const res = await fetch('/notes/api/upload_image', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.ok && data.url) {
            editor.focus();
            document.execCommand('insertHTML', false, `<p><img src="${data.url}" alt="Eklenen Görsel" style="max-width:100%; border-radius:8px; margin:8px 0;" /></p><p><br></p>`);
            handleRichNoteInput();
            showToast("📷 Görsel nota eklendi ✓", "success");
        } else {
            showToast("Görsel yüklenemedi", "error");
        }
    } catch (e) {
        showToast("Görsel yükleme hatası", "error");
    }
}

function exportPageToPdf() {
    if (!currentPageData) {
        showToast("Yazdırılacak açık bir sayfa yok", "warning");
        return;
    }
    window.print();
}

function renderNoteEditor() {
    const editor = document.getElementById('note-rich-editor');
    const textarea = document.getElementById('note-content-textarea');
    if (editor && currentPageData) {
        const draft = localStorage.getItem(`tnote_draft_${currentPageId}`);
        const rawContent = (draft !== null && draft !== undefined) ? draft : (currentPageData.content || '');
        
        // Eğer içerik markdown formatında ise HTML'e çevirip zengin göster
        let htmlToRender = '';
        if (rawContent && !rawContent.trim().startsWith('<') && (rawContent.includes('**') || rawContent.includes('#') || rawContent.includes('- ') || rawContent.includes('\n'))) {
            htmlToRender = renderMarkdownToHtml(rawContent);
        } else {
            htmlToRender = rawContent || '';
        }
        editor.innerHTML = sanitizeRichHtml(htmlToRender);
        if (textarea) textarea.value = editor.innerHTML;
        updateNoteStats();
        const statusEl = document.getElementById('note-save-status');
        if (statusEl) statusEl.textContent = "Kaydedildi ✓";

        // Pano Görseli Yapıştırma Dinleyicisi
        editor.onpaste = async (e) => {
            const items = (e.clipboardData || window.clipboardData)?.items;
            if (items) {
                for (const item of items) {
                    if (item.type.indexOf('image') === 0) {
                        e.preventDefault();
                        const blob = item.getAsFile();
                        await uploadPastedImage(blob, editor);
                        return;
                    }
                }
            }
        };

        editor.onblur = () => {
            clearTimeout(noteAutoSaveTimer);
            saveNoteContent(true);
        };
    }
}

async function saveNoteContent(isAutoSave = false) {
    const editor = document.getElementById('note-rich-editor');
    const textarea = document.getElementById('note-content-textarea');
    const statusEl = document.getElementById('note-save-status');
    if (!editor || !currentPageId) return;

    const content = editor.innerHTML;
    if (textarea) textarea.value = content;
    try {
        localStorage.setItem(`tnote_draft_${currentPageId}`, content);
    } catch(e) {}

    if (!navigator.onLine) {
        enqueueOfflineAction({
            type: 'save_note',
            pageId: currentPageId,
            content: content,
            timestamp: Date.now()
        });
        if (statusEl) statusEl.textContent = "Kaydedildi (çevrimdışı) ✓";
        return;
    }

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({content: content})
        });
        const data = await res.json();
        if (data.ok) {
            if (statusEl) statusEl.textContent = "Kaydedildi ✓";
            if (!isAutoSave) {
                showToast("Not başarıyla kaydedildi!");
            }
        }
    } catch (e) {
        console.error("Not kaydetme hatası:", e);
        enqueueOfflineAction({
            type: 'save_note',
            pageId: currentPageId,
            content: content,
            timestamp: Date.now()
        });
        if (statusEl) statusEl.textContent = "Kaydedildi (yerel) ✓";
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

    const currentNbId = window.CURRENT_NOTEBOOK_ID || 1;
    const res = await fetch('/notes/api/categories', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            name, 
            icon, 
            color,
            notebook_id: currentNbId
        })
    });
    const data = await res.json();
    if (data.ok) {
        closeModal('modal-add-category');
        window.location.href = `/notes?notebook_id=${currentNbId}`;
    }
}

// Sayfa Ekleme
function openAddPageForCat(catId, catName) {
    const sel = document.getElementById('new-page-cat');
    if (sel) sel.value = catId;
    openModal('modal-add-page');
}

function openAddPageModal() {
    const sel = document.getElementById('new-page-cat');
    if (sel && sel.options.length === 0) {
        alert('Bu not defterinde henüz dosya bulunmuyor. Lütfen önce bir dosya ekleyin.');
        openModal('modal-add-category');
        return;
    }
    openModal('modal-add-page');
}

function openAddProjectModal() {
    const typeSel = document.getElementById('new-page-type');
    if (typeSel) typeSel.value = 'project';
    openAddPageModal();
}

const ACADEMIC_THESIS_TEMPLATE = `<h2>🎓 Tez &amp; Ödev Çalışma Masası</h2>
<p><b>Danışman / Öğretim Üyesi:</b> Prof. Dr. ...<br>
<b>Ders / Anabilim Dalı:</b> ...<br>
<b>Teslim Tarihi:</b> [Tarih Giriniz]<br>
<b>Aşama:</b> 🟡 Literatür Taraması &amp; Hipotez Belirleme</p>
<hr>
<h3>📋 Tez &amp; Ödev Yol Haritası (Kontrol Listesi)</h3>
<ul>
  <li>☐ Konu tespiti, problem tanımı ve danışman onayı</li>
  <li>☐ Literatür taraması (Yerli ve yabancı en az 15 makale incelemesi)</li>
  <li>☐ Araştırma soruları, amaç ve metodoloji belirleme</li>
  <li>☐ Veri toplama, anket, deney veya prototip kodlama</li>
  <li>☐ Giriş ve Kuramsal Çerçeve taslağının yazımı</li>
  <li>☐ Bulgular, İstatistiksel Analiz ve Tartışma yazımı</li>
  <li>☐ Sonuç, Değerlendirme ve Gelecek Çalışmalar</li>
  <li>☐ APA 7 / IEEE formatında kaynakça ve metin içi atıf kontrolü</li>
  <li>☐ Danışman inceleme revizyonları ve Turnitin intihal raporu (&lt;%15)</li>
  <li>☐ Ciltleme / PDF son teslimi ve jüri sunumu hazırlığı</li>
</ul>
<hr>
<h3>📚 Kaynakça &amp; İncelenen Makaleler</h3>
<ul>
  <li>📖 <b>Referans 1:</b> Yazar, A. (2025). <i>"Makale Başlığı"</i>, Bilim Dergisi. [Not: Metot için temel referans]</li>
  <li>📖 <b>Referans 2:</b> Smith, J. et al. (2024). <i>"Advanced Methodologies"</i>, IEEE Trans. [Not: İlgili çalışma]</li>
</ul>
<hr>
<h3>📝 Araştırma Notları, Alıntılar &amp; Karalamalar</h3>
<p>Laboratuvar notları, mülakat kayıtları, önemli formüller veya hocanın son geri bildirimlerini buraya yazabilirsiniz...</p>`;

async function submitAddPage() {
    const catId = document.getElementById('new-page-cat').value;
    const title = document.getElementById('new-page-title').value.trim();
    const type = document.getElementById('new-page-type').value;
    let icon = document.getElementById('new-page-icon').value.trim() || '📝';
    if (!title || !catId) return;

    let finalType = type;
    let initialContent = '';
    if (type === 'academic') {
        finalType = 'notes';
        initialContent = ACADEMIC_THESIS_TEMPLATE;
        if (!icon || icon === '📝') icon = '🎓';
    }

    const currentNbId = window.CURRENT_NOTEBOOK_ID || 1;
    const res = await fetch('/notes/api/pages', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            category_id: parseInt(catId), 
            title, 
            type: finalType, 
            icon,
            content: initialContent,
            notebook_id: currentNbId
        })
    });
    const data = await res.json();
    if (data.ok) {
        closeModal('modal-add-page');
        window.location.href = `/notes?notebook_id=${currentNbId}&page_id=${data.id}`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Geri Al (Undo / Ctrl+Z) Yöneticisi
// ─────────────────────────────────────────────────────────────────────────────
window._deletedHistoryStack = [];
let undoToastTimer = null;

function pushDeletedHistory(type, data, restoreFn) {
    window._deletedHistoryStack.push({
        type: type,
        data: data,
        restore: restoreFn,
        timestamp: Date.now()
    });
    const label = (data.title || data.content || data.name || 'Öğe').substring(0, 24);
    showUndoToast(`"${label}" silindi`, restoreFn);
}

function showUndoToast(msg, restoreFn) {
    const toast = document.getElementById('undo-toast');
    if (!toast) return;
    toast.innerHTML = `
        <span>🗑️ ${escapeHtml(msg)}</span>
        <button class="undo-toast-btn" onclick="undoLastDelete()">↩️ Geri Al (Ctrl+Z)</button>
    `;
    toast.style.display = 'flex';
    clearTimeout(undoToastTimer);
    undoToastTimer = setTimeout(() => {
        toast.style.display = 'none';
    }, 7000);
}

function hideUndoToast() {
    const toast = document.getElementById('undo-toast');
    if (toast) toast.style.display = 'none';
    clearTimeout(undoToastTimer);
}

function undoLastDelete() {
    if (!window._deletedHistoryStack || window._deletedHistoryStack.length === 0) {
        showToast("Geri alınacak silme işlemi yok", "info");
        return;
    }
    const last = window._deletedHistoryStack.pop();
    if (last && typeof last.restore === 'function') {
        last.restore();
        hideUndoToast();
        showToast("Öğe geri yüklendi ✓", "success");
    }
}

// Global Ctrl+Z dinleyicisi: aktif metin alanı dışındayken son silineni geri alır
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        const active = document.activeElement;
        const isEditing = active && (
            active.tagName === 'INPUT' || 
            active.tagName === 'TEXTAREA' || 
            active.isContentEditable
        );
        if (!isEditing && window._deletedHistoryStack && window._deletedHistoryStack.length > 0) {
            e.preventDefault();
            undoLastDelete();
        }
    }
});

// Kategori Düzenleme & Silme
function updateWebCatColorPreview(inputId, previewId) {
    const el = document.getElementById(inputId);
    const prev = document.getElementById(previewId);
    if (el && prev) {
        const c = el.value || '#3b82f6';
        prev.style.background = c + '18';
        prev.style.color = c;
        prev.style.borderColor = c + '35';
    }
}

function openEditCategoryModal(catId, name, icon, color) {
    document.getElementById('edit-cat-id').value = catId;
    document.getElementById('edit-cat-name').value = name;
    document.getElementById('edit-cat-icon').value = icon || '📁';
    document.getElementById('edit-cat-color').value = color || '#3b82f6';
    updateWebCatColorPreview('edit-cat-color', 'edit-cat-color-preview');
    openModal('modal-edit-category');
}

async function addCategoryDividerWeb() {
    const label = prompt("Ayraç etiketi (isteğe bağlı, sadece çizgi için boş bırakabilirsiniz):", "");
    if (label === null) return;
    const name = label.trim() || '---';
    const res = await fetch('/notes/api/categories', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            name: name,
            icon: '―',
            color: '#94a3b8',
            is_divider: 1
        })
    });
    const data = await res.json();
    if (data.ok) {
        window.location.reload();
    }
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
    const confirmMsg = (name === 'Ayraç' || name === '---') ? 
        'Bu ayracı silmek istediğinize emin misiniz?' : 
        `"${name}" dosyasını ve içindeki tüm sayfaları silmek istediğinize emin misiniz?`;
    if (!confirm(confirmMsg)) return;
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
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;');
}

function sanitizeUrl(url) {
    if (!url) return '';
    const clean = String(url).trim();
    if (/^https?:\/\//i.test(clean) || clean.startsWith('/') || clean.startsWith('#')) {
        return escapeHtml(clean);
    }
    return '#';
}

function openReminderModalById(itemId) {
    const it = (currentItems || []).find(x => x.id === itemId);
    const title = it ? it.title : "Madde";
    openReminderModal(itemId, title);
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
        netEl.style.color = netVal > 0 ? 'var(--text, #0f172a)' : (netVal < 0 ? 'var(--danger, #dc2626)' : 'var(--text-secondary, #64748b)');

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
        const amountColor = isInc ? 'var(--text, #0f172a)' : '#dc2626';
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
                <button class="btn-icon-subtle" onclick="openEditFinanceModal(${e.id})" title="Düzenle"><svg class="svg-icon svg-icon-xs"><use href="#i-edit"/></svg></button>
                <button class="btn-icon-subtle btn-danger-hover" onclick="deleteFinanceEntry(${e.id}, '${escapeHtml(e.title)}')" title="Sil"><svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg></button>
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
        loadProjectNotes();

        const urlParams = new URLSearchParams(window.location.search);
        const ptab = urlParams.get('ptab');
        if (ptab) {
            switchProjectTab(ptab);
        }
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

    if (tabName === 'notes') {
        loadProjectNotes();
    }
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
        const dateHtml = m.target_date ? `<div class="timeline-node-date">${escapeHtml(m.target_date)}</div>` : '';

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
    document.getElementById('milestone-modal-title').textContent = 'Yeni Proje Aşaması Ekle';
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

    document.getElementById('milestone-modal-title').textContent = 'Aşamayı Düzenle';
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
    if (cInput) {
        const cDraft = localStorage.getItem(`tnote_proj_concept_${currentPageId}`);
        cInput.value = (cDraft !== null && cDraft !== undefined) ? cDraft : (details.concept || '');
        cInput.onblur = () => {
            clearTimeout(projectConceptAutoSaveTimer);
            saveProjectConceptInstant();
        };
    }

    const sInput = document.getElementById('proj-specs-input');
    if (sInput) {
        const sDraft = localStorage.getItem(`tnote_proj_specs_${currentPageId}`);
        sInput.value = (sDraft !== null && sDraft !== undefined) ? sDraft : (details.specs || '');
        sInput.onblur = () => {
            clearTimeout(projectConceptAutoSaveTimer);
            saveProjectConceptInstant();
        };
    }

    const status1 = document.getElementById('proj-concept-save-status');
    const status2 = document.getElementById('proj-specs-save-status');
    if (status1) status1.textContent = "Kaydedildi ✓";
    if (status2) status2.textContent = "Kaydedildi ✓";

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
                    <button class="btn-icon-subtle btn-danger-hover" onclick="deleteDrawing(${d.id}); event.stopPropagation();" title="Sil"><svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg></button>
                </div>
            </div>
        `;
        card.onclick = () => previewDrawingImage(d.url, d.title);
        grid.appendChild(card);
    });
}

let projectConceptAutoSaveTimer = null;
function handleProjectConceptInput() {
    clearTimeout(projectConceptAutoSaveTimer);
    const status1 = document.getElementById('proj-concept-save-status');
    const status2 = document.getElementById('proj-specs-save-status');
    if (status1) status1.textContent = "Kaydediliyor...";
    if (status2) status2.textContent = "Kaydediliyor...";
    projectConceptAutoSaveTimer = setTimeout(() => {
        saveProjectConceptInstant();
    }, 400);
}

async function saveProjectConceptInstant() {
    if (!currentPageId) return;
    const cEl = document.getElementById('proj-concept-input');
    const sEl = document.getElementById('proj-specs-input');
    const concept = cEl ? cEl.value : '';
    const specs = sEl ? sEl.value : '';
    const status1 = document.getElementById('proj-concept-save-status');
    const status2 = document.getElementById('proj-specs-save-status');

    try {
        localStorage.setItem(`tnote_proj_concept_${currentPageId}`, concept);
        localStorage.setItem(`tnote_proj_specs_${currentPageId}`, specs);
    } catch(e) {}

    if (!navigator.onLine) {
        enqueueOfflineAction({
            type: 'save_project',
            pageId: currentPageId,
            concept: concept,
            specs: specs,
            timestamp: Date.now()
        });
        if (status1) status1.textContent = "Kaydedildi (çevrimdışı) ✓";
        if (status2) status2.textContent = "Kaydedildi (çevrimdışı) ✓";
        return;
    }

    try {
        await fetch(`/notes/api/pages/${currentPageId}/project`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ concept, specs })
        });
        if (status1) status1.textContent = "Kaydedildi ✓";
        if (status2) status2.textContent = "Kaydedildi ✓";
    } catch (e) {
        console.error(e);
        enqueueOfflineAction({
            type: 'save_project',
            pageId: currentPageId,
            concept: concept,
            specs: specs,
            timestamp: Date.now()
        });
        if (status1) status1.textContent = "Kaydedildi (yerel) ✓";
        if (status2) status2.textContent = "Kaydedildi (yerel) ✓";
    }
}

async function saveProjectConcept() {
    await saveProjectConceptInstant();
    showToast("Fikir ve teknik şartname kaydedildi!");
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
        let statusLabel = 'Aranıyor';
        if (m.status === 'ordered') {
            statusClass = 'is-ordered';
            statusLabel = 'Sipariş Edildi';
        } else if (m.status === 'available') {
            statusClass = 'is-available';
            statusLabel = 'Elde Var';
        }

        const statusBtn = `<button class="btn-bom-status ${statusClass}" onclick="toggleMaterialStatus(${m.id})">${statusLabel}</button>`;
        const linkHtml = m.url ? `<a href="${escapeHtml(m.url)}" target="_blank" rel="noopener" style="color:var(--accent); font-size:0.8rem; text-decoration:none;">Bağlantı</a>` : '<span style="color:var(--muted); font-size:0.75rem;">-</span>';

        tr.innerHTML = `
            <td>${statusBtn}</td>
            <td><strong>${escapeHtml(m.name)}</strong></td>
            <td style="text-align:center;">${escapeHtml(m.quantity || '1')}</td>
            <td style="text-align:right;">${formatCurrency(m.unit_price || 0)}</td>
            <td style="text-align:right; font-weight:600;">${formatCurrency(lineTotal)}</td>
            <td>${linkHtml}</td>
            <td><span style="font-size:0.75rem; color:var(--muted);">${escapeHtml(m.notes || '')}</span></td>
            <td style="text-align:right;">
                <button class="btn-icon-subtle" onclick="openEditMaterialModal(${m.id})" title="Düzenle"><svg class="svg-icon svg-icon-xs"><use href="#i-edit"/></svg></button>
                <button class="btn-icon-subtle btn-danger-hover" onclick="deleteMaterial(${m.id}, '${escapeHtml(m.name)}')" title="Sil"><svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg></button>
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
        <div>Temin Edilen Tutar: <strong>${formatCurrency(stats.available_mat_cost || 0)}</strong></div>
        <div>Toplam Proje Maliyeti: <strong style="color:var(--primary, #0284c7);">${formatCurrency(stats.total_mat_cost || 0)}</strong></div>
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
    document.getElementById('material-modal-title').textContent = 'Malzeme / Parça Ekle';
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

    document.getElementById('material-modal-title').textContent = 'Malzemeyi Düzenle';
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
                    <button class="btn-icon-subtle btn-danger-hover" onclick="deleteProjectLog(${log.id})" title="Sil"><svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg></button>
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
            showToast(data.message || 'İşlem geri alındı!');
            updateTrashBadgeCount();
            if (currentPageId) {
                loadPage(currentPageId);
            } else {
                loadOverviewPage();
            }
        } else {
            showToast(data.error || 'Geri alınacak işlem bulunamadı.');
        }
    } catch (e) {
        console.error(e);
    }
}

function openHistoryModal() {
    fetchHistoryList();
    openModal('modal-history');
}

async function fetchHistoryList() {
    const container = document.getElementById('history-list-container');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted);">Yükleniyor...</div>';
    try {
        const res = await fetch('/notes/api/history');
        const data = await res.json();
        if (!data.history || data.history.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:24px; color:var(--muted); font-size:0.88rem;">Henüz kayıtlı bir işlem geçmişi bulunmuyor.</div>';
            return;
        }
        renderHistoryList(data.history);
    } catch (e) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:#ef4444;">Geçmiş yüklenemedi.</div>';
    }
}

function renderHistoryList(items) {
    const container = document.getElementById('history-list-container');
    if (!container) return;

    const typeIcons = {
        'create_page': '📄',
        'delete_page': '📄',
        'restore_page': '📄',
        'create_item': '📝',
        'delete_item': '📝',
        'update_item': '📝',
        'create_vault': '🔐',
        'delete_vault': '🔐',
        'update_vault': '🔐',
        'empty_trash': '🗑️'
    };

    let html = '';
    items.forEach(item => {
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
                <button class="btn btn-sm btn-outline" style="font-size:0.75rem; padding:3px 8px; white-space:nowrap; display:inline-flex; align-items:center; gap:4px;" onclick="undoSpecificAction(${item.id})">
                    <svg class="svg-icon svg-icon-xs"><use href="#i-undo"/></svg> Geri Al
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
            showToast(data.message || 'İşlem geri alındı!');
            openHistoryModal();
            updateTrashBadgeCount();
            if (currentPageId) loadPage(currentPageId);
        } else {
            showToast(data.error || 'İşlem geri alınamadı.');
        }
    } catch (e) {
        showToast(`❌ Hata: ${e.message}`);
    }
}

// ─────────────────────────────────────────────────────────────
// Çöp Kutusu (Trash & Restore)
// ─────────────────────────────────────────────────────────────

async function loadTrashPage() {
    closeMobileSidebar();
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
    if (titleEl) titleEl.textContent = 'Çöp Kutusu';
    if (iconEl) iconEl.innerHTML = '<svg class="svg-icon svg-icon-md"><use href="#i-trash"/></svg>';
    if (badgeEl) {
        badgeEl.textContent = '';
        badgeEl.style.display = 'none';
    }

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
                    <button class="btn btn-sm btn-primary" onclick="restoreTrashPage(${item.id})" style="font-size:0.78rem; padding:4px 10px; display:inline-flex; align-items:center; gap:4px;">
                        <svg class="svg-icon svg-icon-xs"><use href="#i-undo"/></svg> Geri Yükle
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="permanentDeleteTrashPage(${item.id})" style="font-size:0.78rem; padding:4px 10px; display:inline-flex; align-items:center; gap:4px;">
                        <svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg> Kalıcı Sil
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
    closeMobileSidebar();
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
    if (titleEl) titleEl.textContent = 'Şifre Kasası';
    if (iconEl) iconEl.innerHTML = '<svg class="svg-icon svg-icon-md"><use href="#i-shield"/></svg>';
    if (badgeEl) {
        badgeEl.textContent = '';
        badgeEl.style.display = 'none';
    }

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

                ${entry.has_password || entry.password ? `
                <div class="vault-field-row">
                    <div style="flex:1; min-width:0;">
                        <div class="vault-field-label">Şifre / Parola</div>
                        <div class="vault-field-val" id="v-val-pwd-${entry.id}" data-revealed="false">••••••••</div>
                    </div>
                    <div class="vault-field-actions">
                        <button class="vault-btn-copy" onclick="toggleCardPasswordVisibility(${entry.id})" title="Şifreyi Göster/Gizle">👁️</button>
                        <button class="vault-btn-copy" onclick="copyVaultPassword(${entry.id})" title="Şifreyi Kopyala">📋</button>
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
                        İlişkili Kayıtlar
                    </button>
                </div>

                <div class="vault-card-footer">
                    <div>
                        ${entry.url ? `
                        <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent); text-decoration:none; font-weight:600; display:inline-flex; align-items:center; gap:3px;">
                            Giriş Yap
                        </a>
                        ` : '<span style="color:var(--muted); font-size:0.72rem;">' + (entry.created_at || '') + '</span>'}
                    </div>
                    <div style="display:flex; gap:4px;">
                        <button class="btn-icon-subtle" onclick="openEditVaultModal(${entry.id})" title="Düzenle"><svg class="svg-icon svg-icon-xs"><use href="#i-edit"/></svg></button>
                        <button class="btn-icon-subtle btn-danger-hover" onclick="deleteVaultEntry(${entry.id}, '${escapeHtml(entry.title)}')" title="Sil"><svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg></button>
                    </div>
                </div>
            </div>
        `;
    });
    grid.innerHTML = html;
}

async function toggleCardPasswordVisibility(id) {
    const el = document.getElementById(`v-val-pwd-${id}`);
    if (!el) return;
    if (el.dataset.revealed === 'true') {
        el.textContent = '••••••••';
        el.dataset.revealed = 'false';
        return;
    }
    try {
        const res = await fetch(`/notes/api/vault/${id}/reveal`, {method: 'POST'});
        const data = await res.json();
        if (data.ok && data.password) {
            el.textContent = data.password;
            el.dataset.revealed = 'true';
        } else {
            showToast("Şifre alınamadı");
        }
    } catch (e) {
        showToast("Şifre çözme hatası");
    }
}

async function copyVaultPassword(id) {
    try {
        const res = await fetch(`/notes/api/vault/${id}/reveal`, {method: 'POST'});
        const data = await res.json();
        if (data.ok && data.password) {
            copyVaultField(data.password, 'Şifre');
        } else {
            showToast("Kopyalanacak şifre bulunamadı");
        }
    } catch (e) {
        showToast("Şifre kopyalanamadı");
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
            showToast(`"${name}" klasörü silindi.`);
            if (currentVaultFolder === name) currentVaultFolder = 'all';
            fetchVaultEntries();
        }
    } catch (e) {
        showToast(`Hata: ${e.message}`);
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
                                <button class="btn-icon-subtle" onclick="closeModal('modal-vault-related'); openEditVaultModal(${item.id})" title="Düzenle"><svg class="svg-icon svg-icon-xs"><use href="#i-edit"/></svg></button>
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
                                <button class="btn-icon-subtle" onclick="closeModal('modal-vault-related'); openEditVaultModal(${item.id})" title="Düzenle"><svg class="svg-icon svg-icon-xs"><use href="#i-edit"/></svg></button>
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
            document.getElementById('vault-modal-title').textContent = 'Şifre Kaydını Düzenle';
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
        uInput.placeholder = 'Müşteri No / T.C.';
        secLabel.textContent = 'IBAN / Kart';
        secInput.placeholder = 'TR00...';
    } else if (cat === 'wifi') {
        uLabel.textContent = 'Wi-Fi Ağ Adı (SSID)';
        uInput.placeholder = 'SSID';
        secLabel.textContent = 'Router IP';
        secInput.placeholder = '192.168.1.1';
    } else if (cat === 'device') {
        uLabel.textContent = 'Cihaz / Model';
        uInput.placeholder = 'Cihaz';
        secLabel.textContent = 'PIN / PUK';
        secInput.placeholder = 'PIN / PUK';
    } else if (cat === 'server') {
        uLabel.textContent = 'Kullanıcı Adı';
        uInput.placeholder = 'root / kullanıcı';
        secLabel.textContent = 'Port / IP / Host';
        secInput.placeholder = 'Port / IP';
    } else {
        uLabel.textContent = 'Kullanıcı Adı / E-posta';
        uInput.placeholder = 'Kullanıcı adı / E-posta';
        secLabel.textContent = 'Ek Bilgi';
        secInput.placeholder = 'İkincil bilgi';
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
            showToast(`"${title}" kaydı silindi (Geri alabilirsiniz).`);
            fetchVaultEntries();
        }
    } catch (e) {
        showToast(`Hata: ${e.message}`);
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

// ─────────────────────────────────────────────────────────────
// 1. Proje Görev & Not Maddeleri (Project Checklist & Bullet Items)
// ─────────────────────────────────────────────────────────────
async function loadProjectNotes() {
    if (!currentPageId) return;
    const container = document.getElementById('project-items-list');
    if (!container) return;
    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/items`);
        const data = await res.json();
        if (!data.ok) return;
        renderProjectNotes(data.items || []);
    } catch (e) {
        console.warn("loadProjectNotes error:", e);
    }
}

function renderProjectNotes(items) {
    const container = document.getElementById('project-items-list');
    if (!container) return;
    if (!items || items.length === 0) {
        container.innerHTML = `<div style="padding:16px; text-align:center; color:var(--muted); font-size:0.85rem;">Bu projede henüz görev veya not maddesi yok. Yukarıdan hemen ekleyin.</div>`;
        return;
    }
    container.innerHTML = items.map(it => `
        <div class="ov-item-row" id="proj-item-${it.id}" style="display:flex; justify-content:space-between; align-items:center; padding:7px 10px; background:var(--surface2, #f8fafc); border:1px solid var(--border, #e2e8f0); border-radius:6px; margin-bottom:4px;">
            <div style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
                <input type="checkbox" ${it.is_done ? 'checked' : ''} onchange="toggleProjectItem(${it.id}, this.checked)" style="width:16px; height:16px; cursor:pointer; flex-shrink:0;">
                <span style="font-size:0.85rem; ${it.is_done ? 'text-decoration:line-through; opacity:0.55;' : 'color:var(--text);'}; word-break:break-word;">
                    ${escapeHtml(it.title)}
                </span>
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                <button class="btn-icon-subtle btn-danger-hover" onclick="deleteProjectItem(${it.id})" title="Sil" style="color:var(--danger, #ef4444); font-size:0.8rem; padding:2px 4px;">
                    ✕
                </button>
            </div>
        </div>
    `).join('');
}

async function addProjectItem() {
    const input = document.getElementById('project-item-title-input');
    if (!input) return;
    const title = input.value.trim();
    if (!title || !currentPageId) return;

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title })
        });
        const data = await res.json();
        if (data.ok) {
            input.value = '';
            loadProjectNotes();
            if (typeof showToast === 'function') showToast("Madde eklendi");
        }
    } catch (e) {
        console.error("addProjectItem error:", e);
    }
}

async function toggleProjectItem(itemId, isDone) {
    try {
        await fetch(`/notes/api/items/${itemId}/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_done: isDone })
        });
        loadProjectNotes();
    } catch (e) {
        console.error("toggleProjectItem error:", e);
    }
}

async function deleteProjectItem(itemId) {
    try {
        await fetch(`/notes/api/items/${itemId}`, { method: 'DELETE' });
        loadProjectNotes();
    } catch (e) {
        console.error("deleteProjectItem error:", e);
    }
}

// ─────────────────────────────────────────────────────────────
// 2. Simge & Renk Seçici Yardımcıları (Emoji & Color Picker)
// ─────────────────────────────────────────────────────────────
function selectPickerIcon(inputId, icon, btnEl) {
    const input = document.getElementById(inputId);
    if (input) {
        input.value = icon;
    }
    if (btnEl && btnEl.parentElement) {
        btnEl.parentElement.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
    }
}

function selectPickerColor(inputId, color, swatchEl) {
    const input = document.getElementById(inputId);
    if (input) {
        input.value = color;
    }
}

// ─────────────────────────────────────────────────────────────
// 3. Sayfa Dışa Aktarma (.md, .txt, .json)
// ─────────────────────────────────────────────────────────────
function exportCurrentPage(format) {
    if (!currentPageId) {
        if (typeof showToast === 'function') showToast("Lütfen önce bir sayfa açın");
        return;
    }
    window.open(`/notes/api/pages/${currentPageId}/export?format=${format}`, '_blank');
}

// ─────────────────────────────────────────────────────────────
// 4. TincAI Mühendislik & Proje Asistanı
// ─────────────────────────────────────────────────────────────
let currentAiReplyText = '';

function openAiAssistModal() {
    const modal = document.getElementById('modal-ai-assist');
    const label = document.getElementById('ai-modal-context-label');
    const title = currentPageTitle || (currentProjectData ? currentProjectData.details.title : 'Aktif Sayfa');
    if (label) label.textContent = `Aktif Sayfa / Proje: ${title || '-'}`;
    if (modal) modal.style.display = 'flex';
}

async function runAiAction(action) {
    const box = document.getElementById('ai-response-box');
    const customPromptInput = document.getElementById('ai-custom-prompt');
    let customText = '';

    if (action === 'custom') {
        customText = customPromptInput.value.trim();
        if (!customText) return;
    }

    box.innerHTML = '<div style="display:flex; align-items:center; gap:8px; color:var(--accent);"><span>⏳</span> <em>TincAI bağlamı analiz ediyor, lütfen bekleyin...</em></div>';

    try {
        const res = await fetch('/notes/api/ai/assist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                page_id: currentPageId,
                action: action,
                custom_prompt: customText
            })
        });
        const data = await res.json();
        if (data.ok) {
            currentAiReplyText = data.reply;
            box.innerText = data.reply;
        } else {
            box.innerHTML = `<span style="color:#ef4444;">❌ Hata: ${escapeHtml(data.error || 'İşlem gerçekleştirilemedi')}</span>`;
        }
    } catch (e) {
        box.innerHTML = `<span style="color:#ef4444;">❌ Ağ Hatası: ${escapeHtml(e.message)}</span>`;
    }
}

function copyAiReply() {
    if (!currentAiReplyText) return;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(currentAiReplyText);
        if (typeof showToast === 'function') showToast("AI yanıtı panoya kopyalandı!");
    }
}

// ─────────────────────────────────────────────────────────────
// 5. Hızlı Not Detay Modal İşlemleri
// ─────────────────────────────────────────────────────────────
let currentDetailQuickNoteId = null;

function openQuickNoteDetail(id, content, dateStr) {
    currentDetailQuickNoteId = id;
    const modal = document.getElementById('modal-quicknote-detail');
    const idInput = document.getElementById('qn-detail-id');
    const contentInput = document.getElementById('qn-detail-content');
    const dateLabel = document.getElementById('qn-detail-date');

    if (idInput) idInput.value = id;
    if (contentInput) contentInput.value = content;
    if (dateLabel) dateLabel.textContent = dateStr ? `Kayıt Tarihi: ${dateStr}` : '';

    if (modal) {
        modal.style.display = 'flex';
        setTimeout(() => { if (contentInput) contentInput.focus(); }, 100);
    }
}

async function saveDetailQuickNote() {
    if (!currentDetailQuickNoteId) return;
    const content = document.getElementById('qn-detail-content').value.trim();
    if (!content) return;
    try {
        const res = await fetch(`/notes/api/quick-notes/${currentDetailQuickNoteId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ content })
        });
        const data = await res.json();
        if (data.ok) {
            closeModal('modal-quicknote-detail');
            if (typeof showToast === 'function') showToast("Hızlı not güncellendi");
            loadOverviewQuickNotes();
            if (typeof renderWebQuickTasks === 'function') renderWebQuickTasks();
        } else {
            alert(data.error || 'Güncellenemedi');
        }
    } catch (e) {
        console.error(e);
    }
}

async function deleteCurrentDetailQuickNote() {
    if (!currentDetailQuickNoteId) return;
    if (!confirm('Bu hızlı notu silmek istediğinize emin misiniz?')) return;
    try {
        const res = await fetch(`/notes/api/quick-notes/${currentDetailQuickNoteId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
            closeModal('modal-quicknote-detail');
            if (typeof showToast === 'function') showToast("Not silindi");
            loadOverviewQuickNotes();
            if (typeof renderWebQuickTasks === 'function') renderWebQuickTasks();
        }
    } catch (e) {
        console.error(e);
    }
}

function copyDetailQuickNote() {
    const content = document.getElementById('qn-detail-content').value;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(content);
        if (typeof showToast === 'function') showToast("Not panoya kopyalandı!");
    }
}

function transferDetailQuickNote() {
    const content = document.getElementById('qn-detail-content').value;
    const id = currentDetailQuickNoteId;
    closeModal('modal-quicknote-detail');
    openTransferQuickNoteModal(id, content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Yazılım Projesi Yönetimi (Web Arayüzü)
// ─────────────────────────────────────────────────────────────────────────────
let webCurrentSoftwareData = null;
let webCurrentSoftwareTab = 'rules';

async function renderSoftwareViewWeb(pageId) {
    try {
        const resp = await fetch(`/notes/api/software/${pageId}`);
        const json = await resp.json();
        if (json.ok && json.data) {
            webCurrentSoftwareData = json.data;
        }
    } catch (e) {
        console.warn("Web software project fetch error:", e);
    }

    if (!webCurrentSoftwareData) return;

    const proj = webCurrentSoftwareData.project || {};
    const rules = webCurrentSoftwareData.rules || [];
    const tasks = webCurrentSoftwareData.tasks || [];
    const ideas = webCurrentSoftwareData.ideas || [];
    const commits = webCurrentSoftwareData.commits || [];

    // Header & Meta
    const nameEl = document.getElementById('web-soft-repo-name');
    const branchEl = document.getElementById('web-soft-branch-badge');
    const pathEl = document.getElementById('web-soft-repo-path');
    const stackEl = document.getElementById('web-soft-tech-stack');

    if (nameEl) nameEl.innerText = proj.repo_name || (currentPageData ? currentPageData.title : 'Yazılım Projesi');
    if (branchEl) branchEl.innerText = proj.branch || 'main';
    if (pathEl) pathEl.innerText = proj.repo_path || '(Yerel depo dizini ayarlanmadı)';
    if (stackEl) stackEl.innerText = proj.tech_stack || 'Genel Yazılım';

    // Counts
    const cr = document.getElementById('web-soft-count-rules');
    const ct = document.getElementById('web-soft-count-tasks');
    const ci = document.getElementById('web-soft-count-ideas');
    const cc = document.getElementById('web-soft-count-commits');
    if (cr) cr.innerText = rules.length;
    if (ct) ct.innerText = tasks.length;
    if (ci) ci.innerText = ideas.length;
    if (cc) cc.innerText = commits.length;

    // AI & Agent Paneli
    const keyEl = document.getElementById('web-soft-api-key-display');
    const urlEl = document.getElementById('web-soft-agents-url-display');
    const linkEl = document.getElementById('web-soft-agents-link');
    const agentsUrl = `${window.location.origin}/notes/api/software/${pageId}/agents.md`;

    if (keyEl) keyEl.value = proj.api_key || '';
    if (urlEl) urlEl.value = agentsUrl;
    if (linkEl) linkEl.href = agentsUrl;

    // Panes
    renderWebSoftwareRules(rules);
    renderWebSoftwareTasks(tasks);
    renderWebSoftwareIdeas(ideas);
    renderWebSoftwareCommits(commits);
}

function switchSoftwareTabWeb(tabName) {
    webCurrentSoftwareTab = tabName;
    ['rules', 'tasks', 'ideas', 'commits', 'ai'].forEach(t => {
        const btn = document.getElementById(`wstab-btn-${t}`);
        const pane = document.getElementById(`web-software-pane-${t}`);
        if (btn) btn.classList.toggle('active', t === tabName);
        if (pane) pane.style.display = (t === tabName) ? 'block' : 'none';
    });
}

function renderWebSoftwareRules(rules) {
    const el = document.getElementById('web-software-rules-list');
    if (!el) return;
    if (rules.length === 0) {
        el.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted);">Henüz kural eklenmedi.</div>';
        return;
    }
    el.innerHTML = rules.map(r => `
        <div class="card" style="padding:12px; display:flex; flex-direction:column; gap:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; gap:6px; align-items:center;">
                    <span style="font-size:0.75rem; font-weight:800; color:#dc2626; background:rgba(220,38,38,0.1); padding:2px 6px; border-radius:4px;">${r.severity}</span>
                    <span style="font-size:0.75rem; color:var(--muted);">[${r.category}]</span>
                </div>
                <button class="btn btn-sm btn-ghost" style="color:var(--danger);" onclick="deleteSoftwareRuleWeb(${r.id})">✕</button>
            </div>
            <div style="font-weight:700; font-size:0.95rem;">${escapeHtml(r.title)}</div>
            <div style="font-size:0.85rem; color:var(--text-secondary);">${escapeHtml(r.content)}</div>
        </div>
    `).join('');
}

function renderWebSoftwareTasks(tasks) {
    const el = document.getElementById('web-software-tasks-list');
    if (!el) return;
    if (tasks.length === 0) {
        el.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted);">Henüz görev eklenmedi.</div>';
        return;
    }
    el.innerHTML = tasks.map(t => {
        const isDone = (t.status === 'done');
        return `
            <div class="card" style="padding:12px; display:flex; flex-direction:column; gap:6px; opacity:${isDone ? 0.65 : 1};">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <input type="checkbox" ${isDone ? 'checked' : ''} onchange="toggleSoftwareTaskDoneWeb(${t.id}, this.checked)">
                        <span style="font-weight:700; font-size:0.95rem; ${isDone ? 'text-decoration:line-through; color:var(--muted);' : ''}">${escapeHtml(t.title)}</span>
                    </div>
                    <button class="btn btn-sm btn-ghost" style="color:var(--danger);" onclick="deleteSoftwareTaskWeb(${t.id})">✕</button>
                </div>
                ${t.description ? `<div style="font-size:0.85rem; color:var(--text-secondary); margin-left:26px;">${escapeHtml(t.description)}</div>` : ''}
                <div style="display:flex; justify-content:space-between; align-items:center; margin-left:26px; margin-top:4px;">
                    <div style="display:flex; gap:6px; align-items:center;">
                        <span style="font-size:0.75rem; background:var(--surface); border:1px solid var(--border); padding:2px 6px; border-radius:4px;">${t.priority}</span>
                        ${t.assigned_agent ? `<span style="font-size:0.75rem; color:#4f46e5;">🤖 @${escapeHtml(t.assigned_agent)}</span>` : ''}
                    </div>
                    <select class="form-control" style="width:auto; padding:2px 8px; font-size:0.78rem;" onchange="updateSoftwareTaskStatusWeb(${t.id}, this.value)">
                        <option value="todo" ${t.status === 'todo' ? 'selected' : ''}>Yapılacak</option>
                        <option value="in_progress" ${t.status === 'in_progress' ? 'selected' : ''}>Devam Eden</option>
                        <option value="review" ${t.status === 'review' ? 'selected' : ''}>İnceleme</option>
                        <option value="done" ${t.status === 'done' ? 'selected' : ''}>Tamam</option>
                    </select>
                </div>
            </div>
        `;
    }).join('');
}

function renderWebSoftwareIdeas(ideas) {
    const el = document.getElementById('web-software-ideas-list');
    if (!el) return;
    if (ideas.length === 0) {
        el.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted);">Henüz fikir eklenmedi.</div>';
        return;
    }
    el.innerHTML = ideas.map(i => `
        <div class="card" style="padding:12px; display:flex; flex-direction:column; gap:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; gap:6px; align-items:center;">
                    <span style="font-size:0.75rem; font-weight:700; background:var(--surface); border:1px solid var(--border); padding:2px 6px; border-radius:4px;">${i.category}</span>
                    <span style="font-size:0.75rem; color:var(--muted);">${i.status}</span>
                </div>
                <button class="btn btn-sm btn-ghost" style="color:var(--danger);" onclick="deleteSoftwareIdeaWeb(${i.id})">✕</button>
            </div>
            <div style="font-weight:700; font-size:0.95rem;">${escapeHtml(i.title)}</div>
            ${i.description ? `<div style="font-size:0.85rem; color:var(--text-secondary);">${escapeHtml(i.description)}</div>` : ''}
        </div>
    `).join('');
}

function renderWebSoftwareCommits(commits) {
    const el = document.getElementById('web-software-commits-list');
    if (!el) return;
    if (commits.length === 0) {
        el.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted);">Henüz commit kaydı yok. "🔄 Şimdi Eşitle" butonuna tıklayın.</div>';
        return;
    }
    el.innerHTML = commits.map(c => `
        <div class="card" style="padding:10px 14px; display:flex; flex-direction:column; gap:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="font-family:monospace; font-size:0.8rem; font-weight:700; color:var(--primary);">${c.commit_hash.slice(0, 7)}</span>
                <span style="font-size:0.75rem; color:var(--muted);">${c.committed_at || ''}</span>
            </div>
            <div style="font-size:0.9rem; font-weight:600;">${escapeHtml(c.message)}</div>
            <div style="font-size:0.78rem; color:var(--muted);">Yazar: <b>${escapeHtml(c.author || 'Anonim')}</b></div>
        </div>
    `).join('');
}

async function syncSoftwareGitWeb() {
    if (!currentPageData) return;
    try {
        const resp = await fetch(`/notes/api/software/${currentPageData.id}/sync-git`, { method: 'POST' });
        const json = await resp.json();
        if (json.ok) {
            alert(`✅ ${json.synced_count || 0} yeni commit eşitlendi!`);
            await renderSoftwareViewWeb(currentPageData.id);
        } else {
            alert(json.error || 'Git eşitleme hatası');
        }
    } catch (e) {
        alert('Hata: ' + e.message);
    }
}

async function updateSoftwareTaskStatusWeb(taskId, status) {
    if (!currentPageData) return;
    await fetch(`/notes/api/software/${currentPageData.id}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
    });
    await renderSoftwareViewWeb(currentPageData.id);
}

async function toggleSoftwareTaskDoneWeb(taskId, isDone) {
    await updateSoftwareTaskStatusWeb(taskId, isDone ? 'done' : 'todo');
}

async function deleteSoftwareTaskWeb(taskId) {
    if (!confirm('Görevi silmek istediğinize emin misiniz?')) return;
    await fetch(`/notes/api/software/${currentPageData.id}/tasks/${taskId}`, { method: 'DELETE' });
    await renderSoftwareViewWeb(currentPageData.id);
}

async function deleteSoftwareRuleWeb(ruleId) {
    if (!confirm('Kuralı silmek istediğinize emin misiniz?')) return;
    await fetch(`/notes/api/software/${currentPageData.id}/rules/${ruleId}`, { method: 'DELETE' });
    await renderSoftwareViewWeb(currentPageData.id);
}

async function deleteSoftwareIdeaWeb(ideaId) {
    if (!confirm('Fikri silmek istediğinize emin misiniz?')) return;
    await fetch(`/notes/api/software/${currentPageData.id}/ideas/${ideaId}`, { method: 'DELETE' });
    await renderSoftwareViewWeb(currentPageData.id);
}

function openAddSoftwareRuleModalWeb() {
    const title = prompt('Kural Başlığı:');
    if (!title) return;
    const content = prompt('Kural Açıklaması / Şartlar:');
    const severity = prompt('Önem Derecesi (MUST, SHOULD, NEVER):', 'MUST');
    fetch(`/notes/api/software/${currentPageData.id}/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content: content || '', severity: severity || 'MUST', category: 'Architecture' })
    }).then(() => renderSoftwareViewWeb(currentPageData.id));
}

function openAddSoftwareTaskModalWeb() {
    const title = prompt('Görev Başlığı:');
    if (!title) return;
    const desc = prompt('Açıklama:');
    const prio = prompt('Öncelik (low, medium, high, critical):', 'medium');
    const agent = prompt('Atanan Ajan / Kişi:', 'Antigravity');
    fetch(`/notes/api/software/${currentPageData.id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: desc || '', priority: prio || 'medium', assigned_agent: agent || '' })
    }).then(() => renderSoftwareViewWeb(currentPageData.id));
}

function openAddSoftwareIdeaModalWeb() {
    const title = prompt('Fikir Başlığı:');
    if (!title) return;
    const desc = prompt('Açıklama:');
    fetch(`/notes/api/software/${currentPageData.id}/ideas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: desc || '', category: 'Feature', status: 'draft' })
    }).then(() => renderSoftwareViewWeb(currentPageData.id));
}

function openSoftwareSettingsModalWeb() {
    if (!webCurrentSoftwareData || !webCurrentSoftwareData.project) return;
    const p = webCurrentSoftwareData.project;
    const path = prompt('Yerel Depo Dizini (Repo Path):', p.repo_path || '/home/turan/101');
    if (path === null) return;
    const stack = prompt('Teknoloji Yığını (Tech Stack):', p.tech_stack || 'Python, Flask, SQLite');
    const arch = prompt('Sistem Mimarisi Notu:', p.system_architecture || '');
    fetch(`/notes/api/software/${currentPageData.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo_path: path, tech_stack: stack || '', system_architecture: arch || '' })
    }).then(() => renderSoftwareViewWeb(currentPageData.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// POWER PACKS: Sabitleme (Pin), Sayfa Kilidi (PIN), Ekler, Hedef, Zaman Tüneli
// ─────────────────────────────────────────────────────────────────────────────

async function toggleCurrentPagePin() {
    if (!currentPageId) return;
    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/pin`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            currentPageData.is_pinned = data.is_pinned;
            renderPageHeader();
            loadPagesList();
            showUndoToast(data.is_pinned ? '📌 Sayfa başa sabitlendi' : '📌 Sabitleme kaldırıldı', null);
        }
    } catch (e) {
        console.error("Pin hatası:", e);
    }
}

function promptPageLock() {
    if (!currentPageId) return;
    const desc = document.getElementById('page-lock-modal-desc');
    const removeBtn = document.getElementById('btn-page-unlock-remove');
    const pinInp = document.getElementById('page-lock-modal-pin');
    const errEl = document.getElementById('page-lock-modal-err');

    if (errEl) errEl.style.display = 'none';
    if (pinInp) pinInp.value = '';

    if (currentPageData && currentPageData.is_locked) {
        if (desc) desc.textContent = 'Bu sayfa kilitli. PIN değiştirebilir veya kilidi tamamen kaldırabilirsiniz:';
        if (removeBtn) removeBtn.style.display = 'block';
    } else {
        if (desc) desc.textContent = 'Bu sayfayı kilitlemek için 4 haneli bir PIN kodu belirleyin:';
        if (removeBtn) removeBtn.style.display = 'none';
    }
    openModal('modal-page-lock-set');
    if (pinInp) setTimeout(() => pinInp.focus(), 200);
}

async function submitPageLockSet() {
    const pinInp = document.getElementById('page-lock-modal-pin');
    const pin = pinInp ? pinInp.value.trim() : '';
    const errEl = document.getElementById('page-lock-modal-err');
    if (!pin || pin.length < 4) {
        if (errEl) { errEl.textContent = 'PIN en az 4 haneli olmalıdır.'; errEl.style.display = 'block'; }
        return;
    }
    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/lock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin, action: 'lock' })
        });
        const data = await res.json();
        if (data.ok) {
            currentPageData.is_locked = 1;
            closeModal('modal-page-lock-set');
            renderPageHeader();
            showUndoToast('🔒 Sayfa kilitlendi', null);
        } else {
            if (errEl) { errEl.textContent = data.error || 'İşlem başarısız'; errEl.style.display = 'block'; }
        }
    } catch (e) {
        if (errEl) { errEl.textContent = 'Bağlantı hatası'; errEl.style.display = 'block'; }
    }
}

async function submitPageLockRemove() {
    if (!confirm('Sayfa kilidini kaldırmak istediğinize emin misiniz?')) return;
    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/lock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'unlock' })
        });
        const data = await res.json();
        if (data.ok) {
            currentPageData.is_locked = 0;
            closeModal('modal-page-lock-set');
            renderPageHeader();
            showUndoToast('🔓 Sayfa kilidi kaldırıldı', null);
        }
    } catch (e) {
        console.error("Kilit kaldırma hatası:", e);
    }
}

async function submitUnlockPagePin() {
    const pinInp = document.getElementById('locked-page-pin-input');
    const pin = pinInp ? pinInp.value.trim() : '';
    const errEl = document.getElementById('locked-pin-error');
    if (!pin) return;
    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/verify-lock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin })
        });
        const data = await res.json();
        if (data.ok && data.page) {
            currentPageData = data.page;
            currentItems = data.items || [];
            document.getElementById('note-locked-view').style.display = 'none';
            document.getElementById('note-unlocked-content-wrap').style.display = 'block';
            renderNoteEditor();
            loadAttachmentsList();
        } else {
            if (errEl) {
                errEl.textContent = data.error || 'Hatalı PIN kodu';
                errEl.style.display = 'block';
            }
        }
    } catch (e) {
        if (errEl) {
            errEl.textContent = 'Bağlantı hatası';
            errEl.style.display = 'block';
        }
    }
}

function promptWordGoal() {
    if (!currentPageId) return;
    const curTarget = (currentPageData && currentPageData.target_word_count) ? currentPageData.target_word_count : 0;
    const val = prompt('Hedef kelime sayısı girin (Kaldırmak için 0):', curTarget > 0 ? curTarget : '1000');
    if (val === null) return;
    const target = parseInt(val, 10);
    if (isNaN(target) || target < 0) return;

    fetch(`/notes/api/pages/${currentPageId}/word-count-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
    }).then(r => r.json()).then(data => {
        if (data.ok) {
            currentPageData.target_word_count = target;
            updateNoteStats();
            showUndoToast(target > 0 ? `🎯 Hedef belirlendi: ${target} kelime` : '🎯 Hedef kaldırıldı', null);
        }
    });
}

function insertToggleBlock() {
    const editor = document.getElementById('note-rich-editor');
    if (!editor) return;
    const title = prompt('Katlanabilir Başlık:', '▶️ Bölüm Başlığı') || 'Bölüm';
    const html = `<details class="note-toggle" open><summary>${escapeHtml(title)}</summary><p>Bu alana gizlenebilir detayları yazabilirsiniz...</p></details><p><br></p>`;
    document.execCommand('insertHTML', false, html);
    editor.focus();
}

function promptSmartClip() {
    const box = document.getElementById('smart-clip-preview-box');
    const stat = document.getElementById('smart-clip-status');
    const inp = document.getElementById('smart-clip-url-input');
    if (box) box.style.display = 'none';
    if (stat) stat.style.display = 'none';
    if (inp) inp.value = '';
    openModal('modal-smart-clip');
    if (inp) setTimeout(() => inp.focus(), 200);
}

async function submitSmartClip() {
    const inp = document.getElementById('smart-clip-url-input');
    const url = inp ? inp.value.trim() : '';
    const stat = document.getElementById('smart-clip-status');
    const btn = document.getElementById('btn-smart-clip-submit');
    if (!url) return;

    if (stat) { stat.textContent = 'Bağlantı ve meta veriler çözümleniyor...'; stat.style.display = 'block'; }
    if (btn) btn.disabled = true;

    try {
        const res = await fetch('/notes/api/tools/clip_url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (data.ok && data.card) {
            const c = data.card;
            const thumbHtml = c.image_url ? `<div class="bookmark-card-thumb" style="background-image:url('${c.image_url}');"></div>` : '';
            const cardHtml = `
                <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer" class="bookmark-card">
                    ${thumbHtml}
                    <div class="bookmark-card-info">
                        <div class="bookmark-card-title">${escapeHtml(c.title || c.url)}</div>
                        <div class="bookmark-card-desc">${escapeHtml(c.description || '')}</div>
                        <div class="bookmark-card-source">🔗 ${escapeHtml(c.site_name || 'Web')} &bull; ${new URL(c.url).hostname}</div>
                    </div>
                </a><p><br></p>
            `;
            const editor = document.getElementById('note-rich-editor');
            if (editor) {
                editor.focus();
                document.execCommand('insertHTML', false, cardHtml);
                handleRichNoteInput();
            }
            closeModal('modal-smart-clip');
            showUndoToast('🔗 Yer imi notunuza eklendi', null);
        } else {
            if (stat) stat.textContent = data.error || 'Bağlantı alınamadı.';
        }
    } catch (e) {
        if (stat) stat.textContent = 'Hata: URL çözümlenemedi.';
    } finally {
        if (btn) btn.disabled = false;
    }
}

function toggleAttachmentsTray(forceState) {
    const bar = document.getElementById('note-attachments-bar');
    if (!bar) return;
    if (forceState !== undefined) {
        bar.style.display = forceState ? 'block' : 'none';
    } else {
        bar.style.display = (bar.style.display === 'none' || !bar.style.display) ? 'block' : 'none';
    }
    if (bar.style.display === 'block') {
        loadAttachmentsList();
    }
}

async function loadAttachmentsList() {
    if (!currentPageId) return;
    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/attachments`);
        const data = await res.json();
        if (data.ok && data.attachments) {
            const listEl = document.getElementById('note-attachments-list');
            const countEl = document.getElementById('note-attachments-count');
            if (countEl) countEl.textContent = data.attachments.length;
            if (listEl) {
                if (data.attachments.length === 0) {
                    listEl.innerHTML = '<span style="font-size:0.78rem; color:var(--muted); font-style:italic;">Henüz ekli belge veya PDF yok.</span>';
                    return;
                }
                listEl.innerHTML = data.attachments.map(att => {
                    const isPdf = att.filename.toLowerCase().endsWith('.pdf') || att.mime_type.includes('pdf');
                    const icon = isPdf ? '📄' : (att.filename.match(/\.(zip|tar|gz)$/i) ? '📦' : '📎');
                    const sizeKb = Math.round((att.file_size || 0) / 1024);
                    const clickAction = isPdf ? `openPdfViewer('${att.file_url}', '${escapeHtml(att.original_name)}')` : `window.open('${att.file_url}', '_blank')`;
                    return `
                        <div class="attachment-chip" title="${escapeHtml(att.original_name)} (${sizeKb} KB)">
                            <span onclick="${clickAction}">${icon} <strong>${escapeHtml(att.original_name)}</strong> <span style="opacity:0.6; font-size:0.7rem;">(${sizeKb} KB)</span></span>
                            <span class="att-del-btn" onclick="deleteAttachment(${att.id})" title="Eki Sil">✕</span>
                        </div>
                    `;
                }).join('');
            }
        }
    } catch (e) {
        console.error("Ekler yüklenemedi:", e);
    }
}

async function handleAttachmentFileSelected(event) {
    const file = event.target.files[0];
    if (!file || !currentPageId) return;
    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/attachments`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.ok) {
            showUndoToast(`📎 ${file.name} başarıyla eklendi`, null);
            loadAttachmentsList();
            document.getElementById('note-attachments-bar').style.display = 'block';
        } else {
            alert(data.error || 'Dosya yüklenemedi');
        }
    } catch (e) {
        alert('Dosya yükleme hatası');
    }
    event.target.value = '';
}

async function deleteAttachment(attId) {
    if (!confirm('Bu eki silmek istediğinize emin misiniz?')) return;
    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/attachments/${attId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
            loadAttachmentsList();
            showUndoToast('Ek silindi', null);
        }
    } catch (e) {
        console.error("Ek silinemedi:", e);
    }
}

function openPdfViewer(fileUrl, filename) {
    const frame = document.getElementById('pdf-viewer-iframe');
    const nameEl = document.getElementById('pdf-viewer-filename');
    const dlLink = document.getElementById('pdf-viewer-download-link');
    if (frame) frame.src = fileUrl;
    if (nameEl) nameEl.textContent = filename || 'PDF Belge';
    if (dlLink) dlLink.href = fileUrl;
    openModal('modal-pdf-viewer');
}

// ─────────────────────────────────────────────────────────────────────────────
// ZAMAN TÜNELİ (Time Machine / Sayfa Versiyon Geçmişi)
// ─────────────────────────────────────────────────────────────────────────────

async function openTimeMachineModal() {
    if (!currentPageId) return;
    openModal('modal-time-machine');
    const listEl = document.getElementById('time-machine-list');
    if (listEl) listEl.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted);">Versiyonlar yükleniyor...</div>';

    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/versions`);
        const data = await res.json();
        if (data.ok && data.versions) {
            if (data.versions.length === 0) {
                listEl.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted); font-style:italic;">Bu sayfa için henüz kaydedilmiş bir önceki versiyon yok. Sayfayı düzenledikçe anlık kopyalar buraya eklenir.</div>';
                return;
            }
            listEl.innerHTML = data.versions.map(v => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:var(--surface2); border:1px solid var(--border); border-radius:8px;">
                    <div>
                        <div style="font-weight:600; font-size:0.85rem; color:var(--text);">${escapeHtml(v.title || 'Başlıksız')}</div>
                        <div style="font-size:0.75rem; color:var(--muted);">${v.created_at} &bull; ${v.char_count || 0} karakter</div>
                    </div>
                    <button class="btn btn-xs btn-primary" onclick="restorePageVersion(${v.id})">↩️ Geri Yükle</button>
                </div>
            `).join('');
        }
    } catch (e) {
        if (listEl) listEl.innerHTML = '<div style="color:var(--danger); text-align:center; padding:20px;">Versiyon geçmişi alınamadı.</div>';
    }
}

async function restorePageVersion(versionId) {
    if (!confirm('Bu versiyonu geri yüklemek istediğinize emin misiniz? Mevcut sayfa bu kopyayla değiştirilecek.')) return;
    try {
        const res = await fetch(`/notes/api/pages/${currentPageId}/versions/${versionId}/restore`, { method: 'POST' });
        const data = await res.json();
        if (data.ok && data.page) {
            currentPageData = data.page;
            renderPageHeader();
            renderNoteEditor();
            closeModal('modal-time-machine');
            showUndoToast('⏳ Sayfa önceki versiyona geri yüklendi!', null);
        } else {
            alert(data.error || 'Geri yüklenemedi');
        }
    } catch (e) {
        alert('Geri yükleme hatası');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// OBSIDIAN BENZERİ İNTERAKTİF ZİHİN AĞI GRAFİĞİ (Mind Map / Graph View)
// ─────────────────────────────────────────────────────────────────────────────

let graphSimData = null;
let graphAnimationId = null;

async function openGraphViewModal() {
    openModal('modal-graph-view');
    await refreshGraphData();
}

async function refreshGraphData() {
    try {
        const nbParam = window.CURRENT_NOTEBOOK_ID ? `?notebook_id=${window.CURRENT_NOTEBOOK_ID}` : '';
        const res = await fetch(`/notes/api/graph${nbParam}`);
        const data = await res.json();
        if (data.ok && data.graph) {
            initGraphRenderer(data.graph);
        }
    } catch (e) {
        console.error("Graf verisi alınamadı:", e);
    }
}

function initGraphRenderer(graph) {
    const canvas = document.getElementById('graph-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Canvas boyutlandırma
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const width = canvas.width;
    const height = canvas.height;

    // Node konumlarını merkez etrafında başlat
    const nodes = graph.nodes.map((n, i) => {
        const angle = (i / graph.nodes.length) * 2 * Math.PI;
        const radius = 100 + Math.random() * 80;
        return {
            ...n,
            x: width / 2 + Math.cos(angle) * radius,
            y: height / 2 + Math.sin(angle) * radius,
            vx: 0,
            vy: 0,
            r: Math.max(8, Math.min(22, 6 + (n.val || 1) * 3))
        };
    });

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const links = graph.links.map(l => ({
        source: nodeMap.get(l.source),
        target: nodeMap.get(l.target)
    })).filter(l => l.source && l.target);

    let scale = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let dragNode = null;
    let lastMouseX = 0;
    let lastMouseY = 0;

    canvas.onmousedown = (e) => {
        const r = canvas.getBoundingClientRect();
        const mx = (e.clientX - r.left - panX) / scale;
        const my = (e.clientY - r.top - panY) / scale;

        // Tıklanan node bul
        dragNode = nodes.find(n => Math.hypot(n.x - mx, n.y - my) <= n.r);
        isDragging = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
    };

    canvas.onmousemove = (e) => {
        if (!isDragging) return;
        if (dragNode) {
            const r = canvas.getBoundingClientRect();
            dragNode.x = (e.clientX - r.left - panX) / scale;
            dragNode.y = (e.clientY - r.top - panY) / scale;
            dragNode.vx = 0;
            dragNode.vy = 0;
        } else {
            panX += (e.clientX - lastMouseX);
            panY += (e.clientY - lastMouseY);
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
        }
    };

    canvas.onmouseup = (e) => {
        if (dragNode) {
            const r = canvas.getBoundingClientRect();
            const mx = (e.clientX - r.left - panX) / scale;
            const my = (e.clientY - r.top - panY) / scale;
            if (Math.hypot(dragNode.x - mx, dragNode.y - my) < 5) {
                // Tıklanan sayfaya git!
                closeModal('modal-graph-view');
                selectPage(dragNode.id);
            }
        }
        isDragging = false;
        dragNode = null;
    };

    canvas.onwheel = (e) => {
        e.preventDefault();
        const zoom = e.deltaY < 0 ? 1.1 : 0.9;
        scale = Math.max(0.3, Math.min(3, scale * zoom));
    };

    if (graphAnimationId) cancelAnimationFrame(graphAnimationId);

    function simulateAndDraw() {
        // Basit Yay ve İtme Simülasyonu (Spring Force Layout)
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            // Merkeze çekim
            a.vx += (width / 2 - a.x) * 0.0005;
            a.vy += (height / 2 - a.y) * 0.0005;

            // Düğümler arası itme (Repulsion)
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist = Math.hypot(dx, dy) || 1;
                if (dist < 220) {
                    const force = (220 - dist) / dist * 0.05;
                    a.vx -= dx * force;
                    a.vy -= dy * force;
                    b.vx += dx * force;
                    b.vy += dy * force;
                }
            }
        }

        // Bağlantılar (Spring Attaction)
        for (const l of links) {
            const dx = l.target.x - l.source.x;
            const dy = l.target.y - l.source.y;
            const dist = Math.hypot(dx, dy) || 1;
            const force = (dist - 80) * 0.005;
            l.source.vx += dx * force;
            l.source.vy += dy * force;
            l.target.vx -= dx * force;
            l.target.vy -= dy * force;
        }

        // Konum güncelle ve sürtünme uygula
        for (const n of nodes) {
            if (n !== dragNode) {
                n.x += n.vx;
                n.y += n.vy;
                n.vx *= 0.88;
                n.vy *= 0.88;
            }
        }

        // Çizim
        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(scale, scale);

        // Çizgiler (Edges)
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
        ctx.lineWidth = 1.5;
        for (const l of links) {
            ctx.beginPath();
            ctx.moveTo(l.source.x, l.source.y);
            ctx.lineTo(l.target.x, l.target.y);
            ctx.stroke();
        }

        // Düğümler (Nodes)
        for (const n of nodes) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
            ctx.fillStyle = n.id === currentPageId ? '#3b82f6' : (n.group || '#94a3b8');
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Etiket
            ctx.font = '11px sans-serif';
            ctx.fillStyle = '#f8fafc';
            ctx.textAlign = 'center';
            ctx.fillText(n.label, n.x, n.y + n.r + 14);
        }

        ctx.restore();
        graphAnimationId = requestAnimationFrame(simulateAndDraw);
    }

    simulateAndDraw();
}

// ─────────────────────────────────────────────────────────────────────────────
// E-POSTA DOĞRULAMA (6 Haneli Kod)
// ─────────────────────────────────────────────────────────────────────────────

async function submitVerifyEmailCode() {
    const inp = document.getElementById('verify-email-code-input');
    const code = inp ? inp.value.trim() : '';
    const stat = document.getElementById('verify-code-status');
    if (!code || code.length < 6) {
        if (stat) { stat.textContent = 'Lütfen 6 haneli kodu girin.'; stat.style.color = 'var(--danger)'; stat.style.display = 'block'; }
        return;
    }
    try {
        const res = await fetch('/notes/api/auth/verify-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (data.ok) {
            if (stat) { stat.textContent = '✓ E-posta başarıyla doğrulandı!'; stat.style.color = 'var(--success)'; stat.style.display = 'block'; }
            setTimeout(() => {
                closeModal('modal-email-verify');
                window.location.reload();
            }, 1000);
        } else {
            if (stat) { stat.textContent = data.error || 'Geçersiz kod'; stat.style.color = 'var(--danger)'; stat.style.display = 'block'; }
        }
    } catch (e) {
        if (stat) { stat.textContent = 'Doğrulama hatası'; stat.style.color = 'var(--danger)'; stat.style.display = 'block'; }
    }
}

async function resendEmailVerificationCode() {
    const stat = document.getElementById('verify-code-status');
    try {
        const res = await fetch('/notes/api/auth/resend-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (data.ok) {
            if (stat) {
                const demoHint = data.code_demo ? ` (Demo Kodu: ${data.code_demo})` : '';
                stat.textContent = `Doğrulama kodu tekrar gönderildi!${demoHint}`;
                stat.style.color = 'var(--primary)';
                stat.style.display = 'block';
            }
        }
    } catch (e) {
        if (stat) { stat.textContent = 'Kod gönderilemedi.'; stat.style.color = 'var(--danger)'; stat.style.display = 'block'; }
    }
}




