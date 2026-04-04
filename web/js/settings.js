document.addEventListener('settings_loaded', async () => {
    console.log("Settings view initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

    const tabButtons = document.querySelectorAll('.settings-container .tab-btn');
    const tabContents = document.querySelectorAll('.settings-container .tab-content');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            document.getElementById(btn.getAttribute('data-tab')).classList.add('active');
        });
    });

    await refreshCustomDirsList();

    const settings = await eel.get_settings()();

    const accentColorPicker = document.getElementById('setting-accent-color');
    if (accentColorPicker) {
        accentColorPicker.value = settings.accent_color || '#5ec6ff';
        accentColorPicker.addEventListener('change', async (e) => {
            const currentSettings = await eel.get_settings()();
            currentSettings.accent_color = e.target.value;
            await eel.save_settings(currentSettings)();
            document.documentElement.style.setProperty('--accent-blue', e.target.value);
        });
    }

    const communityContentToggle = document.getElementById('setting-show-community-content');
    if (communityContentToggle) {
        communityContentToggle.checked = settings.show_community_content !== false;
        
        communityContentToggle.addEventListener('change', async (e) => {
            const currentSettings = await eel.get_settings()();
            currentSettings.show_community_content = e.target.checked;
            await eel.save_settings(currentSettings)();
        });
    }

    const autoFixToggle = document.getElementById('setting-auto-fix-names');
    
    if (autoFixToggle) {
        autoFixToggle.checked = settings.auto_fix_names === true;
        
        autoFixToggle.addEventListener('change', async (e) => {
            const currentSettings = await eel.get_settings()();
            currentSettings.auto_fix_names = e.target.checked;
            await eel.save_settings(currentSettings)();
        });
    }

    const autoFixConfigsToggle = document.getElementById('setting-auto-fix-configs');
    
    if (autoFixConfigsToggle) {
        autoFixConfigsToggle.checked = settings.auto_fix_configs === true;
        
        autoFixConfigsToggle.addEventListener('change', async (e) => {
            const currentSettings = await eel.get_settings()();
            currentSettings.auto_fix_configs = e.target.checked;
            await eel.save_settings(currentSettings)();
        });
    }

    const openModalBtn = document.getElementById('btn-open-add-dir-modal');
    const closeModalBtn = document.getElementById('btn-close-add-dir-modal');
    const modal = document.getElementById('add-dir-modal');
    const browseBtn = document.getElementById('btn-browse-dir');
    const saveBtn = document.getElementById('btn-save-dir');
    const nameInput = document.getElementById('add-dir-name');
    const pathInput = document.getElementById('add-dir-path');

    if (openModalBtn) {
        openModalBtn.addEventListener('click', () => {
            nameInput.value = '';
            pathInput.value = '';
            saveBtn.disabled = true;
            saveBtn.style.opacity = '0.5';
            saveBtn.style.cursor = 'not-allowed';
            modal.classList.add('active');
        });
    }

    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => {
            modal.classList.remove('active');
        });
    }
    
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    }

    if (browseBtn) {
        browseBtn.addEventListener('click', async () => {
            const originalText = browseBtn.innerHTML;
            browseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            browseBtn.disabled = true;

            const response = await eel.browse_for_game_dir()();
            
            if (response.success) {
                pathInput.value = response.path;
                
                if (!nameInput.value.trim()) {
                    nameInput.value = response.path.split(/[\\/]/).pop() || t("Custom Trove");
                }
                
                saveBtn.disabled = false;
                saveBtn.style.opacity = '1';
                saveBtn.style.cursor = 'pointer';
            } else if (response.error) {
                window.showToast(response.error, true);
            }
            
            browseBtn.innerHTML = originalText;
            browseBtn.disabled = false;
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const path = pathInput.value;
            const name = nameInput.value.trim() || t("Custom Trove");
            
            if (!path) return;

            const originalText = saveBtn.innerHTML;
            saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Saving...")}`;
            saveBtn.disabled = true;

            const settings = await eel.get_settings()();
            if (!settings.custom_directories) settings.custom_directories = [];
            
            const exists = settings.custom_directories.some(d => d.path === path);
            
            if (!exists) {
                settings.custom_directories.push({ name: name, path: path });
                await eel.save_settings(settings)();
                await refreshCustomDirsList();
                modal.classList.remove('active');
            } else {
                window.showToast(t("This directory is already in your custom list."), true);
            }
            
            saveBtn.innerHTML = originalText;
            saveBtn.disabled = false;
        });
    }

    const listEl = document.getElementById('custom-dirs-list');
    if (listEl) {
        listEl.addEventListener('click', async (e) => {
            const removeBtn = e.target.closest('.remove-dir-btn');
            const editBtn = e.target.closest('.edit-dir-btn');
            
            if (removeBtn) {
                const pathToRemove = removeBtn.getAttribute('data-path');
                const settings = await eel.get_settings()();
                if (settings.custom_directories) {
                    settings.custom_directories = settings.custom_directories.filter(d => d.path !== pathToRemove);
                    await eel.save_settings(settings)();
                    await refreshCustomDirsList();
                }
            } else if (editBtn) {
                const pathToEdit = editBtn.getAttribute('data-path');
                const currentName = editBtn.getAttribute('data-name');
                const editModal = document.getElementById('edit-dir-modal');
                document.getElementById('edit-dir-name').value = currentName;
                document.getElementById('edit-dir-path').value = pathToEdit;
                editModal.classList.add('active');
            }
        });
    }

    const closeEditModalBtn = document.getElementById('btn-close-edit-dir-modal');
    const editModal = document.getElementById('edit-dir-modal');
    const saveEditBtn = document.getElementById('btn-save-edit-dir');
    
    if (closeEditModalBtn) {
        closeEditModalBtn.addEventListener('click', () => {
            editModal.classList.remove('active');
        });
    }

    if (editModal) {
        editModal.addEventListener('click', (e) => {
            if (e.target === editModal) {
                editModal.classList.remove('active');
            }
        });
    }

    if (saveEditBtn) {
        saveEditBtn.addEventListener('click', async () => {
            const path = document.getElementById('edit-dir-path').value;
            const newName = document.getElementById('edit-dir-name').value.trim() || t("Custom Trove");
            
            const originalText = saveEditBtn.innerHTML;
            saveEditBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Saving...")}`;
            saveEditBtn.disabled = true;

            const settings = await eel.get_settings()();
            if (settings.custom_directories) {
                for (let d of settings.custom_directories) {
                    if (d.path === path) {
                        d.name = newName;
                        break;
                    }
                }
                await eel.save_settings(settings)();
                await refreshCustomDirsList();
                editModal.classList.remove('active');
            }
            
            saveEditBtn.innerHTML = originalText;
            saveEditBtn.disabled = false;
        });
    }
});

async function refreshCustomDirsList() {
    const listEl = document.getElementById('custom-dirs-list');
    if (!listEl) return;
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    
    const settings = await eel.get_settings()();
    const dirs = settings.custom_directories || [];
    
    if (dirs.length === 0) {
        listEl.innerHTML = `<div class="placeholder-box" style="padding: 10px;">${t("No custom directories added.")}</div>`;
        return;
    }

    listEl.innerHTML = dirs.map(dir => `
        <div class="custom-dir-item">
            <div style="display: flex; flex-direction: column; overflow: hidden; margin-right: 15px;">
                <span style="font-weight: 600; font-size: 14px; margin-bottom: 4px; color: var(--text-main);">${dir.name}</span>
                <span class="dir-path" title="${dir.path}">${dir.path}</span>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="primary-btn edit-dir-btn" style="padding: 6px 10px;" data-path="${dir.path.replace(/"/g, '&quot;')}" data-name="${dir.name.replace(/"/g, '&quot;')}"><i class="fa-solid fa-pen"></i></button>
                <button class="danger-btn remove-dir-btn" data-path="${dir.path.replace(/"/g, '&quot;')}"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `).join('');
}