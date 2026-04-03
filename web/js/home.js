document.addEventListener('home_loaded', () => {
    console.log("Home Dashboard initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    
    let _currentMediaLocale = null;

    const mediaTabs = document.querySelectorAll('.media-tab');
    const youtubeCarousel = document.getElementById('youtube-carousel');
    const twitchCarousel = document.getElementById('streams-carousel');
    const bilibiliCarousel = document.getElementById('bilibili-carousel');
    const scrollLeftBtn = document.getElementById('btn-scroll-left');
    const scrollRightBtn = document.getElementById('btn-scroll-right');

    mediaTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            mediaTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const activeTab = tab.dataset.tab;
            
            if (youtubeCarousel) youtubeCarousel.style.display = 'none';
            if (twitchCarousel) twitchCarousel.style.display = 'none';
            if (bilibiliCarousel) bilibiliCarousel.style.display = 'none';
            
            if (activeTab === 'youtube' && youtubeCarousel) {
                youtubeCarousel.style.display = 'flex';
                youtubeCarousel.scrollLeft = 0;
            } else if (activeTab === 'bilibili' && bilibiliCarousel) {
                bilibiliCarousel.style.display = 'flex';
                bilibiliCarousel.scrollLeft = 0;
            } else if (twitchCarousel) {
                twitchCarousel.style.display = 'flex';
                twitchCarousel.scrollLeft = 0;
            }
        });
    });

    if (scrollLeftBtn && scrollRightBtn) {
        scrollLeftBtn.onclick = () => document.querySelector('.streams-carousel:not([style*="display: none"])')?.scrollBy({ left: -260, behavior: 'smooth' });
        scrollRightBtn.onclick = () => document.querySelector('.streams-carousel:not([style*="display: none"])')?.scrollBy({ left: 260, behavior: 'smooth' });
    }

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
        const isChinese = window.I18nManager && window.I18nManager.currentLocale === 'zh_CN';
        const currentLocale = window.I18nManager ? window.I18nManager.currentLocale : null;
        const localeChanged = _currentMediaLocale !== currentLocale;
        _currentMediaLocale = currentLocale;

        const bilibiliTab = document.querySelector('.media-tab[data-tab="bilibili"]');
        if (bilibiliTab) {
            bilibiliTab.style.display = isChinese ? 'flex' : 'none';
            if (isChinese && localeChanged) {
                bilibiliTab.click();
            } else if (!isChinese && bilibiliTab.classList.contains('active')) {
                document.querySelector('.media-tab[data-tab="youtube"]')?.click();
            }
        }

        fetchYoutubeVideos();
        fetchStreams();
        if (isChinese) {
            fetchBilibiliVideos();
        }
        fetchServerData();
        fetchEvents();
    }

    function getTimeAgo(dateString, t) {
        const date = new Date(dateString);
        const now = new Date();
        const diffTime = Math.abs(now - date);
        const diffSeconds = Math.floor(diffTime / 1000);
        const diffMinutes = Math.floor(diffSeconds / 60);
        const diffHours = Math.floor(diffMinutes / 60);
        const diffDays = Math.floor(diffHours / 24);
    
        if (diffDays > 7) {
            return date.toLocaleDateString(window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US', { month: 'short', day: 'numeric' });
        }
        if (diffDays > 0) {
            return t('{count} days ago').replace('{count}', diffDays);
        }
        if (diffHours > 0) {
            return t('{count} hours ago').replace('{count}', diffHours);
        }
        if (diffMinutes > 0) {
            return t('{count} minutes ago').replace('{count}', diffMinutes);
        }
        return t('Just now');
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

    const yearlyCalendarModal = document.getElementById('yearly-calendar-modal');
    const yearlyCloseBtn = document.getElementById('yearly-modal-close-btn');
    const openCalendarBtn = document.getElementById('btn-open-yearly-calendar');

    if (yearlyCloseBtn) {
        yearlyCloseBtn.addEventListener('click', () => {
            yearlyCalendarModal.style.display = 'none';
        });
    }

    if (openCalendarBtn) {
        openCalendarBtn.addEventListener('click', () => {
            yearlyCalendarModal.style.display = 'flex';
            loadYearlyCalendar();
        });
    }
    
    window.addEventListener('click', (event) => {
        if (event.target === rotationModal) {
            rotationModal.style.display = 'none';
        }
        if (yearlyCalendarModal && event.target === yearlyCalendarModal) {
            yearlyCalendarModal.style.display = 'none';
        }
    });

    async function loadYearlyCalendar() {
        const modalBody = document.getElementById('yearly-calendar-body');
        if (!modalBody) return;
        
        modalBody.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Calculating predictions...")}</div>`;
        
        try {
            const res = await eel.get_yearly_calendar_data()();
            if (!res || !res.success) {
                modalBody.innerHTML = `<div style="padding: 40px; text-align: center; color: #ff5555;">${t("Error loading calendar data.")}</div>`;
                return;
            }

            const events = res.events;
            const now = new Date();
            
            const startTs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 365).getTime();
            
            const totalDays = 730;
            const dayWidth = 40; // px
            const labelWidth = 140; // px
            const totalWidth = labelWidth + (totalDays * dayWidth);
            
            let html = `<div class="calendar-timeline-wrapper" id="timeline-wrapper">`;
            
            const todayPx = ((now.getTime() - startTs) / 86400000) * dayWidth;
            html += `<div class="calendar-today-line" style="left: ${todayPx + labelWidth}px;"></div>`;
            
            html += `<div class="calendar-timeline-header" style="width: ${totalWidth}px; flex-direction: column;">`;
            
            let monthsHtml = `<div class="calendar-months-row" style="display: flex; border-bottom: 1px solid rgba(255,255,255,0.05); background: rgba(0,0,0,0.2);">`;
            monthsHtml += `<div class="calendar-track-label" style="min-width: ${labelWidth}px; width: ${labelWidth}px; border-bottom: none; box-shadow: none; border-right: 1px solid var(--border-color); background: var(--bg-panel); z-index: 7;"></div>`;
            
            let daysHtml = `<div class="calendar-days-row" style="display: flex;">`;
            daysHtml += `<div class="calendar-track-label" style="min-width: ${labelWidth}px; width: ${labelWidth}px; border-bottom: none; box-shadow: none; border-right: 1px solid var(--border-color); background: var(--bg-panel); z-index: 7;"></div>`;
            
            let currentMonthKey = null;
            let currentMonthDays = 0;
            let currentMonthName = "";
            let currentYear = "";

            for(let i=0; i<totalDays; i++) {
                const d = new Date(startTs + (i * 86400000));
                const monthKey = d.getFullYear() + "-" + d.getMonth();
                const monthLongStr = window.I18nManager ? d.toLocaleDateString(window.I18nManager.currentLocale.replace("_", "-"), { month: 'long' }) : d.toLocaleDateString(undefined, { month: 'long' });
                
                if (monthKey !== currentMonthKey) {
                    if (currentMonthKey !== null) {
                        monthsHtml += `<div class="calendar-month-col" style="width: ${currentMonthDays * dayWidth}px;"><div class="calendar-month-label" style="left: ${labelWidth}px;">${currentMonthName} ${currentYear}</div></div>`;
                    }
                    currentMonthKey = monthKey;
                    currentMonthDays = 0;
                    currentMonthName = monthLongStr;
                    currentYear = d.getFullYear();
                }
                currentMonthDays++;

                const isToday = (i === 365) ? 'is-today' : '';
                const dayNum = d.getDate();
                const weekdayStr = window.I18nManager ? d.toLocaleDateString(window.I18nManager.currentLocale.replace("_", "-"), { weekday: 'short' }) : d.toLocaleDateString(undefined, { weekday: 'short' });
                
                daysHtml += `
                    <div class="calendar-day-col ${isToday}" id="day-col-${i}">
                        <div class="calendar-day-weekday">${weekdayStr}</div>
                        <div class="calendar-day-num">${dayNum}</div>
                    </div>
                `;
            }
            if (currentMonthDays > 0) {
                monthsHtml += `<div class="calendar-month-col" style="width: ${currentMonthDays * dayWidth}px;"><div class="calendar-month-label" style="left: ${labelWidth}px;">${currentMonthName} ${currentYear}</div></div>`;
            }
            monthsHtml += `</div>`;
            daysHtml += `</div>`;
            
            html += monthsHtml + daysHtml + `</div>`; 
            
            html += `<div class="calendar-tracks" style="width: ${totalWidth}px;">`;
            
            const tracks = [
                { id: 'weekly_buff', name: 'Weekly Buffs', color: 'weekly', icon: 'fa-bolt' },
                { id: 'dragon_merchants', types: ['luxion', 'corruxion', 'fluxion'], name: 'Dragon Merchants', color: 'luxion', icon: 'fa-dragon' },
                // { id: 'invasion', name: "Luxion's Fast Trials", color: 'invasion', icon: 'fa-meteor' },
                { id: 'gardening_2', name: '2-day plants', color: 'gardening', icon: 'fa-seedling' },
                { id: 'gardening_3', name: '3-day plants', color: 'gardening', icon: 'fa-seedling' },
                { id: 'mana', name: 'Wild Mana', color: 'mana', icon: 'fa-flask' },
                { id: 'stampy', name: 'Stampy', color: 'stampy', icon: 'fa-paw' }
            ];

            const locale = window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US';

            tracks.forEach(track => {
                html += `<div class="calendar-track" style="width: 100%;">
                            <div class="calendar-track-label" style="min-width: ${labelWidth}px; width: ${labelWidth}px;">
                                <i class="fa-solid ${track.icon}" style="margin-right: 8px; opacity: 0.8;"></i> ${t(track.name)}
                            </div>`;
                
                const trackEvents = events.filter(e => track.types ? track.types.includes(e.type) : e.type === track.id);
                trackEvents.forEach(ev => {
                    const eStartTs = ev.start * 1000;
                    const eEndTs = ev.end * 1000;
                    
                    let leftPx = ((eStartTs - startTs) / 86400000) * dayWidth;
                    let widthPx = ((eEndTs - eStartTs) / 86400000) * dayWidth;
                    
                    if (leftPx + widthPx > 0 && leftPx < totalDays * dayWidth) {
                        if (leftPx < 0) { widthPx += leftPx; leftPx = 0; }
                        
                        const startStr = new Date(eStartTs).toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                        const endStr = new Date(eEndTs).toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                        
                        let customStyle = "";
                        if (ev.color) {
                            const hex = ev.color.replace('#', '');
                            if (hex.length === 6) {
                                const r = parseInt(hex.substr(0, 2), 16);
                                const g = parseInt(hex.substr(2, 2), 16);
                                const b = parseInt(hex.substr(4, 2), 16);
                                const darkR = Math.floor(r * 0.8);
                                const darkG = Math.floor(g * 0.8);
                                const darkB = Math.floor(b * 0.8);
                                const yiq = ((darkR * 299) + (darkG * 587) + (darkB * 114)) / 1000;
                                const isDark = yiq < 128;
                                customStyle = `background: rgb(${darkR},${darkG},${darkB}); color: ${isDark ? '#fff' : '#000'} !important; border: 1px solid rgba(255,255,255,0.2); text-shadow: ${isDark ? '0 1px 2px rgba(0,0,0,0.8)' : 'none'};`;
                            }
                        }

                        let tooltipText = `<div style="font-weight: bold; color: #5ec6ff; margin-bottom: 5px; font-size: 1.1em;">${t(ev.name)}</div>`;
                        if (ev.biome_names && ev.biome_names.length > 0) {
                            tooltipText += `<div style="margin-bottom: 5px; color: #fff;">${ev.biome_names.map(b => '• ' + t(b)).join('<br>')}</div>`;
                        }
                        tooltipText += `<div style="color: var(--text-muted); font-size: 0.85em; margin-top: 4px;"><i class="fa-regular fa-clock"></i> ${startStr} - ${endStr}</div>`;
                        
                        let iconsHtml = "";
                        if (ev.icons && ev.icons.length > 0) {
                            iconsHtml = `<div style="display: flex; gap: 2px; align-items: center; margin-right: 4px;">` + 
                                ev.icons.map(ic => `<img src="/assets/images/biomes/${ic}.png" onerror="this.style.display='none'" style="width: 14px; height: 14px; filter: drop-shadow(0px 1px 1px rgba(0,0,0,0.5));">`).join('') +
                                `</div>`;
                        }
                        else if (ev.type === 'fluxion') {
                            const isVoting = ev.name.includes('Voting');
                            const iconClass = isVoting ? 'fa-check-to-slot' : 'fa-sack-dollar';
                            iconsHtml = `<div style="display: flex; align-items: center;"><i class="fa-solid ${iconClass}"></i></div>`;
                        }
                        else if (ev.type.startsWith('gardening')) {
                            iconsHtml = `<div style="display: flex; align-items: center;"><i class="fa-solid fa-seedling"></i></div>`;
                        }
                        else if (ev.type === 'luxion' || ev.type === 'corruxion') {
                            iconsHtml = `<div style="display: flex; align-items: center;"><i class="fa-solid fa-dragon"></i></div>`;
                        }
                        else if (ev.type === 'invasion') {
                            iconsHtml = `<div style="display: flex; align-items: center;"><i class="fa-solid fa-meteor"></i></div>`;
                        }

                        let showText = "";
                        if (track.id === 'weekly_buff' && widthPx > 40) showText = t(ev.name);

                        const encodedTooltip = tooltipText.replace(/"/g, '&quot;');

                        const eventColorClass = track.types ? ev.type : track.color;
                        html += `<div class="calendar-event event-${eventColorClass}" 
                                      style="left: ${leftPx + labelWidth}px; width: ${widthPx}px; top: 6px; ${customStyle}"
                                      data-tooltip="${encodedTooltip}">
                                      ${iconsHtml}${showText}
                                 </div>`;
                    }
                });
                html += `</div>`; 
            });
            
            html += `</div></div>`;
            modalBody.innerHTML = html;

            const wrapper = document.getElementById('timeline-wrapper');
            if (wrapper) {
                const centerToday = () => {
                    wrapper.scrollLeft = todayPx + labelWidth - (wrapper.clientWidth / 2);
                };
                
                setTimeout(centerToday, 50);

                const btnToday = document.getElementById('btn-calendar-today');
                if (btnToday) {
                    btnToday.onclick = () => {
                        wrapper.style.scrollBehavior = 'smooth';
                        centerToday();
                        setTimeout(() => wrapper.style.scrollBehavior = 'auto', 500);
                    };
                }

                let isDown = false;
                let startX, scrollLeft;

                wrapper.classList.add('draggable');

                const onMouseMove = (e) => {
                    if (!isDown) return;
                    e.preventDefault();
                    const x = e.pageX - wrapper.offsetLeft;
                    const walk = (x - startX) * 1.5;
                    wrapper.scrollLeft = scrollLeft - walk;
                };

                const onMouseUp = () => {
                    isDown = false;
                    wrapper.classList.remove('dragging');
                    window.removeEventListener('mousemove', onMouseMove);
                    window.removeEventListener('mouseup', onMouseUp);
                };

                wrapper.addEventListener('mousedown', (e) => {
                    isDown = true;
                    wrapper.classList.add('dragging');
                    startX = e.pageX - wrapper.offsetLeft;
                    scrollLeft = wrapper.scrollLeft;
                    
                    window.addEventListener('mousemove', onMouseMove);
                    window.addEventListener('mouseup', onMouseUp);
                });

                wrapper.addEventListener('wheel', (e) => {
                    if (e.deltaY !== 0) {
                        e.preventDefault();
                        wrapper.scrollLeft += e.deltaY;
                    }
                });
            }

        } catch (e) {
            console.error(e);
            modalBody.innerHTML = `<div style="padding: 40px; text-align: center; color: #ff5555;">${t("Error loading calendar data.")}</div>`;
        }
    }

    async function fetchServerData() {
        const buffsGrid = document.getElementById('buffs-grid');
        const merchantsGrid = document.getElementById('merchants-grid');
        const loading = document.getElementById('buffs-loading');
        
        try {
            const [serverData, d15Data, manaData, merchantSchedules, stampyData, chaosChestData, gardeningData] = await Promise.all([
                eel.get_current_server_data()(),
                eel.get_d15_rotation()(),
                eel.get_wild_mana_rotation()(),
                eel.get_merchant_schedules()(),
                eel.get_stampy_rotation()(),
                eel.get_chaos_chest_data()(),
                eel.get_gardening_rotation()()
            ]);

            if (loading) loading.style.display = 'none';

            if (serverData && serverData.success) {
                renderBuffs(serverData.daily, serverData.weekly);
                renderChaosChest(chaosChestData);
                renderRotations(serverData.merchants, d15Data, manaData, stampyData, merchantSchedules, gardeningData);
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
                const modalTitle = document.querySelector('#d15-modal .modal-header h3');
                modalTitle.innerHTML = `<i class="fa-solid fa-calendar-week" style="color: ${colorHex};"></i> ${t("{title} Schedule").replace("{title}", title)}`;
                const modalBody = document.getElementById('d15-modal-body');
                document.querySelector('#d15-modal .modal-content').style.maxWidth = '600px';
                document.querySelector('#d15-modal .modal-content').style.width = '90%';
                
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

        function renderChaosChest(ccResp) {
            if (!buffsGrid || !ccResp || !ccResp.success) return;
            
            const card = document.createElement('div');
            card.className = 'merchant-card'; 
            card.style.setProperty('--merchant-color', '#ab47bc'); 
            card.style.cursor = 'default';
            
            let name = "Chaos Chest";
            let iconUrl = "https://trovesaurus.com/data/catalog/item_chaos_box.png";
            let isUnknown = true;
            let start = 0;
            let end = 0;
            let identifier = null;
            
            if (ccResp.data) {
                name = ccResp.data.name || name;
                if (ccResp.data.blueprint) {
                    iconUrl = `https://trovesaurus.com/data/catalog/${ccResp.data.blueprint.toLowerCase()}.png`;
                    isUnknown = false;
                }
                end = ccResp.data.end;
                identifier = ccResp.data.identifier;
            } else if (ccResp.fallback_times) {
                end = ccResp.fallback_times.end;
            } else { return; }
            
            if (identifier) {
                card.classList.add('hover-card');
                card.style.cursor = 'pointer';
                card.title = t("{name} (Click to view on Trovesaurus)").replace("{name}", t(name));
                card.onclick = () => {
                    eel.open_url_in_browser(`https://trovesaurus.com/${identifier}`)();
                };
            }
            
            const timeText = t("Changes in {time}").replace("{time}", `<b>${getCountdown(end, false)}</b>`);
            const unknownIcon = isUnknown ? `<i class="fa-solid fa-triangle-exclamation" style="color: #fbc02d; font-size: 0.8em; margin-left: 8px; cursor: help;" data-tooltip="${t("We don't know the item yet")}"></i>` : '';
            
            card.innerHTML = `
                <div class="merchant-icon" style="background: transparent;"><img src="${iconUrl}" style="width: 40px; height: 40px; object-fit: contain;" onerror="this.src='https://trovesaurus.com/data/catalog/item_chaos_box.png'"></div>
                <div class="merchant-info" style="width: 100%;">
                    <div class="merchant-name" style="color: #ab47bc;">${t(name)}${unknownIcon}</div>
                    <div class="merchant-time"><i class="fa-regular fa-clock"></i> ${timeText}</div>
                </div>`;
            
            buffsGrid.appendChild(card);
        }

        function renderRotations(merchants, d15, mana, stampy, schedules, gardening) {
            if (!merchantsGrid) return;
            merchantsGrid.style.display = 'flex';
            merchantsGrid.innerHTML = '';
            
            const configs = [
                { id: 'luxion', name: 'Luxion', color: '#fbc02d', icon: 'fa-dragon' },
                { id: 'corruxion', name: 'Corruxion', color: '#9c27b0', icon: 'fa-dragon' },
                { id: 'fluxion', name: 'Fluxion', color: '#4fc3f7', icon: 'fa-scale-balanced' },
                // { id: 'invasion', name: "Luxion's Fast Trials", color: '#ff5252', icon: 'fa-meteor' }
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
                    const modalTitle = document.querySelector('#d15-modal .modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid ${conf.icon}" style="color: ${conf.color};"></i> ${t("Upcoming {name} Schedule").replace("{name}", conf.name)}`;
                    document.querySelector('#d15-modal .modal-content').style.maxWidth = '600px';
                    document.querySelector('#d15-modal .modal-content').style.width = '90%';
                    
                    if(schedules && schedules.success && schedules[conf.id]) {
                        const actionType = (conf.id === 'invasion' || conf.id === 'fluxion') ? 'event' : 'merchant';
                        populateMerchantModal(schedules[conf.id], conf.color, actionType);
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
                    const modalTitle = document.querySelector('#d15-modal .modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid fa-paw" style="color: ${stampyColor};"></i> ${t("Upcoming Stampy Locations")}`;
                    document.querySelector('#d15-modal .modal-content').style.maxWidth = '600px';
                    document.querySelector('#d15-modal .modal-content').style.width = '90%';
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
                    const modalTitle = document.querySelector('#d15-modal .modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid fa-leaf" style="color: #4caf50;"></i> ${t("Upcoming D15 Biomes")} <button id="btn-toggle-biome-names" style="margin-left: 10px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: var(--text-muted); border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 0.6em; vertical-align: middle; transition: all 0.2s;" onmouseover="this.style.color='#fff'; this.style.borderColor='rgba(255,255,255,0.3)'" onmouseout="this.style.color='var(--text-muted)'; this.style.borderColor='rgba(255,255,255,0.1)'" title="${t('Toggle Biome Names')}"><i class="fa-solid fa-font"></i></button> <button id="btn-toggle-all-slots" style="margin-left: 5px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: var(--text-muted); border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 0.6em; vertical-align: middle; transition: all 0.2s;" onmouseover="this.style.color='#fff'; this.style.borderColor='rgba(255,255,255,0.3)'" onmouseout="this.style.color='var(--text-muted)'; this.style.borderColor='rgba(255,255,255,0.1)'" title="${t('Expand/Collapse All')}"><i class="fa-solid fa-expand"></i></button>`;
                    document.querySelector('#d15-modal .modal-content').style.maxWidth = '95%';
                    document.querySelector('#d15-modal .modal-content').style.width = 'max-content';
                    populateWeeklyBiomeModal(d15.rotations, '#4caf50');
                    
                    const toggleNamesBtn = document.getElementById('btn-toggle-biome-names');
                    let showFinalName = true;
                    toggleNamesBtn.addEventListener('click', () => {
                        showFinalName = !showFinalName;
                        const textEls = document.querySelectorAll('#d15-modal-body .biome-name-text');
                        textEls.forEach(el => {
                            el.innerText = showFinalName ? el.getAttribute('data-final-name') : el.getAttribute('data-name');
                        });
                    });

                    const toggleAllBtn = document.getElementById('btn-toggle-all-slots');
                    let allExpanded = false;
                    toggleAllBtn.addEventListener('click', () => {
                        allExpanded = !allExpanded;
                        toggleAllBtn.innerHTML = allExpanded ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
                        const slots = document.querySelectorAll('#d15-modal-body .schedule-slot');
                        slots.forEach(s => { if (s._toggleView) s._toggleView(allExpanded); });
                    });

                    if(rotationModal) rotationModal.style.display = 'flex';
                });

                merchantsGrid.appendChild(card);
            }

            if (gardening && gardening.success) {
                const two = gardening.two_day;
                const three = gardening.three_day;
                
                let activeNames = [];
                if (two.active) activeNames.push("2-day plants");
                if (three.active) activeNames.push("3-day plants");
                
                const isActive = activeNames.length > 0;
                
                const card = document.createElement('div');
                card.className = `merchant-card hover-card ${isActive ? '' : 'inactive'}`; 
                
                let gardeningColor = '#8bc34a';
                if (activeNames.length === 1 && activeNames[0].includes('3')) gardeningColor = '#4caf50';
                if (activeNames.length === 2) gardeningColor = '#ff9800'; 
                
                card.style.setProperty('--merchant-color', gardeningColor);
                card.style.cursor = 'pointer';
                card.title = t("Click to see upcoming rotations");
                
                const statusText = isActive ? t('HARVEST') : t('GROWING');
                let titleStr = "";
                let timeHtml = "";
                
                if (isActive) {
                    titleStr = activeNames.map(n => t(n)).join(" &amp; ");
                    let endTs = two.active && three.active ? Math.min(two.end, three.end) : (two.active ? two.end : three.end);
                    timeHtml = t("Ends in {time}").replace("{time}", `<b>${getCountdown(endTs, false)}</b>`);
                } else {
                    titleStr = t("Gardening Cycles");
                    let soonerStart = Math.min(two.start, three.start);
                    let nextName = soonerStart === two.start ? "2-day plants" : "3-day plants";
                    
                    if (two.start === three.start) {
                        timeHtml = `${t("2-day plants")} &amp; ${t("3-day plants")} - ` + t("Starts in {time}").replace("{time}", `<b>${getCountdown(soonerStart, false)}</b>`);
                    } else {
                        timeHtml = `${t(nextName)} - ` + t("Starts in {time}").replace("{time}", `<b>${getCountdown(soonerStart, false)}</b>`);
                    }
                }

                card.innerHTML = `
                    <div class="merchant-icon"><i class="fa-solid fa-seedling"></i></div>
                    <div class="merchant-info" style="width: 100%;">
                        <div class="merchant-name">${titleStr} <span class="merchant-status-badge">${statusText}</span></div>
                        <div class="merchant-time"><i class="fa-regular fa-clock"></i> ${timeHtml}</div>
                    </div>`;
                
                card.addEventListener('click', () => {
                    const modalTitle = document.querySelector('#d15-modal .modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid fa-seedling" style="color: ${gardeningColor};"></i> ${t("Upcoming Gardening Cycles")}`;
                    document.querySelector('#d15-modal .modal-content').style.maxWidth = '600px';
                    document.querySelector('#d15-modal .modal-content').style.width = '90%';
                    populateGardeningModal(gardening.future, gardeningColor);
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
                    const modalTitle = document.querySelector('#d15-modal .modal-header h3');
                    modalTitle.innerHTML = `<i class="fa-solid fa-flask" style="color: ${manaColor};"></i> ${t("Upcoming Wild Mana Biomes")}`;
                    document.querySelector('#d15-modal .modal-content').style.maxWidth = '600px';
                    document.querySelector('#d15-modal .modal-content').style.width = '90%';
                    populateBiomeModal(mana.future, manaColor);
                    if(rotationModal) rotationModal.style.display = 'flex';
                });

                merchantsGrid.appendChild(card);
            }
        }
        
        function populateGardeningModal(futureRotations, highlightColor) {
            const modalBody = document.getElementById('d15-modal-body');
            if (!modalBody) return;
            
            modalBody.innerHTML = '';
            futureRotations.forEach((rot, index) => {
                const isNext = index === 0;
                
                const locale = window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US';
                const startStr = new Date(rot.start * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                const endStr = new Date(rot.end * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                
                let timeText = t("Starts in {time}").replace("{time}", getCountdown(rot.start, false));
                if (rot.start * 1000 < Date.now()) {
                    timeText = t("Ends in {time}").replace("{time}", getCountdown(rot.end, false));
                }
                const phaseColor = rot.name.includes('3') ? '#4caf50' : '#8bc34a';
                
                const row = document.createElement('div');
                row.className = 'modal-rotation-row';
                row.innerHTML = `
                    <div class="modal-time-col" style="min-width: 150px;">
                        <div style="font-weight: bold; color: ${isNext ? highlightColor : '#fff'};">${isNext ? t('Next Cycle') : t("Cycle +{num}").replace("{num}", index + 1)}</div>
                        <div style="font-size: 0.85em; color: var(--text-muted);"><i class="fa-regular fa-clock"></i> ${timeText}</div>
                    </div>
                    <div class="modal-biomes-col" style="flex-direction: column; justify-content: center; gap: 4px;">
                        <div style="font-weight: bold; color: ${phaseColor}; margin-bottom: 2px;">${t(rot.name)}</div>
                        <div style="font-size: 0.9em; color: #eee;"><i class="fa-solid fa-play"></i> ${startStr}</div>
                        <div style="font-size: 0.9em; color: #a3adc2;"><i class="fa-solid fa-stop"></i> ${endStr}</div>
                    </div>
                `;
                modalBody.appendChild(row);
            });
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

            const daysData = [];
            let maxRows = 0;

            for (let i = 0; i < 7; i++) {
                const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
                const dayStartTs = dayStart.getTime();
                const dayEndTs = dayStartTs + 86400000;

                const dayRots = rotations.filter(rot => (rot.start * 1000 < dayEndTs && rot.end * 1000 > dayStartTs));
                dayRots.sort((a,b) => a.start - b.start);
                if (dayRots.length > maxRows) maxRows = dayRots.length;

                daysData.push({ dateObj: dayStart, rots: dayRots });
            }

            const headerRow = document.createElement('div');
            headerRow.className = 'schedule-row schedule-header-row';
            
            const timeHeader = document.createElement('div');
            timeHeader.className = 'schedule-time-col';
            headerRow.appendChild(timeHeader);

            daysData.forEach((day, i) => {
                const header = document.createElement('div');
                header.className = 'schedule-day-header';
                header.innerText = (i === 0) ? t("Today") : day.dateObj.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
                
                header.style.cursor = 'pointer';
                header.title = t("Click to toggle column");
                let colExpanded = false;
                header.addEventListener('click', () => {
                    colExpanded = !colExpanded;
                    const slots = grid.querySelectorAll(`.schedule-slot[data-col="${i}"]`);
                    slots.forEach(s => { if (s._toggleView) s._toggleView(colExpanded); });
                });
                
                headerRow.appendChild(header);
            });
            grid.appendChild(headerRow);

            for (let r = 0; r < maxRows; r++) {
                const rowEl = document.createElement('div');
                rowEl.className = 'schedule-row';

                let rowTimeStr = "";
                let baseRot = daysData[0].rots[r] || daysData[1].rots[r];
                if (baseRot) {
                    const timeObj = new Date(baseRot.start * 1000);
                    rowTimeStr = timeObj.toLocaleTimeString(locale, { hour: '2-digit', minute:'2-digit' });
                }

                const timeCol = document.createElement('div');
                timeCol.className = 'schedule-time-col';
                // Make the text display vertically, reading bottom-to-top
                timeCol.innerHTML = `<span style="writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap;">${rowTimeStr}</span>`;
                
                timeCol.style.cursor = 'pointer';
                timeCol.title = t("Click to toggle row");
                let rowExpanded = false;
                timeCol.addEventListener('click', () => {
                    rowExpanded = !rowExpanded;
                    const slots = rowEl.querySelectorAll('.schedule-slot');
                    slots.forEach(s => { if (s._toggleView) s._toggleView(rowExpanded); });
                });
                
                rowEl.appendChild(timeCol);

                daysData.forEach((day, i) => {
                    const rot = day.rots[r];
                    const slot = document.createElement('div');
                    slot.className = 'schedule-slot';
                    slot.dataset.col = i;
                    
                    if (!rot) {
                        slot.style.visibility = 'hidden';
                        rowEl.appendChild(slot);
                        return;
                    }

                    const rotStartTs = rot.start * 1000;
                    const rotEndTs = rot.end * 1000;
                    const isCurrent = nowTs >= rotStartTs && nowTs < rotEndTs;
                    const hasPassed = nowTs >= rotEndTs;
                    
                    if (hasPassed && i === 0) {
                        slot.style.opacity = '0.5';
                    }

                    if (isCurrent) {
                        slot.style.borderColor = highlightColor;
                        slot.style.boxShadow = `inset 0 0 10px rgba(0,0,0,0.5), 0 0 8px -2px ${highlightColor}`;
                    }
                    
                    let collapsedPills = rot.biomes.map(b => 
                        `<span class="biome-pill modal-pill" title="${t("Biome: {name}").replace("{name}", t(b.name))}" style="padding: 4px; flex: 1; justify-content: center;">
                            <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="" style="width: 16px; height: 16px;">
                        </span>`
                    ).join('');

                    let expandedPills = rot.biomes.map(b => 
                        `<span class="biome-pill modal-pill" title="${t("Biome: {name}").replace("{name}", t(b.name))}" style="justify-content: flex-start; padding: 4px 8px; font-size: 0.7em;">
                            <img src="/assets/images/biomes/${b.icon}.png" onerror="this.style.display='none'" alt="" style="width: 14px; height: 14px;">
                            <span class="biome-name-text" data-name="${t(b.name)}" data-final-name="${t(b.final_name)}">${t(b.final_name)}</span>
                        </span>`
                    ).join('');

                    slot.innerHTML = `
                        <div class="schedule-biomes-collapsed" style="display: ${isCurrent ? 'none' : 'flex'}; flex-direction: row; gap: 6px;">
                            ${collapsedPills}
                        </div>
                        <div class="schedule-biomes-expanded" style="display: ${isCurrent ? 'flex' : 'none'}; flex-direction: column; gap: 4px;">
                            ${expandedPills}
                        </div>
                        <div style="text-align: center; margin-top: auto; opacity: 0.4; padding-top: 4px;">
                            <i class="fa-solid fa-chevron-${isCurrent ? 'up' : 'down'} expand-icon"></i>
                        </div>
                    `;

                    slot.style.cursor = 'pointer';
                    const collapsedView = slot.querySelector('.schedule-biomes-collapsed');
                    const expandedView = slot.querySelector('.schedule-biomes-expanded');
                    const btn = slot.querySelector('.expand-icon');
                    
                    slot._toggleView = (forceExpand) => {
                        const isExpanded = expandedView.style.display === 'flex';
                        const targetState = forceExpand !== undefined ? forceExpand : !isExpanded;
                        
                        if (targetState) {
                            expandedView.style.display = 'flex';
                            collapsedView.style.display = 'none';
                            btn.className = 'fa-solid fa-chevron-up expand-icon';
                        } else {
                            expandedView.style.display = 'none';
                            collapsedView.style.display = 'flex';
                            btn.className = 'fa-solid fa-chevron-down expand-icon';
                        }
                    };
                    
                    slot.addEventListener('click', () => slot._toggleView());

                    rowEl.appendChild(slot);
                });
                
                grid.appendChild(rowEl);
            }
            
            modalBody.appendChild(grid);
        }

        function populateMerchantModal(schedule, highlightColor, actionType = 'merchant') {
            const modalBody = document.getElementById('d15-modal-body');
            if (!modalBody) return;
            
            modalBody.innerHTML = '';
            schedule.forEach((rot, index) => {
                const isNext = index === 0;
                
                const locale = window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US';
                const startStr = new Date(rot.start * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                const endStr = new Date(rot.end * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
                
                let arriveStr = actionType === 'event' ? t("Starts in {time}") : t("Arrives in {time}");
                let leaveStr = actionType === 'event' ? t("Ends in {time}") : t("Leaves in {time}");
                let nextStr = actionType === 'event' ? t('Next Event') : t('Next Arrival');
                let futureStr = actionType === 'event' ? t("Event +{num}") : t("Arrival +{num}");

                let timeText = arriveStr.replace("{time}", getCountdown(rot.start, false));
                if (rot.start * 1000 < Date.now()) {
                    timeText = leaveStr.replace("{time}", getCountdown(rot.end, false));
                }

                const phaseLabel = rot.name ? `<div style="font-weight: bold; color: ${highlightColor}; margin-bottom: 2px;">${t(rot.name)}</div>` : '';

                let iconStart = actionType === 'event' ? 'fa-play' : 'fa-plane-arrival';
                let iconEnd = actionType === 'event' ? 'fa-stop' : 'fa-plane-departure';

                const row = document.createElement('div');
                row.className = 'modal-rotation-row';
                row.innerHTML = `
                    <div class="modal-time-col" style="min-width: 150px;">
                        <div style="font-weight: bold; color: ${isNext ? highlightColor : '#fff'};">${isNext ? nextStr : futureStr.replace("{num}", index + 1)}</div>
                        <div style="font-size: 0.85em; color: var(--text-muted);"><i class="fa-regular fa-clock"></i> ${timeText}</div>
                    </div>
                    <div class="modal-biomes-col" style="flex-direction: column; justify-content: center; gap: 4px;">
                        ${phaseLabel}
                        <div style="font-size: 0.9em; color: #eee;"><i class="fa-solid ${iconStart}"></i> ${startStr}</div>
                        <div style="font-size: 0.9em; color: #a3adc2;"><i class="fa-solid ${iconEnd}"></i> ${endStr}</div>
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

    eel.expose(receive_youtube_videos, 'receive_youtube_videos');
    function receive_youtube_videos(response) {
        const wrapper = document.getElementById('carousel-wrapper');
        const carousel = document.getElementById('youtube-carousel');
        const loading = document.getElementById('media-loading');
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
                        <i class="fa-brands fa-youtube" style="font-size: 32px; opacity: 0.4; margin-bottom: 15px; display: block;"></i>
                        <span style="font-size: 14px;">${t("No Trove videos found right now. Check back later!")}</span>
                    </div>
                `;
                return;
            }

            if (btnLeft) btnLeft.style.display = 'flex';
            if (btnRight) btnRight.style.display = 'flex';

            response.data.sort((a, b) => new Date(b.published_at) - new Date(a.published_at)).forEach(video => {
                const card = document.createElement('div');
                card.className = 'stream-card';
                card.style.cursor = 'pointer';
                
                card.onclick = () => {
                    eel.open_url_in_browser(video.url)();
                };

                const thumb = video.thumbnail_url;
                const publishedStr = getTimeAgo(video.published_at, t);
                
                const verifiedChannels = ['Trove'];
                const verifiedBadge = verifiedChannels.includes(video.channel) ? ' <i class="fa-solid fa-circle-check" style="color: #5ec6ff;" title="Verified"></i>' : '';

                card.innerHTML = `<div class="stream-thumb"><img src="${thumb}" alt=""><div class="stream-badges"><span class="badge viewers">${publishedStr}</span></div></div>
                                  <div class="stream-info"><div class="stream-title">${video.title}</div><div class="stream-user"><i class="fa-brands fa-youtube" style="color:#FF0000;"></i> ${video.channel}${verifiedBadge}</div></div>`;
                carousel.appendChild(card);
            });
        } else {
            console.error("YouTube video fetch error:", response?.error);
        }
    }

    eel.expose(receive_twitch_streams, 'receive_twitch_streams');
    function receive_twitch_streams(response) {
        const wrapper = document.getElementById('carousel-wrapper');
        const carousel = document.getElementById('streams-carousel');
        const loading = document.getElementById('media-loading');
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
                
                const verifiedTwitchChannels = ['trovegame'];
                const verifiedBadge = verifiedTwitchChannels.includes(stream.user_login.toLowerCase()) ? ' <i class="fa-solid fa-circle-check" style="color: #5ec6ff;" title="Verified"></i>' : '';

                card.innerHTML = `<div class="stream-thumb"><img src="${thumb}" alt=""><div class="stream-badges"><span class="badge viewers">🔴 ${stream.viewer_count.toLocaleString()}</span></div></div>
                                  <div class="stream-info"><div class="stream-title">${stream.title}</div><div class="stream-user"><i class="fa-brands fa-twitch" style="color:#9146FF;"></i> ${stream.user_name}${verifiedBadge}</div></div>`;
                carousel.appendChild(card);
            });
        } else {
            console.error("Stream fetch error:", response?.error);
        }
    }

    eel.expose(receive_bilibili_videos, 'receive_bilibili_videos');
    function receive_bilibili_videos(response) {
        const wrapper = document.getElementById('carousel-wrapper');
        const carousel = document.getElementById('bilibili-carousel');
        const loading = document.getElementById('media-loading');
        const btnLeft = document.getElementById('btn-scroll-left');
        const btnRight = document.getElementById('btn-scroll-right');
        
        if (loading && document.querySelector('.media-tab.active')?.dataset.tab === 'bilibili') {
            loading.style.display = 'none';
        }
        if (wrapper) wrapper.style.display = 'flex';
        if (!carousel) return;
        
        carousel.innerHTML = '';

        if (response && response.success) {
            if (!response.data || response.data.length === 0) {
                carousel.innerHTML = `
                    <div style="width: 100%; text-align: center; padding: 30px; color: var(--text-muted);">
                        <i class="fa-brands fa-bilibili" style="font-size: 32px; opacity: 0.4; margin-bottom: 15px; display: block;"></i>
                        <span style="font-size: 14px;">${t("No Trove videos found right now. Check back later!")}</span>
                    </div>
                `;
                return;
            }

            if (btnLeft) btnLeft.style.display = 'flex';
            if (btnRight) btnRight.style.display = 'flex';

            response.data.sort((a, b) => new Date(b.published_at) - new Date(a.published_at)).forEach(video => {
                const card = document.createElement('div');
                card.className = 'stream-card';
                card.style.cursor = 'pointer';
                
                card.onclick = () => {
                    eel.open_url_in_browser(video.url)();
                };

                const thumb = `/proxy/bilibili_image?url=${encodeURIComponent(video.thumbnail_url)}`;
                const publishedStr = getTimeAgo(video.published_at, t);
                
                const verifiedChannels = [];
                const verifiedBadge = verifiedChannels.includes(video.channel) ? ' <i class="fa-solid fa-circle-check" style="color: #5ec6ff;" title="Verified"></i>' : '';

                card.innerHTML = `<div class="stream-thumb"><img src="${thumb}" alt=""><div class="stream-badges"><span class="badge viewers">${publishedStr}</span></div></div>
                                  <div class="stream-info"><div class="stream-title">${video.title}</div><div class="stream-user"><i class="fa-brands fa-bilibili" style="color:#00A1D6;"></i> ${video.channel}${verifiedBadge}</div></div>`;
                carousel.appendChild(card);
            });
        } else {
            console.error("Bilibili video fetch error:", response?.error);
        }
    }

    function fetchYoutubeVideos() {
        eel.get_youtube_videos()();
    }

    function fetchBilibiliVideos() {
        eel.get_bilibili_videos()();
    }

    function fetchStreams() {
        eel.get_twitch_streams()();
    }
});