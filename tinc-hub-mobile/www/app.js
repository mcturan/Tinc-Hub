/**
 * TincNote Mobile — Ana Uygulama Mantığı (app.js)
 * Aydınlık Tema, Floating Sidebar Drawer, Çoklu Not Defteri ve Akordeon Hiyerarşi
 */

let activeView = 'ozet'; // 'page', 'ozet', 'kasa', 'trash', 'settings'
let activeNotebookId = 1;
let activePageId = null;
let activePageObj = null;
let openCategoryIds = new Set();
let activeVaultScope = 'all';
let activeVaultFolder = null;
let currentFinancePeriod = '';
let currentFinanceFilter = 'all';
let currentProjectTab = 'milestones';
let currentProjectData = null;
let projectConceptSaveTimeout = null;
let noteSaveTimeout = null;
let newPageType = 'checklist';

function formatMoney(amount) {
    const num = parseFloat(amount) || 0;
    return num.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. IndexedDB Başlat
    await window.appStorage.init();

    // 2. Finans Dönemi
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    currentFinancePeriod = `${y}-${m}`;

    // 3. Aktif Defteri Al
    activeNotebookId = (await window.appStorage.getActiveNotebookId()) || 1;

    // 4. Senkronizasyon Durum Dinleyicisi
    window.appSync.onStatusChange((status, msg) => {
        updateSyncBadge(status, msg);
    });

    // 5. Tarih Gösterimi
    updateDateDisplay();

    // 6. Sol Çekmece Ağacını (Defterler & Kategoriler & Sayfalar) Yükle
    await reloadDrawerNavigation();

    // 7. İlk Görünüm: Widget tıklaması varsa oraya git, yoksa Özet
    isAppReady = true;

    let targetAction = null;
    let targetPageId = 0;

    // A) Android Native köprüsünden bekleyen widget tıklaması var mı?
    if (window.AndroidWidgetBridge && window.AndroidWidgetBridge.consumePendingAction) {
        try {
            targetAction = window.AndroidWidgetBridge.consumePendingAction();
            targetPageId = window.AndroidWidgetBridge.consumePendingPageId();
        } catch (e) {}
    }

    // B) Javascript tarafında bekleyen eylem var mı?
    if (!targetAction && window.pendingWidgetAction) {
        targetAction = window.pendingWidgetAction.action;
        targetPageId = window.pendingWidgetAction.extra;
        window.pendingWidgetAction = null;
    }

    if (targetAction === 'open_quick') {
        await openQuickNotesView();
    } else if (targetAction === 'quick_add') {
        await openQuickNotesView();
        setTimeout(() => {
            const input = document.getElementById('input-quick-task');
            if (input) {
                input.focus();
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 150);
    } else if (targetAction === 'open_page' && targetPageId > 0) {
        await openPage(targetPageId);
    } else {
        await openOverviewView();
    }

    // 7.5. Yerel depodaki görevleri ANINDA widget'a aktar (Beklemeden, çevrimdışı dahi çalışır)
    syncWidgetData();

    // 8. Arka Planda Eşitle (Sunucuya Bağlan)
    window.appSync.syncNow().then(async () => {
        await reloadDrawerNavigation();
        if (activeView === 'ozet') await renderOverview();
        else if (activeView === 'quick') await renderQuickNotesView();
        else if (activeView === 'page' && activePageId) await renderActivePage();
    }).catch(e => console.warn('İlk eşitleme arka plan:', e));

    // 9. Güncelleme Kontrolü (Sessiz)
    setTimeout(() => {
        if (window.appUpdater) window.appUpdater.checkForUpdates(true);
    }, 4000);

    // 10. Android Donanım Geri Tuşu Yönetimi (Stepped Back Navigation)
    setupBackButtonListener();
});

// ─────────────────────────────────────────────────────────────────────────────
// Donanım / Sistem Geri Tuşu Mantığı (Stepped Back Navigation)
// İstek:
// 1. Sayfa içindeyken geriye basınca: direkt çıkmasın, önce sol menüyü açsın.
// 2. Sol menü açıkken tekrar basınca: özet sayfasına dönsün ve menüyü kapatsın.
// 3. Özet sayfasında (menü kapalıyken) basınca: uygulamadan çıksın.
// ─────────────────────────────────────────────────────────────────────────────
function setupBackButtonListener() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        try {
            window.Capacitor.Plugins.App.addListener('backButton', () => {
                handleHardwareBack();
            });
        } catch (e) {
            console.warn("Capacitor App addListener error:", e);
        }
    }

    document.addEventListener('backbutton', (e) => {
        if (e && e.preventDefault) e.preventDefault();
        handleHardwareBack();
    }, false);
}

function handleHardwareBack() {
    // 1. Açık herhangi bir modal varsa önce modalı kapat
    const activeModal = document.querySelector('.modal-overlay.active');
    if (activeModal) {
        activeModal.classList.remove('active');
        return;
    }

    const drawer = document.getElementById('sidebar-drawer');
    const isDrawerOpen = drawer && drawer.classList.contains('open');

    // 2. Sayfa, Kasa, Çöp veya Ayarlar görünümündeysek
    if (activeView !== 'ozet') {
        if (!isDrawerOpen) {
            // Adım 1: Önce sol menüyü aç
            toggleSidebar(true);
        } else {
            // Adım 2: Sol menü açıkken tekrar basılırsa özet sayfasına dön ve menüyü kapat
            toggleSidebar(false);
            openOverviewView();
        }
        return;
    }

    // 3. Özet sayfasındayken
    if (isDrawerOpen) {
        // Sol menü açıksa önce menüyü kapat
        toggleSidebar(false);
        return;
    }

    // Adım 3: Özet ekranında ve menü kapalıyken uygulamadan çık
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        window.Capacitor.Plugins.App.exitApp();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Android Ana Ekran Widget Köprüsü (Home Screen AppWidget Sync)
// ─────────────────────────────────────────────────────────────────────────────
async function syncWidgetData() {
    try {
        if (!window.AndroidWidgetBridge || !window.AndroidWidgetBridge.updateWidgetData) return;

        // Widget'tan gelen bekleyen tıklamalar varsa uygula
        if (window.AndroidWidgetBridge.getPendingWidgetToggles) {
            try {
                const pendingStr = window.AndroidWidgetBridge.getPendingWidgetToggles();
                if (pendingStr && pendingStr !== "[]") {
                    const toggles = JSON.parse(pendingStr);
                    for (const tog of toggles) {
                        await window.appStorage.toggleUnifiedTask(tog.task_type, tog.raw_id);
                    }
                    if (toggles.length > 0 && window.appSync) {
                        window.appSync.syncNow();
                    }
                }
            } catch (e) {
                console.warn("getPendingWidgetToggles error:", e);
            }
        }

        if (window.AndroidWidgetBridge.setServerUrl && window.appSync) {
            const serverUrl = await window.appSync.getServerUrl();
            if (serverUrl) {
                window.AndroidWidgetBridge.setServerUrl(serverUrl);
            }
        }

        const tasks = await window.appStorage.getUnifiedTasks();
        const activeTasks = tasks.filter(t => !t.is_done);

        const payload = {
            total_count: activeTasks.length,
            tasks: tasks
        };

        window.AndroidWidgetBridge.updateWidgetData(JSON.stringify(payload));
    } catch (e) {
        console.warn("syncWidgetData error:", e);
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        syncWidgetData();
    }
});

window.pendingWidgetAction = null;
let isAppReady = false;

