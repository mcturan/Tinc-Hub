/**
 * TincNote Mobile — Otomatik Güncelleme Kontrolcüsü
 * Yeni sürüm bulunca sormadan indirir, indirme bitince kuruluma yönlendirir.
 */

const APP_VERSION = "1.9.0";
const DEFAULT_GITHUB_REPO = "mcturan/tinc-hub";

class TincNoteUpdater {
    constructor(storage) {
        this.storage = storage;
        this.currentVersion = APP_VERSION;
        this.hasTriggeredAutoDownload = false;
    }

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

    autoDownloadUpdate(version, downloadUrl) {
        if (!downloadUrl || this.hasTriggeredAutoDownload) return;
        this.hasTriggeredAutoDownload = true;
        console.log(`[Updater] APK indirme başlatılıyor: v${version} -> ${downloadUrl}`);
        try {
            if (window.AndroidWidgetBridge && window.AndroidWidgetBridge.downloadAndInstallUpdate) {
                window.AndroidWidgetBridge.downloadAndInstallUpdate(downloadUrl, version);
                return;
            }
        } catch (e) {
            console.warn("[Updater] downloadAndInstallUpdate hatası:", e);
        }
        // Web fallback
        try {
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = `TincNote-v${version}.apk`;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
        } catch(err) {
            window.location.href = downloadUrl;
        }
    }

    async checkForUpdates(silent = false) {
        try {
            // 1. TincNote sunucusu — yerel ağ öncelikli
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
                            if (downloadUrl.startsWith('/')) downloadUrl = serverUrl + downloadUrl;
                            this.autoDownloadUpdate(sVer, downloadUrl);
                            this.showUpdateBanner({ version: sVer, currentVersion: this.currentVersion, downloadUrl });
                            return { hasUpdate: true, version: sVer, downloadUrl };
                        } else {
                            if (!silent) this._toast(`✅ Uygulama güncel (v${this.currentVersion})`);
                            return { hasUpdate: false, version: this.currentVersion };
                        }
                    }
                }
            } catch (errServer) {
                console.log("[Updater] Sunucu kontrol atlandı:", errServer);
            }

            // 2. GitHub Releases kontrolü
            const repo = await this.getRepo();
            if (!repo) {
                if (!silent) this._toast("Güncelleme kontrolü için sunucuya ulaşılamadı.");
                return null;
            }
            const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });
            if (!res.ok) {
                if (!silent) this._toast(`Güncellemeler kontrol edilemedi (${res.status})`);
                return null;
            }
            const release = await res.json();
            const remoteVersion = release.tag_name || release.name || "";
            if (this.compareVersions(remoteVersion, this.currentVersion) > 0) {
                let apkUrl = null;
                if (release.assets && release.assets.length > 0) {
                    const apkAsset = release.assets.find(a => a.name.toLowerCase().endsWith('.apk'));
                    if (apkAsset) apkUrl = apkAsset.browser_download_url;
                }
                if (!apkUrl) apkUrl = release.html_url;
                this.autoDownloadUpdate(remoteVersion, apkUrl);
                this.showUpdateBanner({ version: remoteVersion, currentVersion: this.currentVersion, downloadUrl: apkUrl });
                return { hasUpdate: true, version: remoteVersion, downloadUrl: apkUrl };
            } else {
                if (!silent) this._toast(`✅ Uygulama güncel (v${this.currentVersion})`);
                return { hasUpdate: false, version: this.currentVersion };
            }
        } catch (e) {
            console.warn("[Updater] Hata:", e);
            if (!silent) this._toast("Güncelleme kontrolü hatası: " + e.message);
            return null;
        }
    }

    _toast(msg) {
        if (typeof showMobileToast === 'function') {
            showMobileToast(msg);
        } else {
            console.log("[Updater]", msg);
        }
    }

    showUpdateBanner(info) {
        // Varsa eski banner/modal'ı kaldır
        ['update-modal', 'update-banner'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });

        const banner = document.createElement('div');
        banner.id = 'update-banner';
        banner.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
            background: linear-gradient(135deg, #1d4ed8, #2563eb);
            color: #fff; padding: 10px 16px;
            display: flex; align-items: center; justify-content: space-between;
            box-shadow: 0 2px 12px rgba(0,0,0,0.35); font-family: inherit;
        `;
        banner.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
                <span style="font-size:1.4rem; flex-shrink:0;">📥</span>
                <div style="min-width:0;">
                    <div style="font-weight:700; font-size:0.9rem;">
                        TincNote v${info.version} indiriliyor...
                    </div>
                    <div style="font-size:0.75rem; opacity:0.85;">
                        Tamamlanınca kurulum otomatik başlayacak
                    </div>
                </div>
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0; margin-left:10px;">
                <button onclick="window.downloadAndInstallApk('${info.downloadUrl}', '${info.version}')"
                    style="background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.4);
                    color:#fff; border-radius:6px; padding:5px 10px; font-size:0.78rem; cursor:pointer;">
                    Tekrar İndir
                </button>
                <button onclick="this.closest('#update-banner').remove()"
                    style="background:none; border:none; color:#fff; font-size:1.3rem; cursor:pointer; padding:2px 6px; line-height:1;">
                    ✕
                </button>
            </div>
        `;
        document.body.appendChild(banner);

        // 20 saniye sonra kendiliğinden kapansın
        setTimeout(() => { if (banner.parentNode) banner.remove(); }, 20000);
    }
}

window.downloadAndInstallApk = (url, version = "") => {
    try {
        if (window.AndroidWidgetBridge && window.AndroidWidgetBridge.downloadAndInstallUpdate) {
            window.AndroidWidgetBridge.downloadAndInstallUpdate(url, version);
            return;
        }
        if (window.AndroidWidgetBridge && window.AndroidWidgetBridge.openBrowserUrl) {
            window.AndroidWidgetBridge.openBrowserUrl(url);
            return;
        }
    } catch (e) {}
    window.location.href = url;
};

window.appUpdater = new TincNoteUpdater(window.appStorage);
