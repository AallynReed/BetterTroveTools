const I18nManager = {
    currentLocale: 'en_US',
    dictionary: {},
    availableLanguages: [],
    
    pendingMissingKeys: new Set(),
    syncTimeout: null,
    
    observer: null,
    translateTimeout: null,

    async init() {
        if (window.eel && eel.get_available_languages) {
            this.availableLanguages = await eel.get_available_languages()();
            
            try {
                const settings = await eel.get_settings()();
                if (settings && settings.locale) {
                    this.currentLocale = settings.locale;
                }
            } catch (e) {
                console.warn("Could not load locale from settings, defaulting to en_US.");
            }

            this.populateLanguageDropdown();
            await this.loadDictionary(this.currentLocale);
        }
        
        this.startObserver();
    },

    populateLanguageDropdown() {
        const select = document.getElementById('global-language-select');
        if (!select) return;
        
        select.innerHTML = '';
        this.availableLanguages.forEach(lang => {
            const opt = document.createElement('option');
            opt.value = lang.code;
            
            opt.textContent = `${lang.name} (${lang.percent}%)`;
            
            if (lang.code === this.currentLocale) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });

        select.addEventListener('change', async (e) => {
            const newLocale = e.target.value;
            await this.setLanguage(newLocale);
            
            try {
                const settings = await eel.get_settings()();
                settings.locale = newLocale;
                await eel.save_settings(settings)();
            } catch (err) {
                console.error("Failed to save locale to settings.json:", err);
            }
        });
    },

    async loadDictionary(localeCode) {
        this.currentLocale = localeCode;

        try {
            const response = await fetch(`assets/locale/${localeCode}.json?t=${new Date().getTime()}`);
            if (response.ok) {
                const data = await response.json();
                this.dictionary = data.keys || {};
            } else {
                console.warn(`Locale file for ${localeCode} not found. Falling back to default.`);
                this.dictionary = {};
            }
        } catch (error) {
            console.error("Failed to load language dictionary:", error);
            this.dictionary = {};
        }

        await this.translatePage();
    },

    startObserver() {
        // The observer used to schedule a full translatePage() (three
        // document.querySelectorAll passes) on ANY DOM mutation -- every Vue
        // re-render of a heavy view (file tree updates, modder tools repaints,
        // mod list filtering) re-translated the entire page even when none of
        // the changed nodes had a [data-i18n] attribute. Now we cheap-check
        // each batch of mutations for i18n-relevant additions first and skip
        // the heavy pass when there's nothing to translate.
        const hasI18nNode = (node) => {
            if (!node || node.nodeType !== 1) return false;
            if (node.hasAttribute && (
                node.hasAttribute('data-i18n')
                || node.hasAttribute('data-i18n-placeholder')
                || node.hasAttribute('data-i18n-title')
            )) return true;
            return !!(node.querySelector && node.querySelector('[data-i18n], [data-i18n-placeholder], [data-i18n-title]'));
        };

        this.observer = new MutationObserver((mutations) => {
            let relevant = false;
            for (let i = 0; i < mutations.length && !relevant; i++) {
                const m = mutations[i];
                if (m.type !== 'childList') continue;
                const added = m.addedNodes;
                for (let j = 0; j < added.length; j++) {
                    if (hasI18nNode(added[j])) { relevant = true; break; }
                }
            }
            if (!relevant) return;
            if (this.translateTimeout) clearTimeout(this.translateTimeout);
            this.translateTimeout = setTimeout(() => {
                this.translatePage();
            }, 50);
        });

        this.resumeObserver();
    },

    pauseObserver() {
        if (this.observer) this.observer.disconnect();
    },

    resumeObserver() {
        if (this.observer) {
            this.observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }
    },

    async translatePage() {
        this.pauseObserver();

        const missingKeys = new Set();

        document.querySelectorAll('[data-i18n]').forEach(el => {
            let key = el.getAttribute('data-i18n');
            if (!key) {
                key = el.innerHTML.trim();
                el.setAttribute('data-i18n', key);
            }
            if (key) {
                if (this.dictionary[key] !== undefined && this.dictionary[key] !== "") {
                    if (el.innerHTML !== this.dictionary[key]) {
                        el.innerHTML = this.dictionary[key];
                    }
                } else {
                    if (el.innerHTML !== key) {
                        el.innerHTML = key;
                    }
                    missingKeys.add(key);
                }
            }
        });

        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            let key = el.getAttribute('data-i18n-placeholder');
            if (!key && el.hasAttribute('placeholder')) {
                key = el.getAttribute('placeholder').trim();
                el.setAttribute('data-i18n-placeholder', key);
            }
            
            if (key) {
                if (this.dictionary[key] !== undefined && this.dictionary[key] !== "") {
                    if (el.getAttribute('placeholder') !== this.dictionary[key]) {
                        el.setAttribute('placeholder', this.dictionary[key]);
                    }
                } else {
                    if (el.getAttribute('placeholder') !== key) {
                        el.setAttribute('placeholder', key);
                    }
                    missingKeys.add(key);
                }
            }
        });

        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            let key = el.getAttribute('data-i18n-title');
            if (!key && el.hasAttribute('title')) {
                key = el.getAttribute('title').trim();
                el.setAttribute('data-i18n-title', key);
            }
            
            if (key) {
                if (this.dictionary[key] !== undefined && this.dictionary[key] !== "") {
                    if (el.getAttribute('title') !== this.dictionary[key]) {
                        el.setAttribute('title', this.dictionary[key]);
                    }
                } else {
                    if (el.getAttribute('title') !== key) {
                        el.setAttribute('title', key);
                    }
                    missingKeys.add(key);
                }
            }
        });

        // Auto-capturing missing keys is a dev-only convenience for seeding
        // locale files. Funnel the DOM-pass misses through the same debounced
        // sync as the JS t() path so a single gate (and the async dev-mode
        // detection) governs both -- nothing is sent in the packaged app or in
        // hosted web mode.
        if (this._canCaptureTranslations() && missingKeys.size > 0) {
            missingKeys.forEach(key => this.pendingMissingKeys.add(key));
            this.scheduleSync();
        }

        this.resumeObserver();
    },

    // True only when the backend confirmed we're running from source (not the
    // packaged build) and we're not in hosted web mode. Defaults to false until
    // detection resolves, so the capture never runs on a guess.
    _canCaptureTranslations() {
        return window.BTT_DEV_MODE === true && !!window.eel && !!window.eel.add_missing_translation_keys;
    },

    t(key) {
        if (!key) return "";

        if (this.dictionary[key] !== undefined && this.dictionary[key] !== "") {
            return this.dictionary[key];
        }

        if (this._canCaptureTranslations()) {
            this.pendingMissingKeys.add(key);
            this.scheduleSync();
        }
        return key;
    },

    scheduleSync() {
        if (!this._canCaptureTranslations()) {
            this.pendingMissingKeys.clear();
            return;
        }
        if (this.syncTimeout) clearTimeout(this.syncTimeout);

        this.syncTimeout = setTimeout(() => {
            if (this._canCaptureTranslations() && this.pendingMissingKeys.size > 0) {
                console.log(`Syncing ${this.pendingMissingKeys.size} missing translation keys to backend (dev mode)...`);
                eel.add_missing_translation_keys(this.currentLocale, Array.from(this.pendingMissingKeys))();
                this.pendingMissingKeys.clear();
            }
        }, 2000);
    },

    async setLanguage(localeCode) {
        await this.loadDictionary(localeCode);
    }
};

window.I18nManager = I18nManager;

document.addEventListener('DOMContentLoaded', () => {
    I18nManager.init();
});