window.handleWidgetAction = (action, extra) => {
    if (!isAppReady) {
        window.pendingWidgetAction = { action, extra };
        return;
    }
    if (action === 'open_page' && extra && extra > 0) {
        openPage(parseInt(extra, 10));
    } else if (action === 'quick_add') {
        openQuickNotesView().then(() => {
            const input = document.getElementById('input-quick-task');
            if (input) {
                input.focus();
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    } else {
        openQuickNotesView();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// ⚡ Hızlı Notlar & Görevler Görünümü (Quick Hub)
// ─────────────────────────────────────────────────────────────────────────────
let quickNotesDebounce = null;

async function openQuickNotesView() {
    switchMainView('quick');
    toggleSidebar(false);

    const navQuick = document.getElementById('drawer-nav-quick');
    if (navQuick) navQuick.classList.add('active');

    document.getElementById('top-title').innerHTML = `<span>⚡</span> Hızlı Notlar &amp; Görevler`;
    document.getElementById('top-subtitle').innerText = 'Hızlı Notlar, Görevler ve Tarih Sıralı İşler';

    await renderQuickNotesView();
}

async function renderQuickNotesView() {
    // 1. Basit Hızlı Notlar Listesi (Quick Notes Inbox)
    const quickNotes = await window.appStorage.getQuickNotesList(activeNotebookId);
    const notesCountTag = document.getElementById('quick-notes-count-tag');
    if (notesCountTag) notesCountTag.innerText = `${quickNotes.length} Not`;

    const notesListEl = document.getElementById('quick-notes-list');
    if (notesListEl) {
        if (quickNotes.length === 0) {
            notesListEl.innerHTML = `<div class="empty-hint">Henüz hızlı not eklenmedi. Yukarıdan hemen yazıp ekleyin ✨</div>`;
        } else {
            notesListEl.innerHTML = quickNotes.map(n => {
                const timeStr = n.created_at ? new Date(n.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';
                return `
                    <div class="overview-item" style="padding:10px 12px; display:flex; align-items:flex-start; justify-content:space-between; gap:10px; border-radius:10px; margin-bottom:6px;">
                        <div style="flex:1; min-width:0;">
                            <div style="font-size:0.9rem; color:var(--text); white-space:pre-wrap; word-break:break-word; line-height:1.4;">
                                ${escapeHtml(n.content)}
                            </div>
                            <div style="font-size:0.72rem; color:var(--muted); margin-top:4px;">
                                🕒 ${timeStr}
                            </div>
                        </div>
                        <div style="display:flex; gap:6px; flex-shrink:0;">
                            <button class="btn btn-secondary btn-sm" onclick="openTransferQuickNoteModal(${n.id})" title="Sayfaya Aktar" style="padding:4px 8px; font-size:0.78rem;">📁 Aktar</button>
                            <button class="btn btn-ghost btn-sm" onclick="deleteQuickNoteFromUI(${n.id})" title="Sil" style="padding:4px 8px; color:var(--danger);">🗑️</button>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // 2. Doğrudan Hızlı Görevler (Hızlı Notlar ve Görevler kategorisindeki 'Hızlı Görevler' sayfası)
    let quickPage = await getOrCreateQuickPage();
    let quickItems = [];
    if (quickPage) {
        quickItems = await window.appStorage.getItems(quickPage.id);
    }
    const directActive = quickItems.filter(i => !i.is_done);

    const countTag = document.getElementById('quick-tasks-count-tag');
    if (countTag) countTag.innerText = `${directActive.length} Görev`;

    const directListEl = document.getElementById('quick-direct-tasks-list');
    if (directListEl) {
        if (quickItems.length === 0) {
            directListEl.innerHTML = `<div class="empty-hint">Henüz hızlı görev eklenmedi. Yukarıdan hemen yazıp ekleyin ✨</div>`;
        } else {
            directListEl.innerHTML = quickItems.map(it => `
                <div class="checklist-item-card ${it.is_done ? 'done' : ''}" style="margin-bottom:6px;">
                    <div class="checkbox-custom" onclick="toggleQuickDirectItem(${it.id})">
                        ${it.is_done ? '✓' : ''}
                    </div>
                    <div class="checklist-item-body" onclick="toggleQuickDirectItem(${it.id})">
                        <div class="checklist-item-title">${escapeHtml(it.title)}</div>
                    </div>
                    <div class="checklist-item-actions">
                        <button class="item-action-btn" onclick="deleteQuickDirectItem(${it.id})" title="Sil">🗑️</button>
                    </div>
                </div>
            `).join('');
        }
    }

    // 3. Kategori ve Sayfalardan Gelen Görevler (Tarih Sıralı)
    const unifiedTasks = await window.appStorage.getUnifiedTasks();
    const externalTasks = unifiedTasks.filter(t => !quickPage || t.page_id !== quickPage.id);

    const unifiedListEl = document.getElementById('quick-unified-tasks-list');
    if (unifiedListEl) {
        if (externalTasks.length === 0) {
            unifiedListEl.innerHTML = `<div class="empty-hint">Diğer sayfalarda bekleyen görev veya vadesi yaklaşan ödeme yok ✨</div>`;
        } else {
            unifiedListEl.innerHTML = externalTasks.map(t => {
                let badgeColor = 'var(--text-secondary)';
                if (t.due_badge && t.due_badge.includes('Gecikmiş')) badgeColor = 'var(--danger)';
                else if (t.due_badge && (t.due_badge.includes('Yarın') || t.due_badge.includes('Bugün'))) badgeColor = '#d97706';
                else if (t.due_badge && t.due_badge.includes('Hızlı Görev')) badgeColor = 'var(--accent)';

                return `
                    <div class="overview-item" style="padding:10px 12px; margin-bottom:6px; cursor:pointer;" onclick="openPage(${t.page_id})">
                        <div style="display:flex; align-items:center; gap:10px; overflow:hidden; flex:1;">
                            <div class="checkbox-custom ${t.is_done ? 'checked' : ''}" onclick="event.stopPropagation(); toggleUnifiedTaskFromUI('${t.type}', ${t.raw_id})">
                                ${t.is_done ? '✓' : ''}
                            </div>
                            <div style="overflow:hidden; display:flex; flex-direction:column; gap:2px;">
                                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:0.9rem; color:var(--text); ${t.is_done ? 'text-decoration:line-through; opacity:0.6;' : ''}">
                                    ${escapeHtml(t.title)}
                                </span>
                                <div style="display:flex; align-items:center; gap:6px; font-size:0.75rem;">
                                    ${t.due_badge ? `<span style="font-weight:700; color:${badgeColor};">${escapeHtml(t.due_badge)}</span>` : ''}
                                    <span style="color:var(--muted);">📁 ${escapeHtml(t.page_title)}</span>
                                </div>
                            </div>
                        </div>
                        <span style="color:var(--muted); font-size:0.8rem;">➔</span>
                    </div>
                `;
            }).join('');
        }
    }

    syncWidgetData();
}

async function addQuickNoteFromInput() {
    const input = document.getElementById('input-quick-note');
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;

    await window.appStorage.addQuickNote(content, activeNotebookId);
    input.value = '';
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
}

async function deleteQuickNoteFromUI(noteId) {
    if (!confirm('Bu hızlı notu silmek istediğinize emin misiniz?')) return;
    await window.appStorage.deleteQuickNote(noteId);
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
}

async function openTransferQuickNoteModal(noteId) {
    const note = await window.appStorage.get('quick_notes', noteId);
    if (!note) return;

    document.getElementById('mobile-transfer-note-id').value = noteId;
    document.getElementById('mobile-transfer-note-preview').innerText = note.content;

    // Hedef sayfaları doldur
    const cats = await window.appStorage.getCategories(activeNotebookId);
    const catMap = {};
    cats.forEach(c => catMap[c.id] = c.name);

    const pages = await window.appStorage.getAll('pages');
    const activePages = pages.filter(p => !p._deleted && catMap[p.category_id]);
    const pageSelect = document.getElementById('mobile-transfer-target-page');
    if (pageSelect) {
        if (activePages.length === 0) {
            pageSelect.innerHTML = '<option value="">(Mevcut sayfa bulunamadı)</option>';
        } else {
            pageSelect.innerHTML = activePages.map(p => {
                const catName = catMap[p.category_id] || 'Kategori';
                const typeLabel = p.type === 'checklist' ? '✓ Görev Listesi' : '📝 Not';
                return `<option value="${p.id}">${escapeHtml(catName)} / ${escapeHtml(p.title)} (${typeLabel})</option>`;
            }).join('');
        }
    }

    // Hedef kategorileri doldur
    const catSelect = document.getElementById('mobile-transfer-target-category');
    if (catSelect) {
        catSelect.innerHTML = cats.map(c => `
            <option value="${c.id}">${c.icon || '📁'} ${escapeHtml(c.name)}</option>
        `).join('');
    }

    // Alanları sıfırla
    const titleInput = document.getElementById('mobile-transfer-new-page-title');
    if (titleInput) titleInput.value = '';
    toggleMobileTransferMode('existing');

    openModal('modal-transfer-quick-note');
}

function toggleMobileTransferMode(mode) {
    const existingDiv = document.getElementById('mobile-transfer-mode-existing');
    const newDiv = document.getElementById('mobile-transfer-mode-new');
    if (mode === 'existing') {
        if (existingDiv) existingDiv.style.display = 'block';
        if (newDiv) newDiv.style.display = 'none';
    } else {
        if (existingDiv) existingDiv.style.display = 'none';
        if (newDiv) newDiv.style.display = 'block';
    }
}

async function submitTransferQuickNote() {
    const noteId = Number(document.getElementById('mobile-transfer-note-id').value);
    if (!noteId) return;

    const modeRadios = document.getElementsByName('mobile-transfer-mode');
    let mode = 'existing';
    for (const r of modeRadios) {
        if (r.checked) mode = r.value;
    }

    if (mode === 'existing') {
        const pageId = Number(document.getElementById('mobile-transfer-target-page').value);
        if (!pageId) {
            alert('Lütfen bir hedef sayfa seçin.');
            return;
        }
        await window.appStorage.moveQuickNote(noteId, pageId, null, null);
    } else {
        const catId = Number(document.getElementById('mobile-transfer-target-category').value);
        const newTitle = document.getElementById('mobile-transfer-new-page-title').value.trim();
        if (!catId) {
            alert('Lütfen bir kategori seçin.');
            return;
        }
        if (!newTitle) {
            alert('Lütfen yeni sayfa için bir başlık girin.');
            return;
        }
        await window.appStorage.moveQuickNote(noteId, null, catId, newTitle);
    }

    closeModal('modal-transfer-quick-note');
    await renderQuickNotesView();
    if (activeView === 'ozet') await renderOverview();
    if (window.appSync) window.appSync.syncNow();
    if (typeof showToast === 'function') showToast('Not başarıyla aktarıldı ✓');
}

async function getOrCreateQuickPage() {
    const cats = await window.appStorage.getAll('categories');
    let quickCat = cats.find(c => (c.name === 'Hızlı Notlar ve Görevler' || c.name === 'Hızlı Notlar' || c.name === 'Genel Notlar') && (!c.notebook_id || Number(c.notebook_id) === Number(activeNotebookId)) && !c._deleted);
    if (!quickCat) {
        quickCat = {
            id: Date.now(),
            notebook_id: activeNotebookId,
            name: 'Hızlı Notlar ve Görevler',
            icon: '⚡',
            color: '#f59e0b',
            sort_order: 99,
            _dirty: true,
            _deleted: false,
            created_at: new Date().toISOString()
        };
        await window.appStorage.put('categories', quickCat);
    }
    const pages = await window.appStorage.getAll('pages');
    let page = pages.find(p => p.category_id === quickCat.id && !p._deleted);
    if (!page) {
        page = {
            id: Date.now() + 1,
            category_id: quickCat.id,
            title: 'Hızlı Görevler',
            type: 'checklist',
            icon: '⚡',
            content: '',
            sort_order: 1,
            is_archived: 0,
            _dirty: true,
            _deleted: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        await window.appStorage.put('pages', page);
    }
    return page;
}

function onQuickNotesInput(text) {
    // Eski textarea desteği için korundu
}

async function addQuickTaskFromInput() {
    const input = document.getElementById('input-quick-task');
    if (!input) return;
    const title = input.value.trim();
    if (!title) return;

    let quickPage = await getOrCreateQuickPage();
    if (!quickPage) return;

    await window.appStorage.addItem({
        page_id: quickPage.id,
        title: title,
        quantity: '',
        price: '',
        url: ''
    });

    input.value = '';
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
}

async function toggleQuickDirectItem(itemId) {
    await window.appStorage.toggleItemDone(itemId);
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
}

async function deleteQuickDirectItem(itemId) {
    await window.appStorage.deleteItem(itemId);
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
}

async function toggleUnifiedTaskFromUI(taskType, rawId) {
    await window.appStorage.toggleUnifiedTask(taskType, rawId);
    await renderQuickNotesView();
    if (window.appSync) window.appSync.syncNow();
}


// ─────────────────────────────────────────────────────────────────────────────
// Tarih ve Durum Rozeti
// ─────────────────────────────────────────────────────────────────────────────
function updateDateDisplay() {
    const el = document.getElementById('welcome-date-label');
    if (!el) return;
    const now = new Date();
    const opts = { weekday: 'long', day: 'numeric', month: 'long' };
    el.innerText = now.toLocaleDateString('tr-TR', opts);
}

function updateSyncBadge(status, msg) {
    const badge = document.getElementById('sync-badge');
    if (!badge) return;
    badge.className = `sync-badge ${status}`;
    if (status === 'online') {
        badge.innerHTML = `🟢 <span>${msg || 'Eşitlendi'}</span>`;
    } else if (status === 'syncing') {
        badge.innerHTML = `🔄 <span>Eşitleniyor...</span>`;
    } else if (status === 'error') {
        badge.innerHTML = `⚠️ <span>Hata</span>`;
        badge.title = msg;
    } else {
        badge.innerHTML = `⚪ <span>Çevrimdışı</span>`;
        badge.title = msg;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sol Floating Drawer (Çekmece Menü) Aç / Kapa
// ─────────────────────────────────────────────────────────────────────────────
function toggleSidebar(open) {
    const drawer = document.getElementById('sidebar-drawer');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!drawer || !backdrop) return;

    if (open) {
        drawer.classList.add('open');
        backdrop.classList.add('active');
    } else {
        drawer.classList.remove('open');
        backdrop.classList.remove('active');
        closeNotebookDropdown();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Not Defteri Seçici Dropdown (OneNote Mantığı)
// ─────────────────────────────────────────────────────────────────────────────
async function toggleNotebookDropdown(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('drawer-nb-dropdown');
    if (!menu) return;
    const isOpen = menu.classList.contains('active');
    if (isOpen) {
        menu.classList.remove('active');
    } else {
        await renderNotebookDropdownMenu();
        menu.classList.add('active');
    }
}

function closeNotebookDropdown() {
    const menu = document.getElementById('drawer-nb-dropdown');
    if (menu) menu.classList.remove('active');
}

async function renderNotebookDropdownMenu() {
    const menu = document.getElementById('drawer-nb-dropdown');
    if (!menu) return;

    let notebooks = await window.appStorage.getNotebooks();
    if (notebooks.length === 0) {
        notebooks = [{ id: 1, name: 'Not Defterim', icon: '📓', is_default: 1 }];
    }

    let html = notebooks.map(nb => `
        <div class="notebook-item ${nb.id == activeNotebookId ? 'active' : ''}" onclick="selectNotebook(${nb.id})">
            <span style="display:flex; align-items:center; gap:6px;">
                <span>${nb.icon || '📓'}</span>
                <span>${escapeHtml(nb.name)}</span>
            </span>
            ${nb.id == activeNotebookId ? '<span>✓</span>' : ''}
        </div>
    `).join('');

    html += `
        <div class="notebook-add-item" onclick="openAddNotebookModal()">
            <span>＋</span> Yeni Not Defteri Ekle
        </div>
    `;

    menu.innerHTML = html;
}

async function selectNotebook(nbId) {
    activeNotebookId = nbId;
    await window.appStorage.setActiveNotebookId(nbId);
    closeNotebookDropdown();

    // Sunucuya da bildir
    try {
        await window.appSync.apiFetch('/notes/api/notebooks/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notebook_id: nbId })
        });
    } catch (e) {
        console.warn('Notebook switch bildirilemedi:', e);
    }

    await reloadDrawerNavigation();
    await openOverviewView();
    window.appSync.syncNow();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sol Çekmece Ağacı (Defter, Kategoriler, Sayfalar)
// ─────────────────────────────────────────────────────────────────────────────
async function reloadDrawerNavigation() {
    // 1. Defter Başlığını Güncelle
    let notebooks = await window.appStorage.getNotebooks();
    let curNb = notebooks.find(n => n.id == activeNotebookId);
    if (!curNb && notebooks.length > 0) {
        curNb = notebooks[0];
        activeNotebookId = curNb.id;
    }

    const nbNameEl = document.getElementById('drawer-nb-name');
    const nbIconEl = document.getElementById('drawer-nb-icon');
    if (nbNameEl) nbNameEl.innerText = curNb ? curNb.name : 'Not Defterim';
    if (nbIconEl) nbIconEl.innerText = curNb ? (curNb.icon || '📓') : '📓';

    // 2. Kategoriler ve Sayfalar Listesi
    const catContainer = document.getElementById('drawer-categories-list');
    if (!catContainer) return;

    let categories = await window.appStorage.getCategories(activeNotebookId);
    let allPages = await window.appStorage.getAll('pages');
    allPages = allPages.filter(p => !p._deleted);

    if (categories.length === 0) {
        catContainer.innerHTML = `
            <div style="text-align:center; padding:16px 8px; font-size:0.82rem; color:var(--muted);">
                Bu defterde kategori yok.<br>
                <button class="btn btn-ghost btn-sm" onclick="openAddCategoryModal()" style="color:var(--accent); font-weight:700; margin-top:4px;">
                    ＋ Kategori Ekle
                </button>
            </div>
        `;
        return;
    }

    // İlk kategori varsayılan olarak açık olsun
    if (openCategoryIds.size === 0 && categories.length > 0) {
        openCategoryIds.add(categories[0].id);
    }

    catContainer.innerHTML = categories.map(cat => {
        const catPages = allPages.filter(p => p.category_id == cat.id).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        const isOpen = openCategoryIds.has(cat.id);

        let pagesHtml = catPages.map(page => `
            <div class="drawer-page-item ${activePageId == page.id && activeView === 'page' ? 'active' : ''}" onclick="openPage(${page.id})">
                <span style="display:flex; align-items:center; gap:6px; overflow:hidden; text-overflow:ellipsis;">
                    <span>${page.icon || (page.type === 'checklist' ? '🛒' : '📝')}</span>
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(page.title)}</span>
                </span>
                <span style="font-size:0.7rem; color:var(--muted);">${page.type === 'checklist' ? 'Liste' : 'Not'}</span>
            </div>
        `).join('');

        pagesHtml += `
            <div class="drawer-add-page-btn" onclick="openAddPageModal(${cat.id})">
                <span>＋</span> Yeni Sayfa / Liste Ekle
            </div>
        `;

        return `
            <div class="drawer-cat-group ${isOpen ? 'open' : ''}" id="cat-group-${cat.id}">
                <div class="drawer-cat-header" onclick="toggleCategoryAccordion(${cat.id})">
                    <div class="drawer-cat-title">
                        <span class="drawer-cat-arrow">▶</span>
                        <span>${cat.icon || '📁'}</span>
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(cat.name)}</span>
                    </div>
                    <span style="font-size:0.75rem; color:var(--muted); background:var(--surface); padding:2px 6px; border-radius:10px; font-weight:700;">
                        ${catPages.length}
                    </span>
                </div>
                <div class="drawer-cat-pages">
                    ${pagesHtml}
                </div>
            </div>
        `;
    }).join('');
}

function toggleCategoryAccordion(catId) {
    if (openCategoryIds.has(catId)) {
        openCategoryIds.delete(catId);
    } else {
        openCategoryIds.add(catId);
    }
    const group = document.getElementById(`cat-group-${catId}`);
    if (group) {
        group.classList.toggle('open');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Görünüm Değiştiriciler (View Switchers)
// ─────────────────────────────────────────────────────────────────────────────
function switchMainView(viewName) {
    activeView = viewName;
    document.querySelectorAll('.main-view').forEach(el => el.classList.remove('active'));

    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.add('active');

    // Çekmecedeki aktif linkleri sıfırla
    document.querySelectorAll('.drawer-nav-link').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.drawer-page-item').forEach(el => el.classList.remove('active'));

    // Üst Bar Ekle butonunun davranışını ayarla
    const addBtn = document.getElementById('btn-top-add');
    if (addBtn) {
        addBtn.style.display = (viewName === 'settings' || viewName === 'trash') ? 'none' : 'flex';
    }
}

async function openOverviewView() {
    switchMainView('ozet');
    toggleSidebar(false);

    const navOzet = document.getElementById('drawer-nav-ozet');
    if (navOzet) navOzet.classList.add('active');

    document.getElementById('top-title').innerHTML = `<span>📊</span> Genel Bakış`;
    document.getElementById('top-subtitle').innerText = document.getElementById('drawer-nb-name').innerText;

    await renderOverview();
}

async function openPage(pageId) {
    activePageId = pageId;
    switchMainView('page');
    toggleSidebar(false);

    await renderActivePage();
    await reloadDrawerNavigation(); // Aktif sayfa vurgusu için
}

async function openVaultView() {
    switchMainView('kasa');
    toggleSidebar(false);

    document.getElementById('top-title').innerHTML = `<span>🔐</span> Şifre Kasası`;
    document.getElementById('top-subtitle').innerText = 'Kişisel, Aile ve İş Şifreleri';

    await renderVaultGrid();
}

async function openTrashView() {
    switchMainView('trash');
    toggleSidebar(false);

    document.getElementById('top-title').innerHTML = `<span>🗑️</span> Çöp Kutusu`;
    document.getElementById('top-subtitle').innerText = 'Silinen Sayfalar ve Öğeler';

    await renderTrashList();
}

async function openSettingsView() {
    switchMainView('settings');
    toggleSidebar(false);

    document.getElementById('top-title').innerHTML = `<span>⚙️</span> Ayarlar`;
    document.getElementById('top-subtitle').innerText = 'Sunucu Bağlantısı & Sürüm';

    await loadSettingsUI();
}

function handleTopAddClick() {
    if (activeView === 'page' && activePageId && activePageObj) {
        if (activePageObj.type === 'checklist') {
            const input = document.getElementById('page-quick-input');
            if (input) input.focus();
        } else if (activePageObj.type === 'finance') {
            openAddFinanceModal();
        } else if (activePageObj.type === 'project') {
            if (currentProjectTab === 'materials') openAddMaterialModal();
            else openAddMilestoneModal();
        } else {
            const textarea = document.getElementById('page-note-content');
            if (textarea) textarea.focus();
        }
    } else if (activeView === 'kasa') {
        openVaultEditor(null);
    } else {
        openAddPageModal(null);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Sayfa Görünümü (Checklist, Not, Finans & Proje Detayı)
// ─────────────────────────────────────────────────────────────────────────────
async function renderActivePage() {
    if (!activePageId) return;

    const page = await window.appStorage.getPage(activePageId);
    if (!page || page._deleted) {
        await openOverviewView();
        return;
    }
    activePageObj = page;

    // Üst Bar Başlığı
    const categories = await window.appStorage.getAll('categories');
    const cat = categories.find(c => c.id == page.category_id);
    const catName = cat ? cat.name : 'Genel';

    const defaultIcon = page.type === 'checklist' ? '🛒' :
                        page.type === 'finance' ? '💳' :
                        page.type === 'project' ? '🔬' : '📝';

    document.getElementById('top-title').innerHTML = `<span>${page.icon || defaultIcon}</span> ${escapeHtml(page.title)}`;
    document.getElementById('top-subtitle').innerText = `${document.getElementById('drawer-nb-name').innerText} > ${catName}`;

    // Sayfa Başlık Kartı
    document.getElementById('page-view-cat-badge').innerText = catName;
    document.getElementById('page-view-icon').innerText = page.icon || defaultIcon;
    document.getElementById('page-view-title-input').value = page.title || '';

    const isChecklist = (page.type === 'checklist');
    const isNotes = (page.type === 'notes' || page.type === 'note');
    const isFinance = (page.type === 'finance');
    const isProject = (page.type === 'project');

    document.getElementById('page-progress-wrap').style.display = isChecklist ? 'flex' : 'none';
    document.getElementById('page-quick-add-box').style.display = isChecklist ? 'flex' : 'none';
    document.getElementById('page-checklist-container').style.display = isChecklist ? 'flex' : 'none';
    document.getElementById('page-note-container').style.display = isNotes ? 'block' : 'none';
    document.getElementById('page-finance-container').style.display = isFinance ? 'flex' : 'none';
    document.getElementById('page-project-container').style.display = isProject ? 'flex' : 'none';

    if (isChecklist) {
        await renderChecklistItems(page.id);
        fetchChecklistItemsFromServer(page.id);
    } else if (isFinance) {
        await renderFinancePage(page.id);
    } else if (isProject) {
        await renderProjectPage(page.id);
    } else {
        document.getElementById('page-note-content').value = page.content || '';
        fetchPageDetailsFromServer(page.id);
    }
}

async function renderChecklistItems(pageId) {
    const items = await window.appStorage.getItems(pageId);
    const activeItems = items.filter(i => !i.is_done);
    const doneItems = items.filter(i => i.is_done);

    // İlerleme Çubuğu
    const total = items.length;
    const completed = doneItems.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const progressFill = document.getElementById('page-progress-fill');
    const progressText = document.getElementById('page-progress-text');
    const progressPct = document.getElementById('page-progress-percent');

    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) progressText.innerText = `${completed} / ${total} tamamlandı`;
    if (progressPct) progressPct.innerText = `%${pct}`;

    // Aktif Maddeler Listesi
    const listEl = document.getElementById('page-items-list');
    if (!listEl) return;

    if (activeItems.length === 0 && doneItems.length === 0) {
        listEl.innerHTML = `
            <div style="text-align:center; padding:30px 10px; color:var(--muted); font-size:0.9rem;">
                Liste henüz boş.<br>Yukarıdaki kutudan ilk maddeyi ekleyin ✨
            </div>
        `;
    } else {
        listEl.innerHTML = activeItems.map(it => renderChecklistItemHtml(it)).join('');
    }

    // Tamamlananlar Bölümü
    const compSection = document.getElementById('completed-items-section');
    const compList = document.getElementById('page-completed-list');
    const compTitle = document.getElementById('completed-section-title');

    if (compSection && compList && compTitle) {
        if (doneItems.length > 0) {
            compSection.style.display = 'block';
            compTitle.innerText = `✓ Tamamlananlar (${doneItems.length})`;
            compList.innerHTML = doneItems.map(it => renderChecklistItemHtml(it)).join('');
        } else {
            compSection.style.display = 'none';
            compList.innerHTML = '';
        }
    }

    syncWidgetData();
}

function renderChecklistItemHtml(it) {
    let metaBadges = '';
    if (it.price) metaBadges += `<span class="meta-badge price">💰 ${escapeHtml(it.price)}</span>`;
    if (it.quantity) metaBadges += `<span class="meta-badge" style="background:var(--surface2); color:var(--text-secondary);">${escapeHtml(it.quantity)}</span>`;
    if (it.url) metaBadges += `<a href="${escapeHtml(it.url)}" target="_system" class="meta-badge url">🔗 Link</a>`;

    return `
        <div class="checklist-item-card ${it.is_done ? 'done' : ''}" id="item-card-${it.id}">
            <div class="checkbox-custom" onclick="toggleItemDone(${it.id})">
                ${it.is_done ? '✓' : ''}
            </div>
            <div class="checklist-item-body" onclick="toggleItemDone(${it.id})">
                <div class="checklist-item-title">${escapeHtml(it.title)}</div>
                ${metaBadges ? `<div class="checklist-item-meta">${metaBadges}</div>` : ''}
            </div>
            <div class="checklist-item-actions">
                <button class="item-action-btn" onclick="deletePageItem(${it.id})" title="Sil">🗑️</button>
            </div>
        </div>
    `;
}

function toggleCompletedSection() {
    const list = document.getElementById('page-completed-list');
    const arrow = document.getElementById('completed-section-arrow');
    if (!list) return;
    const isHidden = list.style.display === 'none';
    list.style.display = isHidden ? 'flex' : 'none';
    if (arrow) arrow.innerText = isHidden ? '▼' : '▶';
}

async function quickAddCurrentPageItem() {
    const input = document.getElementById('page-quick-input');
    if (!input || !activePageId) return;
    const rawText = input.value.trim();
    if (!rawText) return;

    // Fiyat ve link ayrıştırma (Örn: "Süt 45 TL https://..." veya düz "Ekmek")
    let title = rawText;
    let price = '';
    let url = '';

    const urlMatch = rawText.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
        url = urlMatch[0];
        title = title.replace(url, '').trim();
    }

    const priceMatch = title.match(/(\d+([.,]\d+)?)\s*(TL|tl|₺)/);
    if (priceMatch) {
        price = priceMatch[0];
        title = title.replace(price, '').trim();
    }

    if (!title && url) title = 'İnternet Bağlantısı';

    const newItem = {
        page_id: activePageId,
        title: title || rawText,
        price: price,
        url: url,
        is_done: 0,
        sort_order: 999
    };

    input.value = '';
    await window.appStorage.saveItem(newItem);
    await renderChecklistItems(activePageId);

    // Arka planda sunucuya da ilet
    window.appSync.syncNow();
}

async function toggleItemDone(itemId) {
    await window.appStorage.toggleItemDone(itemId);
    await renderChecklistItems(activePageId);
    window.appSync.syncNow();
}

async function deletePageItem(itemId) {
    await window.appStorage.deleteItem(itemId);
    await renderChecklistItems(activePageId);
    window.appSync.syncNow();
}

async function updateCurrentPageTitle(newTitle) {
    if (!activePageId) return;
    const page = await window.appStorage.getPage(activePageId);
    if (page) {
        page.title = newTitle.trim() || 'İsimsiz Sayfa';
        await window.appStorage.savePage(page);
        document.getElementById('top-title').innerHTML = `<span>${page.icon || '📝'}</span> ${escapeHtml(page.title)}`;
        await reloadDrawerNavigation();
        window.appSync.syncNow();
    }
}

async function autoSaveCurrentNote(content, immediate = false) {
    if (!activePageId) return;
    clearTimeout(noteSaveTimeout);
    const doSave = async () => {
        const page = await window.appStorage.getPage(activePageId);
        if (page) {
            page.content = content;
            await window.appStorage.savePage(page);
            window.appSync.syncNow();
        }
    };
    if (immediate) {
        await doSave();
    } else {
        noteSaveTimeout = setTimeout(doSave, 350);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sunucudan Taze Veri Çekme (Live Online Fallback & Update)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchChecklistItemsFromServer(pageId) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (!isAlive) return;
        const res = await window.appSync.apiFetch(`/notes/api/pages/${pageId}/items`);
        if (res.ok) {
            const data = await res.json();
            if (data.items) {
                for (const it of data.items) {
                    await window.appStorage.put('items', { ...it, _dirty: false, _deleted: false });
                }
                if (activePageId == pageId && activeView === 'page') {
                    await renderChecklistItems(pageId);
                }
            }
        }
    } catch (e) {
        console.warn("fetchChecklistItemsFromServer error:", e);
    }
}

async function fetchPageDetailsFromServer(pageId) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (!isAlive) return;
        const res = await window.appSync.apiFetch(`/notes/api/pages/${pageId}`);
        if (res.ok) {
            const data = await res.json();
            if (data.page) {
                await window.appStorage.put('pages', { ...data.page, _dirty: false, _deleted: false });
                if (activePageId == pageId && activeView === 'page') {
                    const noteContentEl = document.getElementById('page-note-content');
                    if (noteContentEl && noteContentEl.value !== data.page.content) {
                        noteContentEl.value = data.page.content || '';
                    }
                }
            }
        }
    } catch (e) {
        console.warn("fetchPageDetailsFromServer error:", e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finans & Bütçe İşleyicileri (Finance & Budget Handlers)
// ─────────────────────────────────────────────────────────────────────────────
async function renderFinancePage(pageId) {
    if (!pageId) pageId = activePageId;
    if (!pageId) return;

    // 1. Dönem başlığını güncelle
    const disp = document.getElementById('fin-period-display');
    if (disp) disp.innerText = currentFinancePeriod;

    // 2. İlk olarak yerel veriyi göster (Çevrimdışı desteği)
    const allFin = await window.appStorage.getAll('finances');
    let entries = allFin.filter(f => !f._deleted && f.page_id == pageId && (!f.period || f.period === currentFinancePeriod));

    calculateAndShowFinanceSummary(entries);
    renderFinanceListHtml(entries);

    // 3. Sunucuya bağlanıp taze veri çek
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${pageId}/finance?period=${currentFinancePeriod}`);
            if (res.ok) {
                const data = await res.json();
                if (data.entries) {
                    for (const fe of data.entries) {
                        await window.appStorage.put('finances', { ...fe, _dirty: false, _deleted: false });
                    }
                    entries = data.entries;
                    if (data.summary) {
                        applyFinanceSummary(data.summary, entries);
                    } else {
                        calculateAndShowFinanceSummary(entries);
                    }
                    renderFinanceListHtml(entries);
                }
            }
        }
    } catch (e) {
        console.warn("renderFinancePage server error:", e);
    }
}

function calculateAndShowFinanceSummary(entries) {
    const incomes = entries.filter(e => e.entry_type === 'income');
    const expenses = entries.filter(e => e.entry_type === 'expense');
    const totInc = incomes.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const totExp = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const unpaidExp = expenses.filter(e => !e.is_paid).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    applyFinanceSummary({
        total_income: totInc,
        total_expense: totExp,
        net_balance: totInc - totExp,
        unpaid_expense: unpaidExp,
        income_count: incomes.length,
        expense_count: expenses.length
    }, entries);
}

function applyFinanceSummary(summary, entries) {
    const elInc = document.getElementById('fin-kpi-income');
    const elIncSub = document.getElementById('fin-kpi-income-sub');
    const elExp = document.getElementById('fin-kpi-expense');
    const elExpSub = document.getElementById('fin-kpi-expense-sub');
    const elBal = document.getElementById('fin-kpi-balance');
    const elUnp = document.getElementById('fin-kpi-unpaid');
    const elUnpSub = document.getElementById('fin-kpi-unpaid-sub');

    if (elInc) elInc.innerText = `${formatMoney(summary.total_income)} TL`;
    if (elIncSub) elIncSub.innerText = `${summary.income_count || 0} kalem`;
    if (elExp) elExp.innerText = `${formatMoney(summary.total_expense)} TL`;
    if (elExpSub) elExpSub.innerText = `${summary.expense_count || 0} kalem`;
    if (elBal) elBal.innerText = `${formatMoney(summary.net_balance)} TL`;
    if (elUnp) elUnp.innerText = `${formatMoney(summary.unpaid_expense)} TL`;

    const unpaidCount = entries ? entries.filter(e => e.entry_type === 'expense' && !e.is_paid).length : 0;
    if (elUnpSub) elUnpSub.innerText = `${unpaidCount} bekleyen`;
}

function renderFinanceListHtml(entries) {
    const listEl = document.getElementById('page-finance-list');
    if (!listEl) return;

    let filtered = entries;
    if (currentFinanceFilter === 'expense') {
        filtered = entries.filter(e => e.entry_type === 'expense');
    } else if (currentFinanceFilter === 'income') {
        filtered = entries.filter(e => e.entry_type === 'income');
    } else if (currentFinanceFilter === 'unpaid') {
        filtered = entries.filter(e => e.entry_type === 'expense' && !e.is_paid);
    }

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div style="text-align:center; padding:30px 10px; color:var(--muted); font-size:0.9rem;">
                Bu dönemde finans kaydı bulunamadı.<br>Yukarıdaki ➕ Ekle butonuyla yeni kalem ekleyin.
            </div>
        `;
        return;
    }

    listEl.innerHTML = filtered.map(e => renderFinanceEntryCardHtml(e)).join('');
}

function renderFinanceEntryCardHtml(e) {
    const isExpense = e.entry_type === 'expense';
    const amountSign = isExpense ? '-' : '+';
    const amountClass = isExpense ? 'expense' : 'income';
    const typeIcon = isExpense ? '📉' : '📈';
    const isPaid = !!e.is_paid;

    let metaBadges = `<span class="fin-entry-pill">${escapeHtml(e.category || 'Genel')}</span>`;
    if (e.due_day) {
        metaBadges += `<span class="fin-entry-pill">📅 ${e.due_day}. gün</span>`;
    }
    if (e.is_recurring) {
        metaBadges += `<span class="fin-entry-pill">🔄 Düzenli</span>`;
    }
    if (e.notes) {
        metaBadges += `<span class="fin-entry-pill" title="${escapeHtml(e.notes)}">💬 ${escapeHtml(e.notes)}</span>`;
    }

    const payBtnHtml = isExpense ? `
        <button class="fin-pay-btn ${isPaid ? 'paid' : 'unpaid'}" onclick="toggleFinancePaid(${e.id})">
            ${isPaid ? '✓ Ödendi' : '⏳ Bekliyor'}
        </button>
    ` : `
        <span class="fin-entry-pill" style="color:var(--success); font-weight:700;">Gelir</span>
    `;

    return `
        <div class="fin-entry-card" id="fin-entry-${e.id}">
            <div class="fin-entry-left">
                <div class="fin-entry-title-row">
                    <span>${typeIcon}</span>
                    <span class="fin-entry-title">${escapeHtml(e.title)}</span>
                </div>
                <div class="fin-entry-meta">
                    ${metaBadges}
                </div>
            </div>
            <div class="fin-entry-right">
                <div class="fin-entry-amount ${amountClass}">${amountSign}${formatMoney(e.amount)} TL</div>
                <div style="display:flex; align-items:center; gap:6px;">
                    ${payBtnHtml}
                    <button class="btn-ghost" style="padding:4px; font-size:0.85rem;" onclick="deleteFinanceEntry(${e.id})" title="Sil">🗑️</button>
                </div>
            </div>
        </div>
    `;
}

function changeFinancePeriod(delta) {
    const parts = currentFinancePeriod.split('-');
    let year = parseInt(parts[0], 10) || new Date().getFullYear();
    let month = parseInt(parts[1], 10) || (new Date().getMonth() + 1);

    month += delta;
    if (month > 12) {
        month = 1;
        year += 1;
    } else if (month < 1) {
        month = 12;
        year -= 1;
    }

    currentFinancePeriod = `${year}-${String(month).padStart(2, '0')}`;
    renderFinancePage(activePageId);
}

function resetFinancePeriod() {
    const now = new Date();
    currentFinancePeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    renderFinancePage(activePageId);
}

function filterFinanceEntries(filter) {
    currentFinanceFilter = filter;
    ['all', 'expense', 'income', 'unpaid'].forEach(f => {
        const btn = document.getElementById(`fin-filter-${f}`);
        if (btn) btn.classList.toggle('active', f === filter);
    });
    renderFinancePage(activePageId);
}

function openAddFinanceModal() {
    document.getElementById('fin-add-title').value = '';
    document.getElementById('fin-add-amount').value = '';
    document.getElementById('fin-add-notes').value = '';
    document.getElementById('fin-add-dueday').value = '15';
    document.getElementById('fin-add-recurring').checked = true;
    openModal('modal-add-finance');
}

async function submitAddFinanceEntry() {
    const title = document.getElementById('fin-add-title').value.trim();
    const amount = parseFloat(document.getElementById('fin-add-amount').value) || 0;
    const type = document.getElementById('fin-add-type').value;
    const cat = document.getElementById('fin-add-cat').value.trim() || 'Genel';
    const dueDay = parseInt(document.getElementById('fin-add-dueday').value, 10) || 1;
    const isRecurring = document.getElementById('fin-add-recurring').checked;
    const notes = document.getElementById('fin-add-notes').value.trim();

    if (!title || amount <= 0) {
        alert('Lütfen geçerli bir açıklama ve tutar girin.');
        return;
    }

    const payload = {
        entry_type: type,
        title: title,
        amount: amount,
        category: cat,
        due_day: dueDay,
        is_recurring: isRecurring ? 1 : 0,
        period: currentFinancePeriod,
        notes: notes
    };

    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/finance`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const data = await res.json();
                if (data.ok) {
                    closeModal('modal-add-finance');
                    await renderFinancePage(activePageId);
                    window.appSync.syncNow();
                    return;
                }
            }
        }
    } catch (e) {
        console.warn("submitAddFinanceEntry server error, saving locally:", e);
    }

    const localEntry = {
        id: Date.now(),
        page_id: activePageId,
        ...payload,
        is_paid: 0,
        _dirty: true,
        _deleted: false
    };
    await window.appStorage.put('finances', localEntry);
    closeModal('modal-add-finance');
    await renderFinancePage(activePageId);
}

async function toggleFinancePaid(entryId) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/finance/${entryId}/toggle`, { method: 'POST' });
        }
    } catch (e) {
        console.warn("toggleFinancePaid server error:", e);
    }

    const entry = await window.appStorage.get('finances', entryId);
    if (entry) {
        entry.is_paid = entry.is_paid ? 0 : 1;
        entry._dirty = true;
        await window.appStorage.put('finances', entry);
    }
    await renderFinancePage(activePageId);
}

async function deleteFinanceEntry(entryId) {
    if (!confirm('Bu finans kaydını silmek istediğinize emin misiniz?')) return;

    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/finance/${entryId}`, { method: 'DELETE' });
        }
    } catch (e) {
        console.warn("deleteFinanceEntry server error:", e);
    }

    const entry = await window.appStorage.get('finances', entryId);
    if (entry) {
        entry._deleted = true;
        entry._dirty = true;
        await window.appStorage.put('finances', entry);
    }
    await renderFinancePage(activePageId);
}

