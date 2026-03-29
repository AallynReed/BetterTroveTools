let ts_currentPage = 1;
let ts_isLoading = false;

document.addEventListener('trovesaurus_loaded', () => {
    console.log("Trovesaurus Logic: Hooking into UI...");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

    const searchBtn = document.getElementById('btn-ts-search');
    const searchInput = document.getElementById('ts-search-input');
    const categorySelect = document.getElementById('ts-category-select');
    const sortSelect = document.getElementById('ts-sort-select');
    const prevBtn = document.getElementById('btn-ts-prev');
    const nextBtn = document.getElementById('btn-ts-next');

    if (searchBtn) searchBtn.addEventListener('click', () => fetchTrovesaurusMods(1));
    
    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') fetchTrovesaurusMods(1);
        });
    }

    if (categorySelect) categorySelect.addEventListener('change', () => fetchTrovesaurusMods(1));
    if (sortSelect) sortSelect.addEventListener('change', () => fetchTrovesaurusMods(1));

    if (prevBtn) prevBtn.addEventListener('click', () => {
        if (ts_currentPage > 1) fetchTrovesaurusMods(ts_currentPage - 1);
    });

    if (nextBtn) nextBtn.addEventListener('click', () => {
        fetchTrovesaurusMods(ts_currentPage + 1);
    });

    const modGrid = document.getElementById('ts-mod-grid');
    const imageModal = document.getElementById('image-modal');
    const modalImg = document.getElementById('expanded-img');
    const modalCaption = document.getElementById('modal-caption');

    const tsGameSelect = document.getElementById('ts-game-select');
    if (tsGameSelect) {
        tsGameSelect.addEventListener('change', async () => {
            const settings = await eel.get_settings()();
            settings.last_game_path = tsGameSelect.value;
            await eel.save_settings(settings)();
            fetchTrovesaurusMods(1);
        });
    }

    if (modGrid) {
        modGrid.addEventListener('click', (e) => {
            const installBtn = e.target.closest('.ts-install-btn');
            if (installBtn) {
                handleTrovesaurusInstall(e);
                return;
            }

            const previewImg = e.target.closest('img.mod-preview-img');
            if (previewImg && imageModal) {
                const card = previewImg.closest('.ts-mod-card');
                modalImg.src = previewImg.src;
                modalCaption.innerText = card.querySelector('.ts-mod-title').innerText;
                imageModal.classList.add('active');
            }
        });
    }

    if (imageModal) {
        imageModal.addEventListener('click', (e) => {
            if (e.target === imageModal || e.target.classList.contains('close-modal')) {
                imageModal.classList.remove('active');
                setTimeout(() => { modalImg.src = ""; }, 200);
            }
        });
    }

    fetchTrovesaurusMods(1);
});

async function getActiveGamePath() {
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    const tsSelect = document.getElementById('ts-game-select');
    
    if (tsSelect && tsSelect.getAttribute('data-loaded')) {
        return tsSelect.value;
    }

    const response = await eel.get_detected_game_paths()();
    const settings = await eel.get_settings()();
    const lastPath = settings.last_game_path;

    if (response.success && response.paths.length > 0) {
        if (tsSelect) {
            tsSelect.innerHTML = response.paths.map(p => 
                `<option value="${p.path}">${p.name}</option>`
            ).join('');
            
            if (lastPath && response.paths.some(p => p.path === lastPath)) {
                tsSelect.value = lastPath;
            } else {
                const liveInstall = response.paths.find(p => p.name.toLowerCase().includes('live'));
                if (liveInstall) {
                    tsSelect.value = liveInstall.path;
                } else {
                    tsSelect.value = response.paths[0].path;
                }
            }
            
            tsSelect.setAttribute('data-loaded', 'true');
            return tsSelect.value;
        }
        
        if (lastPath && response.paths.some(p => p.path === lastPath)) {
            return lastPath;
        }
        const liveInstall = response.paths.find(p => p.name.toLowerCase().includes('live'));
        return liveInstall ? liveInstall.path : response.paths[0].path;
    }
    if (tsSelect) tsSelect.innerHTML = `<option value="">${t("No installations found")}</option>`;
    return null;
}

async function fetchTrovesaurusMods(page = 1) {
    if (ts_isLoading) return;
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    
    const grid = document.getElementById('ts-mod-grid');
    const searchInput = document.getElementById('ts-search-input');
    const catSelect = document.getElementById('ts-category-select');
    const sortSelect = document.getElementById('ts-sort-select');

    if (!grid) return;

    ts_isLoading = true;
    grid.innerHTML = `<div class="placeholder-box"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Browsing Trovesaurus...")}</div>`;

    const query = searchInput ? searchInput.value.trim() : "";
    const category = catSelect ? catSelect.value : "";
    const sort = sortSelect ? sortSelect.value : "hot";
    
    const gamePath = await getActiveGamePath() || "";

    eel.get_trovesaurus_mods(page, query, category, sort, gamePath)();
}

