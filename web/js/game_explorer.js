// Game Explorer view orchestrator. Reuses the self-contained File Manager
// component (File Explorer + Update Tracker) that used to be embedded inside
// Modder Tools. We fetch its markup, inject the #file-manager-vue-app root into
// our host, lazy-load file_manager.js, then dispatch `file_manager_loaded` so it
// mounts. Mirrors the old embed in js/modder_tools/index.js.
document.addEventListener('game_explorer_loaded', async () => {
    const host = document.getElementById('game-explorer-host');
    if (!host) return;

    try {
        // no-store: avoid a stale 404 cached by WebView2 from before this split.
        const response = await fetch('views/modder_tools/file_manager.html', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to load file manager view (${response.status})`);

        const html = await response.text();
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const root = parsed.querySelector('#file-manager-vue-app');
        if (!root) throw new Error('File Manager root element not found');

        host.innerHTML = '';
        host.appendChild(root);

        if (window.loadScript) {
            try { await window.loadScript('js/modder_tools/file_manager.js'); }
            catch (e) { console.error('Failed to lazy-load file_manager.js:', e); }
        }

        // Mounts the component (its onMounted registers the set-tab listener
        // synchronously, so the dispatch right below is caught).
        document.dispatchEvent(new CustomEvent('file_manager_loaded'));

        // Land on the requested internal tab (quick actions / command palette set
        // window.pendingGameExplorerTab) or default to the file explorer.
        const tab = window.pendingGameExplorerTab || 'tab-explorer';
        window.pendingGameExplorerTab = null;
        document.dispatchEvent(new CustomEvent('file_manager_set_tab', { detail: { tab } }));
    } catch (e) {
        console.error('Failed to load Game Explorer view:', e);
        const t = (id) => (window.I18nManager && window.I18nManager.t) ? window.I18nManager.t(id) : id;
        host.innerHTML = `<div style="color:var(--danger-ink);padding:var(--t-6);text-align:center;">${t('game_explorer.failed_to_load')}</div>`;
    }
});

// Re-entering a cached Game Explorer via a deep-link into an internal tab fires
// game_explorer_shown; forward the pending tab to the already-mounted file
// manager instead of rebuilding the view. Registered at module scope (once).
document.addEventListener('game_explorer_shown', () => {
    if (!window.pendingGameExplorerTab) return;
    const tab = window.pendingGameExplorerTab;
    window.pendingGameExplorerTab = null;
    document.dispatchEvent(new CustomEvent('file_manager_set_tab', { detail: { tab } }));
});