async function copyRecurringFinanceFromPrev() {
    const parts = currentFinancePeriod.split('-');
    let year = parseInt(parts[0], 10);
    let month = parseInt(parts[1], 10);
    month -= 1;
    if (month < 1) {
        month = 12;
        year -= 1;
    }
    const prevPeriod = `${year}-${String(month).padStart(2, '0')}`;

    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/finance/copy_recurring`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_period: prevPeriod, target_period: currentFinancePeriod })
            });
            const data = await res.json();
            if (data.ok) {
                alert(`${data.copied_count || 0} adet düzenli ödeme bu aya aktarıldı.`);
                await renderFinancePage(activePageId);
                return;
            }
        }
    } catch (e) {
        alert('Sunucuya bağlanılamadı: ' + e.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Proje & Atölye İşleyicileri (Project Handlers)
// ─────────────────────────────────────────────────────────────────────────────
async function renderProjectPage(pageId) {
    if (!pageId) pageId = activePageId;
    if (!pageId) return;

    // Sunucudan veya yerelden proje verisini çek
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${pageId}/project`);
            if (res.ok) {
                const data = await res.json();
                if (data.ok && data.project) {
                    currentProjectData = data.project;
                    await window.appStorage.saveProject({
                        id: pageId,
                        page_id: pageId,
                        data: data.project
                    });
                }
            }
        }
    } catch (e) {
        console.warn("renderProjectPage server fetch error:", e);
    }

    if (!currentProjectData) {
        const cached = await window.appStorage.get('projects', pageId);
        if (cached && cached.data) {
            currentProjectData = cached.data;
        }
    }

    if (!currentProjectData) {
        currentProjectData = {
            details: { status: 'planning', concept: '' },
            milestones: [],
            materials: [],
            stats: { progress_pct: 0, total_milestones: 0, completed_milestones: 0, needed_materials: 0, total_mat_cost: 0 }
        };
    }

    const { details, milestones, materials, stats } = currentProjectData;

    // Header güncelleme
    const statusSelect = document.getElementById('project-status-select');
    if (statusSelect && details) statusSelect.value = details.status || 'planning';

    const progFill = document.getElementById('project-progress-fill');
    const kpiProg = document.getElementById('proj-kpi-prog');
    const kpiMs = document.getElementById('proj-kpi-ms');
    const kpiNeeded = document.getElementById('proj-kpi-needed');
    const kpiCost = document.getElementById('proj-kpi-cost');

    const pct = (stats && stats.progress_pct !== undefined) ? stats.progress_pct : 0;
    if (progFill) progFill.style.width = `${pct}%`;
    if (kpiProg) kpiProg.innerText = `%${pct}`;
    if (kpiMs) kpiMs.innerText = `${stats ? stats.completed_milestones : 0}/${stats ? stats.total_milestones : 0}`;
    if (kpiNeeded) kpiNeeded.innerText = stats ? stats.needed_materials : 0;
    if (kpiCost) kpiCost.innerText = `${formatMoney(stats ? stats.total_mat_cost : 0)} TL`;

    const conceptTextarea = document.getElementById('project-concept-content');
    if (conceptTextarea && details) conceptTextarea.value = details.concept || '';

    // Aşamalar Listesi
    const msList = document.getElementById('project-milestones-list');
    if (msList) {
        if (!milestones || milestones.length === 0) {
            msList.innerHTML = `
                <div style="text-align:center; padding:25px 10px; color:var(--muted); font-size:0.9rem;">
                    Henüz aşama eklenmemiş.<br>Yukarıdaki ➕ Aşama Ekle butonunu kullanın.
                </div>
            `;
        } else {
            msList.innerHTML = milestones.map(m => renderProjectMilestoneCardHtml(m)).join('');
        }
    }

    // Malzemeler Listesi
    const matList = document.getElementById('project-materials-list');
    if (matList) {
        if (!materials || materials.length === 0) {
            matList.innerHTML = `
                <div style="text-align:center; padding:25px 10px; color:var(--muted); font-size:0.9rem;">
                    Henüz malzeme listesi (BOM) eklenmemiş.<br>Yukarıdaki ➕ Malzeme Ekle butonunu kullanın.
                </div>
            `;
        } else {
            matList.innerHTML = materials.map(m => renderProjectMaterialCardHtml(m)).join('');
        }
    }
}

