// "Mods" management tab — full management of the signed-in user's Mods Hub
// projects: list, create, delete, and a per-mod editor (details, banner,
// releases, collaborators). Git file-tree editing stays on the website studio.
document.addEventListener('modder_manage_mods_loaded', () => {
    if (typeof Vue === 'undefined') { console.error('Vue.js failed to load!'); return; }

    const { createApp, ref, reactive, onUnmounted } = Vue;
    const IMAGE_BASE = 'https://api.aallyn.net/v1/mods/hub/image/';
    const STUDIO_BASE = 'https://trove.aallyn.net/mods/';

    const app = createApp({
        setup() {
            const t = (s, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(s, p) : s;
            const unwrap = (raw) => (raw && raw.success && raw.data && typeof raw.data === 'object') ? raw.data : (raw || {});
            const toast = (msg, err) => { if (window.showToast) window.showToast(msg, !!err); };

            const view = ref('list');           // 'list' | 'editor'
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
                    const res = await eel.site_mods_list()();
                    if (res && res.success) items.value = unwrap(res).items || [];
                    else error.value = (res && res.error) || t('manage.load_failed');
                } catch (e) { error.value = String(e && e.message || e); }
                loading.value = false;
            };

            const createMod = async () => {
                const title = createForm.title.trim();
                if (!title || busy.value) return;
                busy.value = true;
                try {
                    const res = await eel.site_mod_create(title, createForm.visibility)();
                    if (res && res.success) { toast(t('manage.created')); createForm.title = ''; createForm.open = false; await load(); }
                    else toast((res && res.error) || t('manage.create_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                busy.value = false;
            };

            const removeMod = async (m) => {
                let ok = true;
                if (typeof window.showConfirmModal === 'function') {
                    ok = await window.showConfirmModal({
                        title: t('manage.delete_mod'),
                        message: t('manage.delete_mod_confirm').replace('{title}', m.title),
                        confirmLabel: t('manage.delete'), cancelLabel: t('common.cancel'), danger: true,
                    });
                }
                if (!ok) return;
                const res = await eel.site_mod_delete(m.handle, m.slug)();
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
            const relBusy = ref(false);
            const collabBusy = ref(false);
            const collabName = ref('');
            const form = reactive({ title: '', summary: '', description: '', tags: '', visibility: 'draft', discord_url: '', website_url: '', donation_urls: '' });
            const relForm = reactive({ tag: '', branch: 'main', status: 'published', title: '', changelog: '' });

            const applyDetail = (d) => {
                detail.value = d || {};
                form.title = d.title || ''; form.summary = d.summary || ''; form.description = d.description || '';
                form.tags = (d.tags || []).join(', '); form.visibility = d.visibility || 'draft';
                form.discord_url = d.discord_url || ''; form.website_url = d.website_url || '';
                form.donation_urls = (d.donation_urls || []).join('\n');
                relForm.branch = d.default_branch || (d.branches && d.branches[0] && d.branches[0].name) || 'main';
            };

            const loadDetail = async () => {
                detailLoading.value = true; detailError.value = '';
                try {
                    const res = await eel.site_mod_detail(editTarget.handle, editTarget.slug)();
                    if (res && res.success) applyDetail(unwrap(res));
                    else detailError.value = (res && res.error) || t('manage.load_failed');
                } catch (e) { detailError.value = String(e && e.message || e); }
                detailLoading.value = false;
            };

            const openEditor = (m) => {
                editTarget.handle = m.handle; editTarget.slug = m.slug; editTarget.title = m.title;
                detail.value = {}; view.value = 'editor';
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
                    const res = await eel.site_mod_update(editTarget.handle, editTarget.slug, patch)();
                    if (res && res.success) { toast(t('manage.saved')); applyDetail(unwrap(res)); }
                    else toast((res && res.error) || t('manage.save_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                savingDetails.value = false;
            };

            const uploadBanner = async () => {
                if (bannerBusy.value) return;
                bannerBusy.value = true;
                try {
                    const res = await eel.site_mod_banner_upload(editTarget.handle, editTarget.slug)();
                    const d = unwrap(res);
                    if (res && res.success && !d.cancelled) { detail.value = { ...detail.value, banner_sha: d.banner_sha }; toast(t('manage.banner_updated')); }
                    else if (res && !res.success) toast(res.error || t('manage.save_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                bannerBusy.value = false;
            };

            const uploadRelease = async () => {
                if (relBusy.value || !relForm.tag.trim()) return;
                relBusy.value = true;
                try {
                    const res = await eel.site_mod_release_upload(editTarget.handle, editTarget.slug, { ...relForm, tag: relForm.tag.trim() })();
                    const d = unwrap(res);
                    if (res && res.success && !d.cancelled) { toast(t('manage.release_uploaded')); relForm.tag = ''; relForm.title = ''; relForm.changelog = ''; await loadDetail(); }
                    else if (res && !res.success) toast(res.error || t('manage.upload_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                relBusy.value = false;
            };

            const toggleRelease = async (r) => {
                const status = r.status === 'published' ? 'draft' : 'published';
                const res = await eel.site_mod_release_update(r.id, { status })();
                if (res && res.success) { r.status = status; toast(t('manage.saved')); }
                else toast((res && res.error) || t('manage.save_failed'), true);
            };

            const deleteRelease = async (r) => {
                let ok = true;
                if (typeof window.showConfirmModal === 'function') {
                    ok = await window.showConfirmModal({
                        title: t('manage.delete_release'),
                        message: t('manage.delete_release_confirm').replace('{tag}', r.tag),
                        confirmLabel: t('manage.delete'), cancelLabel: t('common.cancel'), danger: true,
                    });
                }
                if (!ok) return;
                const res = await eel.site_mod_release_delete(r.id)();
                if (res && res.success) { toast(t('manage.deleted')); await loadDetail(); }
                else toast((res && res.error) || t('manage.delete_failed'), true);
            };

            const addCollaborator = async () => {
                const name = collabName.value.trim();
                if (!name || collabBusy.value) return;
                collabBusy.value = true;
                try {
                    const res = await eel.site_mod_collaborator_add(editTarget.handle, editTarget.slug, name)();
                    if (res && res.success) { applyDetail(unwrap(res)); collabName.value = ''; toast(t('manage.saved')); }
                    else toast((res && res.error) || t('manage.save_failed'), true);
                } catch (e) { toast(String(e && e.message || e), true); }
                collabBusy.value = false;
            };

            const removeCollaborator = async (c) => {
                const res = await eel.site_mod_collaborator_remove(editTarget.handle, editTarget.slug, c.id)();
                if (res && res.success) applyDetail(unwrap(res));
                else toast((res && res.error) || t('manage.save_failed'), true);
            };

            const onShown = () => { if (view.value === 'list') load(); };
            document.addEventListener('modder_manage_mods_shown', onShown);
            onUnmounted(() => document.removeEventListener('modder_manage_mods_shown', onShown));

            return {
                t, view, loading, error, items, busy, createForm, imageUrl, bannerUrl, openStudio,
                load, createMod, removeMod,
                editTarget, detail, detailLoading, detailError, form, relForm, collabName,
                savingDetails, bannerBusy, relBusy, collabBusy,
                openEditor, closeEditor, saveDetails, uploadBanner, uploadRelease, toggleRelease, deleteRelease,
                addCollaborator, removeCollaborator,
            };
        },
    });

    if (window._manageModsApp) window._manageModsApp.unmount();
    window._manageModsApp = app;
    app.mount('#manage-mods-app');
});
