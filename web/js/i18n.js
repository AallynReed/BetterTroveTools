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
        this.observer = new MutationObserver((mutations) => {
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

        if (missingKeys.size > 0 && window.eel && eel.add_missing_translation_keys) {
            console.log(`Sending ${missingKeys.size} missing DOM translation keys to backend...`);
            await eel.add_missing_translation_keys(this.currentLocale, Array.from(missingKeys))();
        }

        this.resumeObserver();
    },

    t(key) {
        if (!key) return "";
        
        if (this.dictionary[key] !== undefined && this.dictionary[key] !== "") {
            return this.dictionary[key];
        }
        
        this.pendingMissingKeys.add(key);
        this.scheduleSync();
        return key;
    },

    scheduleSync() {
        if (this.syncTimeout) clearTimeout(this.syncTimeout);
        
        this.syncTimeout = setTimeout(() => {
            if (this.pendingMissingKeys.size > 0 && window.eel && eel.add_missing_translation_keys) {
                console.log(`Syncing ${this.pendingMissingKeys.size} missing JS keys to backend...`);
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