function renderProjectMilestoneCardHtml(m) {
    const isCompleted = m.status === 'completed';
    const statusLabels = {
        pending: '⏳ Bekliyor',
        in_progress: '⚙️ Devam',
        completed: '✅ Tamam'
    };
    const badgeLabel = statusLabels[m.status] || '⏳ Bekliyor';

    let stepsHtml = '';
    if (m.requirements) {
        const lines = m.requirements.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length > 0) {
            stepsHtml = `
                <div style="margin-top:6px; padding:6px 8px; background:var(--surface2); border-radius:6px; font-size:0.78rem;">
                    <div style="font-weight:700; color:var(--muted); margin-bottom:2px;">📋 Adımlar:</div>
                    ${lines.map(l => `<div>• ${escapeHtml(l)}</div>`).join('')}
                </div>
            `;
        }
    }

    return `
        <div class="project-milestone-card ${isCompleted ? 'completed' : ''}" id="milestone-card-${m.id}">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                <div style="display:flex; flex-direction:column; gap:2px; flex:1;">
                    <span class="ms-title" style="font-weight:700; font-size:0.95rem; color:var(--text);">${escapeHtml(m.title)}</span>
                    <div style="display:flex; gap:6px; align-items:center; font-size:0.75rem; color:var(--muted);">
                        ${m.target_date ? `<span>📅 ${escapeHtml(m.target_date)}</span>` : ''}
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    <button class="mat-status-pill ${m.status === 'completed' ? 'available' : m.status === 'in_progress' ? 'ordered' : 'needed'}" onclick="toggleMilestoneStatus(${m.id})">
                        ${badgeLabel}
                    </button>
                    <button class="btn-ghost" style="padding:2px 4px; font-size:0.85rem;" onclick="deleteMilestone(${m.id})" title="Sil">🗑️</button>
                </div>
            </div>
            ${m.description ? `<div style="font-size:0.82rem; color:var(--text-secondary);">${escapeHtml(m.description)}</div>` : ''}
            ${stepsHtml}
        </div>
    `;
}

