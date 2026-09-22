/**
 * TincNote Mobile — Çevrimdışı (Offline-First) IndexedDB Veri Depolama Motoru
 * Ağ bağlantısı olsun ya da olmasın tüm verileri cihazda yerel saklar.
 */

const DB_NAME = 'tincnote_mobile_db';
const DB_VERSION = 4;

class TincNoteStorage {
    constructor() {
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains('quick_notes')) {
                    const qnStore = db.createObjectStore('quick_notes', { keyPath: 'id' });
                    qnStore.createIndex('notebook_id', 'notebook_id', { unique: false });
                    qnStore.createIndex('_dirty', '_dirty', { unique: false });
                }

                if (!db.objectStoreNames.contains('notebooks')) {
                    const nbStore = db.createObjectStore('notebooks', { keyPath: 'id' });
                    nbStore.createIndex('sort_order', 'sort_order', { unique: false });
                }

                if (!db.objectStoreNames.contains('categories')) {
                    const catStore = db.createObjectStore('categories', { keyPath: 'id' });
                    catStore.createIndex('sort_order', 'sort_order', { unique: false });
                    catStore.createIndex('notebook_id', 'notebook_id', { unique: false });
                }

                if (!db.objectStoreNames.contains('pages')) {
                    const pageStore = db.createObjectStore('pages', { keyPath: 'id' });
                    pageStore.createIndex('category_id', 'category_id', { unique: false });
                    pageStore.createIndex('sort_order', 'sort_order', { unique: false });
                    pageStore.createIndex('_dirty', '_dirty', { unique: false });
                }

                if (!db.objectStoreNames.contains('items')) {
                    const itemStore = db.createObjectStore('items', { keyPath: 'id' });
                    itemStore.createIndex('page_id', 'page_id', { unique: false });
                    itemStore.createIndex('sort_order', 'sort_order', { unique: false });
                    itemStore.createIndex('_dirty', '_dirty', { unique: false });
                }

                if (!db.objectStoreNames.contains('finances')) {
                    const finStore = db.createObjectStore('finances', { keyPath: 'id' });
                    finStore.createIndex('page_id', 'page_id', { unique: false });
                    finStore.createIndex('period', 'period', { unique: false });
                    finStore.createIndex('_dirty', '_dirty', { unique: false });
                }

                if (!db.objectStoreNames.contains('projects')) {
                    const projStore = db.createObjectStore('projects', { keyPath: 'id' });
                    projStore.createIndex('page_id', 'page_id', { unique: false });
                }

                if (!db.objectStoreNames.contains('vault')) {
                    const vaultStore = db.createObjectStore('vault', { keyPath: 'id' });
                    vaultStore.createIndex('scope', 'scope', { unique: false });
                    vaultStore.createIndex('folder_name', 'folder_name', { unique: false });
                    vaultStore.createIndex('profile_name', 'profile_name', { unique: false });
                    vaultStore.createIndex('is_favorite', 'is_favorite', { unique: false });
                    vaultStore.createIndex('_dirty', '_dirty', { unique: false });
                }

                if (!db.objectStoreNames.contains('vault_folders')) {
                    db.createObjectStore('vault_folders', { keyPath: 'name' });
                }

