document.addEventListener('calculators_loaded', () => {
    console.log("Calculators view initialized!");

    // --- TAB SYSTEM LOGIC ---
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

    // ==========================================
    // --- MASTERY CALCULATOR LOGIC ---
    // ==========================================
    
    function initMasteryCalculator() {
        const troveSlider = document.getElementById('trove-slider');
        const troveNum = document.getElementById('trove-number');
        const geodeSlider = document.getElementById('geode-slider');
        const geodeNum = document.getElementById('geode-number');

        // Sync inputs
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

        // Run initial calc
        calculateMastery();
    }

    function calculateMastery() {
        // Parse Inputs
        const rawTrove = parseInt(document.getElementById('trove-number').value) || 0;
        const rawGeode = parseInt(document.getElementById('geode-number').value) || 0;

        // Apply Soft Caps
        const troveCapped = Math.min(rawTrove, 1000);
        const geodeCapped = Math.min(rawGeode, 100);

        // Trove Math
        const troveTier1 = Math.min(troveCapped, 500); // Ranks 1-500
        const troveTier2 = Math.max(0, troveCapped - 500); // Ranks 501-1000

        const hpBonus = (troveTier1 * 0.6).toFixed(1);
        const dmgBonus = (troveTier1 * 0.2).toFixed(1);
        const trovePR = (troveTier1 * 4) + (troveTier2 * 1);
        const troveMF = troveTier2 * 1;

        // Geode Math
        const geodeLight = geodeCapped * 10;
        const geodePR = geodeCapped * 5;

        // Totals
        const totalPR = trovePR + geodePR;

        // Update UI
        document.getElementById('mastery-pr-display').innerText = totalPR.toLocaleString();
        document.getElementById('mastery-dmg').innerText = `+${dmgBonus}%`;
        document.getElementById('mastery-hp').innerText = `+${hpBonus}%`;
        document.getElementById('mastery-light').innerText = `+${geodeLight.toLocaleString()}`;
        document.getElementById('mastery-mf').innerText = `+${troveMF}`;
    }

    // Initialize Mastery Tab
    initMasteryCalculator();


    // ==========================================
    // --- MAGIC FIND CALCULATOR LOGIC ---
    // ==========================================
    
    let mfData = [];

    // Fetch the raw JSON data
    fetch('/assets/data/stats/magic_find.json')
        .then(response => response.json())
        .then(data => {
            mfData = [
                {
                    name: "Mastery",
                    type: "mastery",
                    percentage: false,
                    max: 1000,
                    default: 894
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
        .catch(err => console.error("Failed to load Magic Find data:", err));

    function renderMFCalculator() {
        const container = document.getElementById('mf-inputs-container');
        if (!container) return;
        
        container.innerHTML = '';

        mfData.forEach((item, index) => {
            const el = document.createElement('div');
            el.className = 'calc-item';
            
            // Determine badge style
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
                badgeText = `+${initialBonus} Flat`;
                controlHtml = `
                    <div class="calc-slider-wrapper">
                        <input type="range" class="calc-slider mf-input" data-index="${index}" min="1" max="${item.max}" value="${item.default}">
                        <input type="number" class="calc-number-input mf-input-sync" data-index="${index}" min="1" max="${item.max}" value="${item.default}">
                    </div>
                `;
            } else if (item.type === 'patron_switch') {
                badgeText = `+${item.value}% Multiplier`;
                controlHtml = `
                    <label class="calc-switch">
                        <input type="checkbox" class="mf-input" data-index="${index}" ${item.default_checked ? 'checked' : ''}>
                        <span class="slider-toggle"></span>
                    </label>
                `;
            } else if (item.type === 'slider') {
                badgeText = `+${item.value} Flat`;
                controlHtml = `
                    <div class="calc-slider-wrapper">
                        <input type="range" class="calc-slider mf-input" data-index="${index}" min="0" max="${item.value}" value="${item.value}">
                        <input type="number" class="calc-number-input mf-input-sync" data-index="${index}" min="0" max="${item.value}" value="${item.value}">
                    </div>
                `;
            } else if (item.type === 'switch') {
                badgeText = item.percentage ? `+${item.value}% Bonus` : `+${item.value} Flat`;
                controlHtml = `
                    <label class="calc-switch">
                        <input type="checkbox" class="mf-input" data-index="${index}" checked>
                        <span class="slider-toggle"></span>
                    </label>
                `;
            }

            el.innerHTML = `
                <div class="calc-item-header">
                    <span>${item.name}</span>
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
                    const numberInput = document.querySelector(`.calc-number-input[data-index="${idx}"]`);
                    if (numberInput) numberInput.value = e.target.value;
                }
                calculateMF();
            });
        });

        document.querySelectorAll('.calc-number-input').forEach(input => {
            input.addEventListener('input', (e) => {
                let val = parseInt(e.target.value) || 0;
                const max = parseInt(e.target.getAttribute('max'));
                const min = parseInt(e.target.getAttribute('min')) || 0;
                
                if (val > max) val = max;
                if (val < min) val = min;

                const idx = e.target.getAttribute('data-index');
                const rangeInput = document.querySelector(`.calc-slider[data-index="${idx}"]`);
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
                if (badge) badge.innerText = `+${val} Flat`;
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

        document.getElementById('mf-total-display').innerText = totalMF.toLocaleString();
        
        let breakdownText = `Base MF: ${flatMF.toLocaleString()} | Bonus Multiplier: +${bonusPercent}%`;
        if (patronMultiplier > 1) {
            breakdownText += ` | Patron: x${patronMultiplier}`;
        }
        document.getElementById('mf-breakdown-display').innerText = breakdownText;
    }
});