function renderProjectMaterialCardHtml(m) {
    const statusLabels = {
        needed: '🔍 Aranıyor',
        ordered: '📦 Sipariş',
        available: '✅ Elde Var'
    };
    const badgeLabel = statusLabels[m.status] || '🔍 Aranıyor';
    const unitPrice = parseFloat(m.unit_price) || 0;
    const qty = parseFloat(m.quantity) || 1;
    const totalPrice = unitPrice * qty;

    return `
        <div class="project-material-card" id="mat-card-${m.id}">
            <div style="display:flex; flex-direction:column; gap:2px; flex:1; min-width:0;">
                <div style="font-weight:700; font-size:0.92rem; color:var(--text);">${escapeHtml(m.name)}</div>
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:0.76rem; color:var(--muted);">
                    <span>Miktar: ${escapeHtml(String(m.quantity || '1'))}</span>
                    <span>•</span>
                    <span>Birim: ${formatMoney(unitPrice)} TL</span>
                    ${m.url ? `<a href="${escapeHtml(m.url)}" target="_system" style="color:var(--accent); text-decoration:none; font-weight:600;">🔗 Link</a>` : ''}
                </div>
                ${m.notes ? `<div style="font-size:0.75rem; color:var(--muted);">${escapeHtml(m.notes)}</div>` : ''}
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                <div style="font-size:0.95rem; font-weight:800; color:var(--text);">${formatMoney(totalPrice)} TL</div>
                <div style="display:flex; align-items:center; gap:4px;">
                    <button class="mat-status-pill ${m.status || 'needed'}" onclick="toggleMaterialStatus(${m.id})">
                        ${badgeLabel}
                    </button>
                    <button class="btn-ghost" style="padding:2px 4px; font-size:0.85rem;" onclick="deleteMaterial(${m.id})" title="Sil">🗑️</button>
                </div>
            </div>
        </div>
    `;
}

