document.addEventListener('home_loaded', () => {
    console.log("Home Dashboard initialized!");
    
    // Boot Sequence
    fetchStreams();
    fetchServerData();
    fetchEvents();

    // =====================================
    // SERVER DATA (BUFFS & MERCHANTS)
    // =====================================
    async function fetchServerData() {
        const buffsGrid = document.getElementById('buffs-grid');
        const merchantsGrid = document.getElementById('merchants-grid');
        const loading = document.getElementById('buffs-loading');

        try {
            const response = await eel.get_current_server_data()();
            if (response && response.success) {
                loading.style.display = 'none';
                renderBuffs(response.daily, response.weekly);
                renderMerchants(response.merchants);
            } else {
                loading.innerHTML = `<span style="color: #ff5555;">Failed to load server data.</span>`;
            }
        } catch (e) {
            console.error(e);
            loading.innerHTML = `<span style="color: #ff5555;">Backend Connection Error</span>`;
        }

        function renderBuffs(daily, weekly) {
            buffsGrid.style.display = 'grid';
            buffsGrid.innerHTML = '';
            if (daily) buffsGrid.appendChild(createBuffCard("Daily: " + daily.name, daily));
            if (weekly) buffsGrid.appendChild(createBuffCard("Weekly: " + weekly.name, weekly));
        }

        function createBuffCard(title, data) {
            const card = document.createElement('div');
            card.className = 'buff-card';
            const colorHex = data.color ? `#${data.color}` : '#5ec6ff';
            card.style.setProperty('--buff-color', colorHex); 

            let headerBg = data.banner ? `url('${data.banner}') center/cover` : colorHex;
            let html = `
                <div class="buff-header" style="background: linear-gradient(to right, rgba(0,0,0,0.9) 20%, rgba(0,0,0,0.1) 100%), ${headerBg};">
                    ${data.icon ? `<img src="${data.icon}" alt="">` : ''}
                    <span>${data.emoji || ''} ${title}</span>
                </div>
                <div class="buff-content">
            `;

            if (data.normal_buffs?.length > 0) {
                html += `<ul class="buff-list">`;
                data.normal_buffs.forEach(b => html += `<li>${b}</li>`);
                html += `</ul>`;
            }
            if (data.premium_buffs?.length > 0) {
                html += `<div class="buff-premium-title"><i class="fa-solid fa-crown"></i> Patron Bonus</div><ul class="buff-list">`;
                data.premium_buffs.forEach(b => html += `<li style="color:#eee;">${b}</li>`);
                html += `</ul>`;
            }
            if (data.buffs?.length > 0) { 
                html += `<ul class="buff-list">`;
                data.buffs.forEach(b => html += `<li>${b}</li>`);
                html += `</ul>`;
            }

            html += `</div>`;
            card.innerHTML = html;
            return card;
        }

        function renderMerchants(merchants) {
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
                    </div>
                `;
                merchantsGrid.appendChild(card);
            });
        }
    }

    // =====================================
    // TROVESAURUS EVENTS LOGIC
    // =====================================
    async function fetchEvents() {
        const list = document.getElementById('events-list');
        const loading = document.getElementById('events-loading');

        try {
            const response = await eel.get_trovesaurus_events()();
            if (response && response.success) {
                loading.style.display = 'none';
                list.style.display = 'flex';
                list.innerHTML = '';

                if (!response.data || response.data.length === 0) {
                    list.innerHTML = `<div class="placeholder-box">No events are currently going on.</div>`;
                    return;
                }

                response.data.forEach(event => {
                    const card = document.createElement('a');
                    card.className = 'event-card';
                    card.href = event.url;
                    card.target = '_blank';

                    const start = new Date(parseInt(event.startdate) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                    const end = new Date(parseInt(event.enddate) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                    const img = event.image || event.icon || 'https://trovesaurus.com/images/logos/Sage_64.png';

                    card.innerHTML = `
                        <div class="event-image"><img src="${img}" alt=""></div>
                        <div class="event-main">
                            <div class="event-name-row">
                                <span class="event-name">${event.name}</span>
                                <span class="event-category">${event.category}</span>
                            </div>
                            <div class="event-dates"><i class="fa-regular fa-calendar"></i> ${start} - ${end}</div>
                        </div>
                        <div class="event-link-icon"><i class="fa-solid fa-arrow-up-right-from-square"></i></div>
                    `;
                    list.appendChild(card);
                });
            }
        } catch (e) { console.error(e); }
    }

    // =====================================
    // STREAMS & CAROUSEL LOGIC
    // =====================================
    async function fetchStreams() {
        const wrapper = document.getElementById('carousel-wrapper');
        const carousel = document.getElementById('streams-carousel');
        const loading = document.getElementById('streams-loading');

        try {
            const response = await eel.get_twitch_streams()();
            if (response && response.success) {
                loading.style.display = 'none';
                wrapper.style.display = 'flex';
                carousel.innerHTML = '';

                if (!response.data || response.data.length === 0) {
                    carousel.innerHTML = `<div style="padding: 20px; color: #a3adc2;">No Trove streams live right now.</div>`;
                    return;
                }

                response.data.sort((a, b) => b.viewer_count - a.viewer_count).forEach(stream => {
                    const card = document.createElement('a');
                    card.className = 'stream-card';
                    card.href = `https://twitch.tv/${stream.user_login}`;
                    card.target = '_blank';
                    const thumb = stream.thumbnail_url.replace('{width}', '440').replace('{height}', '248');

                    card.innerHTML = `
                        <div class="stream-thumb">
                            <img src="${thumb}" alt="">
                            <div class="stream-badges">
                                <span class="badge viewers">🔴 ${stream.viewer_count.toLocaleString()}</span>
                            </div>
                        </div>
                        <div class="stream-info">
                            <div class="stream-title">${stream.title}</div>
                            <div class="stream-user"><i class="fa-brands fa-twitch" style="color:#9146FF;"></i> ${stream.user_name}</div>
                        </div>
                    `;
                    carousel.appendChild(card);
                });
                setupCarouselNavigation();
            }
        } catch (e) { console.error(e); }
    }

    function setupCarouselNavigation() {
        const carousel = document.getElementById('streams-carousel');
        const btnLeft = document.getElementById('btn-scroll-left');
        const btnRight = document.getElementById('btn-scroll-right');
        if (!btnLeft || !btnRight) return;

        btnLeft.onclick = () => carousel.scrollBy({ left: -260, behavior: 'smooth' });
        btnRight.onclick = () => carousel.scrollBy({ left: 260, behavior: 'smooth' });
    }
});