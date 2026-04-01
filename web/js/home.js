document.addEventListener('home_loaded', () => {
    console.log("Home Dashboard initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    
    refreshAllData();

    const autoRefresh = setInterval(() => {
        if (document.querySelector('.home-container')) {
            refreshAllData();
        } else {
            clearInterval(autoRefresh);
        }
    }, 60000);

    if (window._homeLangListener) {
        document.removeEventListener('change', window._homeLangListener);
    }
    window._homeLangListener = (e) => {
        if (e.target && e.target.id === 'global-language-select') {
            if (document.querySelector('.home-container')) {
                setTimeout(refreshAllData, 150);
            }
        }
    };
    document.addEventListener('change', window._homeLangListener);

    function refreshAllData() {
        fetchStreams();
        fetchServerData();
        fetchEvents();
    }

    function getCountdown(timestamp, showLeft = true) {
        const now = Math.floor(Date.now() / 1000);
        const diff = timestamp - now;
        if (diff <= 0) return t("Ending now...");
        
        const days = Math.floor(diff / 86400);
        const hours = Math.floor((diff % 86400) / 3600);
        const mins = Math.floor((diff % 3600) / 60);
        
        const dStr = t("{count} days").replace("{count}", days);
        const hStr = t("{count} hours").replace("{count}", hours);
        const mStr = t("{count} minutes").replace("{count}", mins);
        
        let timeParts = [];
        
        if (days > 0) {
            timeParts.push(dStr);
            if (hours > 0) timeParts.push(hStr);
        } else if (hours > 0) {
            timeParts.push(hStr);
            if (mins > 0) timeParts.push(mStr);
        } else {
            timeParts.push(mStr);
        }

        const timeStr = timeParts.join(" ");

        if (showLeft) return t("{time} left").replace("{time}", timeStr);
        return timeStr;
    }

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
            if (daily) buffsGrid.appendChild(createBuffCard(t("Daily: {name}").replace("{name}", t(daily.name)), daily, true));
            if (weekly) buffsGrid.appendChild(createBuffCard(t("Weekly: {name}").replace("{name}", t(weekly.name)), weekly, false));
        }

        function createBuffCard(title, data, isDaily) {
            const card = document.createElement('div');
            card.className = 'buff-card hover-card'; 
            const colorHex = data.color ? `#${data.color}` : '#5ec6ff';
            card.style.setProperty('--buff-color', colorHex); 
            card.style.cursor = 'pointer';
            card.title = t("Click to see schedule");
            
            let headerBg = data.banner ? `url('${data.banner}') center/cover` : colorHex;
            let html = `<div class="buff-header" style="background: linear-gradient(to right, rgba(0,0,0,0.9) 20%, rgba(0,0,0,0.1) 100%), ${headerBg};">
                            ${data.icon ? `<img src="${data.icon}" alt="">` : ''}
                            <span>${data.emoji || ''} ${title}</span>
                        </div><div class="buff-content">`;

            if (isDaily) {
                html += `
                    <div class="buff-split-container">
                        <div class="buff-column normal-buffs">
                            <div class="buff-column-title"><i class="fa-solid fa-crown" style="opacity: 0.5;"></i> ${t("Free")}</div>
                            <ul class="buff-list">${(data.normal_buffs || data.buffs || []).map(b => `<li>${t(b)}</li>`).join('')}</ul>
                        </div>
                        <div class="buff-column patron-buffs">
                            <div class="buff-column-title"><i class="fa-solid fa-crown"></i> ${t("Patron")}</div>
                            <ul class="buff-list">${(data.premium_buffs || data.buffs || []).map(b => `<li>${t(b)}</li>`).join('')}</ul>
                        </div>
                    </div>`;
            } else {
                html += `<div style="padding: 15px;"><ul class="buff-list">${(data.buffs || []).map(b => `<li>${t(b)}</li>`).join('')}</ul></div>`;
            }
            html += `</div>`;
            card.innerHTML = html;

            card.addEventListener('click', async () => {
                const modalTitle = document.querySelector('.modal-header h3');
                modalTitle.innerHTML = `<i class="fa-solid fa-calendar-week" style="color: ${colorHex};"></i> ${t("{title} Schedule").replace("{title}", title)}`;
                const modalBody = document.getElementById('d15-modal-body');
                document.querySelector('#d15-modal .modal-content').style.maxWidth = '600px';
                
                modalBody.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Loading schedule...")}</div>`;
                if(rotationModal) rotationModal.style.display = 'flex';

                try {
                    if (isDaily) {
                        const res = await fetch('/assets/data/daily_buffs.json');
                        const scheduleData = await res.json();
                        
                        const now = new Date();
                        const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
                        const troveMs = utcMs - (11 * 3600000);
                        const troveTime = new Date(troveMs);
                        const currentDayIndex = (troveTime.getDay() + 6) % 7; 

                        let contentHtml = '';
                        for (let i = 0; i < 7; i++) {
                            const d = scheduleData[i.toString()];
                            if (!d) continue;
                            const isActive = i === currentDayIndex;
                            
                            contentHtml += `
                                <div class="modal-rotation-row" style="${isActive ? `border-left: 4px solid #${d.color}; background: rgba(255,255,255,0.05);` : ''}">
                                    <div class="modal-time-col" style="min-width: 120px;">
                                        <div style="font-weight: bold; color: ${isActive ? `#${d.color}` : '#fff'};">${t(d.weekday)}</div>
                                        ${isActive ? `<div style="font-size: 0.85em; color: #${d.color};">${t("ACTIVE TODAY")}</div>` : ''}
                                    </div>
                                    <div class="modal-biomes-col" style="flex-direction: column; align-items: flex-start; justify-content: center; gap: 4px;">
                                        <div style="font-weight: bold; color: #fff;">${d.emoji} ${t(d.name)}</div>
                                        <div style="font-size: 0.85em; color: var(--text-muted);">
                                            <ul style="margin: 0; padding-left: 15px;">
                                                ${d.normal_buffs.map(b => `<li>${t(b)}</li>`).join('')}
                                            </ul>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }
                        modalBody.innerHTML = contentHtml;

                    } else {
                        const res = await fetch('/assets/data/weekly_buffs.json');
                        const scheduleData = await res.json();
                        
                        let activeIndex = 0;
                        const weeklyKeys = Object.keys(scheduleData).sort();
                        
                        for (let k of weeklyKeys) {
                            if (scheduleData[k].name === data.name) {
                                activeIndex = parseInt(k);
                                break;
                            }
                        }

                        let contentHtml = '';
                        for (let i = 0; i < weeklyKeys.length; i++) {
                            const targetIndex = (activeIndex + i) % weeklyKeys.length;
                            const w = scheduleData[targetIndex.toString()];
                            if (!w) continue;
                            
                            const isActive = i === 0;
                            
                            contentHtml += `
                                <div class="modal-rotation-row" style="${isActive ? `border-left: 4px solid #${w.color}; background: rgba(255,255,255,0.05);` : ''}">
                                    <div class="modal-time-col" style="min-width: 120px;">
                                        <div style="font-weight: bold; color: ${isActive ? `#${w.color}` : '#fff'};">${isActive ? t('Current Week') : t("Week +{num}").replace("{num}", i)}</div>
                                        ${isActive ? `<div style="font-size: 0.85em; color: #${w.color};">${t("ACTIVE NOW")}</div>` : ''}
                                    </div>
                                    <div class="modal-biomes-col" style="flex-direction: column; align-items: flex-start; justify-content: center; gap: 4px;">
                                        <div style="font-weight: bold; color: #fff;">${w.emoji} ${t(w.name)}</div>
                                        <div style="font-size: 0.85em; color: var(--text-muted);">
                                            <ul style="margin: 0; padding-left: 15px;">
                                                ${w.buffs.map(b => `<li>${t(b)}</li>`).join('')}
                                            </ul>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }
                        modalBody.innerHTML = contentHtml;
                    }
                } catch (err) {
                    console.error(err);
                    modalBody.innerHTML = `<div style="padding: 20px; text-align: center; color: #ff5555;">${t("Failed to load schedule data.")}</div>`;
                }
            });

            return card;
        }

        function renderRotations(merchants, d15, mana, stampy, schedules) {
            if (!merchantsGrid) return;
            merchantsGrid.style.display = 'flex';
            merchantsGrid.innerHTML = '';
            
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
                card.title = t("Click to see upcoming schedule");
                
                const displayName = (conf.id === 'fluxion' && data.active) ? t("{name} ({state})").replace("{name}", conf.name).replace("{state}", t(data.state)) : conf.name;
                card.innerHTML = `
                    <div class="merchant-icon"><i class="fa-solid ${conf.icon}"></i></div>
                    <div class="merchant-info" style="width: 100%;">
                        <div class="merchant-name">${displayName} <span class="merchant-status-badge">${data.active ? t('ACTIVE') : t('AWAY')}</span></div>
                        <div class="merchant-time"><i class="fa-regular fa-clock"></i> ${t(data.action)} <b>${data.time_str}</b></div>
                    </div>`;
                
                card.addEventListener('click', () => {
                    const modalTitle = document.querySelector('.modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid ${conf.icon}" style="color: ${conf.color};"></i> ${t("Upcoming {name} Schedule").replace("{name}", conf.name)}`;
                    document.querySelector('#d15-modal .modal-content').style.maxWidth = '600px';
                    
                    if(schedules && schedules.success && schedules[conf.id]) {
                        populateMerchantModal(schedules[conf.id], conf.color);
                    } else {
                        document.getElementById('d15-modal-body').innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">${t("Schedule data unavailable.")}</div>`;
                    }
                    
                    if(rotationModal) rotationModal.style.display = 'flex';
                });

                merchantsGrid.appendChild(card);
            });

            if (stampy && stampy.success && stampy.current) {
                const nowSec = Math.floor(Date.now() / 1000);
                const isActive = nowSec >= stampy.current.start && nowSec < stampy.current.end;
                
                const card = document.createElement('div');
                card.className = `merchant-card hover-card ${isActive ? '' : 'inactive'}`; 
                const stampyColor = '#ff9800';
                card.style.setProperty('--merchant-color', stampyColor);
                card.style.cursor = 'pointer';
                card.title = t("Click to see upcoming rotations");
                
                let pills = stampy.current.biomes.map(b => 
                    `<span class="biome-pill" title="${t("Biome: {name}").replace("{name}", t(b.name))}">
                        <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="">
                        ${t(b.final_name)}
                    </span>`
                ).join('');

                const statusText = isActive ? t('ACTIVE') : t('AWAY');
                const timeText = isActive 
                    ? t("Leaves in {time}").replace("{time}", `<b>${getCountdown(stampy.current.end, false)}</b>`) 
                    : t("Arrives in {time}").replace("{time}", `<b>${getCountdown(stampy.current.start, false)}</b>`);

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
                    modalTitle.innerHTML = `<i class="fa-solid fa-paw" style="color: ${stampyColor};"></i> ${t("Upcoming Stampy Locations")}`;
                    document.querySelector('#d15-modal .modal-content').style.maxWidth = '600px';
                    populateBiomeModal(stampy.future, stampyColor, true);
                    if(rotationModal) rotationModal.style.display = 'flex';
                });

                merchantsGrid.appendChild(card);
            }

            if (d15 && d15.success && d15.current) {
                const card = document.createElement('div');
                card.className = `merchant-card hover-card`; 
                card.style.setProperty('--merchant-color', '#4caf50');
                card.style.cursor = 'pointer';
                card.title = t("Click to see upcoming rotations");
                
                let pills = d15.current.biomes.map(b => 
                    `<span class="biome-pill" title="${t("Biome: {name}").replace("{name}", t(b.name))}">
                        <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="">
                        ${t(b.final_name)}
                    </span>`
                ).join('');

                card.innerHTML = `
                    <div class="merchant-icon"><i class="fa-solid fa-leaf"></i></div>
                    <div class="merchant-info" style="width: 100%;">
                        <div class="merchant-name">D15 Biomes <span class="merchant-status-badge">${t("ACTIVE")}</span></div>
                        <div class="merchant-time"><i class="fa-regular fa-clock"></i> ${t("Ends in {time}").replace("{time}", `<b>${getCountdown(d15.current.end, false)}</b>`)}</div>
                        <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
                            ${pills}
                        </div>
                    </div>`;
                
                card.addEventListener('click', () => {
                    const modalTitle = document.querySelector('.modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid fa-leaf" style="color: #4caf50;"></i> ${t("Upcoming D15 Biomes")}`;
                    document.querySelector('#d15-modal .modal-content').style.maxWidth = '1200px';
                    populateWeeklyBiomeModal(d15.rotations, '#4caf50');
                    if(rotationModal) rotationModal.style.display = 'flex';
                });

                merchantsGrid.appendChild(card);
            }

            if (mana && mana.success && mana.current) {
                const card = document.createElement('div');
                card.className = `merchant-card hover-card`; 
                const manaColor = '#00bcd4';
                card.style.setProperty('--merchant-color', manaColor);
                card.style.cursor = 'pointer';
                card.title = t("Click to see upcoming rotations");
                
                let pills = mana.current.biomes.map(b => 
                    `<span class="biome-pill" title="${t("Biome: {name}").replace("{name}", t(b.name))}">
                        <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="">
                        ${t(b.final_name)}
                    </span>`
                ).join('');

                card.innerHTML = `
                    <div class="merchant-icon"><i class="fa-solid fa-flask"></i></div>
                    <div class="merchant-info" style="width: 100%;">
                        <div class="merchant-name">Wild Trovian Mana <span class="merchant-status-badge">${t("ACTIVE")}</span></div>
                        <div class="merchant-time"><i class="fa-regular fa-clock"></i> ${t("Ends in {time}").replace("{time}", `<b>${getCountdown(mana.current.end, false)}</b>`)}</div>
                        <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
                            ${pills}
                        </div>
                    </div>`;
                
                card.addEventListener('click', () => {
                    const modalTitle = document.querySelector('.modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid fa-flask" style="color: ${manaColor};"></i> ${t("Upcoming Wild Mana Biomes")}`;
                    document.querySelector('#d15-modal .modal-content').style.maxWidth = '600px';
                    populateBiomeModal(mana.future, manaColor);
                    if(rotationModal) rotationModal.style.display = 'flex';
                });

                merchantsGrid.appendChild(card);
            }
        }
        
        function populateBiomeModal(futureRotations, highlightColor, isArrival = false) {
            const modalBody = document.getElementById('d15-modal-body');
            if (!modalBody) return;
            
            modalBody.innerHTML = '';
            futureRotations.forEach((rot, index) => {
                const isNext = index === 0;
                
                let timeText = t("Starts in {time}").replace("{time}", getCountdown(rot.start, false));
                if (isArrival) {
                    timeText = t("Arrives in {time}").replace("{time}", getCountdown(rot.start, false));
                }
                
                let pills = rot.biomes.map(b => 
                    `<span class="biome-pill modal-pill" title="${t("Biome: {name}").replace("{name}", t(b.name))}">
                        <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="">
                        ${t(b.final_name)}
                    </span>`
                ).join('');

                const row = document.createElement('div');
                row.className = 'modal-rotation-row';
                row.innerHTML = `
                    <div class="modal-time-col" style="${isArrival ? 'min-width: 150px;' : ''}">
                        <div style="font-weight: bold; color: ${isNext ? highlightColor : '#fff'};">${isNext ? (isArrival ? t('Next Arrival') : t('Next Rotation')) : t("Rotation +{num}").replace("{num}", index + 1)}</div>
                        <div style="font-size: 0.85em; color: var(--text-muted);"><i class="fa-regular fa-clock"></i> ${timeText}</div>
                    </div>
                    <div class="modal-biomes-col">
                        ${pills}
                    </div>
                `;
                modalBody.appendChild(row);
            });
        }

        function populateWeeklyBiomeModal(rotations, highlightColor) {
            const modalBody = document.getElementById('d15-modal-body');
            if (!modalBody) return;
            
            modalBody.innerHTML = '';
            
            const grid = document.createElement('div');
            grid.className = 'weekly-schedule-grid';

            const now = new Date();
            const nowTs = now.getTime();
            const locale = window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US';

            // Create exactly 7 columns, rigidly starting from Today at 12:00 AM Local Time
            for (let i = 0; i < 7; i++) {
                // Set day bounds: 12:00 AM to 11:59:59 PM local time
                const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
                const dayStartTs = dayStart.getTime();
                const dayEndTs = dayStartTs + 86400000; // +24 hours

                const col = document.createElement('div');
                col.className = 'schedule-day-col';
                
                const header = document.createElement('div');
                header.className = 'schedule-day-header';
                header.innerText = (i === 0) ? t("Today") : dayStart.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
                col.appendChild(header);

                // Fit the rotations into this exact local 24-hour window
                const dayRots = rotations.filter(rot => {
                    return (rot.start * 1000 < dayEndTs && rot.end * 1000 > dayStartTs);
                });

                dayRots.forEach(rot => {
                    const rotStartTs = rot.start * 1000;
                    const rotEndTs = rot.end * 1000;
                    
                    const isCurrent = nowTs >= rotStartTs && nowTs < rotEndTs;
                    const hasPassed = nowTs >= rotEndTs;
                    
                    const slot = document.createElement('div');
                    slot.className = 'schedule-slot';
                    if (hasPassed && i === 0) {
                        slot.style.opacity = '0.5';
                    }
                    
                    const timeObj = new Date(rotStartTs);
                    const timeStr = timeObj.toLocaleTimeString(locale, { hour: '2-digit', minute:'2-digit' });
                    
                    let pills = rot.biomes.map(b => 
                        `<span class="biome-pill modal-pill" title="${t("Biome: {name}").replace("{name}", t(b.name))}" style="justify-content: flex-start; padding: 4px 8px; font-size: 0.8em;">
                            <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="" style="width: 14px; height: 14px;">
                            ${t(b.final_name)}
                        </span>`
                    ).join('');

                    const highlightStyle = isCurrent ? `color: ${highlightColor}; font-weight: bold;` : '';
                    const dot = isCurrent ? `<i class="fa-solid fa-circle-play" style="margin-right: 4px;"></i>` : '';

                    slot.innerHTML = `
                        <div class="schedule-time" style="${highlightStyle}">${dot}${timeStr}</div>
                        <div class="schedule-biomes">
                            ${pills}
                        </div>
                    `;
                    col.appendChild(slot);
                });
                
                grid.appendChild(col);
            }
            
            modalBody.appendChild(grid);
        }

        function populateMerchantModal(schedule, highlightColor) {
            const modalBody = document.getElementById('d15-modal-body');
            if (!modalBody) return;
            
            modalBody.innerHTML = '';
            schedule.forEach((rot, index) => {
                const isNext = index === 0;
                
                const locale = window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US';
                const startStr = new Date(rot.start * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                const endStr = new Date(rot.end * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                
                let timeText = t("Arrives in {time}").replace("{time}", getCountdown(rot.start, false));
                if (rot.start * 1000 < Date.now()) {
                    timeText = t("Leaves in {time}").replace("{time}", getCountdown(rot.end, false));
                }

                const row = document.createElement('div');
                row.className = 'modal-rotation-row';
                row.innerHTML = `
                    <div class="modal-time-col" style="min-width: 150px;">
                        <div style="font-weight: bold; color: ${isNext ? highlightColor : '#fff'};">${isNext ? t('Next Arrival') : t("Arrival +{num}").replace("{num}", index + 1)}</div>
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

    eel.expose(receive_events_data, 'receive_events_data');
    function receive_events_data(response) {
        const list = document.getElementById('events-list');
        const loading = document.getElementById('events-loading');
        
        if (loading) loading.style.display = 'none';
        if (!list) return;

        if (response && response.success) {
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
                const locale = window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US';
                const startStr = new Date(startTs * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
                const endStr = new Date(endTs * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
                
                let statusText = nowTs < startTs 
                    ? t("Starts in {time}").replace("{time}", getCountdown(startTs, false)) 
                    : (nowTs < endTs ? t("Ends in {time}").replace("{time}", getCountdown(endTs, false)) : t("Event Ended"));
                let statusColor = nowTs < startTs ? "#5ec6ff" : (nowTs < endTs ? "#ff5555" : "#a3adc2");
                
                const img = event.image || event.icon || 'https://trovesaurus.com/images/logos/Sage_64.png';
                card.innerHTML = `
                    <div class="event-image"><img src="${img}" alt=""></div>
                    <div class="event-main">
                        <div class="event-name-row"><span class="event-name">${t(event.name)}</span><span class="event-category">${t(event.category)}</span></div>
                        <div class="event-dates"><span><i class="fa-regular fa-calendar"></i> ${startStr} - ${endStr}</span>
                        <span style="margin-left: 15px; color: ${statusColor}; font-weight: bold;"><i class="fa-solid fa-hourglass-half"></i> ${statusText}</span></div>
                    </div><div class="event-link-icon"><i class="fa-solid fa-arrow-up-right-from-square"></i></div>`;
                list.appendChild(card);
            });
        } else {
            console.error("Event fetch error:", response?.error);
            list.style.display = 'flex';
            list.innerHTML = `
                <div style="text-align: center; padding: 20px; color: #ff5555; background: rgba(255, 85, 85, 0.1); border: 1px solid rgba(255, 85, 85, 0.3); border-radius: 10px; width: 100%;">
                    <i class="fa-solid fa-triangle-exclamation" style="font-size: 24px; margin-bottom: 10px; display: block;"></i>
                    <span style="font-size: 14px;">${t("Failed to fetch events from Trovesaurus.")}</span>
                </div>
            `;
        }
    }

    function fetchEvents() {
        eel.get_trovesaurus_events()();
    }

    eel.expose(receive_twitch_streams, 'receive_twitch_streams');
    function receive_twitch_streams(response) {
        const wrapper = document.getElementById('carousel-wrapper');
        const carousel = document.getElementById('streams-carousel');
        const loading = document.getElementById('streams-loading');
        const btnLeft = document.getElementById('btn-scroll-left');
        const btnRight = document.getElementById('btn-scroll-right');
        
        if (loading) loading.style.display = 'none';
        if (wrapper) wrapper.style.display = 'flex';
        if (!carousel) return;
        
        carousel.innerHTML = '';

        if (response && response.success) {
            if (!response.data || response.data.length === 0) {
                carousel.innerHTML = `
                    <div style="width: 100%; text-align: center; padding: 30px; color: var(--text-muted);">
                        <i class="fa-brands fa-twitch" style="font-size: 32px; opacity: 0.4; margin-bottom: 15px; display: block;"></i>
                        <span style="font-size: 14px;">${t("No Trove streams are live right now. Check back later!")}</span>
                    </div>
                `;
                if (btnLeft) btnLeft.style.display = 'none';
                if (btnRight) btnRight.style.display = 'none';
                return;
            }

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
        } else {
            console.error("Stream fetch error:", response?.error);
        }
    }

    function fetchStreams() {
        eel.get_twitch_streams()();
    }
});