function switchProjectTab(tabName) {
    currentProjectTab = tabName;
    ['milestones', 'materials', 'concept'].forEach(t => {
        const btn = document.getElementById(`ptab-btn-${t}`);
        const pane = document.getElementById(`project-pane-${t}`);
        if (btn) btn.classList.toggle('active', t === tabName);
        if (pane) pane.style.display = (t === tabName) ? 'block' : 'none';
    });
}

async function updateProjectStatusFromUI(newStatus) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/project`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus })
            });
            await renderProjectPage(activePageId);
        }
    } catch (e) {
        console.warn("updateProjectStatus error:", e);
    }
}

function autoSaveProjectConcept(content) {
    clearTimeout(projectConceptSaveTimeout);
    projectConceptSaveTimeout = setTimeout(async () => {
        try {
            const isAlive = await window.appSync.checkConnection();
            if (isAlive) {
                await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/project`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ concept: content })
                });
            }
        } catch (e) {
            console.warn("autoSaveProjectConcept error:", e);
        }
    }, 600);
}

function openAddMilestoneModal() {
    document.getElementById('ms-add-title').value = '';
    document.getElementById('ms-add-date').value = '';
    document.getElementById('ms-add-desc').value = '';
    document.getElementById('ms-add-reqs').value = '';
    document.getElementById('ms-add-status').value = 'pending';
    openModal('modal-add-milestone');
}

async function submitAddMilestoneEntry() {
    const title = document.getElementById('ms-add-title').value.trim();
    const date = document.getElementById('ms-add-date').value.trim();
    const status = document.getElementById('ms-add-status').value;
    const desc = document.getElementById('ms-add-desc').value.trim();
    const reqs = document.getElementById('ms-add-reqs').value.trim();

    if (!title) {
        alert('Lütfen aşama başlığı girin.');
        return;
    }

    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/project/milestones`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: title,
                    target_date: date,
                    status: status,
                    description: desc,
                    requirements: reqs
                })
            });
            if (res.ok) {
                closeModal('modal-add-milestone');
                await renderProjectPage(activePageId);
                return;
            }
        }
    } catch (e) {
        alert('Hata: ' + e.message);
    }
}

async function toggleMilestoneStatus(milestoneId) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/milestones/${milestoneId}/toggle`, { method: 'POST' });
            await renderProjectPage(activePageId);
        }
    } catch (e) {
        console.warn("toggleMilestoneStatus error:", e);
    }
}

async function deleteMilestone(milestoneId) {
    if (!confirm('Bu aşamayı silmek istediğinize emin misiniz?')) return;
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/milestones/${milestoneId}`, { method: 'DELETE' });
            await renderProjectPage(activePageId);
        }
    } catch (e) {
        console.warn("deleteMilestone error:", e);
    }
}

function openAddMaterialModal() {
    document.getElementById('mat-add-name').value = '';
    document.getElementById('mat-add-qty').value = '1';
    document.getElementById('mat-add-price').value = '';
    document.getElementById('mat-add-status').value = 'needed';
    document.getElementById('mat-add-url').value = '';
    document.getElementById('mat-add-notes').value = '';
    openModal('modal-add-material');
}

async function submitAddMaterialEntry() {
    const name = document.getElementById('mat-add-name').value.trim();
    const qty = document.getElementById('mat-add-qty').value.trim() || '1';
    const price = parseFloat(document.getElementById('mat-add-price').value) || 0;
    const status = document.getElementById('mat-add-status').value;
    const url = document.getElementById('mat-add-url').value.trim();
    const notes = document.getElementById('mat-add-notes').value.trim();

    if (!name) {
        alert('Lütfen malzeme veya parça adı girin.');
        return;
    }

    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            const res = await window.appSync.apiFetch(`/notes/api/pages/${activePageId}/project/materials`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name,
                    quantity: qty,
                    unit_price: price,
                    status: status,
                    url: url,
                    notes: notes
                })
            });
            if (res.ok) {
                closeModal('modal-add-material');
                await renderProjectPage(activePageId);
                return;
            }
        }
    } catch (e) {
        alert('Hata: ' + e.message);
    }
}

async function toggleMaterialStatus(materialId) {
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/materials/${materialId}/toggle`, { method: 'POST' });
            await renderProjectPage(activePageId);
        }
    } catch (e) {
        console.warn("toggleMaterialStatus error:", e);
    }
}

