// Account view — Discord sign-in + profile for the desktop app. The heavy
// lifting (OAuth, tokens, /me) lives in backend/auth.py; this is just the UI.
// Canonical sign-in state is held by window.BTTAccount (defined in main.js) so
// the sidebar chip stays in sync whether or not this view is currently mounted.
document.addEventListener('account_loaded', async () => {
    if (typeof Vue === 'undefined') {
        console.error('Vue.js failed to load!');
        return;
    }

    const { createApp, ref, onMounted, onUnmounted } = Vue;
    const DASHBOARD_URL = 'https://trove.aallyn.net/dashboard';

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;

            const loading = ref(true);
            const busy = ref(false);
            const user = ref((window.BTTAccount && window.BTTAccount.state.user) || null);

            // Keep this view in lockstep with the shared account state (e.g. when
            // a sign-in completes via the deep link while this view is open).
            const unsubscribe = (window.BTTAccount && window.BTTAccount.onChange)
                ? window.BTTAccount.onChange((s) => { user.value = s.user; })
                : null;

            const openUrl = (url) => {
                if (window.eel && eel.open_url_in_browser) eel.open_url_in_browser(url)();
            };
            const openDashboard = () => openUrl(DASHBOARD_URL);

            const signIn = async () => {
                if (busy.value || !(window.eel && eel.site_auth_begin_login)) return;
                busy.value = true;
                try {
                    await eel.site_auth_begin_login()();
                    // The browser opens; the flow returns via btt:// deep link and
                    // BTTAccount.onAuthChanged updates `user`. Drop the busy state
                    // shortly after so the button is usable if the user cancels.
                    setTimeout(() => { busy.value = false; }, 4000);
                } catch (e) {
                    busy.value = false;
                    if (window.showToast) window.showToast(t('account.sign_in_failed'), true);
                }
            };

            const signOut = async () => {
                if (busy.value || !(window.eel && eel.site_auth_logout)) return;
                busy.value = true;
                try {
                    const res = await eel.site_auth_logout()();
                    if (window.BTTAccount) window.BTTAccount.onAuthChanged((res && res.data) || { authenticated: false, user: null });
                    if (window.showToast) window.showToast(t('account.signed_out_toast'));
                } catch (e) {
                    if (window.showToast) window.showToast(t('account.sign_out_failed'), true);
                } finally {
                    busy.value = false;
                }
            };

            onMounted(async () => {
                if (window.BTTAccount) {
                    const s = await window.BTTAccount.refresh();
                    user.value = s.user;
                }
                loading.value = false;
            });

            onUnmounted(() => { if (unsubscribe) unsubscribe(); });

            return { t, loading, busy, user, signIn, signOut, openDashboard };
        },
    });

    if (window._accountApp) window._accountApp.unmount();
    window._accountApp = app;
    app.mount('#account-vue-app');
});