                if (!db.objectStoreNames.contains('overview')) {
                    db.createObjectStore('overview', { keyPath: 'key' });
                }

                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
            };

            request.onsuccess = async (event) => {
                this.db = event.target.result;
                await this.seedDefaultsIfEmpty();
                resolve(this.db);
            };

            request.onerror = (event) => {
                console.error("IndexedDB Başlatılamadı:", event.target.error);
                reject(event.target.error);
            };
        });
    }

    async seedDefaultsIfEmpty() {
        const cats = await this.getAll('categories');
        
        // Migration: Varsa 'Genel Notlar' veya 'Hızlı Notlar' kategorisini 'Hızlı Notlar ve Görevler' olarak güncelle
        for (const cat of cats) {
            if (cat.name === 'Genel Notlar' || cat.name === 'Hızlı Notlar') {
                cat.name = 'Hızlı Notlar ve Görevler';
                cat.icon = '⚡';
                cat.color = '#f59e0b';
                cat._dirty = true;
                await this.put('categories', cat);
            }
        }

        if (cats.length === 0) {
            const now = new Date().toISOString();
            const tempCatId = Date.now(); // Büyük geçici ID — sunucuyla çakışmaz
            const defaultCat = {
                id: tempCatId,
                name: 'Hızlı Notlar ve Görevler',
                icon: '⚡',
                color: '#f59e0b',
                sort_order: 1,
                created_at: now,
                _dirty: true,
                _deleted: false
            };
            await this.put('categories', defaultCat);

            const tempPageId1 = tempCatId + 1;
            const tempPageId2 = tempCatId + 2;

            const welcomePage = {
                id: tempPageId1,
                category_id: tempCatId,
                title: 'TincNote\'a Hoş Geldiniz! 👋',
                type: 'notes',
                icon: '📝',
                content: 'TincNote çevrimdışı öncelikli mobil not ve liste yöneticinizdir.\n\n• İnternet olmadan özgürce not alabilir,\n• Görev listeleri oluşturabilir,\n• TincHub sunucunuza bağlandığınızda otomatik eşitleyebilirsiniz!\n\nAyarlar sekmesinden sunucu IP ve portunuzu tanımlayabilirsiniz.',
                sort_order: 1,
                is_archived: 0,
                created_at: now,
                updated_at: now,
                _dirty: true,
                _deleted: false
            };
            await this.put('pages', welcomePage);

            const todoPage = {
                id: tempPageId2,
                category_id: tempCatId,
                title: 'Yapılacaklar Listesi',
                type: 'checklist',
                icon: '🛒',
                content: '',
                sort_order: 2,
                is_archived: 0,
                created_at: now,
                updated_at: now,
                _dirty: true,
                _deleted: false
            };
            await this.put('pages', todoPage);

            await this.put('items', {
                id: tempCatId + 10,
                page_id: tempPageId2,
                title: 'TincNote mobil uygulamasını keşfet',
                description: '',
                is_done: 1,
                sort_order: 1,
                created_at: now,
                updated_at: now,
                _dirty: true,
                _deleted: false
            });

            await this.put('items', {
                id: tempCatId + 11,
                page_id: tempPageId2,
                title: 'Ayarlar kısmından TincHub sunucu IP adresini gir',
                description: '',
                is_done: 0,
                sort_order: 2,
                created_at: now,
                updated_at: now,
                _dirty: true,
                _deleted: false
            });
        }
    }

    // Generic DB Helpers
    put(storeName, item) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const req = store.put(item);
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    get(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    getAll(storeName) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    delete(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const req = store.delete(key);
            req.onsuccess = () => resolve(true);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    clearStore(storeName) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const req = store.clear();
            req.onsuccess = () => resolve(true);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    // Settings
    async getSetting(key, defaultValue = null) {
        const item = await this.get('settings', key);
        return item ? item.value : defaultValue;
    }

    async setSetting(key, value) {
        return await this.put('settings', { key, value });
    }

    // Notebooks
    async getNotebooks() {
        const nbs = await this.getAll('notebooks');
        return nbs.filter(n => !n._deleted).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    }

    async saveNotebook(nb) {
        if (!nb.id) {
            nb.id = Date.now();
        }
        nb._dirty = true;
        nb.updated_at = new Date().toISOString();
        await this.put('notebooks', nb);
        return nb;
    }

    async deleteNotebook(id) {
        const nb = await this.get('notebooks', id);
        if (nb) {
            nb._deleted = true;
            nb._dirty = true;
            await this.put('notebooks', nb);
        }
    }

    async getActiveNotebookId() {
        return await this.getSetting('active_notebook_id', 1);
    }

    async setActiveNotebookId(id) {
        return await this.setSetting('active_notebook_id', id);
    }

    // Categories
    async getCategories(notebookId = null) {
        const cats = await this.getAll('categories');
        let filtered = cats.filter(c => !c._deleted);
        if (notebookId !== null) {
            filtered = filtered.filter(c => !c.notebook_id || c.notebook_id == notebookId);
        }
        return filtered.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    }

    async saveCategory(cat) {
        if (!cat.id) {
            cat.id = Date.now();
        }
        cat._dirty = true;
        cat.updated_at = new Date().toISOString();
        await this.put('categories', cat);
        return cat;
    }

    async deleteCategory(id) {
        const cat = await this.get('categories', id);
        if (cat) {
            cat._deleted = true;
            cat._dirty = true;
            await this.put('categories', cat);
        }
    }

    async reorderCategories(catIds) {
        for (let idx = 0; idx < catIds.length; idx++) {
            const cat = await this.get('categories', catIds[idx]);
            if (cat) {
                cat.sort_order = idx + 1;
                cat._dirty = true;
                cat.updated_at = new Date().toISOString();
                await this.put('categories', cat);
            }
        }
    }

    // Pages
    async getPages(categoryId = null) {
        const pages = await this.getAll('pages');
        let filtered = pages.filter(p => !p._deleted);
        if (categoryId !== null) {
            filtered = filtered.filter(p => p.category_id == categoryId);
        }
        return filtered.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    }

    async getPage(id) {
        return await this.get('pages', id);
    }

    async savePage(page) {
        if (!page.id) {
            page.id = Date.now();
            page.created_at = new Date().toISOString();
        }
        page._dirty = true;
        page.updated_at = new Date().toISOString();
        await this.put('pages', page);
        return page;
    }

    async deletePage(id) {
        const page = await this.get('pages', id);
        if (page) {
            page._deleted = true;
            page._dirty = true;
            await this.put('pages', page);
        }
    }

    async reorderPages(categoryId, pageIds) {
        for (let idx = 0; idx < pageIds.length; idx++) {
            const page = await this.get('pages', pageIds[idx]);
            if (page) {
                page.category_id = categoryId;
                page.sort_order = idx + 1;
                page._dirty = true;
                page.updated_at = new Date().toISOString();
                await this.put('pages', page);
            }
        }
    }

    async reorderItems(pageId, itemIds) {
        for (let idx = 0; idx < itemIds.length; idx++) {
            const item = await this.get('items', itemIds[idx]);
            if (item) {
                if (pageId) item.page_id = pageId;
                item.sort_order = idx + 1;
                item._dirty = true;
                item.updated_at = new Date().toISOString();
                await this.put('items', item);
            }
        }
    }

    // Items
    async getItems(pageId) {
        const items = await this.getAll('items');
        return items
            .filter(i => !i._deleted && i.page_id == pageId)
            .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    }

    async saveItem(item) {
        if (!item.id) {
            item.id = Date.now();
            item.created_at = new Date().toISOString();
        }
        item._dirty = true;
        item.updated_at = new Date().toISOString();
        await this.put('items', item);
        return item;
    }

    async toggleItemDone(id) {
        const item = await this.get('items', id);
        if (item) {
            item.is_done = item.is_done ? 0 : 1;
            item._dirty = true;
            item.updated_at = new Date().toISOString();
            await this.put('items', item);
            return item;
        }
        return null;
    }

    async deleteItem(id) {
        const item = await this.get('items', id);
        if (item) {
            item._deleted = true;
            item._dirty = true;
            await this.put('items', item);
        }
    }

    // Finances
    async getFinances(pageId) {
        const fins = await this.getAll('finances');
        return fins.filter(f => !f._deleted && (!pageId || f.page_id == pageId));
    }

    async getFinanceEntries(period = null) {
        const all = await this.getAll('finances');
        let list = all.filter(f => !f._deleted);
        if (period) {
            list = list.filter(f => f.period === period);
        }
        return list;
    }

    async saveFinance(fin) {
        if (!fin.id) {
            fin.id = Date.now();
        }
        fin._dirty = true;
        fin.updated_at = new Date().toISOString();
        await this.put('finances', fin);
        return fin;
    }

    async saveFinanceEntry(fin) {
        return await this.saveFinance(fin);
    }

    // Projects
    async getProjects(pageId) {
        const projs = await this.getAll('projects');
        return projs.filter(p => !p._deleted && (!pageId || p.page_id == pageId));
    }

    async saveProject(proj) {
        if (!proj.id) {
            proj.id = Date.now();
        }
        proj._dirty = true;
        proj.updated_at = new Date().toISOString();
        await this.put('projects', proj);
        return proj;
    }

    // Vault Entries
    async getVaultEntries(scope = 'all', folder = 'all', profile = 'all', search = '') {
        const all = await this.getAll('vault');
        let filtered = all.filter(v => !v._deleted);

        if (scope && scope !== 'all') {
            filtered = filtered.filter(v => v.scope === scope);
        }
        if (folder && folder !== 'all') {
            filtered = filtered.filter(v => (v.folder_name === folder || v.folder === folder));
        }
        if (profile && profile !== 'all') {
            filtered = filtered.filter(v => (v.profile_name === profile || v.profile === profile));
        }
        if (search) {
            const s = search.toLowerCase();
            filtered = filtered.filter(v => 
                (v.title && v.title.toLowerCase().includes(s)) ||
                (v.username && v.username.toLowerCase().includes(s)) ||
                (v.notes && v.notes.toLowerCase().includes(s)) ||
                (v.tags && v.tags.toLowerCase().includes(s)) ||
                (v.profile && v.profile.toLowerCase().includes(s)) ||
                (v.profile_name && v.profile_name.toLowerCase().includes(s)) ||
                (v.folder && v.folder.toLowerCase().includes(s)) ||
                (v.folder_name && v.folder_name.toLowerCase().includes(s))
            );
        }

        return filtered.sort((a, b) => (b.is_favorite || 0) - (a.is_favorite || 0));
    }

    async saveVaultEntry(entry) {
        if (!entry.id) {
            entry.id = Date.now();
        }
        entry._dirty = true;
        entry.updated_at = new Date().toISOString();
        await this.put('vault', entry);
        return entry;
    }

    async deleteVaultEntry(id) {
        const entry = await this.get('vault', id);
        if (entry) {
            entry._deleted = true;
            entry._dirty = true;
            await this.put('vault', entry);
        }
    }

    async getVaultFolders() {
        return await this.getAll('vault_folders');
    }

    async saveVaultFolder(folder) {
        await this.put('vault_folders', folder);
    }

    // Overview Cache
    async getOverview() {
        const row = await this.get('overview', 'main');
        return row ? row.data : null;
    }

    async saveOverview(data) {
        await this.put('overview', { key: 'main', data, updated_at: new Date().toISOString() });
    }

    // Hızlı Notlar Listesi (Quick Notes)
    async getQuickNotesList(notebookId = null) {
        const all = await this.getAll('quick_notes');
        const active = all.filter(n => !n._deleted);
        const sortFn = (a, b) => {
            if (a.sort_order && b.sort_order) return a.sort_order - b.sort_order;
            if (a.sort_order) return -1;
            if (b.sort_order) return 1;
            return b.id - a.id;
        };
        if (notebookId) {
            return active.filter(n => Number(n.notebook_id) === Number(notebookId)).sort(sortFn);
        }
        return active.sort(sortFn);
    }

    async reorderQuickNotes(noteIds) {
        for (let idx = 0; idx < noteIds.length; idx++) {
            const note = await this.get('quick_notes', noteIds[idx]);
            if (note) {
                note.sort_order = idx + 1;
                note._dirty = true;
                note.updated_at = new Date().toISOString();
                await this.put('quick_notes', note);
            }
        }
    }

    async addQuickNote(content, notebookId = 1) {
        const note = {
            id: Date.now(),
            notebook_id: notebookId || 1,
            content: content.trim(),
            color: '#ffffff',
            _dirty: true,
            _deleted: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        await this.put('quick_notes', note);
        return note;
    }

    async deleteQuickNote(id) {
        const note = await this.get('quick_notes', id);
        if (note) {
            note._deleted = true;
            note._dirty = true;
            await this.put('quick_notes', note);
        }
    }

    async moveQuickNote(noteId, targetPageId = null, targetCatId = null, newPageTitle = null) {
        const note = await this.get('quick_notes', noteId);
        if (!note) return false;

        if (targetPageId) {
            const page = await this.get('pages', targetPageId);
            if (page) {
                if (page.type === 'checklist') {
                    await this.addItem({
                        page_id: targetPageId,
                        title: note.content,
                        quantity: '',
                        price: '',
                        url: ''
                    });
                } else {
                    const existing = page.content || '';
                    const sep = existing.trim() ? '\n\n---\n' : '';
                    page.content = existing + sep + note.content;
                    page._dirty = true;
                    page.updated_at = new Date().toISOString();
                    await this.put('pages', page);
                }
            }
        } else if (targetCatId && newPageTitle) {
            const newPage = {
                id: Date.now(),
                category_id: targetCatId,
                title: newPageTitle.trim(),
                type: 'notes',
                icon: '📝',
                content: note.content,
                sort_order: 1,
                is_archived: 0,
                _dirty: true,
                _deleted: false,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            await this.put('pages', newPage);
        }

        await this.deleteQuickNote(noteId);
        return true;
    }

    // Birleşik Görevler (Hızlı Notlar + Tüm Sayfalar + Ödemeler - Tarih Sıralı)
    async getUnifiedTasks() {
        const items = await this.getAll('items');
        const activeItems = items.filter(i => !i._deleted && !i.is_done);
        const finances = await this.getAll('finances');
        const activeFinances = finances.filter(f => !f._deleted && !f.is_paid && f.entry_type === 'expense');
        const pages = await this.getAll('pages');
        const categories = await this.getAll('categories');

        const pageMap = {};
        pages.forEach(p => pageMap[p.id] = p);
        const catMap = {};
        categories.forEach(c => catMap[c.id] = c);

        const now = new Date();
        const curYear = now.getFullYear();
        const curMonth = now.getMonth();
        const todayZero = new Date(curYear, curMonth, now.getDate()).getTime();

        const tasks = [];

        // 1. Ödemeler / Faturalar
        for (const f of activeFinances) {
            const page = pageMap[f.page_id] || {};
            const cat = catMap[page.category_id] || {};
            let amtStr = '';
            if (f.amount) {
                amtStr = `${Number(f.amount).toLocaleString('tr-TR')} TL`;
            }
            let displayTitle = `💳 ${f.title || 'Fatura / Ödeme'}`;
            if (amtStr) displayTitle += ` (${amtStr})`;

            let taskDateStr = null;
            let dueBadge = "Ödeme";
            let dueUrgency = 5;

            if (f.due_date) {
                taskDateStr = String(f.due_date).trim();
            } else if (f.due_day) {
                const dayNum = Math.min(Math.max(parseInt(f.due_day, 10) || 1, 1), 28);
                taskDateStr = `${curYear}-${String(curMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
            }

            if (taskDateStr) {
                const parts = taskDateStr.split('-');
                if (parts.length === 3) {
                    const taskDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                    const diffTime = taskDate.getTime() - todayZero;
                    const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

                    if (diffDays < 0) {
                        dueUrgency = 1;
                        dueBadge = `🔴 Gecikmiş (${String(taskDate.getDate()).padStart(2, '0')}.${String(taskDate.getMonth() + 1).padStart(2, '0')})`;
                    } else if (diffDays === 0) {
                        dueUrgency = 2;
                        dueBadge = "🟡 Bugün";
                    } else if (diffDays === 1) {
                        dueUrgency = 3;
                        dueBadge = "🟠 Yarın";
                    } else if (diffDays <= 7) {
                        dueUrgency = 4;
                        dueBadge = `🟢 ${String(taskDate.getDate()).padStart(2, '0')}.${String(taskDate.getMonth() + 1).padStart(2, '0')}`;
                    } else {
                        dueUrgency = 5;
                        dueBadge = `${String(taskDate.getDate()).padStart(2, '0')}.${String(taskDate.getMonth() + 1).padStart(2, '0')}`;
                    }
                }
            }

            tasks.push({
                id: `fin_${f.id}`,
                raw_id: f.id,
                type: 'finance',
                title: displayTitle,
                amount: f.amount,
                page_id: f.page_id,
                page_title: page.title || 'Ödemeler',
                category_name: cat.name || 'Finans',
                is_done: false,
                due_date: taskDateStr,
                due_badge: dueBadge,
                due_urgency: dueUrgency,
                sort_key: `${dueUrgency}_${taskDateStr || '9999-99-99'}_${f.id}`
            });
        }

        // 2. Checklist Görevleri
        for (const it of activeItems) {
            const page = pageMap[it.page_id] || {};
            const cat = catMap[page.category_id] || {};
            const isQuick = (cat.name === 'Hızlı Notlar ve Görevler' || page.title === 'Hızlı Görevler');
            let dueUrgency = isQuick ? 2.5 : 6;
            let dueBadge = isQuick ? '⚡ Hızlı Görev' : (page.title || 'Liste');
            const remindAt = it.remind_at || null;
            const recurrence = it.recurrence || 'none';

            if (remindAt) {
                try {
                    const rDate = new Date(remindAt.replace(' ', 'T'));
                    const isToday = rDate.toDateString() === today.toDateString();
                    const hours = String(rDate.getHours()).padStart(2, '0');
                    const mins = String(rDate.getMinutes()).padStart(2, '0');
                    const day = String(rDate.getDate()).padStart(2, '0');
                    const month = String(rDate.getMonth() + 1).padStart(2, '0');
                    dueBadge = '⏰ ' + (isToday ? `${hours}:${mins}` : `${day}.${month} ${hours}:${mins}`);
                    dueUrgency = isToday ? 1.5 : 2.2;
                } catch(e) {
                    dueBadge = '⏰ ' + remindAt.substring(0, 16);
                    dueUrgency = 2.0;
                }
            }

            tasks.push({
                id: `item_${it.id}`,
                raw_id: it.id,
                type: 'checklist',
                title: it.title || '',
                price: it.price,
                quantity: it.quantity,
                page_id: it.page_id,
                page_title: page.title || 'Liste',
                category_name: cat.name || 'Genel',
                is_done: !!it.is_done,
                due_date: null,
                remind_at: remindAt,
                recurrence: recurrence,
                due_badge: dueBadge,
                due_urgency: dueUrgency,
                sort_key: `${dueUrgency}_9999-99-99_${it.id}`
            });
        }

        // 3. Hızlı Notlar (Quick Notes)
        const quickNotes = await this.getAll('quick_notes');
        const activeQn = quickNotes.filter(n => !n._deleted && n.content);
        for (const qn of activeQn) {
            const firstLine = (qn.content || '').trim().split('\n')[0];
            if (firstLine) {
                tasks.push({
                    id: `qn_${qn.id}`,
                    raw_id: qn.id,
                    type: 'quick_note',
                    title: firstLine,
                    price: null,
                    quantity: null,
                    page_id: 0,
                    page_title: 'Hızlı Not',
                    category_name: 'Notlar',
                    is_done: false,
                    due_date: null,
                    due_badge: '📝 Not',
                    due_urgency: 3.5,
                    sort_key: `3.5_9999-99-99_${qn.id}`
                });
            }
        }

        tasks.sort((a, b) => a.sort_key.localeCompare(b.sort_key));
        return tasks;
    }

    async toggleUnifiedTask(taskType, rawId) {
        if (taskType === 'finance') {
            const f = await this.get('finances', rawId);
            if (f) {
                f.is_paid = f.is_paid ? 0 : 1;
                f._dirty = true;
                await this.put('finances', f);
                return f.is_paid;
            }
        } else {
            const it = await this.get('items', rawId);
            if (it) {
                it.is_done = it.is_done ? 0 : 1;
                it._dirty = true;
                await this.put('items', it);
                return it.is_done;
            }
        }
        return false;
    }

    async setItemReminder(itemId, remindAt, recurrence = 'none') {
        const it = await this.get('items', itemId);
        if (it) {
            it.remind_at = remindAt;
            it.recurrence = recurrence;
            it._dirty = true;
            await this.put('items', it);
            return it;
        }
        return null;
    }

    async deleteItemReminder(itemId) {
        const it = await this.get('items', itemId);
        if (it) {
            it.remind_at = null;
            it.recurrence = 'none';
            it._dirty = true;
            await this.put('items', it);
            return it;
        }
        return null;
    }
}

window.appStorage = new TincNoteStorage();