async function deleteMaterial(materialId) {
    if (!confirm('Bu malzemeyi silmek istediğinize emin misiniz?')) return;
    try {
        const isAlive = await window.appSync.checkConnection();
        if (isAlive) {
            await window.appSync.apiFetch(`/notes/api/materials/${materialId}`, { method: 'DELETE' });
            await renderProjectPage(activePageId);
        }
    } catch (e) {
        console.warn("deleteMaterial error:", e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Özet Dashboard Görünümü
// ─────────────────────────────────────────────────────────────────────────────
async function renderOverview() {
    const pages = await window.appStorage.getAll('pages');
    const activePages = pages.filter(p => !p._deleted);
    const items = await window.appStorage.getAll('items');
    const activeItems = items.filter(i => !i._deleted);
    const pendingItems = activeItems.filter(i => !i.is_done);
    const vault = await window.appStorage.getAll('vault');

    // KPI
    const elPages = document.getElementById('kpi-pages-count');
    const elTasks = document.getElementById('kpi-tasks-count');
    const elVault = document.getElementById('kpi-vault-count');

    if (elPages) elPages.innerText = activePages.length;
    if (elTasks) elTasks.innerText = pendingItems.length;
    if (elVault) elVault.innerText = vault.length;

    // Bekleyen Görevler
    const taskListEl = document.getElementById('overview-tasks-list');
    if (taskListEl) {
        if (pendingItems.length === 0) {
            taskListEl.innerHTML = `<div class="empty-hint">Bekleyen yapılacak görev yok ✨</div>`;
        } else {
            taskListEl.innerHTML = pendingItems.slice(0, 8).map(it => `
                <div class="overview-item" style="cursor:pointer;" onclick="openPage(${it.page_id})">
                    <div style="display:flex; align-items:center; gap:10px; overflow:hidden; flex:1;">
                        <div class="checkbox-custom ${it.is_done ? 'checked' : ''}" onclick="event.stopPropagation(); toggleOverviewItemDone(${it.id})">
                            ${it.is_done ? '✓' : ''}
                        </div>
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; font-size:0.9rem; ${it.is_done ? 'text-decoration:line-through; opacity:0.6;' : ''}">
                            ${escapeHtml(it.title)}
                        </span>
                    </div>
                    <span style="color:var(--muted); font-size:0.75rem;">➔</span>
                </div>
            `).join('');
        }
    }

    // Son Değiştirilen Sayfalar
    const recentListEl = document.getElementById('overview-recent-list');
    if (recentListEl) {
        if (activePages.length === 0) {
            recentListEl.innerHTML = `<div class="empty-hint">Henüz eklenmiş sayfa yok</div>`;
        } else {
            recentListEl.innerHTML = activePages.slice(0, 5).map(p => `
                <div class="overview-item" onclick="openPage(${p.id})">
                    <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
                        <span>${p.icon || '📝'}</span>
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600;">${escapeHtml(p.title)}</span>
                    </div>
                    <span style="font-size:0.72rem; color:var(--muted);">${p.type === 'checklist' ? 'Liste' : 'Not'}</span>
                </div>
            `).join('');
        }
    }

    syncWidgetData();
}

async function toggleOverviewItemDone(itemId) {
    const it = await window.appStorage.get('items', itemId);
    if (it) {
        it.is_done = it.is_done ? 0 : 1;
        it._dirty = true;
        await window.appStorage.put('items', it);
        await renderOverview();
        window.appSync.syncNow();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Şifre Kasası Görünümü
// ─────────────────────────────────────────────────────────────────────────────
function filterVaultScope(scope) {
    activeVaultScope = scope;
    document.querySelectorAll('.scope-pill').forEach(el => el.classList.remove('active'));
    event.target.classList.add('active');
    renderVaultGrid();
}

async function renderVaultGrid() {
    const grid = document.getElementById('vault-entries-grid');
    if (!grid) return;

    let entries = await window.appStorage.getAll('vault');
    entries = entries.filter(e => !e._deleted);

    if (activeVaultScope !== 'all') {
        entries = entries.filter(e => e.scope === activeVaultScope);
    }

    if (entries.length === 0) {
        grid.innerHTML = `<div class="empty-hint">Kayıtlı şifre bulunmuyor ✨</div>`;
        return;
    }

    grid.innerHTML = entries.map(e => `
        <div class="vault-card">
            <div class="vault-card-header">
                <div class="vault-card-title">
                    <span>${e.icon || '🔐'}</span>
                    <span>${escapeHtml(e.title)}</span>
                </div>
                <span class="meta-badge" style="background:var(--surface2); color:var(--muted);">${e.scope || 'Kişisel'}</span>
            </div>

            <div class="vault-field-row">
                <span style="color:var(--muted); font-size:0.8rem;">Kullanıcı:</span>
                <div style="display:flex; align-items:center; gap:6px;">
                    <span class="vault-field-val">${escapeHtml(e.username || '-')}</span>
                    <button class="item-action-btn" onclick="copyToClipboard('${escapeHtml(e.username || '')}')" title="Kopyala">📋</button>
                </div>
            </div>

            <div class="vault-field-row">
                <span style="color:var(--muted); font-size:0.8rem;">Şifre:</span>
                <div style="display:flex; align-items:center; gap:6px;">
                    <span class="vault-field-val" id="vault-pwd-${e.id}">••••••••</span>
                    <button class="item-action-btn" onclick="togglePasswordVisibility(${e.id}, '${escapeHtml(e.password || '')}')" title="Göster">👁️</button>
                    <button class="item-action-btn" onclick="copyToClipboard('${escapeHtml(e.password || '')}')" title="Kopyala">📋</button>
                </div>
            </div>
        </div>
    `).join('');
}

function togglePasswordVisibility(id, clearPwd) {
    const el = document.getElementById(`vault-pwd-${id}`);
    if (!el) return;
    if (el.innerText === '••••••••') {
        el.innerText = clearPwd;
    } else {
        el.innerText = '••••••••';
    }
}

function copyToClipboard(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        alert('Panoya kopyalandı! 📋');
    }).catch(() => {
        alert('Kopyalanamadı.');
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Çöp Kutusu Görünümü
// ─────────────────────────────────────────────────────────────────────────────
async function renderTrashList() {
    const list = document.getElementById('trash-items-list');
    if (!list) return;

    const allPages = await window.appStorage.getAll('pages');
    const deletedPages = allPages.filter(p => p._deleted);

    const allItems = await window.appStorage.getAll('items');
    const deletedItems = allItems.filter(i => i._deleted);

    if (deletedPages.length === 0 && deletedItems.length === 0) {
        list.innerHTML = `<div class="empty-hint">Çöp kutusu boş ✨</div>`;
        return;
    }

    let html = '';
    deletedPages.forEach(p => {
        html += `
            <div class="overview-item">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span>📄</span>
                    <span>${escapeHtml(p.title)} (Sayfa)</span>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="restorePage(${p.id})">Geri Yükle</button>
            </div>
        `;
    });

    deletedItems.forEach(i => {
        html += `
            <div class="overview-item">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span>☑️</span>
                    <span>${escapeHtml(i.title)} (Madde)</span>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="restoreItem(${i.id})">Geri Yükle</button>
            </div>
        `;
    });

    list.innerHTML = html;
}

async function restorePage(pageId) {
    const page = await window.appStorage.getPage(pageId);
    if (page) {
        page._deleted = false;
        page._dirty = true;
        await window.appStorage.savePage(page);
        await renderTrashList();
        await reloadDrawerNavigation();
        window.appSync.syncNow();
    }
}

async function restoreItem(itemId) {
    const item = await window.appStorage.get('items', itemId);
    if (item) {
        item._deleted = false;
        item._dirty = true;
        await window.appStorage.saveItem(item);
        await renderTrashList();
        window.appSync.syncNow();
    }
}

async function confirmEmptyTrash() {
    if (confirm('Çöp kutusundaki tüm silinmiş öğeleri kalıcı olarak temizlemek istediğinize emin misiniz?')) {
        const allPages = await window.appStorage.getAll('pages');
        for (const p of allPages.filter(p => p._deleted)) {
            await window.appStorage.delete('pages', p.id);
        }
        const allItems = await window.appStorage.getAll('items');
        for (const i of allItems.filter(i => i._deleted)) {
            await window.appStorage.delete('items', i.id);
        }
        await renderTrashList();
        alert('Çöp kutusu boşaltıldı.');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Ayarlar
// ─────────────────────────────────────────────────────────────────────────────
async function loadSettingsUI() {
    const url = await window.appSync.getServerUrl();
    const input = document.getElementById('cfg-server-url');
    if (input) input.value = url;

    // Sürüm etiketi
    const verLabel = document.getElementById('app-version-label');
    if (verLabel && window.appUpdater) {
        verLabel.innerText = `v${window.appUpdater.currentVersion}`;
    }

    // Depolama istatistikleri
    const statsEl = document.getElementById('storage-stats-label');
    if (statsEl) {
        const p = await window.appStorage.getAll('pages');
        const it = await window.appStorage.getAll('items');
        const v = await window.appStorage.getAll('vault');
        statsEl.innerText = `${p.length} Sayfa, ${it.length} Madde, ${v.length} Şifre (Yerel IndexedDB)`;
    }

    // Kullanıcı Oturum Bilgisi
    await refreshMobileAuthUI();
}

function quickFillHostIP() {
    const input = document.getElementById('cfg-server-url');
    if (input) input.value = 'http://192.168.1.10:9013';
}

async function saveSettingsFromUI(showAlert = true) {
    const input = document.getElementById('cfg-server-url');
    if (input) {
        let val = input.value.trim();
        if (val) {
            if (!val.startsWith('http://') && !val.startsWith('https://')) {
                val = 'http://' + val;
            }
            while (val.endsWith('/')) val = val.slice(0, -1);
            if (val.endsWith('/notes')) val = val.slice(0, -6);
            while (val.endsWith('/')) val = val.slice(0, -1);
        } else {
            val = 'http://192.168.1.10:9013';
        }
        input.value = val;
        await window.appStorage.setSetting('server_url', val);
        if (showAlert) {
            alert('Ayarlar kaydedildi! ✅');
        }
        window.appSync.syncNow();
    }
}

async function testConnectionFromUI() {
    const btn = document.getElementById('btn-test-conn');
    const diag = document.getElementById('connection-diag-box');
    if (btn) btn.innerText = 'Test ediliyor...';

    await saveSettingsFromUI(false);
    const targetUrl = await window.appSync.getServerUrl();
    const ok = await window.appSync.checkConnection();

    if (btn) btn.innerText = '🔌 Test Et';
    if (diag) {
        diag.style.display = 'block';
        if (ok) {
            diag.innerHTML = `🟢 <strong>Bağlantı Başarılı!</strong><br><span style="font-size:0.75rem; color:var(--text); opacity:0.85;">${escapeHtml(targetUrl)} adresine erişildi. Senkronizasyon devrede.</span>`;
            diag.style.color = 'var(--success)';
        } else {
            diag.innerHTML = `🔴 <strong>Bağlantı Kurulamadı!</strong><br><span style="font-size:0.75rem; color:var(--text); opacity:0.85;">Hedef: ${escapeHtml(targetUrl)}<br>Telefonunuzun aynı Wi-Fi ağında veya VPN'de olduğunu kontrol edin.</span>`;
            diag.style.color = 'var(--danger)';
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal İşlemleri (Defter, Kategori, Sayfa Ekleme)
// ─────────────────────────────────────────────────────────────────────────────
function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
}

function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
}

function openAddNotebookModal() {
    closeNotebookDropdown();
    openModal('modal-add-notebook');
}

async function submitCreateNotebook() {
    const nameInput = document.getElementById('new-nb-name');
    const iconInput = document.getElementById('new-nb-icon');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        alert('Lütfen defter adı yazın.');
        return;
    }

    const newNb = {
        id: Date.now(),
        name: name,
        icon: (iconInput ? iconInput.value.trim() : '') || '📓',
        sort_order: 99
    };

    await window.appStorage.saveNotebook(newNb);
    activeNotebookId = newNb.id;
    await window.appStorage.setActiveNotebookId(newNb.id);

    closeModal('modal-add-notebook');
    if (nameInput) nameInput.value = '';

    await reloadDrawerNavigation();
    await openOverviewView();
    window.appSync.syncNow();
}

function openAddCategoryModal() {
    openModal('modal-add-category');
}

async function submitCreateCategory() {
    const nameInput = document.getElementById('new-cat-name');
    const iconInput = document.getElementById('new-cat-icon');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        alert('Lütfen kategori adı yazın.');
        return;
    }

    const newCat = {
        id: Date.now(),
        notebook_id: activeNotebookId,
        name: name,
        icon: (iconInput ? iconInput.value.trim() : '') || '📁',
        sort_order: 99
    };

    await window.appStorage.saveCategory(newCat);
    openCategoryIds.add(newCat.id);

    closeModal('modal-add-category');
    if (nameInput) nameInput.value = '';

    await reloadDrawerNavigation();
    window.appSync.syncNow();
}

function openAddPageModal(catId) {
    const catInput = document.getElementById('new-page-cat-id');
    if (catInput) catInput.value = catId || '';
    openModal('modal-add-page');
}

function selectNewPageType(type) {
    newPageType = type;
    const btnCheck = document.getElementById('btn-type-checklist');
    const btnNotes = document.getElementById('btn-type-notes');
    const btnFin = document.getElementById('btn-type-finance');
    const btnProj = document.getElementById('btn-type-project');

    if (btnCheck) btnCheck.classList.toggle('active', type === 'checklist');
    if (btnNotes) btnNotes.classList.toggle('active', type === 'notes');
    if (btnFin) btnFin.classList.toggle('active', type === 'finance');
    if (btnProj) btnProj.classList.toggle('active', type === 'project');
}

async function submitCreatePage() {
    const titleInput = document.getElementById('new-page-title');
    const catInput = document.getElementById('new-page-cat-id');
    const title = titleInput ? titleInput.value.trim() : '';

    if (!title) {
        alert('Lütfen sayfa başlığı yazın.');
        return;
    }

    let catId = catInput && catInput.value ? parseInt(catInput.value, 10) : null;
    if (!catId) {
        const cats = await window.appStorage.getCategories(activeNotebookId);
        if (cats.length > 0) catId = cats[0].id;
        else {
            const defaultCat = await window.appStorage.saveCategory({
                id: Date.now(),
                notebook_id: activeNotebookId,
                name: 'Hızlı Notlar',
                icon: '⚡'
            });
            catId = defaultCat.id;
        }
    }

    const typeIcons = {
        checklist: '🛒',
        notes: '📝',
        finance: '💳',
        project: '🔬'
    };

    const newPage = {
        id: Date.now(),
        category_id: catId,
        title: title,
        type: newPageType,
        icon: typeIcons[newPageType] || '📝',
        content: '',
        sort_order: 99
    };

    await window.appStorage.savePage(newPage);
    openCategoryIds.add(catId);

    closeModal('modal-add-page');
    if (titleInput) titleInput.value = '';

    await reloadDrawerNavigation();
    await openPage(newPage.id);
    window.appSync.syncNow();
}

// ─────────────────────────────────────────────────────────────────────────────
// Kasa Modal İşlemleri
// ─────────────────────────────────────────────────────────────────────────────
function openVaultEditor(id) {
    document.getElementById('vault-edit-id').value = id || '';
    document.getElementById('vault-edit-title').value = '';
    document.getElementById('vault-edit-username').value = '';
    document.getElementById('vault-edit-password').value = '';
    document.getElementById('vault-edit-folder').value = '';
    document.getElementById('vault-modal-title').innerText = id ? '🔐 Şifreyi Düzenle' : '🔐 Yeni Şifre Kaydı';
    openModal('modal-vault-editor');
}

async function submitSaveVault() {
    const id = document.getElementById('vault-edit-id').value;
    const title = document.getElementById('vault-edit-title').value.trim();
    const username = document.getElementById('vault-edit-username').value.trim();
    const password = document.getElementById('vault-edit-password').value.trim();
    const scope = document.getElementById('vault-edit-scope').value;
    const folder = document.getElementById('vault-edit-folder').value.trim();

    if (!title) {
        alert('Lütfen başlık girin.');
        return;
    }

    const entry = {
        id: id ? parseInt(id, 10) : Date.now(),
        title: title,
        username: username,
        password: password,
        scope: scope,
        folder_name: folder,
        icon: '🔐'
    };

    await window.appStorage.saveVaultEntry(entry);
    closeModal('modal-vault-editor');
    await renderVaultGrid();
    window.appSync.syncNow();
}

// ─────────────────────────────────────────────────────────────────────────────
// Arama Modal
// ─────────────────────────────────────────────────────────────────────────────
function openSearchModal() {
    openModal('modal-search');
    const input = document.getElementById('global-search-input');
    if (input) {
        input.value = '';
        input.focus();
    }
    document.getElementById('global-search-results').innerHTML = '';
}

async function handleGlobalSearch(q) {
    const results = document.getElementById('global-search-results');
    if (!results) return;
    q = (q || '').trim().toLowerCase();
    if (!q) {
        results.innerHTML = '';
        return;
    }

    const pages = await window.appStorage.getAll('pages');
    const items = await window.appStorage.getAll('items');
    const vault = await window.appStorage.getAll('vault');

    const matchedPages = pages.filter(p => !p._deleted && (p.title || '').toLowerCase().includes(q));
    const matchedItems = items.filter(i => !i._deleted && (i.title || '').toLowerCase().includes(q));
    const matchedVault = vault.filter(v => !v._deleted && ((v.title || '').toLowerCase().includes(q) || (v.username || '').toLowerCase().includes(q)));

    let html = '';
    matchedPages.forEach(p => {
        html += `
            <div class="overview-item" onclick="closeModal('modal-search'); openPage(${p.id})">
                <span>${p.icon || '📝'} ${escapeHtml(p.title)} (Sayfa)</span>
                <span>➔</span>
            </div>
        `;
    });

    matchedItems.forEach(i => {
        html += `
            <div class="overview-item" onclick="closeModal('modal-search'); openPage(${i.page_id})">
                <span>☑️ ${escapeHtml(i.title)} (Madde)</span>
                <span>➔</span>
            </div>
        `;
    });

    matchedVault.forEach(v => {
        html += `
            <div class="overview-item" onclick="closeModal('modal-search'); openVaultView()">
                <span>🔐 ${escapeHtml(v.title)} (Kasa)</span>
                <span>➔</span>
            </div>
        `;
    });

    results.innerHTML = html || `<div class="empty-hint">Eşleşen sonuç bulunamadı</div>`;
}

// Yardımcı Güvenlik
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── Mobil Çoklu Kullanıcı & Oturum ──
let currentMobileAuthTab = 'login';

function switchMobileAuthTab(tab) {
    currentMobileAuthTab = tab;
    const btnLogin = document.getElementById('btn-m-tab-login');
    const btnReg = document.getElementById('btn-m-tab-reg');
    const regGroup = document.getElementById('mobile-reg-group');
    const submitBtn = document.getElementById('btn-m-auth-submit');
    const msg = document.getElementById('m-auth-msg');
    if (msg) msg.style.display = 'none';

    if (tab === 'login') {
        if (btnLogin) { btnLogin.classList.add('btn-primary'); btnLogin.classList.remove('btn-secondary'); }
        if (btnReg) { btnReg.classList.add('btn-secondary'); btnReg.classList.remove('btn-primary'); }
        if (regGroup) regGroup.style.display = 'none';
        if (submitBtn) submitBtn.innerText = '🔑 Giriş Yap';
    } else {
        if (btnLogin) { btnLogin.classList.add('btn-secondary'); btnLogin.classList.remove('btn-primary'); }
        if (btnReg) { btnReg.classList.add('btn-primary'); btnReg.classList.remove('btn-secondary'); }
        if (regGroup) regGroup.style.display = 'block';
        if (submitBtn) submitBtn.innerText = '✨ Hesap Oluştur';
    }
}

async function refreshMobileAuthUI() {
    const token = await window.appStorage.getSetting('auth_token', '');
    const userJson = await window.appStorage.getSetting('user_profile', '');
    const loggedInBox = document.getElementById('mobile-auth-logged-in');
    const formBox = document.getElementById('mobile-auth-form');

    if (token && userJson) {
        try {
            const user = JSON.parse(userJson);
            const nameEl = document.getElementById('mobile-user-name');
            const roleEl = document.getElementById('mobile-user-role');
            if (nameEl) nameEl.innerText = user.display_name || user.username;
            if (roleEl) roleEl.innerText = `@${user.username} (${user.role || 'Kullanıcı'})`;
            if (loggedInBox) loggedInBox.style.display = 'block';
            if (formBox) formBox.style.display = 'none';
            return;
        } catch (e) {}
    }

    if (loggedInBox) loggedInBox.style.display = 'none';
    if (formBox) formBox.style.display = 'block';
}

async function handleMobileAuthSubmit() {
    const uInput = document.getElementById('m-auth-user');
    const pInput = document.getElementById('m-auth-pass');
    const dInput = document.getElementById('m-auth-display');
    const msg = document.getElementById('m-auth-msg');

    const u = uInput ? uInput.value.trim() : '';
    const p = pInput ? pInput.value.trim() : '';
    const displayName = dInput ? dInput.value.trim() : '';

    if (!u || !p) {
        if (msg) {
            msg.innerText = 'Lütfen kullanıcı adı ve şifre girin';
            msg.style.color = 'var(--danger)';
            msg.style.display = 'block';
        }
        return;
    }

    if (msg) {
        msg.innerText = 'İşlem yapılıyor...';
        msg.style.color = 'var(--primary)';
        msg.style.display = 'block';
    }

    let res;
    if (currentMobileAuthTab === 'login') {
        res = await window.appSync.login(u, p);
    } else {
        res = await window.appSync.register(u, p, displayName);
    }

    if (res.ok) {
        if (msg) {
            msg.innerText = 'Başarılı! Oturum açıldı.';
            msg.style.color = 'var(--success)';
        }
        if (pInput) pInput.value = '';
        await refreshMobileAuthUI();
        window.appSync.syncNow();
    } else {
        if (msg) {
            msg.innerText = res.error || 'İşlem başarısız';
            msg.style.color = 'var(--danger)';
        }
    }
}

async function handleMobileLogout() {
    if (confirm('Oturumu kapatmak istediğinize emin misiniz?')) {
        await window.appSync.logout();
        await refreshMobileAuthUI();
    }
}
