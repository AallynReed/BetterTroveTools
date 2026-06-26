// "Modpacks" management tab — full management of the signed-in user's modpacks:
// list, create, delete, and a per-pack editor (details, banner, variants + the
// mod list / entry editor, collaborators).
document.addEventListener('modder_manage_modpacks_loaded', () => {
    if (typeof Vue === 'undefined') { console.error('Vue.js failed to load!'); return; }

    const { createApp, ref, reactive, onUnmounted } = Vue;
    const IMAGE_BASE = 'https://api.aallyn.net/v1/mods/hub/image/';
    const STUDIO_BASE = 'https://trove.aallyn.net/modpacks/';

    const app = createApp({
        setup() {
            const t = (s, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(s, p) : s;
            const unwrap = (raw) => (raw && raw.success && raw.data && typeof raw.data === 'object') ? raw.data : (raw || {});
            const toast = (msg, err) => { if (window.showToast) window.showToast(msg, !!err); };
            const clone = (v) => JSON.parse(JSON.stringify(v || []));

            const view = ref('list');
            const loading = ref(false);
            const error = ref('');
            const items = ref([]);
            const busy = ref(false);
            const createForm = reactive({ open: false, title: '', visibility: 'draft' });

            const imageUrl = (sha) => IMAGE_BASE + sha;
            const bannerUrl = (m) => (m.banner_sha || m.preview_sha) ? imageUrl(m.banner_sha || m.preview_sha) : '';
            const openStudio = (m) => { if (window.eel && eel.open_url_in_browser) eel.open_url_in_browser(`${STUDIO_BASE}${m.handle}/${m.slug}`)(); };

            // ---- list -------------------------------------------------------
            const load = async () => {
                loading.value = true; error.value = '';
                try {
                    const res = await eel.site_modpacks_list()();
                    if (res && res.success) items.value = unwrap(res).items || [];
                    else error.value = (res && res.error) || t('manage.load_failed');
                } catch (e) { error.value = String(e && e.message || e); }
                loading.value = false;
            };
            const createPack = async () => {
                const title = createForm.title.trim();
                if (!title || busy.value) return;
                busy.value = true;
                try {
                    const res = await eel.site_modpack_create(title, createForm.visibility)();
                    if (res && res.success) { toast(t('manage.created')); createForm.title = ''; createForm.open = false; await load(); }
                    else toast((res && res.error) || t('manage.create_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                busy.value = false;
            };
            const removePack = async (m) => {
                let ok = true;
                if (typeof window.showConfirmModal === 'function') {
                    ok = await window.showConfirmModal({
                        title: t('manage.delete_modpack'),
                        message: t('manage.delete_modpack_confirm').replace('{title}', m.title),
                        confirmLabel: t('manage.delete'), cancelLabel: t('common.cancel'), danger: true,
                    });
                }
                if (!ok) return;
                const res = await eel.site_modpack_delete(m.handle, m.slug)();
                if (res && res.success) { toast(t('manage.deleted')); await load(); }
                else toast((res && res.error) || t('manage.delete_failed'), true);
            };

            // ---- editor -----------------------------------------------------
            const editTarget = reactive({ handle: '', slug: '', title: '' });
            const detail = ref({});
            const detailLoading = ref(false);
            const detailError = ref('');
            const savingDetails = ref(false);
            const bannerBusy = ref(false);
            const collabBusy = ref(false);
            const collabName = ref('');
            const form = reactive({ title: '', summary: '', description: '', tags: '', visibility: 'draft', discord_url: '', website_url: '', donation_urls: '' });

            const selectedVariant = ref('');
            const workingEntries = ref([]);
            const savingEntries = ref(false);
            const variantEdit = reactive({ open: false, mode: 'new', value: '' });
            const searchQuery = ref('');
            const searching = ref(false);
            const searchResults = ref([]);

            const currentVariant = () => (detail.value.variants || []).find(v => v.name === selectedVariant.value);
            const syncWorking = () => { const v = currentVariant(); workingEntries.value = v ? clone(v.entries) : []; };

            const applyDetail = (d) => {
                detail.value = d || {};
                form.title = d.title || ''; form.summary = d.summary || ''; form.description = d.description || '';
                form.tags = (d.tags || []).join(', '); form.visibility = d.visibility || 'draft';
                form.discord_url = d.discord_url || ''; form.website_url = d.website_url || '';
                form.donation_urls = (d.donation_urls || []).join('\n');
                const variants = d.variants || [];
                if (!variants.find(v => v.name === selectedVariant.value)) {
                    selectedVariant.value = d.default_variant || (variants[0] && variants[0].name) || '';
                }
                syncWorking();
            };

            const loadDetail = async () => {
                detailLoading.value = true; detailError.value = '';
                try {
                    const res = await eel.site_modpack_detail(editTarget.handle, editTarget.slug)();
                    if (res && res.success) applyDetail(unwrap(res));
                    else detailError.value = (res && res.error) || t('manage.load_failed');
                } catch (e) { detailError.value = String(e && e.message || e); }
                detailLoading.value = false;
            };

            const openEditor = (m) => {
                editTarget.handle = m.handle; editTarget.slug = m.slug; editTarget.title = m.title;
                detail.value = {}; selectedVariant.value = ''; searchResults.value = []; view.value = 'editor';
                loadDetail();
            };
            const closeEditor = async () => { view.value = 'list'; await load(); };

            const saveDetails = async () => {
                if (savingDetails.value || !form.title.trim()) return;
                savingDetails.value = true;
                const patch = {
                    title: form.title.trim(), summary: form.summary, description: form.description,
                    visibility: form.visibility,
                    tags: form.tags.split(',').map(s => s.trim()).filter(Boolean),
                    discord_url: form.discord_url, website_url: form.website_url,
                    donation_urls: form.donation_urls.split('\n').map(s => s.trim()).filter(Boolean),
                };
                try {
                    const res = await eel.site_modpack_update(editTarget.handle, editTarget.slug, patch)();
                    if (res && res.success) { toast(t('manage.saved')); applyDetail(unwrap(res)); }
                    else toast((res && res.error) || t('manage.save_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                savingDetails.value = false;
            };

            const uploadBanner = async () => {
                if (bannerBusy.value) return;
                bannerBusy.value = true;
                try {
                    const res = await eel.site_modpack_banner_upload(editTarget.handle, editTarget.slug)();
                    const d = unwrap(res);
                    if (res && res.success && !d.cancelled) { detail.value = { ...detail.value, banner_sha: d.banner_sha }; toast(t('manage.banner_updated')); }
                    else if (res && !res.success) toast(res.error || t('manage.save_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                bannerBusy.value = false;
            };

            // ---- variants ---------------------------------------------------
            const setDefaultVariant = async () => {
                const res = await eel.site_modpack_update(editTarget.handle, editTarget.slug, { default_variant: selectedVariant.value })();
                if (res && res.success) { applyDetail(unwrap(res)); toast(t('manage.saved')); }
                else toast((res && res.error) || t('manage.save_failed'), true);
            };
            const newVariant = () => { variantEdit.mode = 'new'; variantEdit.value = ''; variantEdit.open = true; };
            const renameVariant = () => { const v = currentVariant(); variantEdit.mode = 'rename'; variantEdit.value = (v && (v.label || v.name)) || ''; variantEdit.open = true; };
            const confirmVariantEdit = async () => {
                const val = variantEdit.value.trim();
                if (!val) return;
                let res;
                if (variantEdit.mode === 'new') res = await eel.site_modpack_variant_create(editTarget.handle, editTarget.slug, val, selectedVariant.value || null)();
                else res = await eel.site_modpack_variant_update(editTarget.handle, editTarget.slug, selectedVariant.value, val)();
                if (res && res.success) { variantEdit.open = false; const d = unwrap(res); applyDetail(d); toast(t('manage.saved')); }
                else toast((res && res.error) || t('manage.save_failed'), true);
            };
            const deleteVariant = async () => {
                if ((detail.value.variants || []).length <= 1) return;
                let ok = true;
                if (typeof window.showConfirmModal === 'function') {
                    ok = await window.showConfirmModal({
                        title: t('manage.delete_variant'),
                        message: t('manage.delete_variant_confirm').replace('{name}', selectedVariant.value),
                        confirmLabel: t('manage.delete'), cancelLabel: t('common.cancel'), danger: true,
                    });
                }
                if (!ok) return;
                const res = await eel.site_modpack_variant_delete(editTarget.handle, editTarget.slug, selectedVariant.value)();
                if (res && res.success) { selectedVariant.value = ''; applyDetail(unwrap(res)); toast(t('manage.deleted')); }
                else toast((res && res.error) || t('manage.delete_failed'), true);
            };

            // ---- entries ----------------------------------------------------
            const moveEntry = (i, dir) => {
                const j = i + dir;
                if (j < 0 || j >= workingEntries.value.length) return;
                const arr = workingEntries.value;
                [arr[i], arr[j]] = [arr[j], arr[i]];
                workingEntries.value = [...arr];
            };
            const removeEntry = (i) => { workingEntries.value.splice(i, 1); };
            const hasEntry = (r) => workingEntries.value.some(e => !e.custom && e.handle === r.handle && e.slug === r.slug);
            const addEntry = (r) => {
                if (hasEntry(r)) return;
                workingEntries.value.push({ custom: false, handle: r.handle, slug: r.slug, title: r.title, author: r.author || r.owner_username, branch: 'main', version_locked: false, locked_tag: null, available: true });
            };
            const saveEntries = async () => {
                if (savingEntries.value) return;
                savingEntries.value = true;
                const entries = workingEntries.value.map(e => e.custom
                    ? { custom_sha: e.custom_sha, custom_filename: e.custom_filename, title: e.title || '', author: e.author || '' }
                    : { handle: e.handle, slug: e.slug, branch: e.branch || 'main', version_locked: !!e.version_locked, locked_tag: e.version_locked ? (e.locked_tag || null) : null });
                try {
                    const res = await eel.site_modpack_set_entries(editTarget.handle, editTarget.slug, selectedVariant.value, entries)();
                    if (res && res.success) { applyDetail(unwrap(res)); toast(t('manage.mod_list_saved')); }
                    else toast((res && res.error) || t('manage.save_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                savingEntries.value = false;
            };

            const searchMods = async () => {
                if (searching.value) return;
                searching.value = true;
                try {
                    const res = await eel.site_hub_search(searchQuery.value, 20)();
                    if (res && res.success) searchResults.value = unwrap(res).items || [];
                    else toast((res && res.error) || t('manage.load_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                searching.value = false;
            };

            // ---- collaborators ----------------------------------------------
            const addCollaborator = async () => {
                const name = collabName.value.trim();
                if (!name || collabBusy.value) return;
                collabBusy.value = true;
                try {
                    const res = await eel.site_modpack_collaborator_add(editTarget.handle, editTarget.slug, name)();
                    if (res && res.success) { applyDetail(unwrap(res)); collabName.value = ''; toast(t('manage.saved')); }
                    else toast((res && res.error) || t('manage.save_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                collabBusy.value = false;
            };
            const removeCollaborator = async (c) => {
                const res = await eel.site_modpack_collaborator_remove(editTarget.handle, editTarget.slug, c.id)();
                if (res && res.success) applyDetail(unwrap(res));
                else toast((res && res.error) || t('manage.save_failed'), true);
            };

            const onShown = () => { if (view.value === 'list') load(); };
            document.addEventListener('modder_manage_modpacks_shown', onShown);
            onUnmounted(() => document.removeEventListener('modder_manage_modpacks_shown', onShown));

            return {
                t, view, loading, error, items, busy, createForm, imageUrl, bannerUrl, openStudio,
                load, createPack, removePack,
                editTarget, detail, detailLoading, detailError, form, savingDetails, bannerBusy,
                openEditor, closeEditor, saveDetails, uploadBanner,
                selectedVariant, workingEntries, savingEntries, syncWorking, variantEdit,
                setDefaultVariant, newVariant, renameVariant, confirmVariantEdit, deleteVariant,
                moveEntry, removeEntry, hasEntry, addEntry, saveEntries,
                searchQuery, searching, searchResults, searchMods,
                collabName, collabBusy, addCollaborator, removeCollaborator,
            };
        },
    });

    if (window._manageModpacksApp) window._manageModpacksApp.unmount();
    window._manageModpacksApp = app;
    app.mount('#manage-modpacks-app');
});
