/**
 * TincNote Mobile — Otomatik Güncelleme Kontrolcüsü (Self-Update Checker)
 * 3 parçalı SemVer (örn: 1.0.0) formatını kullanır ve GitHub Releases üzerinden
 * yeni sürüm çıktığında kullanıcıya APK indirme ve güncelleme imkanı sunar.
 */

const APP_VERSION = "1.5.5";
const DEFAULT_GITHUB_REPO = "mcturan/tinc-hub"; // Ayarlardan değiştirilebilir

class TincNoteUpdater {
    constructor(storage) {
        this.storage = storage;
        this.currentVersion = APP_VERSION;
    }

    // 3 parçalı sürüm karşılaştırma (örn: "1.0.1" > "1.0.0")
    compareVersions(v1, v2) {
        const clean = v => (v || "").replace(/^[^\d]*/, '').split('.').map(n => parseInt(n, 10) || 0);
        const p1 = clean(v1);
        const p2 = clean(v2);
        
        for (let i = 0; i < Math.max(p1.length, p2.length, 3); i++) {
            const num1 = p1[i] || 0;
            const num2 = p2[i] || 0;
            if (num1 > num2) return 1;
            if (num1 < num2) return -1;
        }
        return 0;
    }

    async getRepo() {
        return await this.storage.getSetting('github_repo', DEFAULT_GITHUB_REPO);
    }

    async checkForUpdates(silent = false) {
        try {
            // 1. Önce bağlı olunan TincNote sunucusunu kontrol et (Yerel ağ / LAN desteği)
            try {
                const serverUrl = window.appSync ? await window.appSync.getServerUrl() : null;
                if (serverUrl) {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 3500);
                    const sRes = await fetch(`${serverUrl}/notes/api/app-version`, { signal: controller.signal });
                    clearTimeout(timeout);
                    if (sRes.ok) {
                        const sData = await sRes.json();
                        const sVer = sData.version;
                        if (this.compareVersions(sVer, this.currentVersion) > 0) {
                            let downloadUrl = sData.download_url || '/notes/download/apk';
                            if (downloadUrl.startsWith('/')) {
                                downloadUrl = serverUrl + downloadUrl;
                            }
                            this.showUpdateModal({
                                version: sVer,
                                currentVersion: this.currentVersion,
                                body: sData.notes || "Yeni özellikler ve hata düzeltmeleri.",
                                downloadUrl: downloadUrl
                            });
                            return { hasUpdate: true, version: sVer, downloadUrl };
                        } else {
                            if (!silent) {
                                alert(`✅ TincNote güncel! (Mevcut Sürüm: v${this.currentVersion})`);
                            }
                            return { hasUpdate: false, version: this.currentVersion };
                        }
                    }
                }
            } catch (errServer) {
                console.log("Sunucudan güncelleme kontrolü atlandı veya sunucu yanıt vermedi:", errServer);
            }

            // 2. Sunucuya ulaşılamadıysa GitHub Releases üzerinden kontrol et
            const repo = await this.getRepo();
            if (!repo) {
                if (!silent) alert("Güncelleme kontrolü için sunucuya veya depoya ulaşılamadı.");
                return null;
            }

            const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });

            if (!res.ok) {
                if (!silent) {
                    if (res.status === 404) {
                        alert("Sunucu veya GitHub deposunda yeni bir sürüm yayını bulunamadı.");
                    } else {
                        alert(`Güncellemeler kontrol edilemedi (${res.status}).`);
                    }
                }
                return null;
            }

            const release = await res.json();
            const remoteVersion = release.tag_name || release.name || "";
            
            if (this.compareVersions(remoteVersion, this.currentVersion) > 0) {
                // Yeni sürüm bulundu!
                // APK dosyasını bul
                let apkUrl = null;
                if (release.assets && release.assets.length > 0) {
                    const apkAsset = release.assets.find(a => a.name.toLowerCase().endsWith('.apk'));
                    if (apkAsset) {
                        apkUrl = apkAsset.browser_download_url;
                    }
                }
                if (!apkUrl) {
                    apkUrl = release.html_url;
                }

                this.showUpdateModal({
                    version: remoteVersion,
                    currentVersion: this.currentVersion,
                    body: release.body || "Yeni özellikler ve hata düzeltmeleri.",
                    downloadUrl: apkUrl
                });

                return { hasUpdate: true, version: remoteVersion, downloadUrl: apkUrl };
            } else {
                if (!silent) {
                    alert(`✅ TincNote güncel! (Mevcut Sürüm: v${this.currentVersion})`);
                }
                return { hasUpdate: false, version: this.currentVersion };
            }
        } catch (e) {
            console.warn("Güncelleme kontrol hatası:", e);
            if (!silent) alert("Güncelleme kontrolü sırasında hata oluştu: " + e.message);
            return null;
        }
    }

    showUpdateModal(info) {
        let modal = document.getElementById('update-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'update-modal';
            modal.className = 'modal-overlay';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div class="modal-card">
                <div style="font-size:2.5rem; text-align:center; margin-bottom:8px;">🚀</div>
                <h3 style="margin:0; text-align:center; color:var(--text); font-size:1.3rem;">
                    Yeni Güncelleme Mevcut!
                </h3>
                <div style="text-align:center; color:var(--accent); font-weight:700; margin:6px 0 14px;">
                    v${info.version} <span style="color:var(--muted); font-size:0.85rem; font-weight:normal;">(Sizdeki: v${info.currentVersion})</span>
                </div>

                <div style="background:var(--surface2); border:1px solid var(--border); border-radius:8px; padding:12px; font-size:0.85rem; max-height:150px; overflow-y:auto; color:var(--text); line-height:1.4; white-space:pre-line;">
                    ${info.body}
                </div>

                <div style="display:flex; flex-direction:column; gap:10px; margin-top:16px;">
                    <button type="button" class="btn btn-primary" onclick="window.downloadAndInstallApk('${info.downloadUrl}')" style="text-align:center; padding:12px; font-weight:bold; font-size:0.95rem; width:100%; border:none; cursor:pointer;">
                        📥 Yeni Sürümü İndir & Kur (.APK)
                    </button>
                    <button type="button" class="btn btn-ghost" onclick="document.getElementById('update-modal').classList.remove('active')">
                        Daha Sonra Hatırlat
                    </button>
                </div>
            </div>
        `;
        modal.classList.add('active');
    }
}

window.downloadAndInstallApk = (url) => {
    try {
        if (window.AndroidWidgetBridge && window.AndroidWidgetBridge.openBrowserUrl) {
            window.AndroidWidgetBridge.openBrowserUrl(url);
            return;
        }
    } catch (e) {}
    window.location.href = url;
};

window.appUpdater = new TincNoteUpdater(window.appStorage);
