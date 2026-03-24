document.addEventListener('home_loaded', () => {
    console.log("Home Dashboard initialized!");
    
    refreshAllData();

    const autoRefresh = setInterval(() => {
        if (document.querySelector('.home-container')) {
            refreshAllData();
        } else {
            clearInterval(autoRefresh);
        }
    }, 60000);

    function refreshAllData() {
        fetchStreams();
        fetchServerData();
        fetchEvents();
    }

    function getCountdown(timestamp) {
        const now = Math.floor(Date.now() / 1000);
        const diff = timestamp - now;
        if (diff <= 0) return "Ending now...";
        const days = Math.floor(diff / 86400);
        const hours = Math.floor((diff % 86400) / 3600);
        const mins = Math.floor((diff % 3600) / 60);
        if (days > 0) return `${days}d ${hours}h left`;
        if (hours > 0) return `${hours}h ${mins}m left`;
        return `${mins}m left`;
    }

    // Modal Logic
    const rotationModal = document.getElementById('d15-modal');
    const closeBtn = document.getElementById('modal-close-btn');

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            rotationModal.style.display = 'none';
        });
    }

    window.addEventListener('click', (event) => {
        if (event.target === rotationModal) {
            rotationModal.style.display = 'none';
        }
    });

    async function fetchServerData() {
        const buffsGrid = document.getElementById('buffs-grid');
        const merchantsGrid = document.getElementById('merchants-grid');
        const loading = document.getElementById('buffs-loading');
        
        try {
            const [serverData, d15Data, manaData, merchantSchedules, stampyData] = await Promise.all([
                eel.get_current_server_data()(),
                eel.get_d15_rotation()(),
                eel.get_wild_mana_rotation()(),
                eel.get_merchant_schedules()(),
                eel.get_stampy_rotation()()
            ]);

            if (loading) loading.style.display = 'none';

            if (serverData && serverData.success) {
                renderBuffs(serverData.daily, serverData.weekly);
                renderRotations(serverData.merchants, d15Data, manaData, stampyData, merchantSchedules);
            }
        } catch (e) { console.error(e); }

        function renderBuffs(daily, weekly) {
            if (!buffsGrid) return;
            buffsGrid.style.display = 'grid';
            buffsGrid.innerHTML = '';
            if (daily) buffsGrid.appendChild(createBuffCard("Daily: " + daily.name, daily, true));
            if (weekly) buffsGrid.appendChild(createBuffCard("Weekly: " + weekly.name, weekly, false));
        }

        function createBuffCard(title, data, isDaily) {
            const card = document.createElement('div');
            card.className = 'buff-card';
            const colorHex = data.color ? `#${data.color}` : '#5ec6ff';
            card.style.setProperty('--buff-color', colorHex); 
            let headerBg = data.banner ? `url('${data.banner}') center/cover` : colorHex;
            let html = `<div class="buff-header" style="background: linear-gradient(to right, rgba(0,0,0,0.9) 20%, rgba(0,0,0,0.1) 100%), ${headerBg};">
                            ${data.icon ? `<img src="${data.icon}" alt="">` : ''}
                            <span>${data.emoji || ''} ${title}</span>
                        </div><div class="buff-content">`;

            if (isDaily) {
                html += `
                    <div class="buff-split-container">
                        <div class="buff-column normal-buffs">
                            <div class="buff-column-title"><i class="fa-solid fa-crown" style="opacity: 0.5;"></i> Free</div>
                            <ul class="buff-list">${(data.normal_buffs || data.buffs || []).map(b => `<li>${b}</li>`).join('')}</ul>
                        </div>
                        <div class="buff-column patron-buffs">
                            <div class="buff-column-title"><i class="fa-solid fa-crown"></i> Patron</div>
                            <ul class="buff-list">${(data.premium_buffs || data.buffs || []).map(b => `<li>${b}</li>`).join('')}</ul>
                        </div>
                    </div>`;
            } else {
                html += `<div style="padding: 15px;"><ul class="buff-list">${(data.buffs || []).map(b => `<li>${b}</li>`).join('')}</ul></div>`;
            }
            html += `</div>`;
            card.innerHTML = html;
            return card;
        }

        function renderRotations(merchants, d15, mana, stampy, schedules) {
            if (!merchantsGrid) return;
            merchantsGrid.style.display = 'flex';
            merchantsGrid.innerHTML = '';
            
            // 1. Render Dragons
            const configs = [
                { id: 'luxion', name: 'Luxion', color: '#fbc02d', icon: 'fa-dragon' },
                { id: 'corruxion', name: 'Corruxion', color: '#9c27b0', icon: 'fa-dragon' },
                { id: 'fluxion', name: 'Fluxion', color: '#4fc3f7', icon: 'fa-scale-balanced' }
            ];
            
            configs.forEach(conf => {
                const data = merchants[conf.id];
                if (!data) return;
                const card = document.createElement('div');
                card.className = `merchant-card hover-card ${data.active ? '' : 'inactive'}`;
                card.style.setProperty('--merchant-color', conf.color);
                card.style.cursor = 'pointer';
                card.title = "Click to see upcoming schedule";
                
                const displayName = (conf.id === 'fluxion' && data.active) ? `${conf.name} (${data.state})` : conf.name;
                card.innerHTML = `
                    <div class="merchant-icon"><i class="fa-solid ${conf.icon}"></i></div>
                    <div class="merchant-info" style="width: 100%;">
                        <div class="merchant-name">${displayName} <span class="merchant-status-badge">${data.active ? 'ACTIVE' : 'AWAY'}</span></div>
                        <div class="merchant-time"><i class="fa-regular fa-clock"></i> ${data.action} <b>${data.time_str}</b></div>
                    </div>`;
                
                card.addEventListener('click', () => {
                    const modalTitle = document.querySelector('.modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid ${conf.icon}" style="color: ${conf.color};"></i> Upcoming ${conf.name} Schedule`;
                    
                    if(schedules && schedules.success && schedules[conf.id]) {
                        populateMerchantModal(schedules[conf.id], conf.color);
                    } else {
                        document.getElementById('d15-modal-body').innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">Schedule data unavailable.</div>';
                    }
                    
                    if(rotationModal) rotationModal.style.display = 'flex';
                });

                merchantsGrid.appendChild(card);
            });

            // 2. Render Stampy
            if (stampy && stampy.success && stampy.current) {
                const nowSec = Math.floor(Date.now() / 1000);
                const isActive = nowSec >= stampy.current.start && nowSec < stampy.current.end;
                
                const card = document.createElement('div');
                card.className = `merchant-card hover-card ${isActive ? '' : 'inactive'}`; 
                const stampyColor = '#ff9800'; 
                card.style.setProperty('--merchant-color', stampyColor); 
                card.style.cursor = 'pointer';
                card.title = "Click to see upcoming rotations";
                
                let pills = stampy.current.biomes.map(b => 
                    `<span class="biome-pill" title="Biome: ${b.name}">
                        <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="">
                        ${b.final_name}
                    </span>`
                ).join('');

                const statusText = isActive ? 'ACTIVE' : 'AWAY';
                const timeText = isActive ? `Leaves in <b>${getCountdown(stampy.current.end).replace(' left', '')}</b>` : `Arrives in <b>${getCountdown(stampy.current.start).replace(' left', '')}</b>`;

                card.innerHTML = `
                    <div class="merchant-icon"><i class="fa-solid fa-paw"></i></div>
                    <div class="merchant-info" style="width: 100%;">
                        <div class="merchant-name">Stampy <span class="merchant-status-badge">${statusText}</span></div>
                        <div class="merchant-time"><i class="fa-regular fa-clock"></i> ${timeText}</div>
                        <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
                            ${pills}
                        </div>
                    </div>`;
                
                card.addEventListener('click', () => {
                    const modalTitle = document.querySelector('.modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid fa-paw" style="color: ${stampyColor};"></i> Upcoming Stampy Locations`;
                    populateBiomeModal(stampy.future, stampyColor, true); // true = format as arrival/departure
                    if(rotationModal) rotationModal.style.display = 'flex';
                });

                merchantsGrid.appendChild(card);
            }

            // 3. Render D15 Biomes
            if (d15 && d15.success && d15.current) {
                const card = document.createElement('div');
                card.className = `merchant-card hover-card`; 
                card.style.setProperty('--merchant-color', '#4caf50'); 
                card.style.cursor = 'pointer';
                card.title = "Click to see upcoming rotations";
                
                let pills = d15.current.biomes.map(b => 
                    `<span class="biome-pill" title="Biome: ${b.name}">
                        <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="">
                        ${b.final_name}
                    </span>`
                ).join('');

                card.innerHTML = `
                    <div class="merchant-icon"><i class="fa-solid fa-leaf"></i></div>
                    <div class="merchant-info" style="width: 100%;">
                        <div class="merchant-name">D15 Biomes <span class="merchant-status-badge">ACTIVE</span></div>
                        <div class="merchant-time"><i class="fa-regular fa-clock"></i> Ends in <b>${getCountdown(d15.current.end).replace(' left', '')}</b></div>
                        <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
                            ${pills}
                        </div>
                    </div>`;
                
                card.addEventListener('click', () => {
                    const modalTitle = document.querySelector('.modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid fa-leaf" style="color: #4caf50;"></i> Upcoming D15 Biomes`;
                    populateBiomeModal(d15.future, '#4caf50');
                    if(rotationModal) rotationModal.style.display = 'flex';
                });

                merchantsGrid.appendChild(card);
            }

            // 4. Render Wild Trovian Mana Biomes
            if (mana && mana.success && mana.current) {
                const card = document.createElement('div');
                card.className = `merchant-card hover-card`; 
                const manaColor = '#00bcd4'; 
                card.style.setProperty('--merchant-color', manaColor); 
                card.style.cursor = 'pointer';
                card.title = "Click to see upcoming rotations";
                
                let pills = mana.current.biomes.map(b => 
                    `<span class="biome-pill" title="Biome: ${b.name}">
                        <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="">
                        ${b.final_name}
                    </span>`
                ).join('');

                card.innerHTML = `
                    <div class="merchant-icon"><i class="fa-solid fa-flask"></i></div>
                    <div class="merchant-info" style="width: 100%;">
                        <div class="merchant-name">Wild Trovian Mana <span class="merchant-status-badge">ACTIVE</span></div>
                        <div class="merchant-time"><i class="fa-regular fa-clock"></i> Ends in <b>${getCountdown(mana.current.end).replace(' left', '')}</b></div>
                        <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
                            ${pills}
                        </div>
                    </div>`;
                
                card.addEventListener('click', () => {
                    const modalTitle = document.querySelector('.modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid fa-flask" style="color: ${manaColor};"></i> Upcoming Wild Mana Biomes`;
                    populateBiomeModal(mana.future, manaColor);
                    if(rotationModal) rotationModal.style.display = 'flex';
                });

                merchantsGrid.appendChild(card);
            }
        }
        
        // Modal Formatter for Biomes (Includes icons)
        function populateBiomeModal(futureRotations, highlightColor, isArrival = false) {
            const modalBody = document.getElementById('d15-modal-body');
            if (!modalBody) return;
            
            modalBody.innerHTML = '';
            futureRotations.forEach((rot, index) => {
                const isNext = index === 0;
                
                let timeText = `Starts in ${getCountdown(rot.start).replace(' left', '')}`;
                if (isArrival) {
                    timeText = `Arrives in ${getCountdown(rot.start).replace(' left', '')}`;
                }
                
                let pills = rot.biomes.map(b => 
                    `<span class="biome-pill modal-pill" title="Biome: ${b.name}">
                        <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="">
                        ${b.final_name}
                    </span>`
                ).join('');

                const row = document.createElement('div');
                row.className = 'modal-rotation-row';
                row.innerHTML = `
                    <div class="modal-time-col" style="${isArrival ? 'min-width: 150px;' : ''}">
                        <div style="font-weight: bold; color: ${isNext ? highlightColor : '#fff'};">${isNext ? (isArrival ? 'Next Arrival' : 'Next Rotation') : `Rotation +${index + 1}`}</div>
                        <div style="font-size: 0.85em; color: var(--text-muted);"><i class="fa-regular fa-clock"></i> ${timeText}</div>
                    </div>
                    <div class="modal-biomes-col">
                        ${pills}
                    </div>
                `;
                modalBody.appendChild(row);
            });
        }

        // Modal Formatter specifically for Dragons
        function populateMerchantModal(schedule, highlightColor) {
            const modalBody = document.getElementById('d15-modal-body');
            if (!modalBody) return;
            
            modalBody.innerHTML = '';
            schedule.forEach((rot, index) => {
                const isNext = index === 0;
                
                const startStr = new Date(rot.start * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                const endStr = new Date(rot.end * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                
                let timeText = `Arrives in ${getCountdown(rot.start).replace(' left', '')}`;
                if (rot.start * 1000 < Date.now()) {
                    timeText = `Leaves in ${getCountdown(rot.end).replace(' left', '')}`;
                }

                const row = document.createElement('div');
                row.className = 'modal-rotation-row';
                row.innerHTML = `
                    <div class="modal-time-col" style="min-width: 150px;">
                        <div style="font-weight: bold; color: ${isNext ? highlightColor : '#fff'};">${isNext ? 'Next Arrival' : `Arrival +${index + 1}`}</div>
                        <div style="font-size: 0.85em; color: var(--text-muted);"><i class="fa-regular fa-clock"></i> ${timeText}</div>
                    </div>
                    <div class="modal-biomes-col" style="flex-direction: column; justify-content: center; gap: 4px;">
                        <div style="font-size: 0.9em; color: #eee;"><i class="fa-solid fa-plane-arrival"></i> ${startStr}</div>
                        <div style="font-size: 0.9em; color: #a3adc2;"><i class="fa-solid fa-plane-departure"></i> ${endStr}</div>
                    </div>
                `;
                modalBody.appendChild(row);
            });
        }
    }

    async function fetchEvents() {
        const list = document.getElementById('events-list');
        const loading = document.getElementById('events-loading');
        try {
            const response = await eel.get_trovesaurus_events()();
            if (response && response.success) {
                if (loading) loading.style.display = 'none';
                if (!list) return;
                list.style.display = 'flex';
                list.innerHTML = '';
                response.data.forEach(event => {
                    const card = document.createElement('div');
                    card.className = 'event-card';
                    card.style.cursor = 'pointer'; 
                    
                    card.onclick = () => {
                        eel.open_url_in_browser(event.url)();
                    };

                    const startTs = parseInt(event.startdate), endTs = parseInt(event.enddate), nowTs = Math.floor(Date.now() / 1000);
                    const startStr = new Date(startTs * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                    const endStr = new Date(endTs * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                    let statusText = nowTs < startTs ? `Starts in ${getCountdown(startTs)}` : (nowTs < endTs ? `Ends in ${getCountdown(endTs)}` : "Event Ended");
                    let statusColor = nowTs < startTs ? "#5ec6ff" : (nowTs < endTs ? "#ff5555" : "#a3adc2");
                    const img = event.image || event.icon || 'https://trovesaurus.com/images/logos/Sage_64.png';
                    card.innerHTML = `
                        <div class="event-image"><img src="${img}" alt=""></div>
                        <div class="event-main">
                            <div class="event-name-row"><span class="event-name">${event.name}</span><span class="event-category">${event.category}</span></div>
                            <div class="event-dates"><span><i class="fa-regular fa-calendar"></i> ${startStr} - ${endStr}</span>
                            <span style="margin-left: 15px; color: ${statusColor}; font-weight: bold;"><i class="fa-solid fa-hourglass-half"></i> ${statusText}</span></div>
                        </div><div class="event-link-icon"><i class="fa-solid fa-arrow-up-right-from-square"></i></div>`;
                    list.appendChild(card);
                });
            }
        } catch (e) { console.error(e); }
    }

    async function fetchStreams() {
        const wrapper = document.getElementById('carousel-wrapper'), carousel = document.getElementById('streams-carousel'), loading = document.getElementById('streams-loading');
        const btnLeft = document.getElementById('btn-scroll-left'), btnRight = document.getElementById('btn-scroll-right');
        
        try {
            const response = await eel.get_twitch_streams()();
            if (response && response.success) {
                if (loading) loading.style.display = 'none';
                if (wrapper) wrapper.style.display = 'flex';
                if (!carousel) return;
                carousel.innerHTML = '';
                
                // Handle the scenario where no streams are live
                if (!response.data || response.data.length === 0) {
                    carousel.innerHTML = `
                        <div style="width: 100%; text-align: center; padding: 30px; color: var(--text-muted);">
                            <i class="fa-brands fa-twitch" style="font-size: 32px; opacity: 0.4; margin-bottom: 15px; display: block;"></i>
                            <span style="font-size: 14px;">No Trove streams are live right now. Check back later!</span>
                        </div>
                    `;
                    // Hide the scroll buttons since there is nothing to scroll
                    if (btnLeft) btnLeft.style.display = 'none';
                    if (btnRight) btnRight.style.display = 'none';
                    return;
                }

                // If streams exist, ensure buttons are visible
                if (btnLeft) btnLeft.style.display = 'flex';
                if (btnRight) btnRight.style.display = 'flex';

                response.data.sort((a, b) => b.viewer_count - a.viewer_count).forEach(stream => {
                    const card = document.createElement('div');
                    card.className = 'stream-card'; 
                    card.style.cursor = 'pointer';
                    
                    card.onclick = () => {
                        eel.open_url_in_browser(`https://twitch.tv/${stream.user_login}`)();
                    };

                    const thumb = stream.thumbnail_url.replace('{width}', '440').replace('{height}', '248');
                    card.innerHTML = `<div class="stream-thumb"><img src="${thumb}" alt=""><div class="stream-badges"><span class="badge viewers">🔴 ${stream.viewer_count.toLocaleString()}</span></div></div>
                                      <div class="stream-info"><div class="stream-title">${stream.title}</div><div class="stream-user"><i class="fa-brands fa-twitch" style="color:#9146FF;"></i> ${stream.user_name}</div></div>`;
                    carousel.appendChild(card);
                });
                
                if (btnLeft && btnRight) {
                    btnLeft.onclick = () => carousel.scrollBy({ left: -260, behavior: 'smooth' });
                    btnRight.onclick = () => carousel.scrollBy({ left: 260, behavior: 'smooth' });
                }
            }
        } catch (e) { console.error(e); }
    }
});