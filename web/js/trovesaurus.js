// Global State for Trovesaurus
let ts_currentPage = 1;
let ts_isLoading = false;

// LISTEN for the event from main.js
document.addEventListener('trovesaurus_loaded', () => {
    console.log("Trovesaurus Logic: Hooking into UI...");

    const searchBtn = document.getElementById('btn-ts-search');
    const searchInput = document.getElementById('ts-search-input');
    const categorySelect = document.getElementById('ts-category-select');
    const sortSelect = document.getElementById('ts-sort-select');
    const prevBtn = document.getElementById('btn-ts-prev');
    const nextBtn = document.getElementById('btn-ts-next');

    // Attach Listeners
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

    // Delegate Install Clicks (Handle dynamically created cards)
    const modGrid = document.getElementById('ts-mod-grid');
    const imageModal = document.getElementById('image-modal');
    const modalImg = document.getElementById('expanded-img');
    const modalCaption = document.getElementById('modal-caption');

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

    // Modal Closing
    if (imageModal) {
        imageModal.addEventListener('click', (e) => {
            if (e.target === imageModal || e.target.classList.contains('close-modal')) {
                imageModal.classList.remove('active');
                setTimeout(() => { modalImg.src = ""; }, 200); 
            }
        });
    }

    // Auto-load first page
    fetchTrovesaurusMods(1);
});

// --- CORE FUNCTIONS ---

async function getActiveGamePath() {
    const tsSelect = document.getElementById('ts-game-select');
    
    // If we've already populated the dropdown, just return the user's current selection
    if (tsSelect && tsSelect.getAttribute('data-loaded')) {
        return tsSelect.value;
    }

    const response = await eel.get_detected_game_paths()();
    if (response.success && response.paths.length > 0) {
        if (tsSelect) {
            tsSelect.innerHTML = response.paths.map(p => 
                `<option value="${p.path}" ${p.name.toLowerCase().includes('live') ? 'selected' : ''}>${p.name}</option>`
            ).join('');
            tsSelect.setAttribute('data-loaded', 'true');
            return tsSelect.value;
        }
        const liveInstall = response.paths.find(p => p.name.toLowerCase().includes('live'));
        return liveInstall ? liveInstall.path : response.paths[0].path;
    }
    if (tsSelect) tsSelect.innerHTML = '<option value="">No installations found</option>';
    return null;
}

async function fetchTrovesaurusMods(page = 1) {
    if (ts_isLoading) return;
    
    const grid = document.getElementById('ts-mod-grid');
    const searchInput = document.getElementById('ts-search-input');
    const catSelect = document.getElementById('ts-category-select');
    const sortSelect = document.getElementById('ts-sort-select');
    const prevBtn = document.getElementById('btn-ts-prev');
    const nextBtn = document.getElementById('btn-ts-next');
    const pageDisplay = document.getElementById('ts-page-display');

    if (!grid) return;

    ts_isLoading = true;
    grid.innerHTML = `<div class="placeholder-box"><i class="fa-solid fa-spinner fa-spin"></i> Browsing Trovesaurus...</div>`;

    const query = searchInput ? searchInput.value.trim() : "";
    const category = catSelect ? catSelect.value : "";
    const sort = sortSelect ? sortSelect.value : "hot";
    
    const gamePath = await getActiveGamePath() || "";

    try {
        const response = await eel.get_trovesaurus_mods(page, query, category, sort, gamePath)();
        
        if (response.success) {
            ts_currentPage = response.page;
            renderTrovesaurusGrid(response.mods, grid);
            
            if (pageDisplay) pageDisplay.innerText = `Page ${ts_currentPage} of ${response.max_pages}`;
            if (prevBtn) prevBtn.disabled = ts_currentPage <= 1;
            if (nextBtn) nextBtn.disabled = ts_currentPage >= response.max_pages;
        } else {
            grid.innerHTML = `<div class="placeholder-box" style="color: #ff5555;">API Error: ${response.error}</div>`;
        }
    } catch (err) {
        console.error("Trovesaurus fetch error:", err);
        grid.innerHTML = `<div class="placeholder-box" style="color: #ff5555;">Eel Error: ${err.message || err}</div>`;
    }

    ts_isLoading = false;
}

function renderTrovesaurusGrid(mods, container) {
    if (!mods || mods.length === 0) {
        container.innerHTML = `<div class="placeholder-box">No mods found matching your search.</div>`;
        return;
    }

    container.innerHTML = mods.map(mod => {
        const isInstalled = mod.is_installed;
        const needsUpdate = mod.needs_update;
        const img = mod.image || 'https://trovesaurus.com/images/logos/Sage_64.png';
        
        let btnClass = '';
        let btnIcon = '<i class="fa-solid fa-download"></i>';
        let btnText = 'Install';
        let btnDisabled = '';

        if (needsUpdate) {
            btnClass = 'update';
            btnIcon = '<i class="fa-solid fa-rotate"></i>'; // Update icon
            btnText = 'Update';
        } else if (isInstalled) {
            btnClass = 'installed';
            btnIcon = '<i class="fa-solid fa-check"></i>';
            btnText = 'Installed';
            btnDisabled = 'disabled';
        }
        
        return `
            <div class="ts-mod-card">
                <div class="mod-image-container">
                    <img src="${img}" class="mod-preview-img" loading="lazy" onerror="this.src='https://trovesaurus.com/images/logos/Sage_64.png'">
                </div>
                <div class="mod-card-content">
                    <h3 class="mod-title ts-mod-title" title="${mod.name} (Click to view on Trovesaurus)" onclick="eel.open_url_in_browser('https://trovesaurus.com/mod=${mod.id}')()">${mod.name}</h3>
                    <span class="mod-meta">mod<span class="${mod.author_id ? 'ts-mod-author' : ''}" ${mod.author_id ? `title="View ${mod.author}'s profile" onclick="eel.open_url_in_browser('https://trovesaurus.com/user=${mod.author_id}')()"` : ''}>${mod.author}</span></span>
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
    const btn = e.target.closest('.ts-install-btn');
    if (!btn || btn.disabled) return;

    const modId = btn.getAttribute('data-id');
    const modName = btn.getAttribute('data-name');
    
    const gamePath = await getActiveGamePath();

    if (!gamePath) {
        alert("Could not automatically detect your Trove installation folder! Please check your game install.");
        return;
    }

    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Installing...`;
    btn.disabled = true;

    try {
        const response = await eel.install_trovesaurus_mod(gamePath, modId)();

        if (response.success) {
            btn.innerHTML = `<i class="fa-solid fa-check"></i> Installed`;
            btn.classList.remove('update');
            btn.classList.add('installed');
            btn.disabled = true;
        } else {
            alert(`Error: ${response.error}`);
            btn.innerHTML = originalHTML;
            btn.disabled = false;
        }
    } catch (err) {
        console.error("Trovesaurus install error:", err);
        alert(`Eel Error: ${err.message || err}`);
        btn.innerHTML = originalHTML;
        btn.disabled = false;
    }
}