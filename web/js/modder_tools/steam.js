// Steam tab — publish a .tmod straight to the Trove Steam Workshop, driven by
// backend/modder_tools/steam_workshop.py. The backend runs the upload on a
// worker thread and pushes frames to the JS-exposed
// `receive_steam_workshop_progress`; we keep a module-level dispatcher so the
// exposed name survives the keep-alive view lifecycle, the same way trove.js
// does.
(function () {
    let _progressHandler = null;
    function receive_steam_workshop_progress(payload) {
        if (_progressHandler) _progressHandler(payload);
    }
    if (window.eel && typeof window.eel.expose === 'function') {
        window.eel.expose(receive_steam_workshop_progress, 'receive_steam_workshop_progress');
    }

    // Steam's ERemoteStoragePublishedFileVisibility.
    const VIS = { 0: 'public', 1: 'friends', 2: 'private' };
    // Where we remember the workshop id a title was published under. Steam has
    // no lookup by name, so without this the only fallbacks are the SteamId
    // property inside the .tmod and a title match against the account's items.
    const PREF_IDS = 'steam_workshop_items';

    document.addEventListener('modder_steam_loaded', () => {
        if (typeof Vue === 'undefined') { console.error('Vue.js failed to load!'); return; }

        const { createApp, ref, reactive, computed, onUnmounted } = Vue;

        const app = createApp({
            setup() {
                const { t, unwrapResponse } = window.ModderTools;
                const toast = (msg, err) => { if (window.showToast) window.showToast(msg, !!err); };

                const status = reactive({
                    supported: true, dllPath: '', gamePath: '',
                    steamRunning: false, connected: false, busy: false, account: null,
                });
                const busy = reactive({ connect: false, items: false, reading: false, publish: false });
                const items = ref([]);
                const itemsError = ref('');
                const meta = ref(null);
                const result = ref(null);
                const progress = reactive({ stage: '', status: '', done: 0, total: 0 });
                // How form.itemId got its value: '' | 'embedded' | 'saved' | 'title' | 'manual'.
                const targetMatch = ref('');

                const form = reactive({
                    itemId: '', title: '', description: '', tags: '',
                    visibility: 2, changeNote: '', previewPath: '',
                });

                // --- helpers -------------------------------------------------
                const visKey = (v) => VIS[Number(v)] || 'private';
                const formatSize = (bytes) => {
                    const n = Number(bytes) || 0;
                    if (n < 1024) return `${n} B`;
                    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
                    return `${(n / 1024 / 1024).toFixed(2)} MB`;
                };
                const formatDate = (unix) => {
                    if (!unix) return '—';
                    return new Date(Number(unix) * 1000).toLocaleDateString();
                };
                const openUrl = (url) => { if (url && window.eel && eel.open_url_in_browser) eel.open_url_in_browser(url)(); };
                const openProfile = () => openUrl(status.account && status.account.profile_url);
                const copyText = async (text) => {
                    try { await navigator.clipboard.writeText(String(text || '')); toast(t('steam.copied')); }
                    catch (e) { toast(String(e && e.message || e), true); }
                };

                const readIds = () => (window.AppSettings && window.AppSettings.getPref(PREF_IDS, {})) || {};
                const rememberId = (title, itemId) => {
                    if (!window.AppSettings || !title || !itemId) return;
                    const map = { ...readIds() };
                    map[String(title).trim().toLowerCase()] = String(itemId);
                    window.AppSettings.setPrefSync(PREF_IDS, map);
                };

                const previewOverrideData = ref('');
                const previewSrc = computed(() => {
                    if (form.previewPath) return previewOverrideData.value;
                    return meta.value ? meta.value.previewBase64 : '';
                });
                const previewOverrideName = computed(() => {
                    if (!form.previewPath) return '';
                    return form.previewPath.split(/[\\/]/).pop();
                });
                const previewLabel = computed(() => {
                    if (form.previewPath) return t('steam.preview_replaced');
                    if (!meta.value || !meta.value.previewSize) return t('steam.no_preview');
                    return `${meta.value.previewName} (${formatSize(meta.value.previewSize)})`;
                });
                // Steam caps preview images at 1 MB and the failure it returns is
                // not obvious, so say so before the upload rather than after.
                const previewProblem = computed(() => {
                    if (form.previewPath || !meta.value) return '';
                    if (meta.value.previewTooLarge) return t('steam.preview_too_large');
                    if (!meta.value.previewSize) return t('steam.preview_missing');
                    return '';
                });

                const targetHint = computed(() => {
                    if (!form.itemId) return t('steam.target_new_hint');
                    const hit = items.value.find(i => i.id === form.itemId);
                    const name = hit ? hit.title : form.itemId;
                    switch (targetMatch.value) {
                        case 'embedded': return t('steam.matched_embedded').replace('{title}', name);
                        case 'saved': return t('steam.matched_saved').replace('{title}', name);
                        case 'title': return t('steam.matched_title').replace('{title}', name);
                        default: return t('steam.target_update_hint').replace('{title}', name);
                    }
                });

                const canPublish = computed(() =>
                    !!meta.value && !!form.title.trim() && status.connected && !busy.publish);

                const progressLabel = computed(() => {
                    if (!progress.stage) return '';
                    if (progress.stage === 'uploading' && progress.status) {
                        return t('steam.stage_' + progress.status);
                    }
                    return t('steam.stage_' + progress.stage);
                });
                const progressIcon = computed(() => {
                    if (progress.stage === 'error') return 'fa-circle-exclamation';
                    if (progress.stage === 'done') return 'fa-circle-check';
                    return 'fa-spinner fa-spin';
                });
                const progressPercent = computed(() => {
                    if (!progress.total) return 0;
                    return Math.min(100, Math.round((progress.done / progress.total) * 100));
                });

                // --- status / connection -------------------------------------
                const refreshStatus = async () => {
                    try {
                        const res = await eel.steam_workshop_status()();
                        Object.assign(status, unwrapResponse(res, null, {}) || {});
                    } catch (e) { /* backend not up yet — the panel stays inert */ }
                };

                const connect = async () => {
                    busy.connect = true;
                    try {
                        const res = await eel.steam_workshop_connect()();
                        if (res && res.success) {
                            Object.assign(status, { connected: true, account: unwrapResponse(res, 'account', null) });
                            await loadItems();
                            matchTarget();
                        } else {
                            toast((res && res.error) || t('steam.connect_failed'), true);
                        }
                    } catch (e) { toast(String(e && e.message || e), true); }
                    busy.connect = false;
                };

                const disconnect = async () => {
                    try { await eel.steam_workshop_disconnect()(); } catch (e) { /* already gone */ }
                    status.connected = false;
                    status.account = null;
                    items.value = [];
                };

                const loadItems = async () => {
                    busy.items = true; itemsError.value = '';
                    try {
                        const res = await eel.steam_workshop_list_items()();
                        if (res && res.success) {
                            items.value = unwrapResponse(res, 'items', []) || [];
                            status.connected = true;
                            const account = unwrapResponse(res, 'account', null);
                            if (account) status.account = account;
                        } else {
                            itemsError.value = (res && res.error) || t('manage.load_failed');
                        }
                    } catch (e) { itemsError.value = String(e && e.message || e); }
                    busy.items = false;
                };

                // --- picking the .tmod ---------------------------------------
                // Order of trust for "which workshop item is this": the SteamId
                // written into the archive, then what we recorded locally, then a
                // title match against the account's published items — which is
                // what the game itself does, and the least reliable of the three.
                const matchTarget = () => {
                    if (!meta.value || targetMatch.value === 'manual') return;
                    const embedded = String(meta.value.steamId || '').trim();
                    if (embedded) {
                        form.itemId = embedded;
                        targetMatch.value = 'embedded';
                        return;
                    }
                    const saved = readIds()[String(meta.value.title || '').trim().toLowerCase()];
                    if (saved && items.value.some(i => i.id === saved)) {
                        form.itemId = saved;
                        targetMatch.value = 'saved';
                        return;
                    }
                    const wanted = String(form.title || '').trim().toLowerCase();
                    const byTitle = items.value.find(i => String(i.title).trim().toLowerCase() === wanted);
                    if (byTitle) {
                        form.itemId = byTitle.id;
                        targetMatch.value = 'title';
                    }
                };

                const applyMeta = (data) => {
                    meta.value = data;
                    form.title = data.title || '';
                    form.description = data.description || '';
                    form.tags = (data.tags || []).join(', ');
                    form.previewPath = '';
                    previewOverrideData.value = '';
                    form.itemId = '';
                    form.changeNote = '';
                    targetMatch.value = '';
                    result.value = null;
                    progress.stage = '';
                    matchTarget();
                };

                const browseTmod = async () => {
                    busy.reading = true;
                    try {
                        const fileResp = await eel.ask_tmod_file()();
                        const path = fileResp?.value ?? fileResp?.data?.value ?? fileResp;
                        if (!path) { busy.reading = false; return; }
                        const res = await eel.steam_workshop_read_tmod(path)();
                        if (res && res.success) applyMeta(unwrapResponse(res, null, {}));
                        else toast((res && res.error) || t('steam.read_failed'), true);
                    } catch (e) { toast(String(e && e.message || e), true); }
                    busy.reading = false;
                };

                const browsePreview = async () => {
                    try {
                        const resp = await eel.ask_preview_file()();
                        const file = unwrapResponse(resp, 'file', null);
                        if (!file || !file.path) return;
                        form.previewPath = file.path;
                        previewOverrideData.value = file.data || '';
                    } catch (e) { toast(String(e && e.message || e), true); }
                };
                const clearPreviewOverride = () => {
                    form.previewPath = '';
                    previewOverrideData.value = '';
                };

                const selectItem = (item) => {
                    form.itemId = item.id;
                    targetMatch.value = 'manual';
                };

                // --- publish --------------------------------------------------
                const publish = async () => {
                    if (!canPublish.value) return;
                    const tags = form.tags.split(',').map(s => s.trim()).filter(Boolean);
                    const existing = items.value.find(i => i.id === form.itemId);
                    const account = status.account || {};

                    // Everything that is about to leave this machine, in one
                    // place, before anything leaves it.
                    const lines = [
                        t('steam.confirm_account').replace('{persona}', account.persona || '?').replace('{id}', account.steam_id || '?'),
                        form.itemId
                            ? t('steam.confirm_update').replace('{title}', existing ? existing.title : form.itemId).replace('{id}', form.itemId)
                            : t('steam.confirm_create'),
                        t('steam.confirm_title').replace('{title}', form.title.trim()),
                        t('steam.confirm_visibility').replace('{visibility}', t('steam.vis_' + visKey(form.visibility))),
                        t('steam.confirm_content').replace('{file}', meta.value.fileName).replace('{size}', formatSize(meta.value.fileSize)),
                        t('steam.confirm_tags').replace('{tags}', tags.length ? tags.join(', ') : t('steam.no_tags')),
                    ];
                    if (form.visibility === 0) lines.push(t('steam.confirm_public_warning'));

                    let ok = true;
                    if (typeof window.showConfirmModal === 'function') {
                        ok = await window.showConfirmModal({
                            title: form.itemId ? t('steam.confirm_title_update') : t('steam.confirm_title_new'),
                            message: lines.join('\n'),
                            confirmLabel: form.itemId ? t('steam.update_item') : t('steam.publish_new'),
                            cancelLabel: t('common.cancel'),
                            danger: form.visibility === 0,
                        });
                    }
                    if (!ok) return;

                    busy.publish = true;
                    result.value = null;
                    Object.assign(progress, { stage: 'starting', status: '', done: 0, total: 0 });
                    try {
                        const res = await eel.steam_workshop_publish({
                            tmodPath: meta.value.path,
                            title: form.title.trim(),
                            description: form.description,
                            tags,
                            visibility: Number(form.visibility),
                            changeNote: form.changeNote,
                            itemId: form.itemId,
                            previewPath: form.previewPath,
                        })();
                        if (!res || !res.success) {
                            busy.publish = false;
                            progress.stage = '';
                            toast((res && res.error) || t('steam.publish_failed'), true);
                        }
                    } catch (e) {
                        busy.publish = false;
                        progress.stage = '';
                        toast(String(e && e.message || e), true);
                    }
                };

                const changeVisibility = async (item, event) => {
                    const value = Number(event.target.value);
                    if (value === item.visibility) return;
                    let ok = true;
                    if (typeof window.showConfirmModal === 'function') {
                        ok = await window.showConfirmModal({
                            title: t('steam.confirm_visibility_title'),
                            message: t('steam.confirm_visibility_body')
                                .replace('{title}', item.title)
                                .replace('{visibility}', t('steam.vis_' + visKey(value))),
                            confirmLabel: t('common.confirm'),
                            cancelLabel: t('common.cancel'),
                            danger: value === 0,
                        });
                    }
                    if (!ok) { event.target.value = item.visibility; return; }
                    try {
                        const res = await eel.steam_workshop_set_visibility(item.id, value)();
                        if (res && res.success) { item.visibility = value; toast(t('manage.saved')); }
                        else { event.target.value = item.visibility; toast((res && res.error) || t('manage.save_failed'), true); }
                    } catch (e) {
                        event.target.value = item.visibility;
                        toast(String(e && e.message || e), true);
                    }
                };

                // --- progress frames ------------------------------------------
                _progressHandler = (payload) => {
                    if (!payload || typeof payload !== 'object') return;
                    progress.stage = payload.stage || '';
                    if (payload.stage === 'uploading') {
                        progress.status = payload.status || '';
                        progress.done = Number(payload.done) || 0;
                        progress.total = Number(payload.total) || 0;
                    } else {
                        progress.status = '';
                        progress.done = 0;
                        progress.total = 0;
                    }
                    if (payload.account) status.account = payload.account;
                    if (payload.stage === 'connected') status.connected = true;
                    // `finished`, not `done` -- `done` is the byte counter on the
                    // uploading frames.
                    if (!payload.finished) return;

                    busy.publish = false;
                    result.value = payload;
                    if (payload.ok) {
                        rememberId(form.title, payload.itemId);
                        form.itemId = String(payload.itemId || '');
                        targetMatch.value = 'manual';
                        toast(payload.created ? t('steam.result_created') : t('steam.result_updated'));
                        loadItems();
                    } else {
                        toast(payload.error || t('steam.publish_failed'), true);
                    }
                };

                const onShown = () => {
                    refreshStatus().then(() => { if (status.connected) loadItems(); });
                };
                document.addEventListener('modder_steam_shown', onShown);
                onUnmounted(() => {
                    document.removeEventListener('modder_steam_shown', onShown);
                    _progressHandler = null;
                });

                refreshStatus();

                return {
                    t, status, busy, items, itemsError, meta, form, result, progress, targetMatch,
                    previewSrc, previewOverrideName, previewLabel, previewProblem, targetHint,
                    canPublish, progressLabel, progressIcon, progressPercent,
                    visKey, formatSize, formatDate, openUrl, openProfile, copyText,
                    connect, disconnect, loadItems, browseTmod, browsePreview,
                    clearPreviewOverride, selectItem, publish, changeVisibility,
                };
            },
        });

        if (window._modderSteamApp) window._modderSteamApp.unmount();
        window._modderSteamApp = app;
        app.mount('#modder-steam-app');
    });
})();