eel.expose(receive_trovesaurus_mods, 'receive_trovesaurus_mods');
function receive_trovesaurus_mods(response) {
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    const grid = document.getElementById('ts-mod-grid');
    const prevBtn = document.getElementById('btn-ts-prev');
    const nextBtn = document.getElementById('btn-ts-next');
    
    const pageCurrent = document.getElementById('ts-page-current');
    const pageMaxContainer = document.getElementById('ts-page-max-container');
    const pageMax = document.getElementById('ts-page-max');

    if (!grid) return;

    if (response && response.success) {
        ts_currentPage = response.page;
        renderTrovesaurusGrid(response.mods, grid);
        
        if (pageCurrent) pageCurrent.innerText = ts_currentPage;
        if (pageMaxContainer && pageMax) {
            pageMaxContainer.style.display = 'inline';
            pageMax.innerText = response.max_pages;
        }

        if (prevBtn) prevBtn.disabled = ts_currentPage <= 1;
        if (nextBtn) nextBtn.disabled = ts_currentPage >= response.max_pages;
    } else {
        grid.innerHTML = `<div class="placeholder-box" style="color: #ff5555;"><i class="fa-solid fa-triangle-exclamation"></i> ${response?.error || t('Unknown error occurred')}</div>`;
    }

    ts_isLoading = false;
}

function renderTrovesaurusGrid(mods, container) {
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    if (!mods || mods.length === 0) {
        container.innerHTML = `<div class="placeholder-box">${t("No mods found matching your search.")}</div>`;
        return;
    }

    container.innerHTML = mods.map(mod => {
        const isInstalled = mod.is_installed;
        const needsUpdate = mod.needs_update;
        const img = mod.image || '/assets/images/no_preview.png';
        
        let btnClass = '';
        let btnIcon = '<i class="fa-solid fa-download"></i>';
        let btnText = t('Install');
        let btnDisabled = '';

        if (needsUpdate) {
            btnClass = 'update';
            btnIcon = '<i class="fa-solid fa-rotate"></i>';
            btnText = t('Update');
        } else if (isInstalled) {
            btnClass = 'installed';
            btnIcon = '<i class="fa-solid fa-check"></i>';
            btnText = t('Installed');
            btnDisabled = 'disabled';
        }
        
        return `
            <div class="ts-mod-card">
                <div class="mod-image-container">
                    <img src="${img}" class="mod-preview-img" loading="lazy" onerror="this.src='/assets/images/no_preview.png'">
                </div>
                <div class="mod-card-content">
                    <h3 class="mod-title ts-mod-title" title="${t("{name} (Click to view on Trovesaurus)").replace("{name}", mod.name)}" onclick="eel.open_url_in_browser('https://trovesaurus.com/mod=${mod.id}')()">${mod.name}</h3>
                    <span class="mod-meta"><span class="${mod.author_id ? 'ts-mod-author' : ''}" ${mod.author_id ? `title="${t("View {author}'s profile").replace("{author}", mod.author)}" onclick="eel.open_url_in_browser('https://trovesaurus.com/user=${mod.author_id}')()"` : ''}>${mod.author}</span></span>
                    <div class="ts-mod-stats">
                        <span class="ts-stat-item"><i class="fa-solid fa-download"></i> ${mod.downloads}</span>
                        <span class="ts-stat-item"><i class="fa-solid fa-heart"></i> ${mod.likes}</span>
                    </div>
                    <button class="ts-install-btn ${btnClass}" 
                            data-id="${mod.id}" data-name="${mod.name}" ${btnDisabled}>
                        ${btnIcon} ${btnText}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function handleTrovesaurusInstall(e) {
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    const btn = e.target.closest('.ts-install-btn');
    if (!btn || btn.disabled) return;

    const modId = btn.getAttribute('data-id');
    const modName = btn.getAttribute('data-name');
    
    const gamePath = await getActiveGamePath();

    if (!gamePath) {
        window.showToast(t("Could not automatically detect your Trove installation folder! Please check your game install."), true);
        return;
    }

    btn.setAttribute('data-original-html', btn.innerHTML);
    
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Installing...")}`;
    btn.disabled = true;

    eel.install_trovesaurus_mod(gamePath, modId)();
}

eel.expose(receive_install_result, 'receive_install_result');
function receive_install_result(response) {
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    const btn = document.querySelector(`.ts-install-btn[data-id="${response.mod_id}"]`);
    if (!btn) return;

    if (response && response.success) {
        btn.innerHTML = `<i class="fa-solid fa-check"></i> ${t("Installed")}`;
        btn.classList.remove('update');
        btn.classList.add('installed');
        btn.disabled = true;
    } else {
        window.showToast(t("Error: {error}").replace("{error}", response?.error || t('Unknown error occurred')), true);
        const originalHTML = btn.getAttribute('data-original-html');
        if (originalHTML) btn.innerHTML = originalHTML;
        btn.disabled = false;
    }
}