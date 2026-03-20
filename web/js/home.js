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

    async function fetchServerData() {
        const buffsGrid = document.getElementById('buffs-grid');
        const merchantsGrid = document.getElementById('merchants-grid');
        const loading = document.getElementById('buffs-loading');
        try {
            const response = await eel.get_current_server_data()();
            if (response && response.success) {
                if (loading) loading.style.display = 'none';
                renderBuffs(response.daily, response.weekly);
                renderMerchants(response.merchants);
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

        function renderMerchants(merchants) {
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
                card.className = `merchant-card ${data.active ? '' : 'inactive'}`;
                card.style.setProperty('--merchant-color', conf.color);
                const displayName = (conf.id === 'fluxion' && data.active) ? `${conf.name} (${data.state})` : conf.name;
                card.innerHTML = `
                    <div class="merchant-icon"><i class="fa-solid ${conf.icon}"></i></div>
                    <div class="merchant-info">
                        <div class="merchant-name">${displayName} <span class="merchant-status-badge">${data.active ? 'ACTIVE' : 'AWAY'}</span></div>
                        <div class="merchant-time"><i class="fa-regular fa-clock"></i> ${data.action} <b>${data.time_str}</b></div>
                    </div>`;
                merchantsGrid.appendChild(card);
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
                    const card = document.createElement('a');
                    card.className = 'event-card';
                    card.href = event.url;
                    card.target = '_blank';
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
        try {
            const response = await eel.get_twitch_streams()();
            if (response && response.success) {
                if (loading) loading.style.display = 'none';
                if (wrapper) wrapper.style.display = 'flex';
                if (!carousel) return;
                carousel.innerHTML = '';
                response.data.sort((a, b) => b.viewer_count - a.viewer_count).forEach(stream => {
                    const card = document.createElement('a');
                    card.className = 'stream-card'; card.href = `https://twitch.tv/${stream.user_login}`; card.target = '_blank';
                    const thumb = stream.thumbnail_url.replace('{width}', '440').replace('{height}', '248');
                    card.innerHTML = `<div class="stream-thumb"><img src="${thumb}" alt=""><div class="stream-badges"><span class="badge viewers">🔴 ${stream.viewer_count.toLocaleString()}</span></div></div>
                                      <div class="stream-info"><div class="stream-title">${stream.title}</div><div class="stream-user"><i class="fa-brands fa-twitch" style="color:#9146FF;"></i> ${stream.user_name}</div></div>`;
                    carousel.appendChild(card);
                });
                const btnLeft = document.getElementById('btn-scroll-left'), btnRight = document.getElementById('btn-scroll-right');
                if (btnLeft && btnRight) {
                    btnLeft.onclick = () => carousel.scrollBy({ left: -260, behavior: 'smooth' });
                    btnRight.onclick = () => carousel.scrollBy({ left: 260, behavior: 'smooth' });
                }
            }
        } catch (e) { console.error(e); }
    }
});