// "Modpacks" management tab — manage the signed-in user's own modpacks.
// Lists my modpacks + create / edit core details / visibility / delete. The mod
// list (variants + entries) editor deep-links to the website studio.
document.addEventListener('modder_manage_modpacks_loaded', () => {
    if (typeof Vue === 'undefined') { console.error('Vue.js failed to load!'); return; }

    const { createApp, ref, reactive, onUnmounted } = Vue;
    const IMAGE_BASE = 'https://api.aallyn.net/v1/mods/hub/image/';
    const STUDIO_BASE = 'https://trove.aallyn.net/modpacks/';

    const app = createApp({
        setup() {
            const t = (s, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(s, p) : s;
            const unwrap = (raw) => (raw && raw.success && raw.data && typeof raw.data === 'object') ? raw.data : (raw || {});

            const loading = ref(false);
            const error = ref('');
            const items = ref([]);
            const busy = ref(false);
            const createForm = reactive({ open: false, title: '', visibility: 'draft' });
            const editForm = reactive({ open: false, handle: '', slug: '', title: '', summary: '', tags: '', visibility: 'draft', saving: false });

            const bannerUrl = (m) => (m.banner_sha || m.preview_sha) ? IMAGE_BASE + (m.banner_sha || m.preview_sha) : '';
            const openStudio = (m) => { if (window.eel && eel.open_url_in_browser) eel.open_url_in_browser(`${STUDIO_BASE}${m.handle}/${m.slug}`)(); };

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
                    if (res && res.success) { if (window.showToast) window.showToast(t('manage.created')); createForm.title = ''; createForm.open = false; await load(); }
                    else if (window.showToast) window.showToast((res && res.error) || t('manage.create_failed'), true);
                } catch (e) { if (window.showToast) window.showToast(String(e && e.message || e), true); }
                busy.value = false;
            };

            const setVisibility = async (m, visibility) => {
                if (visibility === m.visibility) return;
                const res = await eel.site_modpack_update(m.handle, m.slug, { visibility })();
                if (res && res.success) { m.visibility = visibility; if (window.showToast) window.showToast(t('manage.saved')); }
                else if (window.showToast) window.showToast((res && res.error) || t('manage.save_failed'), true);
            };

            const openEdit = (m) => {
                editForm.open = true;
                editForm.handle = m.handle; editForm.slug = m.slug;
                editForm.title = m.title || ''; editForm.summary = m.summary || '';
                editForm.tags = (m.tags || []).join(', '); editForm.visibility = m.visibility || 'draft';
            };

            const saveEdit = async () => {
                const title = editForm.title.trim();
                if (!title || editForm.saving) return;
                editForm.saving = true;
                const patch = {
                    title,
                    summary: editForm.summary,
                    visibility: editForm.visibility,
                    tags: editForm.tags.split(',').map(s => s.trim()).filter(Boolean),
                };
                try {
                    const res = await eel.site_modpack_update(editForm.handle, editForm.slug, patch)();
                    if (res && res.success) { if (window.showToast) window.showToast(t('manage.saved')); editForm.open = false; await load(); }
                    else if (window.showToast) window.showToast((res && res.error) || t('manage.save_failed'), true);
                } catch (e) { if (window.showToast) window.showToast(String(e && e.message || e), true); }
                editForm.saving = false;
            };

            const removePack = async (m) => {
                let ok = true;
                if (typeof window.showConfirmModal === 'function') {
                    ok = await window.showConfirmModal({
                        title: t('manage.delete_modpack'),
                        message: t('manage.delete_modpack_confirm').replace('{title}', m.title),
                        confirmLabel: t('manage.delete'),
                        cancelLabel: t('common.cancel'),
                        danger: true,
                    });
                }
                if (!ok) return;
                const res = await eel.site_modpack_delete(m.handle, m.slug)();
                if (res && res.success) { if (window.showToast) window.showToast(t('manage.deleted')); await load(); }
                else if (window.showToast) window.showToast((res && res.error) || t('manage.delete_failed'), true);
            };

            const onShown = () => load();
            document.addEventListener('modder_manage_modpacks_shown', onShown);
            onUnmounted(() => document.removeEventListener('modder_manage_modpacks_shown', onShown));

            return { t, loading, error, items, busy, createForm, editForm, bannerUrl, openStudio, load, createPack, setVisibility, openEdit, saveEdit, removePack };
        },
    });

    if (window._manageModpacksApp) window._manageModpacksApp.unmount();
    window._manageModpacksApp = app;
    app.mount('#manage-modpacks-app');
});
