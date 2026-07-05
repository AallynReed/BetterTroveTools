document.addEventListener('home_loaded', () => {
    console.log("Home Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, onUnmounted } = Vue;
    const NEWS_COLLAPSED_PREF_KEY = 'home_official_news_collapsed_v1';
    const NEWS_REFRESH_MS = 30 * 60 * 1000;
    const SECTION_ORDER_PREF_KEY = 'home_section_order_v1';
    const SECTION_COLLAPSED_PREF_KEY = 'home_section_collapsed_v1';
    const DENSITY_PREF_KEY = 'home_density_v1';
    const QUICK_TOOLS_PREF_KEY = 'home_quick_tools_v1';
    const WHATS_NEW_PREF_KEY = 'home_whats_new_seen_version_v1';
    const SUPPORT_CARD_PREF_KEY = 'home_support_card_dismissed_v1';
    const NAV_VISITS_PREF_KEY = 'home_nav_visits';
    const NEWS_CATEGORY_PREF_KEY = 'home_news_category_v1';
    const DEFAULT_SECTION_ORDER = ['streams', 'news', 'rotations'];
    const URGENT_THRESHOLD_SEC = 2 * 60 * 60;

    const QUICK_TOOLS_CATALOG = [
        { id: 'gems_and_builds:gem-builds', label: 'Gem Builds', icon: 'fa-dice-five', target: 'gems_and_builds', gemsTab: 'gem-builds' },
        { id: 'gems_and_builds:star-chart', label: 'Star Chart', icon: 'fa-star', target: 'gems_and_builds', gemsTab: 'star-chart' },
        { id: 'gems_and_builds:gem-evaluator', label: 'Gem Evaluator', icon: 'fa-magnifying-glass-chart', target: 'gems_and_builds', gemsTab: 'gem-evaluator' },
        { id: 'gems_and_builds:gem-simulator', label: 'Gem Simulator', icon: 'fa-gem', target: 'gems_and_builds', gemsTab: 'gem-simulator' },
        { id: 'mod_manager:mod_manager', label: 'My Mods', icon: 'fa-cubes', target: 'mod_manager', mmSection: 'mod_manager' },
        { id: 'mod_manager:trovesaurus', label: 'Trovesaurus', icon: 'fa-folder-open', target: 'mod_manager', mmSection: 'trovesaurus' },
        { id: 'game_explorer:file_explorer', label: 'File Explorer', icon: 'fa-folder-tree', target: 'game_explorer', gxTab: 'tab-explorer' },
        { id: 'game_explorer:update_tracker', label: 'Update Tracker', icon: 'fa-satellite-dish', target: 'game_explorer', gxTab: 'tab-tracker' },
        { id: 'modder_tools:build', label: 'Build TMod', icon: 'fa-hammer', target: 'modder_tools', modderTab: 'build' },
        { id: 'modder_tools:extract', label: 'Extract TMod', icon: 'fa-box-open', target: 'modder_tools', modderTab: 'extract' },
        { id: 'calculators', label: 'Calculators', icon: 'fa-calculator', target: 'calculators' },
        { id: 'codexes:allies', label: 'Ally Codex', icon: 'fa-paw', target: 'codexes', codexTab: 'allies', beta: true },
        { id: 'codexes:mounts', label: 'Mount Codex', icon: 'fa-horse', target: 'codexes', codexTab: 'mounts', beta: true },
        { id: 'codexes:dragons', label: 'Dragon Codex', icon: 'fa-dragon', target: 'codexes', codexTab: 'dragons', beta: true },
        { id: 'codexes:mementos', label: 'Memento Codex', icon: 'fa-scroll', target: 'codexes', codexTab: 'mementos', beta: true },
        { id: 'codexes:recipes', label: 'Recipe Codex', icon: 'fa-book', target: 'codexes', codexTab: 'recipes', beta: true },
        { id: 'codexes:items', label: 'Item Codex', icon: 'fa-box', target: 'codexes', codexTab: 'items', beta: true },
        { id: 'codexes:fish', label: 'Fish Codex', icon: 'fa-fish', target: 'codexes', codexTab: 'fish', beta: true },
        { id: 'codexes:badges', label: 'Badge Codex', icon: 'fa-shield-halved', target: 'codexes', codexTab: 'badges', beta: true }
    ];
    const DEFAULT_QUICK_TOOLS = [
        'gems_and_builds:gem-builds',
        'gems_and_builds:star-chart',
        'mod_manager:trovesaurus',
        'calculators'
    ];
    const QUICK_TOOL_SLOT_COUNT = 4;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            let isDisposed = false;
            let homeViewAbortController = new AbortController();
            
            const resetHomeAbortController = () => {
                if (homeViewAbortController) {
                    try { homeViewAbortController.abort(); } catch {}
                }
                homeViewAbortController = new AbortController();
                return homeViewAbortController;
            };

            const cancelHomeWork = async () => {
                isDisposed = true;
                resetHomeAbortController();
                window._homeAppHandleYoutube = null;
                window._homeAppHandleTwitch = null;
                window._homeAppHandleBilibili = null;
                window._homeAppHandleEvents = null;
                window._homeAppHandleNews = null;
                window._homeAppHandleGiveaways = null;
                window._homeAppHandleUpcomingGiveaways = null;
                window._homeAppHandleEndedGiveaways = null;
                window._homeAppHandleActivity = null;
                if (window.eel && eel.cancel_home_fetches) {
                    try {
                        await eel.cancel_home_fetches()();
                    } catch (e) {}
                }
            };

            const settings = reactive({ show_community_content: true, show_official_news: true, show_player_activity: true });
            const isChinese = ref(window.I18nManager?.currentLocale === 'zh_CN');
            
            const mediaTab = ref('youtube');
            const carouselRef = ref(null);
            const newsCarouselRef = ref(null);
            const showShopOffers = ref(false);
            const isNewsCollapsed = ref(false);
            let hydratingNewsPrefs = false;
            
            const mediaData = reactive({
                youtube: { loading: true, data: [] },
                twitch: { loading: true, data: [] },
                bilibili: { loading: true, data: [] }
            });
            const activeMediaPlatformKey = computed(() => ({
                youtube: 'YouTube',
                twitch: 'Twitch',
                bilibili: 'BiliBili'
            }[mediaTab.value] || 'YouTube'));

            const nowSec = ref(Math.floor(Date.now() / 1000));
            let timeInterval;
            let refreshInterval;
            let newsRefreshInterval;
            let resetTimer = null;

            const serverData = reactive({ loading: true, daily: null, weekly: null });
            const merchants = ref({});
            const stampy = ref(null);
            const d15 = ref(null);
            const delve = ref(null);
            const gardening = ref(null);
            const mana = ref(null);
            const chaosChest = ref(null);
            const schedulesCache = ref({});

            const events = reactive({ loading: true, error: false, data: [] });
            const news = reactive({ loading: true, error: false, data: [] });
            const giveaways = reactive({ loading: true, error: false, data: [] });
            const upcomingGiveaways = reactive({ loading: true, error: false, data: [] });
            const endedGiveaways = reactive({ loading: true, error: false, data: [] });
            const giveawayModal = reactive({ show: false });
            const activity = reactive({ loading: true, error: false, data: null });
            const timeMode = ref('local');
            
            const calendarModal = reactive({ show: false, isLoading: true, error: false });
            const calendarData = reactive({ months: [], days: [], tracks: [], todayPx: 0, totalWidth: 0, startTs: 0, dayWidth: 40 });
            const calendarViewFilter = ref('full');
            
            const rotationModal = reactive({
                show: false, titleHtml: '', color: '', iconClass: '', type: 'list',
                list: [], d15Cols: [], d15Rows: [], d15ShowFinalName: true, d15AllExpanded: false,
                delveWeeks: [], delveCurrentWeekId: null, isLoading: false, error: '', instanceKey: 0
            });

            const sectionOrder = ref([...DEFAULT_SECTION_ORDER]);
            const sectionCollapsed = reactive({ streams: false, news: false, rotations: false });
            const quickToolsMode = ref('auto');
            const quickToolsCustom = ref([...DEFAULT_QUICK_TOOLS]);
            const quickToolsEditing = ref(false);
            const quickToolsEditingSlot = ref(-1);
            const navVisits = ref({});
            const whatsNewRelease = ref(null);
            const whatsNewDismissed = ref(false);
            // Support card: hidden once the user dismisses, period. They can
            // still reach the donate flow from the sidebar at any time.
            const supportCardDismissed = ref(
                !!(window.AppSettings && window.AppSettings.getPref(SUPPORT_CARD_PREF_KEY, false))
            );
            const newsActiveCategory = ref('all');
            const draggingSectionId = ref(null);
            const dragInsertBefore = ref(null);
            const serverTimeNowText = ref('--:--:--');
            let hydratingHomePrefs = false;

            const openUrl = (url) => eel.open_url_in_browser(url)();

            // --- Giveaway joining (desktop + signed in) -------------------------
            // On desktop a signed-in user can enter giveaways in-app; signed-out
            // users get a sign-in hint. On web/Android (no eel auth) we keep the
            // existing "open the website" behaviour.
            const GIVEAWAYS_URL = 'https://trove.aallyn.net/giveaways';
            const isGiveawayWebMode = window.BTT_WEB_MODE === true;
            const giveawayLoggedIn = ref(!!(window.BTTAccount && window.BTTAccount.state.authenticated));
            const enteredGiveaways = ref(new Set());
            const joiningGiveaway = ref('');
            let unsubGiveawayAccount = null;

            const isGiveawayEntered = (id) => enteredGiveaways.value.has(id);

            const refreshMyGiveaways = async () => {
                if (isGiveawayWebMode || !giveawayLoggedIn.value || !window.eel || !eel.site_giveaway_mine) {
                    enteredGiveaways.value = new Set();
                    return;
                }
                try {
                    const res = await eel.site_giveaway_mine()();
                    if (res && res.success && res.data) enteredGiveaways.value = new Set(res.data.giveaway_ids || []);
                } catch (e) { /* offline / not signed in */ }
            };

            const giveawaySignIn = () => {
                giveawayModal.show = false;
                if (window.loadView) window.loadView('account');
            };

            const joinGiveaway = async (g) => {
                if (isGiveawayWebMode) { openUrl(GIVEAWAYS_URL); return; }
                if (!giveawayLoggedIn.value) { giveawaySignIn(); return; }
                if (joiningGiveaway.value || isGiveawayEntered(g.id)) return;
                joiningGiveaway.value = g.id;
                try {
                    const res = await eel.site_giveaway_enter(g.id)();
                    if (res && res.success && res.data && res.data.entered) {
                        enteredGiveaways.value = new Set([...enteredGiveaways.value, g.id]);
                        const raw = giveaways.data.find(x => x.id === g.id);
                        if (raw && typeof res.data.entry_count === 'number') raw.entry_count = res.data.entry_count;
                        if (window.showToast) window.showToast(t('home.giveaways.entered_toast'));
                    } else if (window.showToast) {
                        window.showToast((res && res.error) || t('home.giveaways.enter_failed'), true);
                    }
                } catch (e) {
                    if (window.showToast) window.showToast(t('home.giveaways.enter_failed'), true);
                }
                joiningGiveaway.value = '';
            };
            // The Vue template ref binds asynchronously and the eel-backed
            // desktop WebView has historically had quirks with scrollBy +
            // behavior:'smooth'. Fall back to walking the carousel's children
            // and setting scrollLeft directly -- this works even when the ref
            // is briefly stale (querySelector finds the live element) and even
            // when smooth-scrolling silently no-ops. The `amount` sign is the
            // only thing that matters now (negative = previous, positive = next).
            const stepCarousel = (selector, amount) => {
                const root = document.querySelector(selector);
                if (!root) return;
                const cards = root.children;
                if (!cards.length) return;
                const cur = root.scrollLeft;
                const view = root.clientWidth;
                let targetLeft = cur;
                if (amount > 0) {
                    // Snap to the first child whose right edge is past the visible area.
                    for (const c of cards) {
                        if (c.offsetLeft + c.offsetWidth > cur + view + 1) {
                            targetLeft = c.offsetLeft;
                            break;
                        }
                    }
                    // No child found ahead? Fall back to a plain pixel nudge.
                    if (targetLeft === cur) targetLeft = cur + Math.abs(amount);
                } else {
                    // Walk forward until we'd overshoot, then back one.
                    let prev = 0;
                    for (const c of cards) {
                        if (c.offsetLeft >= cur - 1) break;
                        prev = c.offsetLeft;
                    }
                    targetLeft = prev;
                    if (targetLeft === cur) targetLeft = Math.max(0, cur - Math.abs(amount));
                }
                root.scrollLeft = targetLeft;
            };
            const scrollCarousel = (amount) => stepCarousel('.streams-carousel', amount);
            const scrollNewsCarousel = (amount) => stepCarousel('.news-carousel', amount);
            const toggleNewsCollapsed = () => {
                isNewsCollapsed.value = !isNewsCollapsed.value;
                if (window.AppSettings) window.AppSettings.setPrefSync(NEWS_COLLAPSED_PREF_KEY, isNewsCollapsed.value);
            };

            const persistSectionState = () => {
                if (!window.AppSettings || hydratingHomePrefs) return;
                window.AppSettings.setPrefSync(SECTION_ORDER_PREF_KEY, sectionOrder.value.slice());
                window.AppSettings.setPrefSync(SECTION_COLLAPSED_PREF_KEY, { ...sectionCollapsed });
            };

            const isSectionCollapsed = (id) => !!sectionCollapsed[id];
            const toggleSectionCollapsed = (id) => {
                sectionCollapsed[id] = !sectionCollapsed[id];
                persistSectionState();
            };

            const onSectionDragStart = (id, e) => {
                draggingSectionId.value = id;
                dragInsertBefore.value = null;
                if (e?.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    try { e.dataTransfer.setData('text/plain', id); } catch {}
                }
            };
            const computeInsertBeforeId = (hoverId, clientY, rect) => {
                const order = sectionOrder.value;
                const idx = order.indexOf(hoverId);
                if (idx < 0) return hoverId;
                const midY = rect.top + rect.height / 2;
                if (clientY < midY) return hoverId;
                const nextId = order[idx + 1];
                return nextId || null;
            };
            const onSectionDragOver = (id, e) => {
                if (!draggingSectionId.value) return;
                if (e?.preventDefault) e.preventDefault();
                if (e?.dataTransfer) e.dataTransfer.dropEffect = 'move';
                const target = e.currentTarget;
                if (!target || !target.getBoundingClientRect) return;
                const rect = target.getBoundingClientRect();
                let insertBefore = computeInsertBeforeId(id, e.clientY, rect);
                const from = draggingSectionId.value;
                const order = sectionOrder.value;
                const fromIdx = order.indexOf(from);
                const insertIdx = insertBefore === null ? order.length : order.indexOf(insertBefore);
                if (fromIdx === insertIdx || fromIdx + 1 === insertIdx) {
                    dragInsertBefore.value = null;
                    return;
                }
                dragInsertBefore.value = insertBefore;
            };
            const onSectionDrop = (e) => {
                if (e?.preventDefault) e.preventDefault();
                const from = draggingSectionId.value;
                const insertBefore = dragInsertBefore.value;
                draggingSectionId.value = null;
                dragInsertBefore.value = null;
                if (!from) return;
                const order = sectionOrder.value.slice();
                const fromIdx = order.indexOf(from);
                if (fromIdx < 0) return;
                order.splice(fromIdx, 1);
                let insertIdx = insertBefore === null ? order.length : order.indexOf(insertBefore);
                if (insertIdx < 0) insertIdx = order.length;
                order.splice(insertIdx, 0, from);
                sectionOrder.value = order;
                persistSectionState();
            };
            const onSectionDragEnd = () => {
                draggingSectionId.value = null;
                dragInsertBefore.value = null;
            };
            const showDropLine = (id, edge) => {
                if (!draggingSectionId.value) return false;
                if (edge === 'before') return dragInsertBefore.value === id;
                if (edge === 'after') {
                    const order = sectionOrder.value;
                    return dragInsertBefore.value === null && order[order.length - 1] === id;
                }
                return false;
            };
            const onTailDragOver = (e) => {
                if (!draggingSectionId.value) return;
                if (e?.preventDefault) e.preventDefault();
                if (e?.dataTransfer) e.dataTransfer.dropEffect = 'move';
                const order = sectionOrder.value;
                const lastId = order[order.length - 1];
                if (lastId === draggingSectionId.value) {
                    dragInsertBefore.value = null;
                    return;
                }
                dragInsertBefore.value = null;
            };

            const persistQuickToolsPref = () => {
                if (!window.AppSettings || hydratingHomePrefs) return;
                window.AppSettings.setPrefSync(QUICK_TOOLS_PREF_KEY, {
                    mode: quickToolsMode.value,
                    custom: quickToolsCustom.value.slice()
                });
            };

            const visitsKey = ref(0);
            const refreshNavVisits = () => {
                if (!window.AppSettings) return;
                const v = window.AppSettings.getPref(NAV_VISITS_PREF_KEY, {});
                navVisits.value = v && typeof v === 'object' ? { ...v } : {};
                visitsKey.value += 1;
            };

            const topVisitedToolIds = computed(() => {
                void visitsKey.value;
                const visits = navVisits.value || {};
                const ranked = ['mod_manager', 'modder_tools', 'gems_and_builds', 'calculators', 'codexes']
                    .filter(id => (visits[id] || 0) > 0)
                    .sort((a, b) => (visits[b] || 0) - (visits[a] || 0));
                // In the native app, never surface desktop-only tools.
                const hiddenHere = (target) => window.BTT_NATIVE === true && isWebUnavailable(target);
                const tools = [];
                const seen = new Set();
                for (const id of ranked) {
                    const tool = QUICK_TOOLS_CATALOG.find(c => c.target === id);
                    if (tool && !seen.has(tool.id) && !hiddenHere(tool.target)) { tools.push(tool.id); seen.add(tool.id); }
                    if (tools.length >= QUICK_TOOL_SLOT_COUNT) break;
                }
                for (const def of DEFAULT_QUICK_TOOLS) {
                    if (tools.length >= QUICK_TOOL_SLOT_COUNT) break;
                    const tool = QUICK_TOOLS_CATALOG.find(c => c.id === def);
                    if (!seen.has(def) && !(tool && hiddenHere(tool.target))) { tools.push(def); seen.add(def); }
                }
                // Native: backfill remaining slots from the available catalog so removing
                // desktop-only tools doesn't leave empty "Add tool" placeholders.
                if (window.BTT_NATIVE === true) {
                    for (const c of QUICK_TOOLS_CATALOG) {
                        if (tools.length >= QUICK_TOOL_SLOT_COUNT) break;
                        if (!seen.has(c.id) && !hiddenHere(c.target) && !c.beta) { tools.push(c.id); seen.add(c.id); }
                    }
                }
                return tools;
            });

            const quickToolsList = computed(() => {
                const ids = quickToolsMode.value === 'custom'
                    ? quickToolsCustom.value
                    : topVisitedToolIds.value;
                const out = [];
                for (let i = 0; i < QUICK_TOOL_SLOT_COUNT; i++) {
                    const id = ids[i];
                    let tool = id ? QUICK_TOOLS_CATALOG.find(t => t.id === id) : null;
                    // Drop desktop-only tools in the native app (e.g. a custom slot).
                    if (tool && window.BTT_NATIVE === true && isWebUnavailable(tool.target)) tool = null;
                    out.push(tool || null);
                }
                return out;
            });

            const isWebUnavailable = (target) => {
                if (!target) return false;
                const blocked = window.BTT_UNAVAILABLE_WEB_VIEWS || [];
                return window.BTT_WEB_MODE === true && blocked.includes(target);
            };

            const navigateToTool = (tool) => {
                if (!tool || isWebUnavailable(tool.target)) return;
                document.dispatchEvent(new CustomEvent('btt_navigate', {
                    detail: {
                        target: tool.target,
                        modderTab: tool.modderTab,
                        gxTab: tool.gxTab,
                        mmSection: tool.mmSection,
                        gemsTab: tool.gemsTab,
                        codexTab: tool.codexTab
                    }
                }));
            };

            // Enter customise mode: switch to the custom set (seeding it from the
            // most-visited tools the first time) and turn on slot editing.
            const startQuickToolsEditing = () => {
                if (quickToolsMode.value !== 'custom') {
                    quickToolsMode.value = 'custom';
                    if (!quickToolsCustom.value || quickToolsCustom.value.length === 0) {
                        quickToolsCustom.value = topVisitedToolIds.value.slice();
                    }
                }
                quickToolsEditing.value = true;
                quickToolsEditingSlot.value = -1;
                persistQuickToolsPref();
            };

            // Leave edit mode but keep the custom layout — slots become clickable
            // shortcuts again instead of openers for the tool picker.
            const finishQuickToolsEditing = () => {
                quickToolsEditing.value = false;
                quickToolsEditingSlot.value = -1;
                persistQuickToolsPref();
            };

            // Drop the custom layout and go back to the auto "most visited" list.
            const useAutoQuickTools = () => {
                quickToolsMode.value = 'auto';
                quickToolsEditing.value = false;
                quickToolsEditingSlot.value = -1;
                persistQuickToolsPref();
            };

            const openQuickToolSlotEditor = (slotIdx) => {
                if (!quickToolsEditing.value) return;
                quickToolsEditingSlot.value = quickToolsEditingSlot.value === slotIdx ? -1 : slotIdx;
            };

            const setQuickToolAtSlot = (slotIdx, toolId) => {
                const arr = quickToolsCustom.value.slice();
                while (arr.length < QUICK_TOOL_SLOT_COUNT) arr.push(null);
                arr[slotIdx] = toolId || null;
                quickToolsCustom.value = arr;
                quickToolsEditingSlot.value = -1;
                persistQuickToolsPref();
            };

            const clearQuickToolSlot = (slotIdx) => setQuickToolAtSlot(slotIdx, null);

            const quickToolsCatalogVisible = computed(() => {
                const betaHidden = window.AppSettings ? window.AppSettings.get('hide_beta_features', false) === true : false;
                return QUICK_TOOLS_CATALOG.filter(t => !isWebUnavailable(t.target) && !(t.beta && betaHidden));
            });

            const loadWhatsNew = async () => {
                if (window.BTT_WEB_MODE) return;
                try {
                    let releases = window.BTT_GH_RELEASES;
                    if (!releases) {
                        const res = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/releases?per_page=3');
                        if (!res.ok) return;
                        releases = await res.json();
                        window.BTT_GH_RELEASES = releases;
                    }
                    const latest = Array.isArray(releases)
                        ? releases.find(r => r && !r.draft && !r.prerelease)
                        : null;
                    if (!latest) return;
                    const body = (latest.body || '').split(/\r?\n/)
                        .map(line => line.replace(/^[#\-*\s>]+/, '').trim())
                        .filter(Boolean);
                    whatsNewRelease.value = {
                        tag: latest.tag_name,
                        name: latest.name || latest.tag_name,
                        url: latest.html_url,
                        headline: body[0] || (latest.name || latest.tag_name),
                        publishedAt: latest.published_at
                    };
                    if (window.AppSettings) {
                        const seen = window.AppSettings.getPref(WHATS_NEW_PREF_KEY, '');
                        whatsNewDismissed.value = seen === latest.tag_name;
                    }
                } catch {}
            };
            const dismissWhatsNew = () => {
                if (!whatsNewRelease.value) return;
                whatsNewDismissed.value = true;
                if (window.AppSettings) {
                    window.AppSettings.setPrefSync(WHATS_NEW_PREF_KEY, whatsNewRelease.value.tag);
                }
            };
            const whatsNewVisible = computed(() => !!whatsNewRelease.value && !whatsNewDismissed.value);

            const supportCardVisible = computed(() => !supportCardDismissed.value);
            const dismissSupportCard = () => {
                supportCardDismissed.value = true;
                if (window.AppSettings) {
                    window.AppSettings.setPrefSync(SUPPORT_CARD_PREF_KEY, true);
                }
            };
            // Open the About view with the donate hero scrolled into focus.
            // Uses the same window.pendingViewScroll handshake the sidebar
            // "Support the Project" button uses.
            const openSupport = () => {
                window.pendingViewScroll = { view: 'about', elementId: 'donate-hero' };
                if (typeof window.loadView === 'function') window.loadView('about');
            };

            const newsCategoriesAvailable = computed(() => {
                const counts = new Map();
                (news.data || []).forEach((item) => {
                    (item.categories || []).forEach((cat) => {
                        if (!cat) return;
                        if (!showShopOffers.value && cat === 'Shop Offers') return;
                        counts.set(cat, (counts.get(cat) || 0) + 1);
                    });
                });
                return Array.from(counts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([cat, count]) => ({ id: cat, label: cat, count }));
            });

            const setNewsCategory = (cat) => {
                newsActiveCategory.value = cat || 'all';
                if (window.AppSettings) window.AppSettings.setPrefSync(NEWS_CATEGORY_PREF_KEY, newsActiveCategory.value);
            };

            const saveShopOfferPreference = async () => {
                try {
                    const currentSettings = window.AppSettings
                        ? await window.AppSettings.load()
                        : await eel.get_settings()();
                    currentSettings.show_news_shop_offers = showShopOffers.value;
                    await eel.save_settings(currentSettings)();
                    if (window.AppSettings) {
                        window.AppSettings._cache = { ...currentSettings };
                    }
                } catch (e) {}
            };

            const getTimeAgo = (dateString) => {
                const date = new Date(dateString);
                const diffTime = Math.abs(new Date() - date);
                const diffSeconds = Math.floor(diffTime / 1000);
                const diffMinutes = Math.floor(diffSeconds / 60);
                const diffHours = Math.floor(diffMinutes / 60);
                const diffDays = Math.floor(diffHours / 24);
            
                if (diffDays > 7) return date.toLocaleDateString(window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US', { month: 'short', day: 'numeric' });
                if (diffDays > 0) return t('home.count_days_ago').replace('{count}', diffDays);
                if (diffHours > 0) return t('home.count_hours_ago').replace('{count}', diffHours);
                if (diffMinutes > 0) return t('home.count_minutes_ago').replace('{count}', diffMinutes);
                return t('common.just_now');
            };

            const getCountdown = (targetTs, showLeft = true) => {
                // Clamp to 0 so an already-elapsed timestamp renders "0 minutes"
                // instead of the literal "null" (callers interpolate this directly).
                const diff = Math.max(0, targetTs - nowSec.value);
                const days = Math.floor(diff / 86400);
                const hours = Math.floor((diff % 86400) / 3600);
                const mins = Math.floor((diff % 3600) / 60);
                let parts = [];
                if (days > 0) { parts.push(t("home.count_days").replace("{count}", days)); if (hours > 0) parts.push(t("home.count_hours").replace("{count}", hours)); }
                else if (hours > 0) { parts.push(t("home.count_hours").replace("{count}", hours)); if (mins > 0) parts.push(t("common.count_minutes").replace("{count}", mins)); }
                else parts.push(t("common.count_minutes").replace("{count}", mins));
                const timeStr = parts.join(" ");
                return showLeft ? t("home.time_left").replace("{time}", timeStr) : timeStr;
            };

            const TROVE_OFFSET_MS = 11 * 3600000;
            const DAY_MS = 86400000;

            const toDisplayDate = (input) => {
                const base = input instanceof Date ? new Date(input.getTime()) : new Date(input);
                if (timeMode.value !== 'trove') return base;
                const utcMs = base.getTime() + (base.getTimezoneOffset() * 60000);
                return new Date(utcMs - (11 * 3600000));
            };

            const toTimelineDisplayMs = (input) => {
                const baseMs = input instanceof Date ? input.getTime() : new Date(input).getTime();
                return timeMode.value === 'trove' ? baseMs - TROVE_OFFSET_MS : baseMs;
            };

            const getTimelineDayStartMs = (input, dayOffset = 0) => {
                const baseMs = input instanceof Date ? input.getTime() : new Date(input).getTime();
                if (timeMode.value !== 'trove') {
                    const d = new Date(baseMs);
                    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset).getTime();
                }

                const shifted = new Date(baseMs - TROVE_OFFSET_MS);
                return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + dayOffset);
            };

            const formatTimelineDate = (displayMs, options) => {
                const locale = (window.I18nManager && window.I18nManager.currentLocale)
                    ? window.I18nManager.currentLocale.replace('_', '-')
                    : 'en-US';
                const formatOptions = timeMode.value === 'trove'
                    ? { ...options, timeZone: 'UTC' }
                    : options;
                return new Date(displayMs).toLocaleDateString(locale, formatOptions);
            };

            const updateCalendarNowMarker = () => {
                if (!calendarData.startTs || !calendarData.dayWidth) return;
                const displayNowTs = toTimelineDisplayMs(nowSec.value * 1000);
                calendarData.todayPx = ((displayNowTs - calendarData.startTs) / DAY_MS) * calendarData.dayWidth;
            };

            const formatDisplayDate = (ts, options) => {
                const locale = (window.I18nManager && window.I18nManager.currentLocale)
                    ? window.I18nManager.currentLocale.replace('_', '-')
                    : 'en-US';
                return toDisplayDate(ts).toLocaleString(locale, options);
            };

            const formatDateRange = (startTs, endTs) => {
                const start = formatDisplayDate(startTs * 1000, { month: 'short', day: 'numeric' });
                const end = formatDisplayDate(endTs * 1000, { month: 'short', day: 'numeric' });
                return `${start} - ${end}`;
            };

            const formatDelveWeekRange = (startTs, endTs) => {
                const locale = (window.I18nManager && window.I18nManager.currentLocale)
                    ? window.I18nManager.currentLocale.replace('_', '-')
                    : 'en-US';
                const formatOptions = { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' };
                const monday = new Date(startTs * 1000).toLocaleString(locale, formatOptions);
                const sundayTs = endTs - 86400;
                const sunday = new Date(sundayTs * 1000).toLocaleString(locale, formatOptions);
                return `${monday} through ${sunday}`;
            };

            const getDelveWeekHeading = (week) => {
                if (!week) return '';
                if (week.isCurrent) return t("home.this_week_s");
                if (rotationModal.delveCurrentWeekId && week.weekId === rotationModal.delveCurrentWeekId - 1) return t('home.last_week');
                return formatDelveWeekRange(week.start, week.end);
            };

            const displayDateKey = (input) => {
                const d = toDisplayDate(input);
                return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            };

            window._homeAppHandleYoutube = (response) => {
                if (isDisposed) return;
                mediaData.youtube.loading = false;
                if (response?.success && response.data) {
                    mediaData.youtube.data = response.data.sort((a, b) => new Date(b.published_at) - new Date(a.published_at)).map(v => ({
                        url: v.url, thumb: v.thumbnail_url, title: v.title, channel: v.channel,
                        badgeHtml: getTimeAgo(v.published_at),
                        verified: ['Trove'].includes(v.channel), iconColor: '#FF0000'
                    }));
                }
            };

            window._homeAppHandleTwitch = (response) => {
                if (isDisposed) return;
                mediaData.twitch.loading = false;
                if (response?.success && response.data) {
                    mediaData.twitch.data = response.data.sort((a, b) => b.viewer_count - a.viewer_count).map(v => ({
                        url: `https://twitch.tv/${v.user_login}`, thumb: v.thumbnail_url.replace('{width}', '440').replace('{height}', '248'), title: v.title, channel: v.user_name,
                        badgeHtml: `🔴 ${v.viewer_count.toLocaleString()}`,
                        verified: ['trovegame'].includes(v.user_login.toLowerCase()), iconColor: '#9146FF'
                    }));
                }
            };

            window._homeAppHandleBilibili = (response) => {
                if (isDisposed) return;
                mediaData.bilibili.loading = false;
                if (response?.success && response.data) {
                    // Bilibili thumbnails (hdslb.com) need a Referer-injecting proxy.
                    // Desktop serves one locally; the web/Android builds have no local
                    // server, so route through the Kiwi API's proxy (reachable on every
                    // platform — cross-origin <img> loads aren't subject to CORS).
                    const biliImgBase = window.BTT_WEB_MODE
                        ? 'https://api.aallyn.net/v1/feeds/bilibili/image'
                        : '/proxy/bilibili_image';
                    mediaData.bilibili.data = response.data.sort((a, b) => new Date(b.published_at) - new Date(a.published_at)).map(v => ({
                        url: v.url, thumb: `${biliImgBase}?url=${encodeURIComponent(v.thumbnail_url)}`, title: v.title, channel: v.channel,
                        badgeHtml: getTimeAgo(v.published_at),
                        verified: false, iconColor: '#00A1D6'
                    }));
                }
            };

            window._homeAppHandleEvents = (response) => {
                if (isDisposed) return;
                events.loading = false;
                if (response?.success && response.data) {
                    events.data = response.data;
                    events.error = false;
                } else {
                    events.error = true;
                }
            };

            window._homeAppHandleNews = (response) => {
                if (isDisposed) return;
                news.loading = false;
                if (response?.success && response.data) {
                    news.data = response.data;
                    news.error = false;
                } else {
                    news.error = true;
                }
            };

            const makeGiveawayHandler = (bucket) => (response) => {
                if (isDisposed) return;
                bucket.loading = false;
                if (response?.success && Array.isArray(response.data)) {
                    bucket.data = response.data;
                    bucket.error = false;
                } else {
                    bucket.error = true;
                }
            };
            window._homeAppHandleGiveaways = makeGiveawayHandler(giveaways);
            window._homeAppHandleUpcomingGiveaways = makeGiveawayHandler(upcomingGiveaways);
            window._homeAppHandleEndedGiveaways = makeGiveawayHandler(endedGiveaways);

            window._homeAppHandleActivity = (response) => {
                if (isDisposed) return;
                activity.loading = false;
                if (response?.success && response.data && typeof response.data === 'object') {
                    activity.data = response.data;
                    activity.error = false;
                } else {
                    activity.error = true;
                }
            };

            const mappedEvents = computed(() => {
                return events.data.map(ev => {
                    const startTs = parseInt(ev.startdate);
                    const endTs = parseInt(ev.enddate);
                    const startStr = formatDisplayDate(startTs * 1000, { month: 'short', day: 'numeric' });
                    const endStr = formatDisplayDate(endTs * 1000, { month: 'short', day: 'numeric' });

                    let statusText = '';
                    let statusClass = '';

                    if (nowSec.value < startTs) {
                        statusText = t("home.starts_in_time").replace("{time}", getCountdown(startTs, false));
                        statusClass = 'is-upcoming';
                    } else if (nowSec.value < endTs) {
                        statusText = t("home.ends_in_time").replace("{time}", getCountdown(endTs, false));
                        statusClass = 'is-active';
                    } else {
                        statusText = t("home.ended");
                        statusClass = 'is-ended';
                    }

                    return {
                        ...ev,
                        startStr,
                        endStr,
                        statusText,
                        statusClass,
                        img: ev.image || ev.icon || 'https://trovesaurus.com/images/logos/Sage_64.png'
                    };
                });
            });

            const mappedNews = computed(() => {
                const filtered = news.data.filter((item) => {
                    if (!showShopOffers.value && (item.categories || []).includes('Shop Offers')) return false;
                    if (newsActiveCategory.value !== 'all' && !(item.categories || []).includes(newsActiveCategory.value)) return false;
                    return true;
                });
                return filtered.slice(0, 10).map((item, index) => ({
                    ...item,
                    id: item.url || `${item.title}-${index}`,
                    publishedLabel: getTimeAgo(item.published_at),
                    image: item.image || '/assets/images/no_preview.png'
                }));
            });

            const mappedActivity = computed(() => {
                const d = activity.data;
                if (!d) return null;
                const fmt = (n) => (typeof n === 'number' && isFinite(n)) ? n.toLocaleString() : '—';
                // window_end is when the most recent capture closed; use that
                // (or computed_at as a fallback) for the "updated" label so it
                // reflects data age, not server clock skew.
                const stampSec = (typeof d.window_end === 'number' && d.window_end) || d.computed_at || 0;
                const updatedAgoText = stampSec
                    ? getTimeAgo(new Date(stampSec * 1000).toISOString())
                    : '';
                return {
                    estimate: fmt(d.estimate),
                    estimate_24h: fmt(d.estimate_24h),
                    estimate_7d: fmt(d.estimate_7d),
                    hasAny: typeof d.estimate === 'number' || typeof d.estimate_24h === 'number' || typeof d.estimate_7d === 'number',
                    updatedAgoText,
                    methodology: d.methodology || ''
                };
            });

            const fmtGiveawayDateTime = (ts) => {
                if (!ts) return '';
                const locale = (window.I18nManager && window.I18nManager.currentLocale)
                    ? window.I18nManager.currentLocale.replace('_', '-')
                    : 'en-US';
                return new Date(ts * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
            };
            const mapGiveawayList = (list, { urgentByEnd = false } = {}) => {
                return (list || []).map((g) => {
                    const endsTs = Math.floor(new Date(g.ends_at).getTime() / 1000) || 0;
                    const startsTs = Math.floor(new Date(g.starts_at).getTime() / 1000) || 0;
                    const entries = Number(g.entry_count) || 0;
                    // Per-entry odds as a percentage with two decimals (e.g.
                    // 2 entries -> "50.00", 1000 entries -> "0.10"). The
                    // template wraps it with the locale's "Odds" label + %.
                    const oddsText = entries > 0
                        ? t('home.giveaways.odds_percent').replace('{percent}', (100 / entries).toFixed(2))
                        : t('home.giveaways.odds_unknown');
                    const isUrgent = urgentByEnd && endsTs > 0 && (endsTs - nowSec.value) <= URGENT_THRESHOLD_SEC;
                    return {
                        id: g.id,
                        status: g.status || '',
                        title: g.title || g.prize_name,
                        prizeName: g.prize_name,
                        description: g.description,
                        entries,
                        oddsText,
                        startsTs,
                        endsTs,
                        startsAtText: fmtGiveawayDateTime(startsTs),
                        endsAtText: fmtGiveawayDateTime(endsTs),
                        startsInText: startsTs > 0 ? t('home.giveaways.starts_in_time').replace('{time}', getCountdown(startsTs, false)) : '',
                        endsInText: endsTs > 0 ? t('home.ends_in_time').replace('{time}', getCountdown(endsTs, false)) : '',
                        isUrgent,
                        winner: g.winner_username || null
                    };
                });
            };

            const mappedGiveaways = computed(() => mapGiveawayList(
                (giveaways.data || []).filter((g) => g && g.status === 'open'),
                { urgentByEnd: true }
            ));
            const mappedUpcoming = computed(() => mapGiveawayList(upcomingGiveaways.data || []));
            const mappedEnded = computed(() => mapGiveawayList(endedGiveaways.data || []));

            // Single-line summary for the home-page giveaway tile. Cascades:
            // ongoing → upcoming → recently-ended → empty. Each bucket
            // becomes the primary state only when no earlier one has rows,
            // so a live giveaway always wins the headline.
            const giveawayTileSummary = computed(() => {
                const ongoingList = mappedGiveaways.value;
                const upcomingList = mappedUpcoming.value;
                const endedList = mappedEnded.value;

                if (giveaways.loading && upcomingGiveaways.loading && endedGiveaways.loading) {
                    return { statusText: '', headline: t('home.giveaways.loading'), subline: '', tooltip: '', isUrgent: false };
                }
                if (giveaways.error && upcomingGiveaways.error && endedGiveaways.error) {
                    return { statusText: '', headline: t('home.giveaways.error'), subline: '', tooltip: '', isUrgent: false };
                }

                if (ongoingList.length > 0) {
                    const first = ongoingList[0];
                    const statusText = ongoingList.length === 1
                        ? t('home.giveaways.tile_status_open')
                        : t('home.giveaways.tile_status_open_count').replace('{count}', ongoingList.length);
                    return {
                        statusText,
                        headline: first.prizeName,
                        subline: first.endsInText,
                        tooltip: `${first.prizeName} - ${first.endsAtText}`,
                        isUrgent: first.isUrgent
                    };
                }

                if (upcomingList.length > 0) {
                    const first = upcomingList[0];
                    const statusText = upcomingList.length === 1
                        ? t('home.giveaways.tile_status_upcoming')
                        : t('home.giveaways.tile_status_upcoming_count').replace('{count}', upcomingList.length);
                    return {
                        statusText,
                        headline: first.prizeName,
                        subline: first.startsInText,
                        tooltip: `${first.prizeName} - ${first.startsAtText}`,
                        isUrgent: false
                    };
                }

                if (endedList.length > 0) {
                    const statusText = endedList.length === 1
                        ? t('home.giveaways.tile_status_recent')
                        : t('home.giveaways.tile_status_recent_count').replace('{count}', endedList.length);
                    return {
                        statusText,
                        headline: t('home.giveaways.recently_ended_short'),
                        subline: t('home.giveaways.click_for_details'),
                        tooltip: t('home.giveaways.recently_ended_tooltip').replace('{count}', endedList.length),
                        isUrgent: false
                    };
                }

                return {
                    statusText: t('home.giveaways.tile_status_none'),
                    headline: t('home.giveaways.empty_short'),
                    subline: t('home.giveaways.click_for_details'),
                    tooltip: t('home.giveaways.empty'),
                    isUrgent: false
                };
            });

            const openGiveawayModal = () => { giveawayModal.show = true; refreshMyGiveaways(); };

            // Tiles hide themselves entirely on fetch failure (Kiwi API down,
            // CORS reject, etc.) so the home page declutters instead of showing
            // a permanent error pill. The row wrapper collapses when both go.
            // For the giveaway tile: only hide when all three buckets failed —
            // any single working endpoint is enough to keep the tile useful.
            const showActivityTile = computed(() => settings.show_player_activity && !activity.error);
            const showGiveawayTile = computed(() => !(giveaways.error && upcomingGiveaways.error && endedGiveaways.error));
            const showStatRow = computed(() => showActivityTile.value || showGiveawayTile.value);

            const filteredCalendarTracks = computed(() => {
                const nowMs = nowSec.value * 1000;
                const nextWindowEnd = nowMs + (24 * 3600 * 1000);

                const filtered = calendarData.tracks.map((track) => {
                    let eventsForTrack = track.events;
                    if (calendarViewFilter.value === 'now') {
                        eventsForTrack = track.events.filter((ev) => ev.startTs <= nowMs && ev.endTs > nowMs);
                    } else if (calendarViewFilter.value === 'next') {
                        eventsForTrack = track.events.filter((ev) => ev.startTs > nowMs && ev.startTs <= nextWindowEnd);
                    }
                    return { ...track, events: eventsForTrack };
                }).filter((track) => track.events.length > 0);

                return filtered;
            });

            const chaosChestCard = computed(() => {
                if (!chaosChest.value) return null;
                const c = chaosChest.value;
                const now = nowSec.value;
                const end = c.data?.end || c.fallback_times?.end || 0;
                // If Trovesaurus endpoint failed, or end is in the past, show fallback/unknown
                if (!c.data || !c.data.end || end < now) {
                    return {
                        name: t('home.chaos_chest'),
                        identifier: null,
                        unknown: true,
                        iconUrl: "https://trovesaurus.com/data/catalog/item_chaos_box.png",
                        timeHtml: t("home.dates_start_end")
                            .replace("{start}", new Date((c.fallback_times?.start || 0) * 1000).toLocaleDateString())
                            .replace("{end}", new Date((c.fallback_times?.end || 0) * 1000).toLocaleDateString())
                    };
                }
                // Otherwise, show the real item
                return {
                    name: c.data?.name || "Chaos Chest",
                    identifier: c.data?.identifier,
                    unknown: !c.data?.blueprint,
                    iconUrl: c.data?.blueprint ? `https://trovesaurus.com/data/catalog/${c.data.blueprint.toLowerCase()}.png` : "https://trovesaurus.com/data/catalog/item_chaos_box.png",
                    timeHtml: t("home.changes_in_time").replace("{time}", `<b>${getCountdown(end, false)}</b>`)
                };
            });

            const merchantCards = computed(() => {
                const cards = [];
                const m = merchants.value;
                const now = nowSec.value;

                if (m.corruxion) cards.push({ type: 'merchant', id: 'corruxion', name: 'Corruxion', color: '#9c27b0', iconClass: 'fa-dragon', active: m.corruxion.active, statusText: m.corruxion.active ? 'ACTIVE' : 'AWAY', timeHtml: `${t(m.corruxion.action)} <b>${m.corruxion.time_str}</b>`, endTs: null });
                if (m.fluxion) cards.push({ type: 'merchant', id: 'fluxion', name: m.fluxion.active ? t("home.fluxion_state").replace("{state}", t(m.fluxion.state)) : 'Fluxion', color: '#4fc3f7', iconClass: 'fa-scale-balanced', active: m.fluxion.active, statusText: m.fluxion.active ? 'ACTIVE' : 'AWAY', timeHtml: `${t(m.fluxion.action)} <b>${m.fluxion.time_str}</b>`, endTs: null });

                if (stampy.value && stampy.value.current) {
                    const s = stampy.value.current;
                    const isActive = now >= s.start && now < s.end;
                    cards.push({ type: 'biome', id: 'stampy', name: 'Stampy', color: '#ff9800', iconClass: 'fa-paw', active: isActive, statusText: isActive ? 'ACTIVE' : 'AWAY', timeHtml: isActive ? t("home.leaves_in_time").replace("{time}", `<b>${getCountdown(s.end, false)}</b>`) : t("home.arrives_in_time").replace("{time}", `<b>${getCountdown(s.start, false)}</b>`), biomes: s.biomes, endTs: isActive ? s.end : null });
                }

                if (d15.value && d15.value.current) {
                    cards.push({ type: 'd15', id: 'd15', name: 'D15 Biomes', color: '#4caf50', iconClass: 'fa-leaf', active: true, statusText: 'ACTIVE', timeHtml: t("home.ends_in_time").replace("{time}", `<b>${getCountdown(d15.value.current.end, false)}</b>`), biomes: d15.value.current.biomes, endTs: d15.value.current.end });
                }

                if (gardening.value) {
                    const g = gardening.value;
                    const activeNames = [];
                    if (g.two_day.active) activeNames.push("2-day plants");
                    if (g.three_day.active) activeNames.push("3-day plants");
                    const isActive = activeNames.length > 0;

                    let gColor = '#8bc34a';
                    if (activeNames.length === 1 && activeNames[0].includes('3')) gColor = '#4caf50';
                    if (activeNames.length === 2) gColor = '#ff9800';

                    let titleStr = isActive ? activeNames.map(n => t(n)).join(" &amp; ") : t("home.gardening_cycles");
                    let timeHtml = "";
                    if (isActive) {
                        let endTs = g.two_day.active && g.three_day.active ? Math.min(g.two_day.end, g.three_day.end) : (g.two_day.active ? g.two_day.end : g.three_day.end);
                        timeHtml = t("home.ends_in_time").replace("{time}", `<b>${getCountdown(endTs, false)}</b>`);
                    } else {
                        let soonerStart = Math.min(g.two_day.start, g.three_day.start);
                        let nextName = soonerStart === g.two_day.start ? "2-day plants" : "3-day plants";
                        timeHtml = (g.two_day.start === g.three_day.start) ? `${t("home.2_day_plants")} &amp; ${t("home.3_day_plants")} - ` + t("home.starts_in_time").replace("{time}", `<b>${getCountdown(soonerStart, false)}</b>`) : `${t(nextName)} - ` + t("home.starts_in_time").replace("{time}", `<b>${getCountdown(soonerStart, false)}</b>`);
                    }
                    const gEnd = isActive
                        ? (g.two_day.active && g.three_day.active ? Math.min(g.two_day.end, g.three_day.end) : (g.two_day.active ? g.two_day.end : g.three_day.end))
                        : null;
                    cards.push({ type: 'gardening', id: 'gardening', name: titleStr, color: gColor, iconClass: 'fa-seedling', active: isActive, statusText: isActive ? 'HARVEST' : 'GROWING', timeHtml: timeHtml, endTs: gEnd });
                }

                if (mana.value && mana.value.current) {
                    cards.push({ type: 'biome', id: 'mana', name: 'Wild Trovian Mana', color: '#00bcd4', iconClass: 'fa-flask', active: true, statusText: 'ACTIVE', timeHtml: t("home.ends_in_time").replace("{time}", `<b>${getCountdown(mana.value.current.end, false)}</b>`), biomes: mana.value.current.biomes, endTs: mana.value.current.end });
                }

                // Delve Index card disabled — intentionally not surfaced in the rotation grid.

                const sorted = cards.sort((a, b) => {
                    if (a.id === 'd15' && b.id !== 'd15') return -1;
                    if (b.id === 'd15' && a.id !== 'd15') return 1;
                    if (a.active !== b.active) return a.active ? -1 : 1;
                    return 0;
                });

                let urgentEnd = Infinity;
                sorted.forEach((card) => {
                    if (card.active && typeof card.endTs === 'number' && card.endTs > now && (card.endTs - now) <= URGENT_THRESHOLD_SEC) {
                        if (card.endTs < urgentEnd) urgentEnd = card.endTs;
                    }
                });
                sorted.forEach((card) => {
                    card.isUrgent = card.active && card.endTs === urgentEnd && urgentEnd !== Infinity;
                });

                return sorted;
            });

            const nowStripItems = computed(() => {
                const items = [];
                const now = nowSec.value;
                if (serverData.daily) {
                    items.push({
                        key: 'daily',
                        label: t('home.daily_buff'),
                        title: t(serverData.daily.name),
                        emoji: serverData.daily.emoji || '',
                        icon: serverData.daily.icon || '',
                        color: serverData.daily.color ? `#${serverData.daily.color}` : 'var(--accent-blue)',
                        meta: t('home.resets_in_time').replace('{time}', getCountdown(getNextServerResetSec(), false)),
                        action: () => openBuffSchedule('daily')
                    });
                }
                if (serverData.weekly) {
                    items.push({
                        key: 'weekly',
                        label: t('home.weekly_buff'),
                        title: t(serverData.weekly.name),
                        emoji: serverData.weekly.emoji || '',
                        icon: serverData.weekly.icon || '',
                        color: serverData.weekly.color ? `#${serverData.weekly.color}` : 'var(--accent-blue)',
                        meta: '',
                        action: () => openBuffSchedule('weekly')
                    });
                }
                const chaos = chaosChestCard.value;
                if (chaos) {
                    items.push({
                        key: 'chaos',
                        label: t('home.chaos_chest'),
                        title: t(chaos.name),
                        emoji: '',
                        icon: chaos.iconUrl,
                        color: '#ffb74d',
                        metaHtml: chaos.timeHtml,
                        action: () => chaos.identifier && openUrl(`https://trovesaurus.com/${chaos.identifier}`)
                    });
                }
                const candidates = (merchantCards.value || []).filter((c) => c.active && typeof c.endTs === 'number' && c.endTs > now);
                if (candidates.length) {
                    candidates.sort((a, b) => a.endTs - b.endTs);
                    const next = candidates[0];
                    items.push({
                        key: 'next-merchant',
                        label: t('home.departing_soon'),
                        title: t(next.name),
                        iconClass: next.iconClass,
                        color: next.color,
                        meta: t('home.leaves_in_time').replace('{time}', getCountdown(next.endTs, false)),
                        isUrgent: !!next.isUrgent,
                        action: () => openMerchantSchedule(next)
                    });
                }
                return items;
            });

            const refreshNews = () => {
                if (settings.show_official_news) {
                    news.loading = true;
                    news.error = false;
                    eel.get_trove_news()();
                } else {
                    news.loading = false;
                    news.error = false;
                    news.data = [];
                }
            };

            const refreshAllData = async ({ refreshOfficialNews = false } = {}) => {
                if (isDisposed) return;
                isChinese.value = window.I18nManager?.currentLocale === 'zh_CN';
                const sets = window.AppSettings
                    ? await window.AppSettings.load(true)
                    : await eel.get_settings()();
                settings.show_community_content = sets.show_community_content !== false;
                settings.show_official_news = sets.show_official_news !== false;
                settings.show_player_activity = sets.show_player_activity !== false;
                hydratingNewsPrefs = true;
                showShopOffers.value = sets.show_news_shop_offers === true;
                hydratingNewsPrefs = false;

                if (settings.show_community_content) {
                    if (isChinese.value && mediaTab.value !== 'bilibili') mediaTab.value = 'bilibili';
                    else if (!isChinese.value && mediaTab.value === 'bilibili') mediaTab.value = 'youtube';

                    eel.get_youtube_videos()();
                    eel.get_twitch_streams()();
                    if (isChinese.value) eel.get_bilibili_videos()();
                }

                if (refreshOfficialNews) {
                    refreshNews();
                } else if (!settings.show_official_news) {
                    news.loading = false;
                    news.error = false;
                    news.data = [];
                }
                eel.get_trovesaurus_events()();
                for (const bucket of [giveaways, upcomingGiveaways, endedGiveaways]) {
                    bucket.loading = true;
                    bucket.error = false;
                }
                eel.get_giveaways()();
                eel.get_upcoming_giveaways()();
                eel.get_ended_giveaways()();
                if (settings.show_player_activity) {
                    activity.loading = true;
                    activity.error = false;
                    eel.get_player_activity()();
                } else {
                    activity.loading = false;
                    activity.error = false;
                    activity.data = null;
                }
                
                try {
                    const [sd, d15d, manad, schedulesd, stampyd, chaosd, gardend, delvestatus] = await Promise.all([
                        eel.get_current_server_data()(),
                        eel.get_d15_rotation()(),
                        eel.get_wild_mana_rotation()(),
                        eel.get_merchant_schedules()(),
                        eel.get_stampy_rotation()(),
                        eel.get_chaos_chest_data()(),
                        eel.get_gardening_rotation()(),
                        eel.get_delve_status()()
                    ]);

                    if (sd && sd.success) {
                        serverData.daily = sd.daily;
                        serverData.weekly = sd.weekly;
                        merchants.value = sd.merchants;
                    }
                    if (d15d?.success) d15.value = d15d;
                    if (manad?.success) mana.value = manad;
                    if (schedulesd?.success) schedulesCache.value = schedulesd;
                    if (stampyd?.success) stampy.value = stampyd;
                    if (chaosd?.success) chaosChest.value = chaosd;
                    if (gardend?.success) gardening.value = gardend;
                    if (delvestatus?.success) delve.value = delvestatus;
                } catch(e) {}
                if (isDisposed) return;
                serverData.loading = false;
            };

            const openBuffSchedule = async (type) => {
                rotationModal.instanceKey += 1;
                rotationModal.type = 'list';
                const buff = type === 'daily' ? serverData.daily : serverData.weekly;
                rotationModal.color = `#${buff.color}`;
                rotationModal.titleHtml = `<i class="fa-solid fa-calendar-week" style="color: ${rotationModal.color};"></i> ${t("home.title_schedule").replace("{title}", type === 'daily' ? t("home.daily_name").replace("{name}", t(buff.name)) : t("home.weekly_name").replace("{name}", t(buff.name)))}`;
                rotationModal.list = [];
                rotationModal.show = true;
                
                try {
                    const controller = homeViewAbortController;
                    const res = await fetch(`/assets/data/${type}_buffs.json`, { signal: controller.signal });
                    const scheduleData = await res.json();
                    
                    if (type === 'daily') {
                        const utcMs = Date.now() + (new Date().getTimezoneOffset() * 60000);
                        const troveMs = utcMs - (11 * 3600000);
                        const currentDayIndex = (new Date(troveMs).getDay() + 6) % 7;
                        
                        for (let i = 0; i < 7; i++) {
                            const d = scheduleData[i.toString()];
                            if (!d) continue;
                            const isActive = i === currentDayIndex;
                            rotationModal.list.push({
                                isNext: isActive, isActive: isActive, style: isActive ? `border-left: 4px solid #${d.color}; background: rgba(255,255,255,0.05);` : '',
                                timeColStyle: 'min-width: 120px;', titleLabel: t(d.weekday), timeText: '',
                                contentColStyle: 'flex-direction: column; align-items: flex-start; justify-content: center; gap: 4px;',
                                contentHtml: `<div style="font-weight: bold; color: #fff;">${d.emoji} ${t(d.name)}</div>
                                              <div style="font-size: 0.85em; color: var(--text-muted);"><ul style="margin: 0; padding-left: 15px;">
                                              ${d.normal_buffs.map(b => `<li>${t(b)}</li>`).join('')}</ul></div>`
                            });
                        }
                    } else {
                        let activeIndex = 0;
                        const weeklyKeys = Object.keys(scheduleData).sort();
                        for (let k of weeklyKeys) { if (scheduleData[k].name === buff.name) { activeIndex = parseInt(k); break; } }
                        
                        for (let i = 0; i < weeklyKeys.length; i++) {
                            const targetIndex = (activeIndex + i) % weeklyKeys.length;
                            const w = scheduleData[targetIndex.toString()];
                            if (!w) continue;
                            const isActive = i === 0;
                            rotationModal.list.push({
                                isNext: isActive, isActive: isActive, style: isActive ? `border-left: 4px solid #${w.color}; background: rgba(255,255,255,0.05);` : '',
                                timeColStyle: 'min-width: 120px;', titleLabel: isActive ? t('home.current_week') : t("home.week_num").replace("{num}", i), timeText: '',
                                contentColStyle: 'flex-direction: column; align-items: flex-start; justify-content: center; gap: 4px;',
                                contentHtml: `<div style="font-weight: bold; color: #fff;">${w.emoji} ${t(w.name)}</div>
                                              <div style="font-size: 0.85em; color: var(--text-muted);"><ul style="margin: 0; padding-left: 15px;">
                                              ${w.buffs.map(b => `<li>${t(b)}</li>`).join('')}</ul></div>`
                            });
                        }
                    }
                } catch(e) {
                    if (e && e.name === 'AbortError') return;
                }
            };

            const openMerchantSchedule = async (card) => {
                rotationModal.instanceKey += 1;
                rotationModal.color = card.color;
                rotationModal.titleHtml = `<i class="fa-solid ${card.iconClass}" style="color: ${card.color};"></i> ${t("home.upcoming_name_schedule").replace("{name}", t(card.name))}`;
                rotationModal.list = [];
                rotationModal.isLoading = false;
                rotationModal.error = '';
                rotationModal.delveWeeks = [];
                rotationModal.delveCurrentWeekId = null;
                
                const locale = (window.I18nManager && window.I18nManager.currentLocale) ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US';
                
                if (card.type === 'merchant') {
                    rotationModal.type = 'list';
                    const sch = schedulesCache.value[card.id];
                    if (sch) {
                        const actionType = (card.id === 'invasion' || card.id === 'fluxion') ? 'event' : 'merchant';
                        sch.forEach((rot, index) => {
                            const isNext = index === 0;
                            const startStr = formatDisplayDate(rot.start * 1000, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                            const endStr = formatDisplayDate(rot.end * 1000, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                            
                            let arriveStr = actionType === 'event' ? t("home.starts_in_time") : t("home.arrives_in_time");
                            let leaveStr = actionType === 'event' ? t("home.ends_in_time") : t("home.leaves_in_time");
                            let nextStr = actionType === 'event' ? t('home.next_event') : t('home.next_arrival');
                            let futureStr = actionType === 'event' ? t("home.event_num") : t("home.arrival_num");

                            let timeText = arriveStr.replace("{time}", getCountdown(rot.start, false));
                            if (rot.start * 1000 < Date.now()) timeText = leaveStr.replace("{time}", getCountdown(rot.end, false));
                            
                            const phaseLabel = rot.name ? `<div style="font-weight: bold; color: ${card.color}; margin-bottom: 2px;">${t(rot.name)}</div>` : '';
                            let iconStart = actionType === 'event' ? 'fa-play' : 'fa-plane-arrival';
                            let iconEnd = actionType === 'event' ? 'fa-stop' : 'fa-plane-departure';
                            
                            rotationModal.list.push({
                                isNext, isActive: false, style: '', timeColStyle: 'min-width: 150px;',
                                titleLabel: isNext ? nextStr : futureStr.replace("{num}", index + 1), timeText,
                                contentColStyle: 'flex-direction: column; justify-content: center; gap: 4px;',
                                contentHtml: `${phaseLabel}<div style="font-size: 0.9em; color: #eee;"><i class="fa-solid ${iconStart}"></i> ${startStr}</div><div style="font-size: 0.9em; color: #a3adc2;"><i class="fa-solid ${iconEnd}"></i> ${endStr}</div>`
                            });
                        });
                    }
                } else if (card.type === 'biome') {
                    rotationModal.type = 'list';
                    const dataSrc = card.id === 'stampy' ? stampy.value?.future : mana.value?.future;
                    if (dataSrc) {
                        dataSrc.forEach((rot, index) => {
                            const isNext = index === 0;
                            const timeText = t("home.starts_in_time").replace("{time}", getCountdown(rot.start, false));
                            let pills = rot.biomes.map(b => `<span class="biome-pill modal-pill" title="${t("home.biome_name").replace("{name}", t(b.name))}"><img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt=""> ${t(b.final_name)}</span>`).join('');
                            
                            rotationModal.list.push({
                                isNext, isActive: false, style: '', timeColStyle: '',
                                titleLabel: isNext ? t('home.next_rotation') : t("home.rotation_num").replace("{num}", index + 1), timeText,
                                contentColStyle: '', contentHtml: pills
                            });
                        });
                    }
                } else if (card.type === 'gardening') {
                    rotationModal.type = 'list';
                    if (gardening.value?.future) {
                        gardening.value.future.forEach((rot, index) => {
                            const isNext = index === 0;
                            const startStr = formatDisplayDate(rot.start * 1000, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                            const endStr = formatDisplayDate(rot.end * 1000, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                            let timeText = rot.start * 1000 < Date.now() ? t("home.ends_in_time").replace("{time}", getCountdown(rot.end, false)) : t("home.starts_in_time").replace("{time}", getCountdown(rot.start, false));
                            const phaseColor = rot.name.includes('3') ? '#4caf50' : '#8bc34a';
                            
                            rotationModal.list.push({
                                isNext, isActive: false, style: '', timeColStyle: 'min-width: 150px;',
                                titleLabel: isNext ? t('home.next_cycle') : t("home.cycle_num").replace("{num}", index + 1), timeText,
                                contentColStyle: 'flex-direction: column; justify-content: center; gap: 4px;',
                                contentHtml: `<div style="font-weight: bold; color: ${phaseColor}; margin-bottom: 2px;">${t(rot.name)}</div><div style="font-size: 0.9em; color: #eee;"><i class="fa-solid fa-play"></i> ${startStr}</div><div style="font-size: 0.9em; color: #a3adc2;"><i class="fa-solid fa-stop"></i> ${endStr}</div>`
                            });
                        });
                    }
                } else if (card.type === 'd15') {
                    rotationModal.type = 'd15';
                    rotationModal.titleHtml = `<i class="fa-solid fa-leaf" style="color: #4caf50;"></i> ${t("home.upcoming_d15_biomes")}`;
                    
                    const daysData = [];
                    let maxCols = 0;
                    const rotations = d15.value.rotations;
                    for (let i = 0; i < 7; i++) {
                        const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + i);
                        const dayEndTs = dayStart.getTime() + 86400000;
                        const dayRots = rotations.filter(rot => (rot.start * 1000 < dayEndTs && rot.end * 1000 > dayStart.getTime())).sort((a,b) => a.start - b.start);
                        if (dayRots.length > maxCols) maxCols = dayRots.length;
                        daysData.push({ label: i === 0 ? t("home.today") : formatDisplayDate(dayStart, { weekday: 'short', month: 'short', day: 'numeric' }), rots: dayRots });
                    }
                    
                    const cols = [];
                    for (let c = 0; c < maxCols; c++) {
                        const baseRot = daysData.find(day => day.rots[c])?.rots[c];
                        cols.push({
                            label: baseRot ? formatDisplayDate(baseRot.start * 1000, { hour: '2-digit', minute:'2-digit' }) : '',
                            expanded: false
                        });
                    }

                    const rows = daysData.map((day) => {
                        const rowExpanded = false;
                        const slots = cols.map((_, c) => {
                            const rot = day.rots[c];
                            if (!rot) return { empty: true };
                            const isCurrent = nowSec.value >= rot.start && nowSec.value < rot.end;
                            return { empty: false, rot, isCurrent, hasPassed: nowSec.value >= rot.end, expanded: rowExpanded };
                        });
                        return { label: day.label, slots, expanded: rowExpanded };
                    });
                    
                    rotationModal.d15Cols = cols;
                    rotationModal.d15Rows = rows;
                    rotationModal.d15AllExpanded = false;
                    rotationModal.d15ShowFinalName = false;
                } else if (card.type === 'delve') {
                    rotationModal.type = 'delve';
                    rotationModal.titleHtml = `<i class="fa-solid fa-dungeon" style="color: ${card.color};"></i> ${t('home.delve_index')}`;
                    rotationModal.isLoading = true;
                    rotationModal.show = true;
                    try {
                        const delveData = await eel.get_delve_rotation()();
                        if (!delveData?.success) {
                            throw new Error(delveData?.error || 'Failed to load delve rotation');
                        }
                        const delveWeeks = Array.isArray(delveData.weeks) ? delveData.weeks : [];
                        const currentWeekId = delveData.currentWeekId || null;
                        rotationModal.delveWeeks = delveWeeks
                            .filter((week) => week && currentWeekId && week.weekId <= currentWeekId && week.weekId >= currentWeekId - 7)
                            .sort((a, b) => (b.weekId || 0) - (a.weekId || 0))
                            .slice(0, 8);
                        rotationModal.delveCurrentWeekId = delveData.currentWeekId || null;
                    } catch (e) {
                        rotationModal.error = e?.message || 'Failed to load delve rotation';
                    } finally {
                        rotationModal.isLoading = false;
                    }
                    return;
                }
                
                rotationModal.show = true;
            };

            const timelineWrapperRef = ref(null);
            const isDraggingTimeline = ref(false);
            let dragStartX = 0, dragScrollLeft = 0;

            const jumpToCalendarTarget = (target) => {
                const wrapper = timelineWrapperRef.value;
                if (!wrapper || !calendarData.tracks.length) return;

                const nowMs = nowSec.value * 1000;
                const allEvents = calendarData.tracks.flatMap((track) => track.events || []);
                const matches = allEvents.filter((ev) => {
                    if (target === 'weekly_buff') return ev.sourceTrack === 'weekly_buff';
                    if (target === 'mana') return ev.sourceTrack === 'mana' || ev.sourceType === 'mana';
                    if (target === 'stampy') return ev.sourceTrack === 'stampy' || ev.sourceType === 'stampy';
                    if (target === 'd15') return ev.sourceTrack === 'd15' || ev.sourceType === 'd15';
                    return ev.sourceType === target;
                });

                if (!matches.length) {
                    window.showToast(t('home.no_timeline_entries_found_for_this_targe_018634'), true);
                    return;
                }

                const sorted = [...matches].sort((a, b) => {
                    const aDelta = a.startTs >= nowMs ? a.startTs - nowMs : Math.abs(nowMs - a.startTs) + 999999999;
                    const bDelta = b.startTs >= nowMs ? b.startTs - nowMs : Math.abs(nowMs - b.startTs) + 999999999;
                    return aDelta - bDelta;
                });

                const pick = sorted[0];
                wrapper.style.scrollBehavior = 'smooth';
                wrapper.scrollLeft = Math.max(0, pick.leftPx - (wrapper.clientWidth * 0.35));
                setTimeout(() => {
                    if (timelineWrapperRef.value) timelineWrapperRef.value.style.scrollBehavior = 'auto';
                }, 400);
            };

            const loadYearlyCalendar = async () => {
                calendarModal.isLoading = true;
                calendarModal.error = false;
                try {
                    const res = await eel.get_yearly_calendar_data()();
                    if (!res || !res.success) throw new Error();

                    const evs = res.events;
                    const startTs = getTimelineDayStartMs(Date.now(), -365);
                    const totalDays = 730;
                    const dayWidth = 40;
                    
                    calendarData.startTs = startTs;
                    calendarData.dayWidth = dayWidth;
                    calendarData.totalWidth = 140 + (totalDays * dayWidth);
                    
                    let months = [], days = [], currentMonthKey = null, currentMonth = null;
                    const todayIndex = 365;

                    for(let i=0; i<totalDays; i++) {
                        const dayStartMs = startTs + (i * DAY_MS);
                        const displayDate = new Date(dayStartMs);
                        const monthKey = timeMode.value === 'trove'
                            ? `${displayDate.getUTCFullYear()}-${displayDate.getUTCMonth()}`
                            : `${displayDate.getFullYear()}-${displayDate.getMonth()}`;
                        if (monthKey !== currentMonthKey) {
                            if (currentMonth) months.push(currentMonth);
                            currentMonthKey = monthKey;
                            currentMonth = {
                                name: formatTimelineDate(dayStartMs, { month: 'long' }),
                                year: timeMode.value === 'trove' ? displayDate.getUTCFullYear() : displayDate.getFullYear(),
                                days: 0
                            };
                        }
                        currentMonth.days++;
                        days.push({
                            isToday: i === todayIndex,
                            num: timeMode.value === 'trove' ? displayDate.getUTCDate() : displayDate.getDate(),
                            weekday: formatTimelineDate(dayStartMs, { weekday: 'short' })
                        });
                    }
                    if (currentMonth) months.push(currentMonth);

                    calendarData.months = months;
                    calendarData.days = days;

                    const trackDefs = [
                        { id: 'weekly_buff', name: 'Weekly Buffs', color: 'weekly', icon: 'fa-bolt' },
                        { id: 'dragon_merchants', types: ['corruxion', 'fluxion'], name: 'Dragon Merchants', color: 'corruxion', icon: 'fa-dragon' },
                        { id: 'd15', name: 'D15 Biomes', color: 'gardening', icon: 'fa-leaf' },
                        { id: 'gardening_2', name: '2-day plants', color: 'gardening', icon: 'fa-seedling' },
                        { id: 'gardening_3', name: '3-day plants', color: 'gardening', icon: 'fa-seedling' },
                        { id: 'mana', name: 'Wild Mana', color: 'mana', icon: 'fa-flask' },
                        { id: 'stampy', name: 'Stampy', color: 'stampy', icon: 'fa-paw' }
                    ];

                    calendarData.tracks = trackDefs.map(track => {
                        const trackEvents = evs.filter(e => track.types ? track.types.includes(e.type) : e.type === track.id);
                        const mapped = [];
                        trackEvents.forEach(ev => {
                            const eStartTs = ev.start * 1000, eEndTs = ev.end * 1000;
                            const displayStartTs = toTimelineDisplayMs(eStartTs);
                            const displayEndTs = toTimelineDisplayMs(eEndTs);
                            let leftPx = ((displayStartTs - startTs) / DAY_MS) * dayWidth;
                            let widthPx = ((displayEndTs - displayStartTs) / DAY_MS) * dayWidth;
                            
                            if (leftPx + widthPx > 0 && leftPx < totalDays * dayWidth) {
                                if (leftPx < 0) { widthPx += leftPx; leftPx = 0; }
                                
                                let customStyle = "";
                                if (ev.color) {
                                    const hex = ev.color.replace('#', '');
                                    if (hex.length === 6) {
                                        const r = parseInt(hex.substr(0, 2), 16), g = parseInt(hex.substr(2, 2), 16), b = parseInt(hex.substr(4, 2), 16);
                                        const isDark = (((Math.floor(r*0.8)*299) + (Math.floor(g*0.8)*587) + (Math.floor(b*0.8)*114))/1000) < 128;
                                        customStyle = `background: rgb(${Math.floor(r*0.8)},${Math.floor(g*0.8)},${Math.floor(b*0.8)}); color: ${isDark ? '#fff' : '#000'} !important; border: 1px solid rgba(255,255,255,0.2); text-shadow: ${isDark ? '0 1px 2px rgba(0,0,0,0.8)' : 'none'};`;
                                    }
                                }
                                
                                let tooltipText = `<div style="font-weight: bold; color: var(--accent-blue); margin-bottom: 5px; font-size: 1.1em;">${t(ev.name)}</div>`;
                                if (ev.biome_names && ev.biome_names.length > 0) tooltipText += `<div style="margin-bottom: 5px; color: #fff;">${ev.biome_names.map(b => '• ' + t(b)).join('<br>')}</div>`;
                                tooltipText += `<div style="color: var(--text-muted); font-size: 0.85em; margin-top: 4px;"><i class="fa-regular fa-clock"></i> ${formatDisplayDate(eStartTs, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' })} - ${formatDisplayDate(eEndTs, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' })}</div>`;
                                
                                let iconsHtml = "";
                                if (ev.icons?.length > 0) iconsHtml = `<div style="display: flex; gap: 2px; align-items: center; margin-right: 4px;">${ev.icons.map(ic => `<img src="/assets/images/biomes/${ic}.png" onerror="this.style.display='none'" style="width: 14px; height: 14px; filter: drop-shadow(0px 1px 1px rgba(0,0,0,0.5));">`).join('')}</div>`;
                                else if (ev.type === 'fluxion') iconsHtml = `<div style="display: flex; align-items: center;"><i class="fa-solid ${ev.name.includes('Voting') ? 'fa-check-to-slot' : 'fa-sack-dollar'}"></i></div>`;
                                else if (ev.type.startsWith('gardening')) iconsHtml = `<div style="display: flex; align-items: center;"><i class="fa-solid fa-seedling"></i></div>`;
                                else if (ev.type === 'corruxion') iconsHtml = `<div style="display: flex; align-items: center;"><i class="fa-solid fa-dragon"></i></div>`;
                                else if (ev.type === 'invasion') iconsHtml = `<div style="display: flex; align-items: center;"><i class="fa-solid fa-meteor"></i></div>`;
                                
                                let showText = "";
                                if (track.id === 'weekly_buff' && widthPx > 40) showText = t(ev.name);
                                else if (track.id === 'dragon_merchants' && widthPx > 40) showText = `<span style="font-weight: normal; text-transform: uppercase; margin-left: 4px;">${ev.type === 'fluxion' ? (ev.name.includes('Voting') ? t("home.voting") : t("home.selling")) : t(ev.type.charAt(0).toUpperCase() + ev.type.slice(1))}</span>`;
                                
                                const fullStyle = `left: ${leftPx + 140}px; width: ${widthPx}px; top: 6px; ${customStyle}`;
                                mapped.push({
                                    style: fullStyle,
                                    tooltip: tooltipText.replace(/"/g, '&quot;'),
                                    colorClass: track.types ? ev.type : track.color,
                                    htmlContent: `${iconsHtml}${showText}`,
                                    sourceType: ev.type,
                                    sourceTrack: track.id,
                                    startTs: eStartTs,
                                    endTs: eEndTs,
                                    leftPx: leftPx + 140
                                });
                            }
                        });
                        return { ...track, events: mapped };
                    }).filter((track) => track.events.length > 0);
                    updateCalendarNowMarker();
                    calendarModal.isLoading = false;
                    setTimeout(() => centerCalendarToday(false), 50);
                } catch(e) { calendarModal.error = true; calendarModal.isLoading = false; }
            };

            const centerCalendarToday = (animate = true) => {
                if (timelineWrapperRef.value) {
                    timelineWrapperRef.value.style.scrollBehavior = animate ? 'smooth' : 'auto';
                    timelineWrapperRef.value.scrollLeft = calendarData.todayPx + 140 - (timelineWrapperRef.value.clientWidth / 2);
                    if (animate) {
                        setTimeout(() => timelineWrapperRef.value.style.scrollBehavior = 'auto', 500);
                    }
                }
            };

            const startDrag = (e) => { isDraggingTimeline.value = true; dragStartX = e.pageX - timelineWrapperRef.value.offsetLeft; dragScrollLeft = timelineWrapperRef.value.scrollLeft; };
            const onDrag = (e) => { if (!isDraggingTimeline.value) return; e.preventDefault(); timelineWrapperRef.value.scrollLeft = dragScrollLeft - ((e.pageX - timelineWrapperRef.value.offsetLeft) - dragStartX) * 1.5; };
            const stopDrag = () => { isDraggingTimeline.value = false; };
            const onWheel = (e) => {
                if (e.deltaY !== 0) timelineWrapperRef.value.scrollLeft += e.deltaY;
            };

            function getNextServerResetSec() {
                // Server day rolls over at 00:00 server time (UTC-11), i.e. 11:00 UTC.
                const now = new Date();
                const utcNow = new Date(now.getTime() + now.getTimezoneOffset() * 60000);
                const nextReset = new Date(utcNow);
                nextReset.setUTCHours(11, 0, 0, 0);
                if (utcNow >= nextReset) nextReset.setUTCDate(nextReset.getUTCDate() + 1);
                return Math.floor(nextReset.getTime() / 1000);
            }

            function scheduleResetRefresh() {
                if (resetTimer) clearTimeout(resetTimer);
                const now = Math.floor(Date.now() / 1000);
                const nextReset = getNextServerResetSec();
                const msUntil = Math.max(1000, ((nextReset - now) * 1000) + 2000);

                resetTimer = setTimeout(async () => {
                    await refreshAllData();
                    if (calendarModal.show) {
                        await loadYearlyCalendar();
                    }
                    scheduleResetRefresh();
                }, msUntil);
            }

            // Leaving Home: abort in-flight work but keep the app mounted (it's
            // cached now, not destroyed). Unlike cancelHomeWork this does NOT null
            // the receive handlers -- they're assigned once in setup() and must
            // survive so a later return can refresh. Late responses that arrive
            // while away are dropped by the isDisposed guards inside each handler.
            const pauseHomeWork = () => {
                isDisposed = true;
                resetHomeAbortController();
                if (window.eel && eel.cancel_home_fetches) {
                    try { eel.cancel_home_fetches()(); } catch (e) {}
                }
            };

            const handleHomeUnloading = () => {
                pauseHomeWork();
            };

            // Returning to a cached Home tab: re-arm and snap to fresh data
            // (mirrors onMounted's startup refresh).
            const handleHomeShown = () => {
                isDisposed = false;
                resetHomeAbortController();
                refreshAllData({ refreshOfficialNews: true });
            };

            // Visibility-aware tickers: every interval below checks document.hidden
            // before doing work. When the user minimizes the window or switches to
            // another OS app the home tab still has these timers attached (it's
            // the active view) but burning a frame per second on a Vue reactive
            // update + 8 backend calls per 30 s while nobody is looking is pure
            // waste. The "snap back" on focus is handled by the visibilitychange
            // listener below, which forces a fresh refreshAllData when the window
            // becomes visible again so the user sees current data without waiting
            // for the next 30 s tick.
            // "Hidden" now also covers the case where Home is cached but is not the
            // active tab -- no point polling streams/news/giveaways for a view the
            // user isn't looking at. BTT_CURRENT_VIEW is maintained by loadView.
            const isHidden = () => (typeof document !== 'undefined' && document.hidden)
                || (typeof window !== 'undefined' && !!window.BTT_CURRENT_VIEW && window.BTT_CURRENT_VIEW !== 'home');
            let pendingRefreshOnVisible = false;

            const onVisibilityChange = () => {
                if (isDisposed) return;
                if (!document.hidden && pendingRefreshOnVisible) {
                    pendingRefreshOnVisible = false;
                    refreshAllData();
                }
            };

            onMounted(() => {
                isDisposed = false;
                resetHomeAbortController();
                refreshAllData({ refreshOfficialNews: true });
                refreshInterval = setInterval(() => {
                    if (isHidden()) { pendingRefreshOnVisible = true; return; }
                    refreshAllData();
                }, 30000);
                newsRefreshInterval = setInterval(() => {
                    if (isHidden()) return;
                    refreshNews();
                }, NEWS_REFRESH_MS);
                timeInterval = setInterval(() => {
                    if (isHidden()) return;
                    nowSec.value = Math.floor(Date.now() / 1000);
                }, 1000);
                scheduleResetRefresh();

                window._homeLangListener = (e) => {
                    if (e.target && e.target.id === 'global-language-select') setTimeout(() => refreshAllData({ refreshOfficialNews: false }), 150);
                };
                document.addEventListener('change', window._homeLangListener);
                document.addEventListener('home_unloading', handleHomeUnloading);
                document.addEventListener('home_shown', handleHomeShown);
                document.addEventListener('visibilitychange', onVisibilityChange);
            });

            watch(timeMode, async () => {
                if (calendarModal.show) {
                    await loadYearlyCalendar();
                }
            });

            watch(nowSec, () => {
                if (calendarModal.show) {
                    updateCalendarNowMarker();
                }
            });

            watch(showShopOffers, async () => {
                if (hydratingNewsPrefs) return;
                await saveShopOfferPreference();
            });

            onUnmounted(() => {
                clearInterval(refreshInterval);
                clearInterval(newsRefreshInterval);
                clearInterval(timeInterval);
                document.removeEventListener('visibilitychange', onVisibilityChange);
                if (resetTimer) clearTimeout(resetTimer);
                document.removeEventListener('change', window._homeLangListener);
                document.removeEventListener('home_unloading', handleHomeUnloading);
                document.removeEventListener('home_shown', handleHomeShown);
                cancelHomeWork();
            });

            const refreshServerTime = () => {
                const utcNow = new Date(Date.now());
                const troveDate = new Date(utcNow.getTime() - (11 * 3600000));
                serverTimeNowText.value = troveDate.toLocaleTimeString(
                    (window.I18nManager && window.I18nManager.currentLocale)
                        ? window.I18nManager.currentLocale.replace('_', '-')
                        : 'en-US',
                    { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC', hour12: false }
                );
            };

            const visitsTickInterval = ref(null);

            onMounted(async () => {
                refreshServerTime();
                if (window.AppSettings) {
                    await window.AppSettings.load();
                    hydratingHomePrefs = true;
                    isNewsCollapsed.value = window.AppSettings.getPref(NEWS_COLLAPSED_PREF_KEY, false) === true;

                    const savedOrder = window.AppSettings.getPref(SECTION_ORDER_PREF_KEY, null);
                    if (Array.isArray(savedOrder)) {
                        const filtered = savedOrder.filter(id => DEFAULT_SECTION_ORDER.includes(id));
                        DEFAULT_SECTION_ORDER.forEach(id => { if (!filtered.includes(id)) filtered.push(id); });
                        sectionOrder.value = filtered;
                    }
                    const savedCollapsed = window.AppSettings.getPref(SECTION_COLLAPSED_PREF_KEY, null);
                    if (savedCollapsed && typeof savedCollapsed === 'object') {
                        DEFAULT_SECTION_ORDER.forEach(id => {
                            if (typeof savedCollapsed[id] === 'boolean') sectionCollapsed[id] = savedCollapsed[id];
                        });
                    }
                    const savedQuick = window.AppSettings.getPref(QUICK_TOOLS_PREF_KEY, null);
                    if (savedQuick && typeof savedQuick === 'object') {
                        if (savedQuick.mode === 'custom' || savedQuick.mode === 'auto') quickToolsMode.value = savedQuick.mode;
                        if (Array.isArray(savedQuick.custom)) quickToolsCustom.value = savedQuick.custom.slice();
                    }

                    const savedCategory = window.AppSettings.getPref(NEWS_CATEGORY_PREF_KEY, 'all');
                    if (typeof savedCategory === 'string') newsActiveCategory.value = savedCategory;

                    refreshNavVisits();
                    hydratingHomePrefs = false;
                }
                loadWhatsNew();
                visitsTickInterval.value = setInterval(refreshNavVisits, 5000);

                // Track sign-in state for in-app giveaway entry (desktop only).
                if (window.BTTAccount) {
                    giveawayLoggedIn.value = !!window.BTTAccount.state.authenticated;
                    unsubGiveawayAccount = window.BTTAccount.onChange((s) => {
                        giveawayLoggedIn.value = !!s.authenticated;
                        refreshMyGiveaways();
                    });
                    refreshMyGiveaways();
                }
            });

            onUnmounted(() => {
                if (visitsTickInterval.value) clearInterval(visitsTickInterval.value);
                if (unsubGiveawayAccount) unsubGiveawayAccount();
            });

            watch(nowSec, () => {
                refreshServerTime();
            });

            return {
                t, settings, isChinese, mediaTab, mediaData, activeMediaPlatformKey, carouselRef,
                newsCarouselRef, showShopOffers, isNewsCollapsed,
                serverData, events, mappedEvents, news, mappedNews,
                giveaways, upcomingGiveaways, endedGiveaways,
                mappedGiveaways, mappedUpcoming, mappedEnded,
                giveawayModal, giveawayTileSummary, openGiveawayModal,
                isGiveawayWebMode, giveawayLoggedIn, isGiveawayEntered, joiningGiveaway, joinGiveaway, giveawaySignIn,
                activity, mappedActivity, showActivityTile, showGiveawayTile, showStatRow, merchantCards, chaosChestCard,
                scrollCarousel, scrollNewsCarousel, toggleNewsCollapsed, openUrl, openBuffSchedule, openMerchantSchedule,
                rotationModal, calendarModal, calendarData, loadYearlyCalendar, centerCalendarToday,
                timelineWrapperRef, isDraggingTimeline, startDrag, onDrag, stopDrag, onWheel,
                filteredCalendarTracks, calendarViewFilter, jumpToCalendarTarget, formatDisplayDate, formatDelveWeekRange, getDelveWeekHeading, getCountdown,
                timeMode,
                sectionOrder, sectionCollapsed, isSectionCollapsed, toggleSectionCollapsed,
                onSectionDragStart, onSectionDragOver, onSectionDrop, onSectionDragEnd, onTailDragOver,
                draggingSectionId, dragInsertBefore, showDropLine,
                quickToolsMode, quickToolsList, quickToolsCatalogVisible, quickToolsEditingSlot, quickToolsEditing,
                startQuickToolsEditing, finishQuickToolsEditing, useAutoQuickTools,
                openQuickToolSlotEditor, setQuickToolAtSlot, clearQuickToolSlot, navigateToTool,
                whatsNewRelease, whatsNewVisible, dismissWhatsNew,
                supportCardVisible, dismissSupportCard, openSupport,
                nowStripItems, newsCategoriesAvailable, newsActiveCategory, setNewsCategory,
                serverTimeNowText, isWebUnavailable
            };
        }
    });

    if (window._homeApp) window._homeApp.unmount();
    window._homeApp = app;
    app.mount('#home-vue-app');
});

eel.expose(receive_youtube_videos, 'receive_youtube_videos');
function receive_youtube_videos(response) { if (window._homeAppHandleYoutube) window._homeAppHandleYoutube(response); }

eel.expose(receive_twitch_streams, 'receive_twitch_streams');
function receive_twitch_streams(response) { if (window._homeAppHandleTwitch) window._homeAppHandleTwitch(response); }

eel.expose(receive_bilibili_videos, 'receive_bilibili_videos');
function receive_bilibili_videos(response) { if (window._homeAppHandleBilibili) window._homeAppHandleBilibili(response); }

eel.expose(receive_events_data, 'receive_events_data');
function receive_events_data(response) { if (window._homeAppHandleEvents) window._homeAppHandleEvents(response); }

eel.expose(receive_trove_news, 'receive_trove_news');
function receive_trove_news(response) { if (window._homeAppHandleNews) window._homeAppHandleNews(response); }

eel.expose(receive_giveaways, 'receive_giveaways');
function receive_giveaways(response) { if (window._homeAppHandleGiveaways) window._homeAppHandleGiveaways(response); }

eel.expose(receive_upcoming_giveaways, 'receive_upcoming_giveaways');
function receive_upcoming_giveaways(response) { if (window._homeAppHandleUpcomingGiveaways) window._homeAppHandleUpcomingGiveaways(response); }

eel.expose(receive_ended_giveaways, 'receive_ended_giveaways');
function receive_ended_giveaways(response) { if (window._homeAppHandleEndedGiveaways) window._homeAppHandleEndedGiveaways(response); }

eel.expose(receive_player_activity, 'receive_player_activity');
function receive_player_activity(response) { if (window._homeAppHandleActivity) window._homeAppHandleActivity(response); }
