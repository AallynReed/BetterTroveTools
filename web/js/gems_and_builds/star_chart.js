document.addEventListener('star_chart_loaded', async () => {
    console.log("Star Chart Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

    const COLORS = {
        Combat: { minor: "#FF8F00", major: "#D84315" },
        Gathering: { minor: "#00695C", major: "#558B2F" },
        Pve: { minor: "#6A1B9A", major: "#283593" }
    };
    const REPLACEMENT_GOLD = "#d8ab45";
    const COMPACT_CODE_PREFIX = 'SC:';
    const ROOT_TO_ABBREV = { combat: 'c', gathering: 'g', pve: 'p' };
    const ABBREV_TO_ROOT = { c: 'combat', g: 'gathering', p: 'pve' };

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
            const PREF_STATE_KEY = 'state_star_chart';
            const unwrapResp = (resp, key = null, fallback = null) => {
                if (key) {
                    if (resp && Object.prototype.hasOwnProperty.call(resp, key)) return resp[key];
                    if (resp && resp.data && Object.prototype.hasOwnProperty.call(resp.data, key)) return resp.data[key];
                }
                if (resp && resp.data !== undefined && resp.success !== undefined) return resp.data;
                return resp ?? fallback;
            };

            const isLoading = ref(true);
            const cheatModeEnabled = ref(false);
            const CHART_Y_OFFSET = -130;
            const CHART_SPACING_SCALE = 0.92;
            const origin = ref([500, 460]);
            const chartBaseOrigin = ref([500, 500]);
            const maxNodeLimit = computed(() => cheatModeEnabled.value ? 120 : 40);

            const withChartOffset = (coords) => {
                if (!Array.isArray(coords) || coords.length < 2) return [500, 500 + CHART_Y_OFFSET];
                const [baseX, baseY] = chartBaseOrigin.value;
                const dx = coords[0] - baseX;
                const dy = coords[1] - baseY;
                return [
                    baseX + (dx * CHART_SPACING_SCALE),
                    baseY + (dy * CHART_SPACING_SCALE) + CHART_Y_OFFSET
                ];
            };

            const mixColors = (hexA, hexB, weight = 0.5) => {
                const parseHex = (hex) => {
                    const value = String(hex || '').replace('#', '');
                    const normalized = value.length === 3
                        ? value.split('').map((char) => char + char).join('')
                        : value.padEnd(6, '0').slice(0, 6);
                    return {
                        r: parseInt(normalized.slice(0, 2), 16),
                        g: parseInt(normalized.slice(2, 4), 16),
                        b: parseInt(normalized.slice(4, 6), 16)
                    };
                };

                const a = parseHex(hexA);
                const b = parseHex(hexB);
                const blend = (start, end) => Math.round((start * (1 - weight)) + (end * weight));
                return `rgb(${blend(a.r, b.r)}, ${blend(a.g, b.g)}, ${blend(a.b, b.b)})`;
            };

            const getNodeCenter = (path) => {
                const node = nodeMap[path];
                if (!node || !node.Coords) return null;
                const [x, y] = withChartOffset(node.Coords);
                return { x, y };
            };

            const distancePointToSegment = (px, py, x1, y1, x2, y2) => {
                const dx = x2 - x1;
                const dy = y2 - y1;
                const lenSq = (dx * dx) + (dy * dy);
                if (lenSq === 0) return Math.hypot(px - x1, py - y1);
                const t = Math.max(0, Math.min(1, (((px - x1) * dx) + ((py - y1) * dy)) / lenSq));
                const projX = x1 + (t * dx);
                const projY = y1 + (t * dy);
                return Math.hypot(px - projX, py - projY);
            };

            const sampleQuadratic = (from, control, to, t) => {
                const mt = 1 - t;
                return {
                    x: (mt * mt * from.x) + (2 * mt * t * control.x) + (t * t * to.x),
                    y: (mt * mt * from.y) + (2 * mt * t * control.y) + (t * t * to.y)
                };
            };
            
            const nodeMap = reactive({});
            const selectedPaths = reactive(new Set());
            const linesList = ref([]);
            const nodesList = ref([]);

            const buildCode = ref("");
            const codeInputFocused = ref(false);

            const templates = ref({});
            const selectedTemplate = ref("");
            const selectedStatFilter = ref("");
            const nodeSearchQuery = ref("");

            // Pan & zoom: the SVG viewBox is reactive so the wheel/drag handlers can
            // move and scale the visible window over the (fixed) chart geometry.
            const DEFAULT_VIEWBOX = { x: 0, y: 0, w: 1000, h: 800 };
            const VIEWBOX_ASPECT = DEFAULT_VIEWBOX.w / DEFAULT_VIEWBOX.h;
            const MIN_VIEW_W = 250;
            const MAX_VIEW_W = 1400;
            const viewBox = reactive({ ...DEFAULT_VIEWBOX });
            const viewBoxStr = computed(() => `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
            const importTemplatesRef = ref(null);

            const summarySectionState = reactive({
                stats: true,
                abilities: true,
                obtainables: true
            });

            const modal = reactive({ show: false, title: '', msg: '', showInput: false, inputValue: '', action: null, renameFrom: '' });
            const modalInputRef = ref(null);

            const tooltip = reactive({ show: false, node: null, x: 0, y: 0 });
            let chartResizeObserver = null;

            const syncSummaryPanelHeight = () => {
                const root = document.getElementById('star-chart-vue-app-inner');
                const chartWrapper = document.getElementById('chart-wrapper');
                const summaryPanel = document.getElementById('build-summary-panel');
                if (!root || !chartWrapper || !summaryPanel) return;
                const chartRect = chartWrapper.getBoundingClientRect();
                const panelRect = summaryPanel.getBoundingClientRect();
                const height = Math.round(chartRect.height);
                const viewportHeight = Math.max(0, Math.floor(window.innerHeight - panelRect.top - 16));
                if (height > 0) {
                    root.style.setProperty('--star-chart-panel-height', `${height}px`);
                }
                if (viewportHeight > 0) {
                    root.style.setProperty('--star-chart-panel-max-height', `${viewportHeight}px`);
                }
            };

            const scheduleSummaryPanelHeightSync = () => {
                requestAnimationFrame(() => {
                    syncSummaryPanelHeight();
                    requestAnimationFrame(syncSummaryPanelHeight);
                });
            };

            const templateOptions = computed(() => {
                const opts = [['-- Templates --', '']];
                for (let name in templates.value) {
                    opts.push([name, name]);
                }
                return opts;
            });

            const statFilterOptions = computed(() => {
                const labels = new Set();
                nodesList.value.forEach((node) => {
                    if (!Array.isArray(node.Stats)) return;
                    node.Stats.forEach((stat) => {
                        const name = String(stat?.name || '').trim();
                        if (name) labels.add(name);
                    });
                });

                const options = [['-- Highlight Stat --', '']];
                Array.from(labels)
                    .sort((left, right) => t(left).localeCompare(t(right)))
                    .forEach((name) => options.push([t(name), name]));
                return options;
            });

            const highlightedStatPaths = computed(() => {
                const statName = String(selectedStatFilter.value || '').trim();
                if (!statName) return new Set();

                const matching = new Set();
                nodesList.value.forEach((node) => {
                    if (!Array.isArray(node.Stats) || node.Type === 'Root') return;
                    const hasStat = node.Stats.some((stat) => String(stat?.name || '').trim() === statName);
                    if (hasStat) matching.add(node.Path);
                });
                return matching;
            });

            const highlightedStatNodeCount = computed(() => highlightedStatPaths.value.size);

            const searchMatchedPaths = computed(() => {
                const query = String(nodeSearchQuery.value || '').trim().toLowerCase();
                if (query.length < 2) return new Set();
                const matches = new Set();
                nodesList.value.forEach((node) => {
                    if (node.Type === 'Root') return;
                    const haystack = [];
                    if (node.Name) haystack.push(t(node.Name), node.Name);
                    if (node.Description) haystack.push(t(node.Description), node.Description);
                    if (Array.isArray(node.Abilities)) node.Abilities.forEach(a => haystack.push(t(a), a));
                    if (Array.isArray(node.Obtainables)) node.Obtainables.forEach(o => haystack.push(t(o), o));
                    if (Array.isArray(node.Stats)) node.Stats.forEach(s => { if (s && s.name) haystack.push(t(s.name), s.name); });
                    if (haystack.some(text => String(text || '').toLowerCase().includes(query))) {
                        matches.add(node.Path);
                    }
                });
                return matches;
            });

            const searchMatchCount = computed(() => searchMatchedPaths.value.size);
            const clearNodeSearch = () => { nodeSearchQuery.value = ""; };

            // The selectable-path list is static once the chart is loaded, so build
            // the id<->path maps once instead of on every selection change.
            let _codecMapsCache = null;
            const getCodecMaps = () => {
                if (_codecMapsCache) return _codecMapsCache;
                const selectablePaths = Object.keys(nodeMap)
                    .filter(path => nodeMap[path] && nodeMap[path].Type !== 'Root')
                    .sort();
                const pathToId = new Map();
                selectablePaths.forEach((path, index) => pathToId.set(path, index));
                _codecMapsCache = { selectablePaths, pathToId };
                return _codecMapsCache;
            };
            const getSelectablePathList = () => getCodecMaps().selectablePaths;

            const toBase64Url = (binary) => {
                return btoa(binary)
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=+$/g, '');
            };

            const fromBase64Url = (payload) => {
                const normalized = String(payload || '')
                    .replace(/-/g, '+')
                    .replace(/_/g, '/');
                const padLength = (4 - (normalized.length % 4)) % 4;
                return atob(normalized + '='.repeat(padLength));
            };

            const getSelectedTerminalPaths = (selection = selectedPaths) => {
                const selected = Array.from(selection)
                    .filter(path => nodeMap[path] && nodeMap[path].Type !== 'Root');

                return selected
                    .filter(path => !selected.some(other => other !== path && other.startsWith(`${path}.`)))
                    .sort();
            };

            const encodeCompactPath = (path) => {
                const [root, ...segments] = String(path || '').split('.');
                const rootAbbrev = ROOT_TO_ABBREV[root];
                if (!rootAbbrev || segments.length === 0) return null;
                return `${rootAbbrev}${segments.join('')}`;
            };

            const decodeCompactPath = (token) => {
                const compactToken = String(token || '').trim().toLowerCase();
                if (!compactToken) return null;

                const root = ABBREV_TO_ROOT[compactToken[0]];
                if (!root) return null;

                const remainder = compactToken.slice(1);
                const segments = remainder.match(/[a-z]+|\d+/g) || [];
                const fullPath = [root, ...segments].join('.');
                return nodeMap[fullPath] && nodeMap[fullPath].Type !== 'Root' ? fullPath : null;
            };

            const expandPathSelection = (path, collected = new Set()) => {
                let currentPath = path;
                while (currentPath && nodeMap[currentPath] && nodeMap[currentPath].Type !== 'Root') {
                    if (collected.has(currentPath)) break;
                    collected.add(currentPath);
                    const parentPath = nodeMap[currentPath].parentPath;
                    if (!parentPath || !nodeMap[parentPath] || nodeMap[parentPath].Type === 'Root') break;
                    currentPath = parentPath;
                }
                return collected;
            };

            const encodeBuildCodeFromSelection = (selection = selectedPaths) => {
                const { pathToId } = getCodecMaps();
                const ids = getSelectedTerminalPaths(selection)
                    .map(path => pathToId.get(path))
                    .filter(id => Number.isInteger(id))
                    .sort((left, right) => left - right);

                if (ids.length === 0) return '';

                const binary = String.fromCharCode(...ids);
                return `${COMPACT_CODE_PREFIX}${toBase64Url(binary)}`;
            };

            const decodeBuildCodeToPathSet = (code) => {
                const trimmed = String(code || '').trim();
                const expanded = new Set();
                if (!trimmed) return expanded;

                if (trimmed.startsWith(COMPACT_CODE_PREFIX) || trimmed.startsWith('v2:')) {
                    const payload = trimmed.slice(trimmed.indexOf(':') + 1);

                    if (payload.includes('|')) {
                        payload.split('|').forEach(token => {
                            const path = decodeCompactPath(token);
                            if (path) expandPathSelection(path, expanded);
                        });
                        return expanded;
                    }

                    try {
                        const { selectablePaths } = getCodecMaps();
                        const binary = fromBase64Url(payload);
                        Array.from(binary).forEach(char => {
                            const path = selectablePaths[char.charCodeAt(0)];
                            if (path) expandPathSelection(path, expanded);
                        });
                    } catch (error) {
                        return new Set();
                    }

                    return expanded;
                }

                try {
                    const decoded = atob(trimmed);
                    decoded.split('$').forEach(path => {
                        const normalizedPath = String(path || '').trim();
                        if (nodeMap[normalizedPath] && nodeMap[normalizedPath].Type !== 'Root') {
                            expanded.add(normalizedPath);
                        }
                    });
                } catch (error) {
                    return new Set();
                }

                return expanded;
            };

            const overwrites = computed(() => {
                let ow = new Set();
                selectedPaths.forEach(p => {
                    let node = nodeMap[p];
                    if (node && node.Overwrites) node.Overwrites.forEach(o => ow.add(o));
                });
                return ow;
            });

            const activePaths = computed(() => {
                return Array.from(selectedPaths).filter(p => !overwrites.value.has(p));
            });

            const replacementInfo = computed(() => {
                const selectedSet = new Set(Array.from(selectedPaths));
                const overwrittenSelected = new Set();
                const edges = [];

                selectedSet.forEach((path) => {
                    const node = nodeMap[path];
                    const directOverwrites = (node?.Overwrites || []).filter(overwrittenPath => selectedSet.has(overwrittenPath));
                    if (directOverwrites.length === 0) return;

                    directOverwrites.forEach((overwrittenPath) => overwrittenSelected.add(overwrittenPath));

                    const directParents = directOverwrites.filter((candidate) => {
                        return !directOverwrites.some((other) => {
                            if (other === candidate) return false;
                            const otherNode = nodeMap[other];
                            return Array.isArray(otherNode?.Overwrites) && otherNode.Overwrites.includes(candidate);
                        });
                    });

                    directParents.forEach((fromPath) => {
                        edges.push({ fromPath, toPath: path });
                    });
                });

                const tipSet = new Set();
                selectedSet.forEach((path) => {
                    const node = nodeMap[path];
                    const overwritesSelected = (node?.Overwrites || []).some(overwrittenPath => selectedSet.has(overwrittenPath));
                    if (overwritesSelected && !overwrittenSelected.has(path)) {
                        tipSet.add(path);
                    }
                });

                const chainNodeSet = new Set();
                edges.forEach((edge) => {
                    chainNodeSet.add(edge.fromPath);
                    chainNodeSet.add(edge.toPath);
                });

                return { edges, tipSet, chainNodeSet };
            });

            const summaryStats = computed(() => {
                let statsObj = {};
                activePaths.value.forEach(path => {
                    let node = nodeMap[path];
                    if (node && node.Stats) {
                        node.Stats.forEach(stat => {
                            let key = stat.name + (stat.percentage ? "_pct" : "_flat");
                            if (!statsObj[key]) statsObj[key] = { name: stat.name, percentage: stat.percentage, value: 0 };
                            statsObj[key].value += stat.value;
                        });
                    }
                });
                return Object.values(statsObj);
            });

            const summaryAbilities = computed(() => {
                let abs = [];
                activePaths.value.forEach(path => {
                    let node = nodeMap[path];
                    if (node && node.Abilities) abs.push(...node.Abilities);
                });
                return abs;
            });

            const summaryObtainables = computed(() => {
                let obsMap = {};
                activePaths.value.forEach(path => {
                    let node = nodeMap[path];
                    if (node && node.Obtainables) {
                        node.Obtainables.forEach(o => obsMap[o] = (obsMap[o] || 0) + 1);
                    }
                });
                return Object.entries(obsMap).map(([name, count]) => ({ name, count }));
            });

            const hasAnySelection = computed(() => {
                let has = false;
                selectedPaths.forEach(path => {
                    if (nodeMap[path]) has = true;
                });
                return has;
            });

            const selectedNodeCount = computed(() => selectedPaths.size);

            const persistState = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    buildCode: buildCode.value || "",
                    cheatModeEnabled: cheatModeEnabled.value,
                    summarySections: { ...summarySectionState }
                });
            };

            const renderNodes = computed(() => {
                const replacementTips = replacementInfo.value.tipSet;
                const statPaths = highlightedStatPaths.value;
                const searchPaths = searchMatchedPaths.value;
                const searchActive = String(nodeSearchQuery.value || '').trim().length >= 2;
                const hasStatFilter = Boolean(selectedStatFilter.value) || searchActive;
                return nodesList.value.map(node => {
                    const isSelected = selectedPaths.has(node.Path);
                    const isOverwritten = overwrites.value.has(node.Path);
                    const isReplacementTip = replacementTips.has(node.Path);
                    const isStatHighlighted = statPaths.has(node.Path) || searchPaths.has(node.Path);
                    const baseColor = node.fill;
                    
                    let rootActive = false;
                    if (node.Type === 'Root') {
                        for (let p of selectedPaths) {
                            if (nodeMap[p] && nodeMap[p].constellName === node.constellName) {
                                rootActive = true;
                                break;
                            }
                        }
                    }

                    return {
                        ...node,
                        selected: isSelected,
                        overwritten: isOverwritten,
                        rootActive: rootActive,
                        replacementTip: isReplacementTip,
                        statHighlighted: isStatHighlighted,
                        muted: !isSelected && !isOverwritten && node.Type !== 'Root',
                        style: node.Type === 'Root'
                            ? {
                                fill: rootActive ? 'rgba(255, 255, 255, 0.06)' : 'var(--bg-dark, #111)',
                                stroke: isReplacementTip ? REPLACEMENT_GOLD : mixColors(node.stroke, '#ffffff', rootActive ? 0.24 : 0)
                            }
                            : {
                                fill: isReplacementTip
                                    ? mixColors(baseColor, REPLACEMENT_GOLD, 0.34)
                                    : (isSelected || isStatHighlighted ? mixColors(baseColor, '#ffffff', isStatHighlighted ? 0.32 : 0.22) : baseColor),
                                stroke: isReplacementTip
                                    ? mixColors(REPLACEMENT_GOLD, '#ffffff', 0.18)
                                    : (isSelected || isStatHighlighted ? mixColors(baseColor, '#ffffff', isStatHighlighted ? 0.5 : 0.38) : '#0f1319'),
                                opacity: isOverwritten
                                    ? 0.24
                                    : (isSelected || isReplacementTip || isStatHighlighted
                                        ? 1
                                        : (hasStatFilter ? 0.2 : 0.62))
                            }
                    };
                });
            });

            const lines = computed(() => {
                return linesList.value.map(line => {
                    const isSelected = selectedPaths.has(line.pathId);
                    return {
                        ...line,
                        selected: isSelected
                    };
                });
            });

            const replacementCurves = computed(() => {
                const tips = replacementInfo.value.tipSet;

                return replacementInfo.value.edges.map((edge) => {
                    const from = getNodeCenter(edge.fromPath);
                    const to = getNodeCenter(edge.toPath);
                    if (!from || !to) return null;

                    const dx = to.x - from.x;
                    const dy = to.y - from.y;
                    const distance = Math.hypot(dx, dy) || 1;
                    const normalX = -dy / distance;
                    const normalY = dx / distance;
                    const bend = Math.max(30, Math.min(72, distance * 0.2));
                    const midpoint = {
                        x: (from.x + to.x) / 2,
                        y: (from.y + to.y) / 2
                    };

                    const candidates = [-1, 1].map((sign) => {
                        const control = {
                            x: midpoint.x + (normalX * bend * sign),
                            y: midpoint.y + (normalY * bend * sign)
                        };

                        let score = 0;
                        for (let step = 1; step < 12; step++) {
                            const point = sampleQuadratic(from, control, to, step / 12);

                            nodesList.value.forEach((node) => {
                                if (node.Path === edge.fromPath || node.Path === edge.toPath) return;
                                const radius = (node.r || 8) + 8;
                                const nodeDistance = Math.hypot(point.x - node.cx, point.y - node.cy);
                                if (nodeDistance < radius) {
                                    score += (radius - nodeDistance) * 10;
                                }
                            });

                            linesList.value.forEach((line) => {
                                if (line.pathId === edge.fromPath || line.pathId === edge.toPath) return;
                                const lineDistance = distancePointToSegment(point.x, point.y, line.x1, line.y1, line.x2, line.y2);
                                if (lineDistance < 10) {
                                    score += (10 - lineDistance) * 4;
                                }
                            });
                        }

                        const centerDistance = Math.hypot(control.x - origin.value[0], control.y - origin.value[1]);
                        score -= centerDistance * 0.02;

                        return { control, score };
                    });

                    candidates.sort((a, b) => a.score - b.score);
                    const best = candidates[0];

                    return {
                        id: `replacement-${edge.fromPath.replace(/\./g, '-')}-to-${edge.toPath.replace(/\./g, '-')}`,
                        d: `M ${from.x} ${from.y} Q ${best.control.x} ${best.control.y} ${to.x} ${to.y}`,
                        isTipEdge: tips.has(edge.toPath)
                    };
                }).filter(Boolean);
            });

            function registerNode(star, constellName, parentPath) {
                star.parentPath = parentPath;
                star.constellName = constellName;
                nodeMap[star.Path] = star;
                
                const isRoot = star.Type === 'Root';
                const isMajor = star.Type === 'Major';

                if (star.Coords) {
                    let nodeData = {
                        id: 'node-' + star.Path.replace(/\./g, "-"),
                        Path: star.Path,
                        Type: star.Type,
                        Name: star.Name,
                        Constellation: star.Constellation,
                        Description: star.Description,
                        Stats: star.Stats,
                        Abilities: star.Abilities,
                        Obtainables: star.Obtainables,
                        Overwrites: star.Overwrites,
                        constellName: constellName
                    };

                    if (isRoot) {
                        const size = 14;
                        const [cx, cy] = withChartOffset(star.Coords);
                        nodeData.points = `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`;
                        nodeData.stroke = COLORS[constellName].major;
                    } else {
                        const [cx, cy] = withChartOffset(star.Coords);
                        nodeData.cx = cx;
                        nodeData.cy = cy;
                        nodeData.r = isMajor ? 13 : 8;
                        nodeData.fill = COLORS[constellName] ? COLORS[constellName][isMajor ? "major" : "minor"] : "#fff";
                    }
                    nodesList.value.push(nodeData);
                }

                if (star.Stars && star.Stars.length > 0) {
                    star.Stars.forEach(child => {
                        if (star.Coords && child.Coords) {
                            const [x1, y1] = withChartOffset(star.Coords);
                            const [x2, y2] = withChartOffset(child.Coords);
                            linesList.value.push({
                                id: 'line-' + child.Path.replace(/\./g, "-"),
                                pathId: child.Path,
                                x1: x1, y1: y1,
                                x2: x2, y2: y2
                            });
                        }
                        registerNode(child, constellName, star.Path);
                    });
                }
            }

            const getAncestorsToSelect = (path, newNodes = []) => {
                if (!path || selectedPaths.has(path)) return newNodes;
                newNodes.push(path);
                const node = nodeMap[path];
                if (node && node.parentPath && nodeMap[node.parentPath].Type !== "Root") {
                    return getAncestorsToSelect(node.parentPath, newNodes);
                }
                return newNodes;
            };

            const deselectNodeAndChildren = (path) => {
                if (!path) return;
                selectedPaths.delete(path);
                Object.values(nodeMap).forEach(child => {
                    if (child.parentPath === path) deselectNodeAndChildren(child.Path);
                });
            };

            const selectAllDescendants = (rootPath) => {
                const rootNode = nodeMap[rootPath];
                if (!rootNode) return;
                let limitHit = false;
                Object.values(nodeMap).forEach(node => {
                    if (node.constellName === rootNode.constellName && node.Type !== "Root") {
                        if (!selectedPaths.has(node.Path)) {
                            if (selectedPaths.size >= maxNodeLimit.value) { limitHit = true; return; }
                            selectedPaths.add(node.Path);
                        }
                    }
                });
                if (limitHit) window.showToast(t("Cannot exceed maximum of {limit} active nodes.").replace("{limit}", maxNodeLimit.value), true);
            };

            let clickTimer = null;
            let centerClickTimer = null;
            const onRootClick = (node, e) => {
                if (e.detail === 1) {
                    clickTimer = setTimeout(() => {
                        deselectNodeAndChildren(node.Path);
                    }, 250);
                } else if (e.detail === 2) {
                    clearTimeout(clickTimer);
                    selectAllDescendants(node.Path);
                }
            };

            const selectAllNodes = () => {
                let limitHit = false;
                Object.values(nodeMap).forEach(node => {
                    if (node.Type !== "Root" && !selectedPaths.has(node.Path)) {
                        if (selectedPaths.size >= maxNodeLimit.value) {
                            limitHit = true;
                            return;
                        }
                        selectedPaths.add(node.Path);
                    }
                });
                if (limitHit) {
                    window.showToast(t("Cannot exceed maximum of {limit} active nodes.").replace("{limit}", maxNodeLimit.value), true);
                }
            };

            const onCenterAnchorClick = (e) => {
                if (e.detail === 1) {
                    centerClickTimer = setTimeout(() => {
                        clearAllSelectedNodes();
                    }, 250);
                } else if (e.detail === 2) {
                    clearTimeout(centerClickTimer);
                    if (!cheatModeEnabled.value) return;
                    selectAllNodes();
                }
            };

            const onNodeClick = (node) => {
                if (selectedPaths.has(node.Path)) {
                    deselectNodeAndChildren(node.Path);
                } else {
                    const nodesToAdd = getAncestorsToSelect(node.Path, []);
                    if (selectedPaths.size + nodesToAdd.length > maxNodeLimit.value) {
                        window.showToast(t("Cannot exceed maximum of {limit} active nodes.").replace("{limit}", maxNodeLimit.value), true);
                        return;
                    }
                    nodesToAdd.forEach(p => selectedPaths.add(p));
                }
            };

            const toggleCheatMode = () => {
                if (cheatModeEnabled.value && selectedPaths.size > 40) {
                    window.showToast(t("Reduce active nodes to 40 or fewer before disabling Cheat Mode."), true);
                    return;
                }

                cheatModeEnabled.value = !cheatModeEnabled.value;
                persistState();

                if (window.showToast) {
                    window.showToast(
                        cheatModeEnabled.value
                            ? t("Cheat Mode enabled. Node limit set to 120.")
                            : t("Cheat Mode disabled. Node limit set to 40.")
                    );
                }
            };

            const clearAllSelectedNodes = () => {
                if (selectedPaths.size === 0) return;
                selectedPaths.clear();
                if (window.showToast) window.showToast(t('All active nodes cleared.'));
            };

            const clearStatFilter = () => {
                selectedStatFilter.value = "";
            };

            const _svgPointFromEvent = (e) => {
                const svg = document.getElementById('chart-svg');
                if (!svg) return null;
                const rect = svg.getBoundingClientRect();
                if (!rect.width || !rect.height) return null;
                const relX = (e.clientX - rect.left) / rect.width;
                const relY = (e.clientY - rect.top) / rect.height;
                return { x: viewBox.x + relX * viewBox.w, y: viewBox.y + relY * viewBox.h, relX, relY };
            };

            const onChartWheel = (e) => {
                const pt = _svgPointFromEvent(e);
                if (!pt) return;
                const factor = e.deltaY < 0 ? 0.85 : 1.0 / 0.85;
                const newW = Math.min(MAX_VIEW_W, Math.max(MIN_VIEW_W, viewBox.w * factor));
                const newH = newW / VIEWBOX_ASPECT;
                // Keep the point under the cursor stationary while zooming.
                viewBox.x = pt.x - pt.relX * newW;
                viewBox.y = pt.y - pt.relY * newH;
                viewBox.w = newW;
                viewBox.h = newH;
            };

            let panState = null;
            const _onPanMove = (e) => {
                if (!panState) return;
                viewBox.x = panState.startVbX - (e.clientX - panState.startClientX) * panState.unitsPerPxX;
                viewBox.y = panState.startVbY - (e.clientY - panState.startClientY) * panState.unitsPerPxY;
            };
            const _onPanUp = () => {
                window.removeEventListener('mousemove', _onPanMove);
                window.removeEventListener('mouseup', _onPanUp);
                const svg = document.getElementById('chart-svg');
                if (svg) svg.classList.remove('panning');
                panState = null;
            };
            const onChartMouseDown = (e) => {
                // Pan only from empty chart background, never when grabbing a node/anchor
                // (those keep their own click handlers).
                const target = e.target;
                if (e.button !== 0 || (target && target.classList &&
                    (target.classList.contains('star-node') || target.classList.contains('center-clear-anchor')))) {
                    return;
                }
                const svg = document.getElementById('chart-svg');
                const rect = svg ? svg.getBoundingClientRect() : null;
                if (!rect || !rect.width || !rect.height) return;
                e.preventDefault();
                panState = {
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    startVbX: viewBox.x,
                    startVbY: viewBox.y,
                    unitsPerPxX: viewBox.w / rect.width,
                    unitsPerPxY: viewBox.h / rect.height
                };
                svg.classList.add('panning');
                window.addEventListener('mousemove', _onPanMove);
                window.addEventListener('mouseup', _onPanUp);
            };

            const zoomBy = (factor) => {
                const cx = viewBox.x + viewBox.w / 2;
                const cy = viewBox.y + viewBox.h / 2;
                const newW = Math.min(MAX_VIEW_W, Math.max(MIN_VIEW_W, viewBox.w * factor));
                const newH = newW / VIEWBOX_ASPECT;
                viewBox.x = cx - newW / 2;
                viewBox.y = cy - newH / 2;
                viewBox.w = newW;
                viewBox.h = newH;
            };

            const resetView = () => {
                viewBox.x = DEFAULT_VIEWBOX.x;
                viewBox.y = DEFAULT_VIEWBOX.y;
                viewBox.w = DEFAULT_VIEWBOX.w;
                viewBox.h = DEFAULT_VIEWBOX.h;
            };

            const toggleSummarySection = (sectionKey) => {
                if (!Object.prototype.hasOwnProperty.call(summarySectionState, sectionKey)) return;
                summarySectionState[sectionKey] = !summarySectionState[sectionKey];
                persistState();
            };

            const normalizeCode = (code) => {
                if (!code) return "";
                return Array.from(decodeBuildCodeToPathSet(code)).sort().join('$');
            };

            watch(selectedPaths, () => {
                if (!codeInputFocused.value) {
                    buildCode.value = encodeBuildCodeFromSelection();
                }
                updateTemplateDropdown();
                persistState();
            }, { deep: true });

            const updateTemplateDropdown = () => {
                let matchedTemplate = "";
                const currentCode = buildCode.value.trim();
                const normalizedCurrent = normalizeCode(currentCode);
                
                for (let name in templates.value) {
                    if (normalizeCode(templates.value[name]) === normalizedCurrent && currentCode !== "") {
                        matchedTemplate = name;
                        break;
                    }
                }
                selectedTemplate.value = matchedTemplate;
            };

            const loadCode = (silentArg) => {
                const isSilent = silentArg === true;
                const code = buildCode.value.trim();
                if (!code) return;
                try {
                    const paths = Array.from(decodeBuildCodeToPathSet(code));
                    let hasValid = paths.length > 0;
                    
                    if (!hasValid) {
                        if (!isSilent) window.showToast(t("No valid nodes found in build code."), true);
                        return;
                    }

                    selectedPaths.clear();
                    let loaded = 0, skipped = 0;

                    paths.sort((left, right) => left.split('.').length - right.split('.').length);

                    paths.forEach(p => {
                        if (nodeMap[p] && nodeMap[p].Type !== "Root") {
                            if (selectedPaths.size < maxNodeLimit.value && !selectedPaths.has(p)) {
                                selectedPaths.add(p);
                                loaded++;
                            } else {
                                skipped++;
                            }
                        }
                    });
                    
                    if (!isSilent) {
                        if (skipped > 0) window.showToast(t("Loaded {loaded} nodes. Skipped {skipped} (Max {limit} limit).").replace("{loaded}", loaded).replace("{skipped}", skipped).replace("{limit}", maxNodeLimit.value), true);
                        else if (loaded > 0) window.showToast(t("Successfully loaded {loaded} nodes!").replace("{loaded}", loaded));
                    }
                } catch (e) {
                    if (!isSilent) window.showToast(t("Invalid build code format."), true);
                }
            };

            watch(buildCode, (newVal) => {
                if (codeInputFocused.value && newVal) {
                    loadCode(true);
                }
            });

            watch(selectedNodeCount, () => {
                scheduleSummaryPanelHeightSync();
            });

            const copyCode = () => {
                const code = buildCode.value;
                if (!code) { window.showToast(t("No nodes selected to copy."), true); return; }
                navigator.clipboard.writeText(code).then(() => window.showToast(t("Build code copied to clipboard!"))).catch(err => window.showToast(t("Failed to copy: {error}").replace("{error}", err), true));
            };

            watch(selectedTemplate, (newVal) => {
                if (newVal && templates.value[newVal]) {
                    buildCode.value = templates.value[newVal];
                    loadCode();
                }
            });

            const fetchTemplates = async () => {
                const templatesResp = await eel.get_star_chart_templates()();
                templates.value = unwrapResp(templatesResp, 'templates', {});
                updateTemplateDropdown();
            };

            const saveTemplate = () => {
                if (cheatModeEnabled.value) {
                    window.showToast(t("Disable Cheat Mode before saving templates."), true);
                    return;
                }
                const code = buildCode.value.trim();
                if (!code) { window.showToast(t("No active build to save."), true); return; }
                modal.action = 'save';
                modal.title = t('Save Template');
                modal.msg = t('Enter a name for your build:');
                modal.showInput = true;
                modal.inputValue = '';
                modal.show = true;
                nextTick(() => { if (modalInputRef.value) modalInputRef.value.focus(); });
            };

            const deleteTemplate = () => {
                const name = selectedTemplate.value;
                if (!name) return;
                modal.action = 'delete';
                modal.title = t('Delete Template');
                modal.msg = t("Are you sure you want to delete '{name}'?").replace("{name}", name);
                modal.showInput = false;
                modal.show = true;
            };

            const confirmOverwrite = async (name) => {
                if (!templates.value[name]) return true;
                if (!window.showConfirmModal) return true;
                return await window.showConfirmModal({
                    title: t('Overwrite Template'),
                    message: t("A template named '{name}' already exists. Overwrite it?").replace("{name}", name),
                    confirmLabel: t('Overwrite'),
                    cancelLabel: t('Cancel'),
                    danger: true
                });
            };

            const confirmModal = async () => {
                if (modal.action === 'save') {
                    const name = modal.inputValue.trim();
                    if (!name) return window.showToast(t("Please enter a name."), true);
                    const code = buildCode.value.trim();
                    modal.show = false;
                    if (!(await confirmOverwrite(name))) return;
                    const res = await eel.save_star_chart_template(name, code)();
                    if (res.success) {
                        window.showToast(t("Template '{name}' saved!").replace("{name}", name));
                        await fetchTemplates();
                        selectedTemplate.value = name;
                    } else window.showToast(t("Error saving template."), true);
                    return;
                } else if (modal.action === 'rename') {
                    const newName = modal.inputValue.trim();
                    const oldName = modal.renameFrom;
                    modal.show = false;
                    if (!newName) return window.showToast(t("Please enter a name."), true);
                    if (newName === oldName) return;
                    const code = templates.value[oldName];
                    if (code === undefined) return;
                    if (!(await confirmOverwrite(newName))) return;
                    const saveRes = await eel.save_star_chart_template(newName, code)();
                    if (saveRes.success) {
                        await eel.delete_star_chart_template(oldName)();
                        await fetchTemplates();
                        selectedTemplate.value = newName;
                        window.showToast(t("Template renamed to '{name}'.").replace("{name}", newName));
                    } else window.showToast(t("Error renaming template."), true);
                    return;
                } else if (modal.action === 'delete') {
                    const name = selectedTemplate.value;
                    const res = await eel.delete_star_chart_template(name)();
                    if (res.success) {
                        window.showToast(t("Template '{name}' deleted!").replace("{name}", name));
                        await fetchTemplates();
                        selectedTemplate.value = '';
                    } else window.showToast(t("Error deleting template."), true);
                }
                modal.show = false;
            };

            const renameTemplate = () => {
                const name = selectedTemplate.value;
                if (!name) return;
                modal.action = 'rename';
                modal.renameFrom = name;
                modal.title = t('Rename Template');
                modal.msg = t('Enter a new name:');
                modal.showInput = true;
                modal.inputValue = name;
                modal.show = true;
                nextTick(() => { if (modalInputRef.value) { modalInputRef.value.focus(); modalInputRef.value.select(); } });
            };

            const exportTemplates = () => {
                const names = Object.keys(templates.value || {});
                if (names.length === 0) { window.showToast(t("No templates to export."), true); return; }
                const blob = new Blob([JSON.stringify(templates.value, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'star_chart_templates.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 0);
            };

            const triggerImportTemplates = () => {
                if (importTemplatesRef.value) importTemplatesRef.value.click();
            };

            const onImportTemplatesFile = async (e) => {
                const file = e.target && e.target.files && e.target.files[0];
                if (e.target) e.target.value = '';
                if (!file) return;
                try {
                    const parsed = JSON.parse(await file.text());
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
                    const entries = Object.entries(parsed).filter(([key, value]) => key && typeof value === 'string');
                    if (entries.length === 0) { window.showToast(t("No valid templates in file."), true); return; }
                    let imported = 0;
                    for (const [name, code] of entries) {
                        const res = await eel.save_star_chart_template(name, code)();
                        if (res && res.success) imported++;
                    }
                    await fetchTemplates();
                    window.showToast(t("Imported {count} templates.").replace("{count}", imported));
                } catch (err) {
                    window.showToast(t("Invalid templates file."), true);
                }
            };

            const showTooltip = (e, node) => {
                tooltip.node = node;
                tooltip.show = true;
                moveTooltip(e);
            };
            const moveTooltip = (e) => {
                if (!tooltip.show) return;
                let x = e.clientX + 15, y = e.clientY + 15;
                const ttEl = document.getElementById('star-tooltip');
                if (ttEl) {
                    if (x + ttEl.offsetWidth > window.innerWidth) x = e.clientX - ttEl.offsetWidth - 15;
                    if (y + ttEl.offsetHeight > window.innerHeight) y = e.clientY - ttEl.offsetHeight - 15;
                }
                tooltip.x = x; tooltip.y = y;
            };
            const hideTooltip = () => { tooltip.show = false; tooltip.node = null; };

            const showContextMenu = (e, node) => {
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                }
                hideTooltip();
                if (!window.ContextMenu) return;
                const items = [];

                if (node.Type === 'Root') {
                    items.push({
                        label: 'Select Constellation',
                        icon: 'fa-check-double',
                        action: () => selectAllDescendants(node.Path)
                    });
                    items.push({
                        label: 'Deselect Constellation',
                        icon: 'fa-ban',
                        action: () => deselectNodeAndChildren(node.Path)
                    });
                } else {
                    const isSelected = selectedPaths.has(node.Path);
                    items.push({
                        label: isSelected ? 'Deselect Node' : 'Select Node',
                        icon: isSelected ? 'fa-minus' : 'fa-plus',
                        action: () => onNodeClick(node)
                    });
                }

                items.push({ separator: true });
                items.push({
                    label: 'Copy Name',
                    icon: 'fa-copy',
                    action: () => navigator.clipboard.writeText(t(node.Name || node.Constellation)).then(() => { if (window.showToast) window.showToast(t("Copied to clipboard!")); })
                });

                window.ContextMenu.show(e, items);
            };

            onMounted(async () => {
                await fetchTemplates();

                const response = await eel.get_calculated_star_chart()();
                if (response.success) {
                    const data = unwrapResp(response, null, {});
                    const responseOrigin = response.origin || response.data?.origin || [500, 500];
                    chartBaseOrigin.value = responseOrigin;
                    origin.value = withChartOffset(responseOrigin);
                    
                    Object.keys(COLORS).forEach(constellName => {
                        if (data[constellName]) {
                            registerNode(data[constellName], constellName, null);
                            if (data[constellName].Coords) {
                                const [rootX, rootY] = withChartOffset(data[constellName].Coords);
                                linesList.value.push({
                                    id: 'line-' + data[constellName].Path + '_rootline',
                                    pathId: data[constellName].Path + '_rootline',
                                    x1: origin.value[0], y1: origin.value[1],
                                    x2: rootX, y2: rootY
                                });
                            }
                        }
                    });
                    isLoading.value = false;

                    if (window.AppSettings) {
                        await window.AppSettings.load();
                        const savedState = window.AppSettings.getPref(PREF_STATE_KEY, null);
                        if (savedState && typeof savedState === 'object') {
                            cheatModeEnabled.value = savedState.cheatModeEnabled === true;
                            if (savedState.summarySections && typeof savedState.summarySections === 'object') {
                                ['stats', 'abilities', 'obtainables'].forEach(key => {
                                    if (typeof savedState.summarySections[key] === 'boolean') {
                                        summarySectionState[key] = savedState.summarySections[key];
                                    }
                                });
                            }
                            if (savedState.buildCode) {
                                buildCode.value = savedState.buildCode;
                                loadCode(true);
                            }
                        }
                    }

                    nextTick(() => {
                        if (window.applyCustomDropdowns) window.applyCustomDropdowns();
                        scheduleSummaryPanelHeightSync();

                        const chartWrapper = document.getElementById('chart-wrapper');
                        if (chartWrapper && typeof ResizeObserver !== 'undefined') {
                            chartResizeObserver = new ResizeObserver(() => {
                                syncSummaryPanelHeight();
                            });
                            chartResizeObserver.observe(chartWrapper);
                        }

                        window.addEventListener('resize', syncSummaryPanelHeight);
                    });
                } else {
                    window.showToast(t("Error loading chart data: {error}").replace("{error}", response.error), true);
                }
            });

            onBeforeUnmount(() => {
                if (chartResizeObserver) {
                    chartResizeObserver.disconnect();
                    chartResizeObserver = null;
                }
                window.removeEventListener('resize', syncSummaryPanelHeight);
                window.removeEventListener('mousemove', _onPanMove);
                window.removeEventListener('mouseup', _onPanUp);
            });

            return {
                t, isLoading, origin, lines, replacementCurves, renderNodes,
                selectedNodeCount, maxNodeLimit, cheatModeEnabled, summaryStats, summaryAbilities, summaryObtainables, hasAnySelection,
                onRootClick, onNodeClick, onCenterAnchorClick, clearAllSelectedNodes, toggleCheatMode,
                summarySectionState, toggleSummarySection,
                buildCode, codeInputFocused, loadCode, copyCode,
                selectedStatFilter, statFilterOptions, highlightedStatNodeCount, clearStatFilter,
                nodeSearchQuery, searchMatchCount, clearNodeSearch,
                viewBoxStr, onChartWheel, onChartMouseDown, zoomBy, resetView,
                selectedTemplate, templateOptions, saveTemplate, deleteTemplate, renameTemplate,
                exportTemplates, triggerImportTemplates, onImportTemplatesFile, importTemplatesRef,
                modal, modalInputRef, confirmModal,
                tooltip, showTooltip, moveTooltip, hideTooltip, showContextMenu
            };
        }
    });

    if (window._starChartApp) window._starChartApp.unmount();
    window._starChartApp = app;

    app.component('custom-vue-select', window.CustomVueSelect);

    app.mount('#star-chart-vue-app-inner');
});
