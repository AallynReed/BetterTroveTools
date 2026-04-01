document.addEventListener('calculators_loaded', () => {
    console.log("Calculators view initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));

            button.classList.add('active');

            const targetId = button.getAttribute('data-tab');
            const targetContent = document.getElementById(targetId);
            
            if (targetContent) {
                targetContent.classList.add('active');
            }
        });
    });

    function initMasteryCalculator() {
        const troveSlider = document.getElementById('trove-slider');
        const troveNum = document.getElementById('trove-number');
        const geodeSlider = document.getElementById('geode-slider');
        const geodeNum = document.getElementById('geode-number');

        if (!troveSlider || !troveNum || !geodeSlider || !geodeNum) return;

        const syncInputs = (slider, num) => {
            slider.addEventListener('input', () => { num.value = slider.value; calculateMastery(); });
            num.addEventListener('input', () => { 
                let val = parseInt(num.value) || 0;
                let max = parseInt(num.max);
                if(val > max) val = max;
                slider.value = val;
                num.value = val;
                calculateMastery(); 
            });
        };

        syncInputs(troveSlider, troveNum);
        syncInputs(geodeSlider, geodeNum);

        calculateMastery();
    }

    function calculateMastery() {
        const rawTrove = parseInt(document.getElementById('trove-number').value) || 0;
        const rawGeode = parseInt(document.getElementById('geode-number').value) || 0;

        const troveCapped = Math.min(rawTrove, 1000);
        const geodeCapped = Math.min(rawGeode, 100);

        const troveTier1 = Math.min(troveCapped, 500);
        const troveTier2 = Math.max(0, troveCapped - 500);

        const hpBonus = (troveTier1 * 0.6).toFixed(1);
        const dmgBonus = (troveTier1 * 0.2).toFixed(1);
        const trovePR = (troveTier1 * 4) + (troveTier2 * 1);
        const troveMF = troveTier2 * 1;

        const geodeLight = geodeCapped * 10;
        const geodePR = geodeCapped * 5;

        const totalPR = trovePR + geodePR;

        document.getElementById('mastery-pr-display').innerText = totalPR.toLocaleString();
        document.getElementById('mastery-dmg').innerText = `+${dmgBonus}%`;
        document.getElementById('mastery-hp').innerText = `+${hpBonus}%`;
        document.getElementById('mastery-light').innerText = `+${geodeLight.toLocaleString()}`;
        document.getElementById('mastery-mf').innerText = `+${troveMF}`;
    }

    initMasteryCalculator();

    let mfData = [];

    fetch('/assets/data/stats/magic_find.json')
        .then(response => {
            if (!response.ok) throw new Error("File not found");
            return response.json();
        })
        .then(data => {
            mfData = [
                {
                    name: "Mastery",
                    type: "mastery",
                    percentage: false,
                    max: 1000,
                    default: 900
                },
                ...data,
                {
                    name: "Patron",
                    type: "patron_switch",
                    percentage: true,
                    value: 100,
                    default_checked: false
                }
            ];

            renderMFCalculator();
        })
        .catch(err => console.warn("Skipping Magic Find setup (data missing):", err));

    function renderMFCalculator() {
        const container = document.getElementById('mf-inputs-container');
        if (!container) return;
        
        container.innerHTML = '';

        mfData.forEach((item, index) => {
            const el = document.createElement('div');
            el.className = 'calc-item';
            
            let badgeClass = 'calc-item-badge';
            if (item.type === 'patron_switch') {
                badgeClass += ' patron';
            } else if (item.percentage) {
                badgeClass += ' bonus';
            }
            
            let badgeText = '';
            let controlHtml = '';
            
            if (item.type === 'mastery') {
                const initialBonus = Math.max(0, item.default - 500);
                badgeText = t("+{val} Flat").replace("{val}", initialBonus);
                controlHtml = `
                    <div class="calc-slider-wrapper">
                        <input type="range" class="calc-slider mf-input" data-index="${index}" min="1" max="${item.max}" value="${item.default}">
                        <input type="number" class="calc-number-input mf-input-sync" data-index="${index}" min="1" max="${item.max}" value="${item.default}">
                    </div>
                `;
            } else if (item.type === 'patron_switch') {
                badgeText = t("+{val}% Multiplier").replace("{val}", item.value);
                controlHtml = `
                    <label class="calc-switch">
                        <input type="checkbox" class="mf-input" data-index="${index}" ${item.default_checked ? 'checked' : ''}>
                        <span class="slider-toggle"></span>
                    </label>
                `;
            } else if (item.type === 'slider') {
                badgeText = t("+{val} Flat").replace("{val}", item.value);
                controlHtml = `
                    <div class="calc-slider-wrapper">
                        <input type="range" class="calc-slider mf-input" data-index="${index}" min="0" max="${item.value}" value="${item.value}">
                        <input type="number" class="calc-number-input mf-input-sync" data-index="${index}" min="0" max="${item.value}" value="${item.value}">
                    </div>
                `;
            } else if (item.type === 'switch') {
                badgeText = item.percentage 
                    ? t("+{val}% Bonus").replace("{val}", item.value) 
                    : t("+{val} Flat").replace("{val}", item.value);
                controlHtml = `
                    <label class="calc-switch">
                        <input type="checkbox" class="mf-input" data-index="${index}" checked>
                        <span class="slider-toggle"></span>
                    </label>
                `;
            }

            el.innerHTML = `
                <div class="calc-item-header">
                    <span>${t(item.name)}</span>
                    <span class="${badgeClass}" id="mf-badge-${index}">${badgeText}</span>
                </div>
                <div>
                    ${controlHtml}
                </div>
            `;
            
            container.appendChild(el);
        });

        bindMFListeners();
        calculateMF();
    }

    function bindMFListeners() {
        document.querySelectorAll('.mf-input').forEach(input => {
            input.addEventListener('input', (e) => {
                const idx = e.target.getAttribute('data-index');
                if (e.target.type === 'range') {
                    const numberInput = document.querySelector(`.calc-number-input.mf-input-sync[data-index="${idx}"]`);
                    if (numberInput) numberInput.value = e.target.value;
                }
                calculateMF();
            });
        });

        document.querySelectorAll('.calc-number-input.mf-input-sync').forEach(input => {
            input.addEventListener('input', (e) => {
                let val = parseInt(e.target.value) || 0;
                const max = parseInt(e.target.getAttribute('max'));
                const min = parseInt(e.target.getAttribute('min')) || 0;
                
                if (val > max) val = max;
                if (val < min) val = min;

                const idx = e.target.getAttribute('data-index');
                const rangeInput = document.querySelector(`.calc-slider.mf-input[data-index="${idx}"]`);
                if (rangeInput) rangeInput.value = val;
                
                calculateMF();
            });
        });
    }

    function calculateMF() {
        let flatMF = 0;
        let bonusPercent = 0;
        let patronMultiplier = 1;

        document.querySelectorAll('.mf-input').forEach(input => {
            const idx = input.getAttribute('data-index');
            const dataItem = mfData[idx];
            
            let val = 0;
            
            if (input.type === 'checkbox') {
                val = input.checked ? dataItem.value : 0;
            } else if (input.type === 'range') {
                const rawVal = parseInt(input.value) || 0;
                if (dataItem.type === 'mastery') {
                    val = Math.max(0, rawVal - 500);
                } else {
                    val = rawVal;
                }
                const badge = document.getElementById(`mf-badge-${idx}`);
                if (badge) badge.innerText = t("+{val} Flat").replace("{val}", val);
            }

            if (dataItem.type === 'patron_switch') {
                if (input.checked) {
                    patronMultiplier = (val / 100) + 1;
                }
            } else if (dataItem.percentage) {
                bonusPercent += val;
            } else {
                flatMF += val;
            }
        });

        const totalMF = Math.floor(flatMF * (1 + (bonusPercent / 100)) * patronMultiplier);

        const displayTotal = document.getElementById('mf-total-display');
        if (displayTotal) displayTotal.innerText = totalMF.toLocaleString();
        
        let breakdownText = t("Base MF: {base} | Bonus Multiplier: +{bonus}%")
            .replace("{base}", flatMF.toLocaleString())
            .replace("{bonus}", bonusPercent);
            
        if (patronMultiplier > 1) {
            breakdownText += t(" | Patron: x{multiplier}").replace("{multiplier}", patronMultiplier);
        }
        
        const displayBreakdown = document.getElementById('mf-breakdown-display');
        if(displayBreakdown) displayBreakdown.innerText = breakdownText;
    }

    let prData = [];

    fetch('/assets/data/stats/power_rank.json')
        .then(response => {
            if (!response.ok) throw new Error("File not found");
            return response.json();
        })
        .then(data => {
            prData = [
                {
                    name: "Trove Mastery",
                    type: "pr_mastery",
                    percentage: false,
                    max: 1100,
                    default: 900
                },
                {
                    name: "Geode Mastery",
                    type: "pr_geode_mastery",
                    percentage: false,
                    max: 150,
                    default: 100
                },
                ...data
            ];

            renderPRCalculator();
        })
        .catch(err => console.warn("Skipping Power Rank setup (data missing):", err));

    function renderPRCalculator() {
        const container = document.getElementById('pr-inputs-container');
        if (!container) return;
        
        container.innerHTML = '';

        prData.forEach((item, index) => {
            const el = document.createElement('div');
            el.className = 'calc-item';
            
            let badgeClass = 'calc-item-badge patron'; 
            let badgeText = '';
            let controlHtml = '';
            
            if (item.type === 'pr_mastery') {
                badgeText = t("+0 PR");
                controlHtml = `
                    <div class="calc-slider-wrapper">
                        <input type="range" class="calc-slider pr-input" data-index="${index}" min="1" max="${item.max}" value="${item.default}" style="accent-color: #fbc02d;">
                        <input type="number" class="calc-number-input pr-input-sync" data-index="${index}" min="1" max="2000" value="${item.default}">
                    </div>
                `;
            } 
            else if (item.type === 'pr_geode_mastery') {
                badgeText = t("+0 PR");
                controlHtml = `
                    <div class="calc-slider-wrapper">
                        <input type="range" class="calc-slider pr-input" data-index="${index}" min="1" max="${item.max}" value="${item.default}" style="accent-color: #fbc02d;">
                        <input type="number" class="calc-number-input pr-input-sync" data-index="${index}" min="1" max="200" value="${item.default}">
                    </div>
                `;
            }
            else if (item.type === 'slider') {
                badgeText = t("+{val} PR").replace("{val}", item.value);
                controlHtml = `
                    <div class="calc-slider-wrapper">
                        <input type="range" class="calc-slider pr-input" data-index="${index}" min="0" max="${item.value}" value="${item.value}" style="accent-color: #fbc02d;">
                        <input type="number" class="calc-number-input pr-input-sync" data-index="${index}" min="0" max="${item.value}" value="${item.value}">
                    </div>
                `;
            } 
            else if (item.type === 'switch') {
                badgeText = t("+{val} PR").replace("{val}", item.value);
                controlHtml = `
                    <label class="calc-switch">
                        <input type="checkbox" class="pr-input" data-index="${index}" checked>
                        <span class="slider-toggle pr-slider-toggle"></span>
                    </label>
                `;
            }

            el.innerHTML = `
                <div class="calc-item-header">
                    <span>${t(item.name)}</span>
                    <span class="${badgeClass}" id="pr-badge-${index}">${badgeText}</span>
                </div>
                <div>
                    ${controlHtml}
                </div>
            `;
            
            container.appendChild(el);
        });

        if (!document.getElementById('pr-switch-styles')) {
            const style = document.createElement('style');
            style.id = 'pr-switch-styles';
            style.innerHTML = `
                .calc-switch input:checked + .slider-toggle.pr-slider-toggle { 
                    background-color: #fbc02d !important; 
                    border-color: #fbc02d !important; 
                }
            `;
            document.head.appendChild(style);
        }

        bindPRListeners();
        calculatePR();
    }

    function bindPRListeners() {
        document.querySelectorAll('.pr-input').forEach(input => {
            input.addEventListener('input', (e) => {
                const idx = e.target.getAttribute('data-index');
                if (e.target.type === 'range') {
                    const numberInput = document.querySelector(`.pr-input-sync[data-index="${idx}"]`);
                    if (numberInput) numberInput.value = e.target.value;
                }
                calculatePR();
            });
        });

        document.querySelectorAll('.pr-input-sync').forEach(input => {
            input.addEventListener('input', (e) => {
                let val = parseInt(e.target.value) || 0;
                const max = parseInt(e.target.getAttribute('max'));
                const min = parseInt(e.target.getAttribute('min')) || 0;
                
                if (val > max) val = max;
                if (val < min) val = min;

                const idx = e.target.getAttribute('data-index');
                const rangeInput = document.querySelector(`.calc-slider.pr-input[data-index="${idx}"]`);
                if (rangeInput) rangeInput.value = val;
                
                calculatePR();
            });
        });
    }

    function calculatePR() {
        let totalPR = 0;

        document.querySelectorAll('.pr-input').forEach(input => {
            const idx = input.getAttribute('data-index');
            const dataItem = prData[idx];
            
            let val = 0;
            
            if (input.type === 'checkbox') {
                val = input.checked ? dataItem.value : 0;
            } else if (input.type === 'range') {
                const rawVal = parseInt(input.value) || 0;
                
                if (dataItem.type === 'pr_mastery') {
                    const capped = Math.min(rawVal, 1000);
                    const tier1 = Math.min(capped, 500);
                    const tier2 = Math.max(0, capped - 500);
                    
                    val = (tier1 * 4) + (tier2 * 1);
                } 
                else if (dataItem.type === 'pr_geode_mastery') {
                    const capped = Math.min(rawVal, 100);
                    val = capped * 5;
                } 
                else {
                    val = rawVal;
                }
                
                const badge = document.getElementById(`pr-badge-${idx}`);
                if (badge) badge.innerText = t("+{val} PR").replace("{val}", val);
            }

            totalPR += val;
        });

        const displayTotal = document.getElementById('pr-total-display');
        if (displayTotal) displayTotal.innerText = totalPR.toLocaleString();
    }
});