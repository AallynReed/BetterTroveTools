const I18nManager = {
    currentLocale: localStorage.getItem('btt_locale') || 'pt_PT',
    dictionary: {},
    availableLanguages: [],
    
    // Background sync queues
    pendingMissingKeys: new Set(),
    syncTimeout: null,
    
    // DOM Mutation tracking
    observer: null,
    translateTimeout: null,

    async init() {
        if (window.eel && eel.get_available_languages) {
            this.availableLanguages = await eel.get_available_languages()();
            await this.loadDictionary(this.currentLocale);
        }
        
        // Start watching the DOM for dynamic changes after the first load
        this.startObserver();
    },

    async loadDictionary(localeCode) {
        this.currentLocale = localeCode;
        localStorage.setItem('btt_locale', localeCode);

        try {
            const response = await fetch(`/assets/locale/${localeCode}.json?t=${new Date().getTime()}`);
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

    // ---------------------------------------------------------
    // MUTATION OBSERVER (Catches dynamically injected HTML)
    // ---------------------------------------------------------
    startObserver() {
        this.observer = new MutationObserver((mutations) => {
            // Debounce: Wait 50ms for JS to finish injecting elements before translating
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
            // Watch the entire body for injected nodes (childList) and deep changes (subtree)
            this.observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }
    },

    // ---------------------------------------------------------
    // METHOD 1: The DOM Scanner (For HTML files)
    // ---------------------------------------------------------
    async translatePage() {
        // PAUSE the observer so our translations don't trigger an infinite loop
        this.pauseObserver();

        const missingKeys = new Set();

        // 1. Standard text translations
        document.querySelectorAll('[data-i18n]').forEach(el => {
            let key = el.getAttribute('data-i18n');
            if (!key) {
                key = el.innerHTML.trim();
                el.setAttribute('data-i18n', key); 
            }
            if (key) {
                if (this.dictionary[key] !== undefined && this.dictionary[key] !== "") {
                    // Only update if it actually changed to save browser paint cycles
                    if (el.innerHTML !== this.dictionary[key]) {
                        el.innerHTML = this.dictionary[key];
                    }
                } else {
                    missingKeys.add(key);
                }
            }
        });

        // 2. Placeholder translations
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            let key = el.getAttribute('data-i18n-placeholder');
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

        // 3. Title/Tooltip translations
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            let key = el.getAttribute('data-i18n-title');
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

        // RESUME the observer now that we are done changing the DOM
        this.resumeObserver();
    },

    // ---------------------------------------------------------
    // METHOD 2: The JS Translator (For Toast messages/dynamic JS)
    // ---------------------------------------------------------
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