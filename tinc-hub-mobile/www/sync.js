/**
 * TincNote Mobile — Senkronizasyon Motoru (Sync Engine)
 * TincHub sunucusuyla iki yönlü çevrimdışı/çevrimiçi senkronizasyon sağlar.
 */

class TincNoteSync {
    constructor(storage) {
        this.storage = storage;
        this.isSyncing = false;
        this.needsResync = false;
        this.status = 'offline'; // 'offline', 'online', 'syncing', 'error'
        this.statusListeners = [];
    }

    onStatusChange(cb) {
        this.statusListeners.push(cb);
    }

    setStatus(status, message = '') {
        this.status = status;
        this.statusListeners.forEach(cb => cb(status, message));
    }

    async getServerUrl() {
        let url = await this.storage.getSetting('server_url', 'http://192.168.1.10:9013');
        if (url) {
            url = url.trim();
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'http://' + url;
            }
            while (url.endsWith('/')) {
                url = url.slice(0, -1);
            }
            if (url.endsWith('/notes')) {
                url = url.slice(0, -6);
            }
            while (url.endsWith('/')) {
                url = url.slice(0, -1);
            }
        }
        return url || 'http://192.168.1.10:9013';
    }

    async getHeaders(customHeaders = {}) {
        const token = await this.storage.getSetting('auth_token', '');
        const headers = { ...customHeaders };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
            headers['X-Auth-Token'] = token;
        }
        return headers;
    }

    async apiFetch(path, options = {}) {
        const serverUrl = await this.getServerUrl();
        const headers = await this.getHeaders(options.headers || {});
        return fetch(`${serverUrl}${path}`, {
            ...options,
            headers
        });
    }

    async login(emailOrUsername, password) {
        try {
            const res = await this.apiFetch('/notes/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: emailOrUsername, username: emailOrUsername, password })
            });
            const data = await res.json();
            if (data.ok && data.token) {
                await this.storage.setSetting('auth_token', data.token);
                await this.storage.setSetting('user_profile', JSON.stringify(data.user));
                return { ok: true, user: data.user };
            }
            return { ok: false, error: data.error || 'Giriş başarısız' };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    async register(emailOrUsername, password, displayName, email) {
        try {
            const res = await this.apiFetch('/notes/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email || emailOrUsername, username: emailOrUsername, password, display_name: displayName })
            });
            const data = await res.json();
            if (data.ok && data.token) {
                await this.storage.setSetting('auth_token', data.token);
                await this.storage.setSetting('user_profile', JSON.stringify(data.user));
                return { ok: true, user: data.user, verification_required: data.verification_required, code_demo: data.verification_code_demo };
            }
            return { ok: false, error: data.error || 'Kayıt başarısız' };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    async loginWithOAuth(provider, payload) {
        try {
            const res = await this.apiFetch(`/notes/api/auth/oauth/${provider}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.ok && data.token) {
                await this.storage.setSetting('auth_token', data.token);
                await this.storage.setSetting('user_profile', JSON.stringify(data.user));
                return { ok: true, user: data.user };
            }
            return { ok: false, error: data.error || `${provider} ile giriş başarısız` };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    async logout() {
        try {
            await this.apiFetch('/notes/api/auth/logout', { method: 'POST' });
        } catch (e) {}
        await this.storage.setSetting('auth_token', '');
        await this.storage.setSetting('user_profile', '');
        return { ok: true };
    }

    async checkConnection() {
        try {
            const serverUrl = await this.getServerUrl();
            if (!serverUrl) return false;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);

            try {
                const res = await this.apiFetch('/notes/api/ping', {
                    method: 'GET',
                    signal: controller.signal
                });
                clearTimeout(timeout);
                if (res && res.ok) return true;
            } catch (e) {
                clearTimeout(timeout);
            }

            // Yedek kontrol (categories endpoint'i)
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 4000);
            try {
                const res2 = await this.apiFetch('/notes/api/categories', {
                    method: 'GET',
                    signal: controller2.signal
                });
                clearTimeout(timeout2);
                return !!(res2 && res2.ok);
            } catch (e2) {
                clearTimeout(timeout2);
                return false;
            }
        } catch (e) {
            return false;
        }
    }

    async syncNow() {
        if (this.isSyncing) {
            this.needsResync = true;
            return false;
        }
        this.isSyncing = true;
        this.setStatus('syncing', 'Eşitleniyor...');

        try {
            const serverUrl = await this.getServerUrl();
            if (!serverUrl) {
                this.setStatus('offline', 'Sunucu URL ayarlanmamış');
                this.isSyncing = false;
                return false;
            }

            const isAlive = await this.checkConnection();
            if (!isAlive) {
                this.setStatus('offline', 'Sunucuya ulaşılamıyor (Çevrimdışı moddasınız)');
                this.isSyncing = false;
                return false;
            }

            // -1. Orphan Pre-Check: sunucuda olmayan yerel kategorileri dirty işaretle
            // (mevcut kullanıcıların ID çakışmalarını onar)
            try {
                const preCheckCats = await this.apiFetch('/notes/api/categories');
                if (preCheckCats.ok) {
                    const preCheckData = await preCheckCats.json();
                    const srvCatIdSet = new Set((preCheckData.categories || []).map(c => c.id));
                    const localCats = await this.storage.getAll('categories');
                    for (const lc of localCats) {
                        if (!lc._deleted && !srvCatIdSet.has(lc.id) && typeof lc.id === 'number' && lc.id < 1000000000) {
                            // Sunucuda yok ve geçici ID'den küçük — dirty yap ki push edilsin
                            lc._dirty = true;
                            await this.storage.put('categories', lc);
                        }
                    }
                }
            } catch(e) {}

            // 0. Genel Bakış (Overview) Verilerini Çek
            try {
                const ovRes = await this.apiFetch('/notes/api/overview');
                if (ovRes.ok) {
                    const ovData = await ovRes.json();
                    if (ovData.overview) {
                        await this.storage.saveOverview(ovData.overview);
                    }
                }
            } catch (ovErr) {
                console.warn("Overview alınamadı:", ovErr);
            }

            // 0.5 Not Defterlerini Çek & Birleştir
            try {
                const nbRes = await this.apiFetch('/notes/api/notebooks');
                if (nbRes.ok) {
                    const nbData = await nbRes.json();
                    if (nbData.notebooks) {
                        for (const nb of nbData.notebooks) {
                            const localNb = await this.storage.get('notebooks', nb.id);
                            if (!localNb || !localNb._dirty) {
                                await this.storage.put('notebooks', { ...nb, _dirty: false, _deleted: false });
                            }
                        }
                    }
                    if (nbData.active_notebook_id) {
                        const curActive = await this.storage.getActiveNotebookId();
                        if (!curActive) {
                            await this.storage.setActiveNotebookId(nbData.active_notebook_id);
                        }
                    }
                }
            } catch (nbErr) {
                console.warn("Notebooks alınamadı:", nbErr);
            }

            // 1. Kategorileri Çek & Birleştir
            try {
                const catRes = await this.apiFetch('/notes/api/categories');
                if (catRes.ok) {
                    const catData = await catRes.json();
                    if (catData.categories) {
                        for (const c of catData.categories) {
                            const local = await this.storage.get('categories', c.id);
                            if (!local || !local._dirty) {
                                await this.storage.put('categories', { ...c, _dirty: false, _deleted: false });
                            }
                        }
                    }
                }
            } catch (catErr) {
                console.warn("Kategoriler alınamadı:", catErr);
            }

            // 2. Sayfaları Çek & Birleştir
            try {
                const pageRes = await this.apiFetch('/notes/api/pages');
                if (pageRes.ok) {
                    const pageData = await pageRes.json();
                    if (pageData.pages) {
                        for (const p of pageData.pages) {
                            const local = await this.storage.get('pages', p.id);
                            if (!local || !local._dirty) {
                                await this.storage.put('pages', { ...p, _dirty: false, _deleted: false });

                                // Sayfa türüne göre alt maddeleri veya finans kayıtlarını çek
                                if (p.type === 'checklist' || p.type === 'note' || p.type === 'notes') {
                                    try {
                                        const itemRes = await this.apiFetch(`/notes/api/pages/${p.id}/items`);
                                        if (itemRes.ok) {
                                            const itemData = await itemRes.json();
                                            if (itemData.items) {
                                                for (const it of itemData.items) {
                                                    const localIt = await this.storage.get('items', it.id);
                                                    if (!localIt || !localIt._dirty) {
                                                        await this.storage.put('items', { ...it, _dirty: false, _deleted: false });
                                                    }
                                                }
                                            }
                                        }
                                    } catch (itemErr) {
                                        console.warn(`Maddeler alınamadı (sayfa ${p.id}):`, itemErr);
                                    }
                                } else if (p.type === 'finance') {
                                    try {
                                        const finRes = await this.apiFetch(`/notes/api/pages/${p.id}/finance`);
                                        if (finRes.ok) {
                                            const finData = await finRes.json();
                                            if (finData.entries) {
                                                for (const fe of finData.entries) {
                                                    const localFe = await this.storage.get('finances', fe.id);
                                                    if (!localFe || !localFe._dirty) {
                                                        await this.storage.put('finances', { ...fe, _dirty: false, _deleted: false });
                                                    }
                                                }
                                            }
                                        }
                                    } catch (finErr) {
                                        console.warn(`Finans kayıtları alınamadı (sayfa ${p.id}):`, finErr);
                                    }
                                } else if (p.type === 'project') {
                                    try {
                                        const projRes = await this.apiFetch(`/notes/api/pages/${p.id}/project`);
                                        if (projRes.ok) {
                                            const projData = await projRes.json();
                                            if (projData.ok && projData.project) {
                                                await this.storage.saveProject({
                                                    id: p.id,
                                                    page_id: p.id,
                                                    data: projData.project
                                                });
                                            }
                                        }
                                    } catch (projErr) {
                                        console.warn(`Proje verisi alınamadı (sayfa ${p.id}):`, projErr);
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (pageErr) {
                console.warn("Sayfalar alınamadı:", pageErr);
            }

            // 3. Şifre Kasası Kayıtlarını Çek & Birleştir
            try {
                const vaultRes = await this.apiFetch('/notes/api/vault');
                if (vaultRes.ok) {
                    const vaultData = await vaultRes.json();
                    if (vaultData.entries) {
                        for (const ve of vaultData.entries) {
                            const localVe = await this.storage.get('vault', ve.id);
                            if (!localVe || !localVe._dirty) {
                                await this.storage.put('vault', { ...ve, _dirty: false, _deleted: false });
                            }
                        }
                    }
                    if (vaultData.folders) {
                        for (const vf of vaultData.folders) {
                            await this.storage.put('vault_folders', vf);
                        }
                    }
                }
            } catch (vaultErr) {
                console.warn("Kasa verisi alınamadı:", vaultErr);
            }

            // 3.5 Hızlı Notları Çek & Birleştir
            try {
                const qnRes = await this.apiFetch('/notes/api/quick-notes');
                if (qnRes.ok) {
                    const qnData = await qnRes.json();
                    if (qnData.notes) {
                        for (const qn of qnData.notes) {
                            const localQn = await this.storage.get('quick_notes', qn.id);
                            if (!localQn || !localQn._dirty) {
                                await this.storage.put('quick_notes', { ...qn, _dirty: false, _deleted: false });
                            }
                        }
                    }
                }
            } catch (qnErr) {
                console.warn("Hızlı notlar alınamadı:", qnErr);
            }

            // 4. Yerelde Değişen (Dirty) Verileri Sunucuya Gönder
            await this.pushDirtyDataToServer();

            const nowStr = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
            await this.storage.setSetting('last_sync_time', nowStr);
            this.setStatus('online', `Eşitlendi (${nowStr})`);
            this.isSyncing = false;

            if (typeof syncWidgetData === 'function') {
                syncWidgetData();
            }
            if (this.needsResync) {
                this.needsResync = false;
                setTimeout(() => this.syncNow(), 300);
            }
            return true;
        } catch (e) {
            console.error("Senkronizasyon hatası:", e);
            this.setStatus('error', `Hata: ${e.message || 'Eşitlenemedi'}`);
            this.isSyncing = false;
            if (this.needsResync) {
                this.needsResync = false;
                setTimeout(() => this.syncNow(), 500);
            }
            return false;
        }
    }

    async pushDirtyDataToServer() {
        // Yerelde değişen / eklenen kategoriler
        const allCats = await this.storage.getAll('categories');

        // Sunucudaki mevcut kategori ID'lerini öğren (orphan detection için)
        let existingServerCatIds = new Set();
        try {
            const checkRes = await this.apiFetch('/notes/api/categories');
            if (checkRes.ok) {
                const checkData = await checkRes.json();
                (checkData.categories || []).forEach(c => existingServerCatIds.add(c.id));
            }
        } catch(e) {}

        for (const cat of allCats) {
            if (cat._deleted && typeof cat.id === 'number' && cat.id < 1000000000) {
                try {
                    await this.apiFetch(`/notes/api/categories/${cat.id}`, { method: 'DELETE' });
                    await this.storage.delete('categories', cat.id);
                } catch (e) {}
            } else if (!cat._deleted) {
                // Hem dirty olanları hem de sunucuda olmayan (orphan) kategorileri push et
                const isNewLocal = typeof cat.id === 'number' && cat.id >= 1000000000;
                const isOrphan = !isNewLocal && !existingServerCatIds.has(cat.id);
                if (!cat._dirty && !isOrphan) continue; // Değişmemiş ve sunucuda var, geç
                try {
                    if (isNewLocal) {
                        const res = await this.apiFetch('/notes/api/categories', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: cat.name,
                                icon: cat.icon || '📁',
                                color: cat.color || '#3b82f6',
                                notebook_id: cat.notebook_id || 1,
                                is_divider: cat.is_divider ? 1 : 0
                            })
                        });
                        const data = await res.json();
                        const newCatId = data.id || data.category_id;
                        if (data.ok && newCatId) {
                            existingServerCatIds.add(newCatId);
                            const oldId = cat.id;
                            await this.storage.delete('categories', oldId);
                            cat.id = newCatId;
                            cat._dirty = false;
                            await this.storage.put('categories', cat);

                            // Bu kategoriye ait sayfaların category_id'sini güncelle
                            const allPages = await this.storage.getAll('pages');
                            for (const p of allPages) {
                                if (p.category_id == oldId) {
                                    p.category_id = newCatId;
                                    await this.storage.put('pages', p);
                                }
                            }
                        }
                    } else if (cat._dirty && !isOrphan) {
                        await this.apiFetch(`/notes/api/categories/${cat.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: cat.name,
                                icon: cat.icon || '📁',
                                color: cat.color || '#3b82f6'
                            })
                        });
                        cat._dirty = false;
                        await this.storage.put('categories', cat);
                    } else if (isOrphan) {
                        // Sunucuda olmayan kategori — yeniden oluştur
                        const res = await this.apiFetch('/notes/api/categories', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: cat.name,
                                icon: cat.icon || '📁',
                                color: cat.color || '#3b82f6',
                                notebook_id: cat.notebook_id || 1,
                                is_divider: cat.is_divider ? 1 : 0
                            })
                        });
                        const data = await res.json();
                        const newCatId = data.id || data.category_id;
                        if (data.ok && newCatId) {
                            existingServerCatIds.add(newCatId);
                            const oldId = cat.id;
                            // ID değiştiyse eski kaydı sil, yenisini ekle
                            if (newCatId !== oldId) {
                                await this.storage.delete('categories', oldId);
                                cat.id = newCatId;
                                const allPages = await this.storage.getAll('pages');
                                for (const p of allPages) {
                                    if (p.category_id == oldId) {
                                        p.category_id = newCatId;
                                        p._dirty = true;
                                        await this.storage.put('pages', p);
                                    }
                                }
                            }
                            cat._dirty = false;
                            await this.storage.put('categories', cat);
                        }
                    }
                } catch (e) {
                    console.warn("Kategori senkronizasyon hatası:", e);
                }
            }
        }

        // Yerelde silinmiş sayfalar
        const allPages = await this.storage.getAll('pages');

        // Sunucu'da geçerli kategori VE sayfa ID'lerini topla (mapping ve orphan detection için)
        let serverCatIds = new Set();
        let firstServerCatId = null;
        let serverPageIds = new Set();
        try {
            const scRes = await this.apiFetch('/notes/api/categories');
            if (scRes.ok) {
                const scData = await scRes.json();
                (scData.categories || []).forEach(c => {
                    serverCatIds.add(c.id);
                    if (firstServerCatId === null) firstServerCatId = c.id;
                });
            }
        } catch(e) {}
        try {
            const spRes = await this.apiFetch('/notes/api/pages');
            if (spRes.ok) {
                const spData = await spRes.json();
                (spData.pages || []).forEach(p => serverPageIds.add(p.id));
            }
        } catch(e) {}

        for (const p of allPages) {
            if (p._deleted && typeof p.id === 'number' && p.id < 1000000000) {
                try {
                    await this.apiFetch(`/notes/api/pages/${p.id}`, { method: 'DELETE' });
                    await this.storage.delete('pages', p.id);
                } catch (e) {}
            } else if (!p._deleted) {
                const isNewLocalPage = typeof p.id === 'number' && p.id >= 1000000000;
                // Sayfa sunucuda yoksa orphan (hem category_id hem page_id bazında)
                const isOrphanPage = !isNewLocalPage && !serverPageIds.has(p.id);
                if (!p._dirty && !isOrphanPage && !isNewLocalPage) continue;
                try {
                    if (isNewLocalPage || isOrphanPage) {
                        // Yeni sayfa ekleme
                        // category_id sunucuda yoksa fallback uygula
                        let pushCatId = p.category_id;
                        if (!serverCatIds.has(pushCatId)) {
                            // Yerel category'yi sunucuya push etmeyi dene (zaten yukarıda yapıldı)
                            // Hâlâ yoksa ilk server kategorisini kullan
                            if (firstServerCatId !== null) {
                                pushCatId = firstServerCatId;
                            } else {
                                console.warn(`Sayfa "${p.title}" için geçerli kategori yok, atlanıyor.`);
                                continue;
                            }
                        }
                        const res = await this.apiFetch('/notes/api/pages', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                category_id: pushCatId,
                                title: p.title,
                                type: p.type,
                                icon: p.icon || '📝',
                                content: p.content || ''
                            })
                        });
                        const data = await res.json();
                        const newPageId = data.page_id || data.id;
                        if (data.ok && newPageId) {
                            const oldPageId = p.id;
                            await this.storage.delete('pages', oldPageId);
                            p.id = newPageId;
                            p.category_id = pushCatId; // doğru category_id'yi güncelle
                            p._dirty = false;
                            await this.storage.put('pages', p);

                            // Yereldeki maddeleri ve finans kayıtlarını yeni sunucu page_id'sine eşle
                            const allLocalItems = await this.storage.getAll('items');
                            for (const item of allLocalItems) {
                                if (item.page_id === oldPageId) {
                                    item.page_id = newPageId;
                                    await this.storage.put('items', item);
                                }
                            }
                            const allLocalFinances = await this.storage.getAll('finances');
                            for (const fin of allLocalFinances) {
                                if (fin.page_id === oldPageId) {
                                    fin.page_id = newPageId;
                                    await this.storage.put('finances', fin);
                                }
                            }
                        }
                    } else {
                        // Var olan sayfayı güncelleme
                        await this.apiFetch(`/notes/api/pages/${p.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                title: p.title,
                                icon: p.icon,
                                content: p.content
                            })
                        });
                        p._dirty = false;
                        await this.storage.put('pages', p);
                    }
                } catch (e) {
                    console.warn("Sayfa eşitleme hatası:", e);
                }
            }
        }

        // Yerelde değişen / eklenen maddeler (items)
        const allItems = await this.storage.getAll('items');

        // Sunucudaki mevcut item ID'lerini topla (orphan detection için)
        let serverItemIds = new Set();
        try {
            // Her sayfa için değil, tüm item'ları tek seferde çek
            const itRes = await this.apiFetch('/notes/api/all-items');
            if (itRes.ok) {
                const itData = await itRes.json();
                (itData.items || []).forEach(i => serverItemIds.add(i.id));
            }
        } catch(e) {}

        for (const it of allItems) {
            if (it._deleted && typeof it.id === 'number' && it.id < 1000000000) {
                try {
                    await this.apiFetch(`/notes/api/items/${it.id}`, { method: 'DELETE' });
                    await this.storage.delete('items', it.id);
                } catch (e) {}
            } else if (!it._deleted) {
                const isNewLocalItem = typeof it.id === 'number' && it.id >= 1000000000;
                const isOrphanItem = !isNewLocalItem && !serverItemIds.has(it.id);
                if (!it._dirty && !isOrphanItem && !isNewLocalItem) continue;
                // Sayfa sunucuda yoksa item'ı push etme
                if (typeof it.page_id === 'number' && it.page_id >= 1000000000) continue;
                try {
                    const itemPayload = {
                        title: it.title,
                        description: it.description || '',
                        quantity: it.quantity || '',
                        price: it.price || '',
                        url: it.url || '',
                        remind_at: it.remind_at || '',
                        recurrence: it.recurrence || 'none',
                        is_done: it.is_done ? 1 : 0,
                        sort_order: it.sort_order || 0
                    };
                    if (isNewLocalItem || isOrphanItem) {
                        // Yeni veya orphan item — POST
                        const res = await this.apiFetch(`/notes/api/pages/${it.page_id}/items`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(itemPayload)
                        });
                        const data = await res.json();
                        if (data.ok && data.item_id) {
                            await this.storage.delete('items', it.id);
                            it.id = data.item_id;
                            it._dirty = false;
                            await this.storage.put('items', it);
                        }
                    } else {
                        // Var olan item — PUT
                        await this.apiFetch(`/notes/api/items/${it.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(itemPayload)
                        });
                        it._dirty = false;
                        await this.storage.put('items', it);
                    }
                } catch (e) {
                    console.warn("Madde eşitleme hatası:", e);
                }
            }
        }

        // Yerelde değişen / eklenen finans kayıtları (finances)
        const allFinances = await this.storage.getAll('finances');
        for (const fn of allFinances) {
            if (fn._deleted && typeof fn.id === 'number' && fn.id < 1000000000) {
                try {
                    await this.apiFetch(`/notes/api/finance/${fn.id}`, { method: 'DELETE' });
                    await this.storage.delete('finances', fn.id);
                } catch (e) {}
            } else if (fn._dirty && !fn._deleted) {
                // Eğer sayfa henüz sunucuda oluşmamışsa geç
                if (typeof fn.page_id === 'number' && fn.page_id >= 1000000000) continue;
                try {
                    const payload = {
                        title: fn.title,
                        amount: fn.amount,
                        type: fn.entry_type || fn.type || 'expense',
                        category: fn.category || 'Genel',
                        period: fn.period,
                        due_day: fn.due_day,
                        notes: fn.notes || ''
                    };
                    if (typeof fn.id === 'number' && fn.id >= 1000000000) {
                        const res = await this.apiFetch(`/notes/api/pages/${fn.page_id}/finance`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const data = await res.json();
                        if (data.ok && (data.entry_id || data.id)) {
                            await this.storage.delete('finances', fn.id);
                            fn.id = data.entry_id || data.id;
                            fn._dirty = false;
                            await this.storage.put('finances', fn);
                        }
                    } else {
                        await this.apiFetch(`/notes/api/finance/${fn.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        fn._dirty = false;
                        await this.storage.put('finances', fn);
                    }
                } catch (e) {
                    console.warn("Finans eşitleme hatası:", e);
                }
            }
        }

        // Yerelde değişen / eklenen şifre kayıtları (vault)
        const allVault = await this.storage.getAll('vault');
        for (const v of allVault) {
            if (v._deleted && typeof v.id === 'number' && v.id < 1000000000) {
                try {
                    await this.apiFetch(`/notes/api/vault/${v.id}`, { method: 'DELETE' });
                    await this.storage.delete('vault', v.id);
                } catch (e) {}
            } else if (v._dirty && !v._deleted) {
                try {
                    const payload = {
                        title: v.title,
                        category: v.category || 'web',
                        scope: v.scope || 'personal',
                        folder_name: v.folder || v.folder_name || '',
                        profile_name: v.profile || v.profile_name || '',
                        username: v.username || '',
                        password: v.password || '',
                        url: v.url || '',
                        notes: v.notes || '',
                        is_favorite: v.is_favorite ? 1 : 0
                    };

                    if (typeof v.id === 'number' && v.id >= 1000000000) {
                        const res = await this.apiFetch('/notes/api/vault', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const data = await res.json();
                        if (data.ok && data.id) {
                            await this.storage.delete('vault', v.id);
                            v.id = data.id;
                            v._dirty = false;
                            await this.storage.put('vault', v);
                        }
                    } else {
                        await this.apiFetch(`/notes/api/vault/${v.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        v._dirty = false;
                        await this.storage.put('vault', v);
                    }
                } catch (e) {
                    console.warn("Kasa eşitleme hatası:", e);
                }
            }
        }

        // Yerelde değişen / eklenen / silinen hızlı notlar
        const allQn = await this.storage.getAll('quick_notes');
        for (const qn of allQn) {
            if (qn._dirty) {
                try {
                    if (qn._deleted) {
                        if (typeof qn.id === 'number' && qn.id < 1000000000) {
                            await this.apiFetch(`/notes/api/quick-notes/${qn.id}`, { method: 'DELETE' });
                        }
                        await this.storage.delete('quick_notes', qn.id);
                    } else if (typeof qn.id === 'number' && qn.id >= 1000000000) {
                        // Yeni hızlı not
                        const res = await this.apiFetch('/notes/api/quick-notes', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ content: qn.content, notebook_id: qn.notebook_id, color: qn.color })
                        });
                        if (res.ok) {
                            const d = await res.json();
                            await this.storage.delete('quick_notes', qn.id);
                            if (d.id) {
                                await this.storage.put('quick_notes', { ...qn, id: d.id, _dirty: false });
                            }
                        }
                    } else {
                        // Var olan hızlı notu güncelle
                        const res = await this.apiFetch(`/notes/api/quick-notes/${qn.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ content: qn.content, color: qn.color })
                        });
                        if (res.ok) {
                            qn._dirty = false;
                            await this.storage.put('quick_notes', qn);
                        }
                    }
                } catch (e) {
                    console.warn(`Hızlı not sunucuya iletilemedi (${qn.id}):`, e);
                }
            }
        }
    }

    async fastPatchNote(pageId, content) {
        if (!pageId) return false;
        try {
            const isAlive = await this.checkConnection();
            if (isAlive) {
                const res = await this.apiFetch(`/notes/api/pages/${pageId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: content })
                });
                if (res.ok) {
                    const page = await this.storage.getPage(pageId);
                    if (page) {
                        page._dirty = false;
                        await this.storage.put('pages', page);
                    }
                    const nowStr = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
                    this.setStatus('online', `Eşitlendi (${nowStr})`);
                    return true;
                }
            }
        } catch (e) {
            console.warn("fastPatchNote offline:", e);
        }
        this.syncNow();
        return false;
    }

    async fastPatchItem(item) {
        if (!item || !item.id || item.id >= 1000000000) {
            return this.syncNow();
        }
        try {
            const isAlive = await this.checkConnection();
            if (isAlive) {
                const res = await this.apiFetch(`/notes/api/items/${item.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: item.title,
                        description: item.description || '',
                        quantity: item.quantity || '',
                        price: item.price || '',
                        url: item.url || '',
                        remind_at: item.remind_at || '',
                        recurrence: item.recurrence || 'none',
                        is_done: item.is_done ? 1 : 0,
                        sort_order: item.sort_order || 0
                    })
                });
                if (res.ok) {
                    item._dirty = false;
                    await this.storage.put('items', item);
                    const nowStr = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
                    this.setStatus('online', `Eşitlendi (${nowStr})`);
                    return true;
                }
            }
        } catch (e) {
            console.warn("fastPatchItem offline:", e);
        }
        this.syncNow();
        return false;
    }
}

window.appSync = new TincNoteSync(window.appStorage);
