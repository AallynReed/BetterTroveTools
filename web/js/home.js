document.addEventListener('home_loaded', () => {
    console.log("Home Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, onUnmounted } = Vue;
    const NEWS_COLLAPSED_PREF_KEY = 'home_official_news_collapsed_v1';
    const NEWS_REFRESH_MS = 30 * 60 * 1000;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
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
                if (window.eel && eel.cancel_home_fetches) {
                    try {
                        await eel.cancel_home_fetches()();
                    } catch (e) {}
                }
            };

            const settings = reactive({ show_community_content: true, show_official_news: true });
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
            const timeMode = ref('local');
            
            const calendarModal = reactive({ show: false, isLoading: true, error: false });
            const calendarData = reactive({ months: [], days: [], tracks: [], todayPx: 0, totalWidth: 0, startTs: 0, dayWidth: 40 });
            const calendarViewFilter = ref('full');
            
            const rotationModal = reactive({
                show: false, titleHtml: '', color: '', iconClass: '', type: 'list',
                list: [], d15Cols: [], d15Rows: [], d15ShowFinalName: true, d15AllExpanded: false,
                delveWeeks: [], delveCurrentWeekId: null, isLoading: false, error: '', instanceKey: 0
            });

            const openUrl = (url) => eel.open_url_in_browser(url)();
            const scrollCarousel = (amount) => { if (carouselRef.value) carouselRef.value.scrollBy({ left: amount, behavior: 'smooth' }); };
            const scrollNewsCarousel = (amount) => { if (newsCarouselRef.value) newsCarouselRef.value.scrollBy({ left: amount, behavior: 'smooth' }); };
            const toggleNewsCollapsed = () => {
                isNewsCollapsed.value = !isNewsCollapsed.value;
                if (window.AppSettings) window.AppSettings.setPrefSync(NEWS_COLLAPSED_PREF_KEY, isNewsCollapsed.value);
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
                if (diffDays > 0) return t('{count} days ago').replace('{count}', diffDays);
                if (diffHours > 0) return t('{count} hours ago').replace('{count}', diffHours);
                if (diffMinutes > 0) return t('{count} minutes ago').replace('{count}', diffMinutes);
                return t('Just now');
            };

            const getCountdown = (targetTs, showLeft = true) => {
                // Clamp to 0 so an already-elapsed timestamp renders "0 minutes"
                // instead of the literal "null" (callers interpolate this directly).
                const diff = Math.max(0, targetTs - nowSec.value);
                const days = Math.floor(diff / 86400);
                const hours = Math.floor((diff % 86400) / 3600);
                const mins = Math.floor((diff % 3600) / 60);
                let parts = [];
                if (days > 0) { parts.push(t("{count} days").replace("{count}", days)); if (hours > 0) parts.push(t("{count} hours").replace("{count}", hours)); }
                else if (hours > 0) { parts.push(t("{count} hours").replace("{count}", hours)); if (mins > 0) parts.push(t("{count} minutes").replace("{count}", mins)); }
                else parts.push(t("{count} minutes").replace("{count}", mins));
                const timeStr = parts.join(" ");
                return showLeft ? t("{time} left").replace("{time}", timeStr) : timeStr;
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
                if (week.isCurrent) return t("This Week's");
                if (rotationModal.delveCurrentWeekId && week.weekId === rotationModal.delveCurrentWeekId - 1) return t('Last Week');
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
                    mediaData.bilibili.data = response.data.sort((a, b) => new Date(b.published_at) - new Date(a.published_at)).map(v => ({
                        url: v.url, thumb: `/proxy/bilibili_image?url=${encodeURIComponent(v.thumbnail_url)}`, title: v.title, channel: v.channel,
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

            const mappedEvents = computed(() => {
                return events.data.map(ev => {
                    const startTs = parseInt(ev.startdate);
                    const endTs = parseInt(ev.enddate);
                    const startStr = formatDisplayDate(startTs * 1000, { month: 'short', day: 'numeric' });
                    const endStr = formatDisplayDate(endTs * 1000, { month: 'short', day: 'numeric' });

                    let statusText = '';
                    let statusClass = '';

                    if (nowSec.value < startTs) {
                        statusText = t("Starts in {time}").replace("{time}", getCountdown(startTs, false));
                        statusClass = 'is-upcoming';
                    } else if (nowSec.value < endTs) {
                        statusText = t("Ends in {time}").replace("{time}", getCountdown(endTs, false));
                        statusClass = 'is-active';
                    } else {
                        statusText = t("Ended");
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
                const filtered = news.data.filter((item) => showShopOffers.value || !((item.categories || []).includes('Shop Offers')));
                return filtered.slice(0, 10).map((item, index) => ({
                    ...item,
                    id: item.url || `${item.title}-${index}`,
                    publishedLabel: getTimeAgo(item.published_at),
                    image: item.image || '/assets/images/no_preview.png'
                }));
            });

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
                        name: t('Chaos Chest'),
                        identifier: null,
                        unknown: true,
                        iconUrl: "https://trovesaurus.com/data/catalog/item_chaos_box.png",
                        timeHtml: t("Dates: {start} - {end}")
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
                    timeHtml: t("Changes in {time}").replace("{time}", `<b>${getCountdown(end, false)}</b>`)
                };
            });

            const merchantCards = computed(() => {
                const cards = [];
                const m = merchants.value;
                
                if (m.corruxion) cards.push({ type: 'merchant', id: 'corruxion', name: 'Corruxion', color: '#9c27b0', iconClass: 'fa-dragon', active: m.corruxion.active, statusText: m.corruxion.active ? 'ACTIVE' : 'AWAY', timeHtml: `${t(m.corruxion.action)} <b>${m.corruxion.time_str}</b>` });
                if (m.fluxion) cards.push({ type: 'merchant', id: 'fluxion', name: m.fluxion.active ? t("Fluxion ({state})").replace("{state}", t(m.fluxion.state)) : 'Fluxion', color: '#4fc3f7', iconClass: 'fa-scale-balanced', active: m.fluxion.active, statusText: m.fluxion.active ? 'ACTIVE' : 'AWAY', timeHtml: `${t(m.fluxion.action)} <b>${m.fluxion.time_str}</b>` });

                if (stampy.value && stampy.value.current) {
                    const s = stampy.value.current;
                    const isActive = nowSec.value >= s.start && nowSec.value < s.end;
                    cards.push({ type: 'biome', id: 'stampy', name: 'Stampy', color: '#ff9800', iconClass: 'fa-paw', active: isActive, statusText: isActive ? 'ACTIVE' : 'AWAY', timeHtml: isActive ? t("Leaves in {time}").replace("{time}", `<b>${getCountdown(s.end, false)}</b>`) : t("Arrives in {time}").replace("{time}", `<b>${getCountdown(s.start, false)}</b>`), biomes: s.biomes });
                }

                if (d15.value && d15.value.current) {
                    cards.push({ type: 'd15', id: 'd15', name: 'D15 Biomes', color: '#4caf50', iconClass: 'fa-leaf', active: true, statusText: 'ACTIVE', timeHtml: t("Ends in {time}").replace("{time}", `<b>${getCountdown(d15.value.current.end, false)}</b>`), biomes: d15.value.current.biomes });
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

                    let titleStr = isActive ? activeNames.map(n => t(n)).join(" &amp; ") : t("Gardening Cycles");
                    let timeHtml = "";
                    if (isActive) {
                        let endTs = g.two_day.active && g.three_day.active ? Math.min(g.two_day.end, g.three_day.end) : (g.two_day.active ? g.two_day.end : g.three_day.end);
                        timeHtml = t("Ends in {time}").replace("{time}", `<b>${getCountdown(endTs, false)}</b>`);
                    } else {
                        let soonerStart = Math.min(g.two_day.start, g.three_day.start);
                        let nextName = soonerStart === g.two_day.start ? "2-day plants" : "3-day plants";
                        timeHtml = (g.two_day.start === g.three_day.start) ? `${t("2-day plants")} &amp; ${t("3-day plants")} - ` + t("Starts in {time}").replace("{time}", `<b>${getCountdown(soonerStart, false)}</b>`) : `${t(nextName)} - ` + t("Starts in {time}").replace("{time}", `<b>${getCountdown(soonerStart, false)}</b>`);
                    }
                    cards.push({ type: 'gardening', id: 'gardening', name: titleStr, color: gColor, iconClass: 'fa-seedling', active: isActive, statusText: isActive ? 'HARVEST' : 'GROWING', timeHtml: timeHtml });
                }

                if (mana.value && mana.value.current) {
                    cards.push({ type: 'biome', id: 'mana', name: 'Wild Trovian Mana', color: '#00bcd4', iconClass: 'fa-flask', active: true, statusText: 'ACTIVE', timeHtml: t("Ends in {time}").replace("{time}", `<b>${getCountdown(mana.value.current.end, false)}</b>`), biomes: mana.value.current.biomes });
                }

                if (delve.value && delve.value.currentWeekId) {
                    cards.push({
                        type: 'delve',
                        id: 'delve',
                        name: 'Delve Index',
                        color: '#ab47bc',
                        iconClass: 'fa-dungeon',
                        active: true,
                        statusText: 'WEEK',
                        timeHtml: t("Ends in {time}").replace("{time}", `<b>${getCountdown(delve.value.end, false)}</b>`)
                    });
                }

                return cards.sort((a, b) => {
                    if (a.id === 'd15' && b.id !== 'd15') return -1;
                    if (b.id === 'd15' && a.id !== 'd15') return 1;
                    if (a.active !== b.active) return a.active ? -1 : 1;
                    return 0;
                });
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
                rotationModal.titleHtml = `<i class="fa-solid fa-calendar-week" style="color: ${rotationModal.color};"></i> ${t("{title} Schedule").replace("{title}", type === 'daily' ? t("Daily: {name}").replace("{name}", t(buff.name)) : t("Weekly: {name}").replace("{name}", t(buff.name)))}`;
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
                                timeColStyle: 'min-width: 120px;', titleLabel: isActive ? t('Current Week') : t("Week +{num}").replace("{num}", i), timeText: '',
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
                rotationModal.titleHtml = `<i class="fa-solid ${card.iconClass}" style="color: ${card.color};"></i> ${t("Upcoming {name} Schedule").replace("{name}", t(card.name))}`;
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
                            
                            let arriveStr = actionType === 'event' ? t("Starts in {time}") : t("Arrives in {time}");
                            let leaveStr = actionType === 'event' ? t("Ends in {time}") : t("Leaves in {time}");
                            let nextStr = actionType === 'event' ? t('Next Event') : t('Next Arrival');
                            let futureStr = actionType === 'event' ? t("Event +{num}") : t("Arrival +{num}");

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
                            const timeText = t("Starts in {time}").replace("{time}", getCountdown(rot.start, false));
                            let pills = rot.biomes.map(b => `<span class="biome-pill modal-pill" title="${t("Biome: {name}").replace("{name}", t(b.name))}"><img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt=""> ${t(b.final_name)}</span>`).join('');
                            
                            rotationModal.list.push({
                                isNext, isActive: false, style: '', timeColStyle: '',
                                titleLabel: isNext ? t('Next Rotation') : t("Rotation +{num}").replace("{num}", index + 1), timeText,
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
                            let timeText = rot.start * 1000 < Date.now() ? t("Ends in {time}").replace("{time}", getCountdown(rot.end, false)) : t("Starts in {time}").replace("{time}", getCountdown(rot.start, false));
                            const phaseColor = rot.name.includes('3') ? '#4caf50' : '#8bc34a';
                            
                            rotationModal.list.push({
                                isNext, isActive: false, style: '', timeColStyle: 'min-width: 150px;',
                                titleLabel: isNext ? t('Next Cycle') : t("Cycle +{num}").replace("{num}", index + 1), timeText,
                                contentColStyle: 'flex-direction: column; justify-content: center; gap: 4px;',
                                contentHtml: `<div style="font-weight: bold; color: ${phaseColor}; margin-bottom: 2px;">${t(rot.name)}</div><div style="font-size: 0.9em; color: #eee;"><i class="fa-solid fa-play"></i> ${startStr}</div><div style="font-size: 0.9em; color: #a3adc2;"><i class="fa-solid fa-stop"></i> ${endStr}</div>`
                            });
                        });
                    }
                } else if (card.type === 'd15') {
                    rotationModal.type = 'd15';
                    rotationModal.titleHtml = `<i class="fa-solid fa-leaf" style="color: #4caf50;"></i> ${t("Upcoming D15 Biomes")}`;
                    
                    const daysData = [];
                    let maxCols = 0;
                    const rotations = d15.value.rotations;
                    for (let i = 0; i < 7; i++) {
                        const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + i);
                        const dayEndTs = dayStart.getTime() + 86400000;
                        const dayRots = rotations.filter(rot => (rot.start * 1000 < dayEndTs && rot.end * 1000 > dayStart.getTime())).sort((a,b) => a.start - b.start);
                        if (dayRots.length > maxCols) maxCols = dayRots.length;
                        daysData.push({ label: i === 0 ? t("Today") : formatDisplayDate(dayStart, { weekday: 'short', month: 'short', day: 'numeric' }), rots: dayRots });
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
                    rotationModal.titleHtml = `<i class="fa-solid fa-dungeon" style="color: ${card.color};"></i> ${t('Delve Index')}`;
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
                    window.showToast(t('No timeline entries found for this target right now.'), true);
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
                                else if (track.id === 'dragon_merchants' && widthPx > 40) showText = `<span style="font-weight: normal; text-transform: uppercase; margin-left: 4px;">${ev.type === 'fluxion' ? (ev.name.includes('Voting') ? t("Voting") : t("Selling")) : t(ev.type.charAt(0).toUpperCase() + ev.type.slice(1))}</span>`;
                                
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

            const handleHomeUnloading = () => {
                cancelHomeWork();
            };

            onMounted(() => {
                isDisposed = false;
                resetHomeAbortController();
                refreshAllData({ refreshOfficialNews: true });
                refreshInterval = setInterval(refreshAllData, 30000);
                newsRefreshInterval = setInterval(() => refreshNews(), NEWS_REFRESH_MS);
                timeInterval = setInterval(() => nowSec.value = Math.floor(Date.now() / 1000), 1000);
                scheduleResetRefresh();

                window._homeLangListener = (e) => {
                    if (e.target && e.target.id === 'global-language-select') setTimeout(() => refreshAllData({ refreshOfficialNews: false }), 150);
                };
                document.addEventListener('change', window._homeLangListener);
                document.addEventListener('home_unloading', handleHomeUnloading);
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
                if (resetTimer) clearTimeout(resetTimer);
                document.removeEventListener('change', window._homeLangListener);
                document.removeEventListener('home_unloading', handleHomeUnloading);
                cancelHomeWork();
            });

            onMounted(async () => {
                if (window.AppSettings) {
                    await window.AppSettings.load();
                    isNewsCollapsed.value = window.AppSettings.getPref(NEWS_COLLAPSED_PREF_KEY, false) === true;
                }
            });

            return {
                t, settings, isChinese, mediaTab, mediaData, activeMediaPlatformKey, carouselRef,
                newsCarouselRef, showShopOffers, isNewsCollapsed,
                serverData, events, mappedEvents, news, mappedNews, merchantCards, chaosChestCard,
                scrollCarousel, scrollNewsCarousel, toggleNewsCollapsed, openUrl, openBuffSchedule, openMerchantSchedule,
                rotationModal, calendarModal, calendarData, loadYearlyCalendar, centerCalendarToday,
                timelineWrapperRef, isDraggingTimeline, startDrag, onDrag, stopDrag, onWheel,
                filteredCalendarTracks, calendarViewFilter, jumpToCalendarTarget, formatDisplayDate, formatDelveWeekRange, getDelveWeekHeading, getCountdown,
                timeMode
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
