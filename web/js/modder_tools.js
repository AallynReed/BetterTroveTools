document.addEventListener('modder_tools_loaded', () => {
    console.log("Modder Tools Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
            const PREF_STATE_KEY = 'state_modder_tools';
            let hydratingState = false;

            const activeTab = ref('build');
            let embeddedFileManagerLoaded = false;
            let embeddedFileManagerLoading = null;
            
            const installs = ref([]);
            const selectedGamePath = ref('');
            const lastBuildOutputPath = ref('');
            const lastCompiledProjectPath = ref('');
            
            const gameOptions = computed(() => {
                if (installs.value.length === 0) return [[t('Searching...'), '']];
                return installs.value.map(g => [`${g.name} - ${g.path}`, g.path]);
            });

            const tagOptions = ref([
                {id: 'Allies', text: 'Allies'}, {id: 'Banners', text: 'Banners'}, {id: 'Boats and Sails', text: 'Boats and Sails'},
                {id: 'Cosmetics', text: 'Cosmetics'}, {id: 'Costumes', text: 'Costumes'}, {id: 'Dragons', text: 'Dragons'},
                {id: 'Fishing', text: 'Fishing'}, {id: 'GUI', text: 'GUI'}, {id: 'Helmets', text: 'Helmets'},
                {id: 'Language', text: 'Language'}, {id: 'Mag Riders', text: 'Mag Riders'}, {id: 'Mounts', text: 'Mounts'},
                {id: 'NPCs', text: 'NPCs'}, {id: 'Utility', text: 'Utility'}, {id: 'Waypoint', text: 'Waypoint'},
                {id: 'Wings', text: 'Wings'}, {id: 'VFX', text: 'VFX'}
            ]);

            const normalizeInternalPath = (value) => String(value || '').replaceAll('\\', '/').trim().toLowerCase();
            const defaultConfigInternalPath = 'ui/default.cfg';
            const previewInternalPath = (name) => `ui/${String(name || '').replace(/[\\/*?:"<>|]/g, '').trim()}`;

            const validateSpecialFileSelections = ({ files, previewName, hasPreview, hasConfig }) => {
                const seen = new Set();
                for (const file of files || []) {
                    const internalPath = normalizeInternalPath(file.internal_path);
                    if (!internalPath) continue;
                    if (seen.has(internalPath)) return 'You cannot add the same file path more than once.';
                    seen.add(internalPath);
                }

                if (hasConfig && seen.has(defaultConfigInternalPath)) {
                    return 'default.cfg can only be added through the config file option.';
                }

                if (hasPreview) {
                    const previewPath = normalizeInternalPath(previewInternalPath(previewName || 'preview.png'));
                    if (seen.has(previewPath)) return 'Preview image path cannot also be included in the files list.';
                }

                const cfgPaths = [...seen].filter(path => path.endsWith('.cfg'));
                if (hasConfig) cfgPaths.push(defaultConfigInternalPath);
                if (cfgPaths.length > 1) return 'Only one config file can be included in a mod.';
                if (cfgPaths.length === 1) {
                    if (cfgPaths[0] !== defaultConfigInternalPath) return 'default.cfg can only be added through the config file option.';
                }

                return null;
            };

            const build = reactive({
                title: '', author: '', version: '1.0', notes: '', tags: [], files: [],
                preview: '', previewName: '', config: '', configName: ''
            });

            const extract = reactive({
                source: '', dest: ''
            });

            const project = reactive({
                dir: '', title: '', author: '', notes: '', tags: [],
                versions: [], activeVersion: '', files: [],
                preview: '', previewName: '', config: '', configName: '', activeOverrides: []
            });

            const softwareCategories = ref({});

            const isWorking = reactive({
                detectingOverrides: false,
                autoStructuringBuild: false,
                buildingTMod: false,
                extracting: false,
                refreshProjectFiles: false,
                autoStructuringProject: false,
                compilingProject: false,
                placingOverrides: false,
                removingOverrides: false,
                savingQb: false
            });

            const clampQbByte = (value, fallback = 0) => {
                const parsed = Number.parseInt(value, 10);
                if (!Number.isFinite(parsed)) return fallback;
                return Math.max(0, Math.min(255, parsed));
            };

            const coerceQbInt = (value, fallback = 0) => {
                const parsed = Number.parseInt(value, 10);
                return Number.isFinite(parsed) ? parsed : fallback;
            };

            const coerceQbSize = (value, fallback = 16) => Math.max(1, coerceQbInt(value, fallback));
            const qbVoxelKey = (x, y, z) => `${x},${y},${z}`;
            const qbVoxelHex = (voxel) => `#${[voxel[3], voxel[4], voxel[5]].map(channel => clampQbByte(channel).toString(16).padStart(2, '0')).join('')}`;
            const qbVoxelSort = (a, b) => (a[2] - b[2]) || (a[1] - b[1]) || (a[0] - b[0]);
            const qbIsAttachmentVoxel = (voxel) => Array.isArray(voxel) && voxel[3] === 255 && voxel[4] === 0 && voxel[5] === 255;
            const qbAttachmentStrokeColor = '#ff3fd5';
            const qbAttachmentGlowColor = 'rgba(255, 63, 213, 0.18)';

            const normalizeQbVoxel = (voxel) => {
                if (!Array.isArray(voxel) || voxel.length < 7) return null;
                return [
                    coerceQbInt(voxel[0], 0),
                    coerceQbInt(voxel[1], 0),
                    coerceQbInt(voxel[2], 0),
                    clampQbByte(voxel[3], 0),
                    clampQbByte(voxel[4], 0),
                    clampQbByte(voxel[5], 0),
                    clampQbByte(voxel[6], 255)
                ];
            };

            const normalizeQbMatrix = (matrix, fallbackName = 'Matrix') => {
                const nextMatrix = {
                    name: String(matrix?.name || fallbackName).trim() || fallbackName,
                    size_x: coerceQbSize(matrix?.size_x, 16),
                    size_y: coerceQbSize(matrix?.size_y, 16),
                    size_z: coerceQbSize(matrix?.size_z, 16),
                    pos_x: coerceQbInt(matrix?.pos_x, 0),
                    pos_y: coerceQbInt(matrix?.pos_y, 0),
                    pos_z: coerceQbInt(matrix?.pos_z, 0),
                    voxels: []
                };

                const deduped = new Map();
                (matrix?.voxels || []).forEach((voxel) => {
                    const normalized = normalizeQbVoxel(voxel);
                    if (!normalized) return;
                    if (normalized[0] < 0 || normalized[0] >= nextMatrix.size_x) return;
                    if (normalized[1] < 0 || normalized[1] >= nextMatrix.size_y) return;
                    if (normalized[2] < 0 || normalized[2] >= nextMatrix.size_z) return;
                    if (normalized[6] <= 0) return;
                    deduped.set(qbVoxelKey(normalized[0], normalized[1], normalized[2]), normalized);
                });

                nextMatrix.voxels = Array.from(deduped.values()).sort(qbVoxelSort);
                nextMatrix.voxel_count = nextMatrix.voxels.length;
                return nextMatrix;
            };

            const createQbMatrix = (overrides = {}) => normalizeQbMatrix({
                name: overrides.name || 'Matrix 1',
                size_x: overrides.size_x ?? 16,
                size_y: overrides.size_y ?? 16,
                size_z: overrides.size_z ?? 16,
                pos_x: overrides.pos_x ?? 0,
                pos_y: overrides.pos_y ?? 0,
                pos_z: overrides.pos_z ?? 0,
                voxels: overrides.voxels || []
            }, overrides.name || 'Matrix 1');

            const createEmptyQbDocument = () => ({
                path: '',
                file_name: 'untitled.qb',
                source_format: 'qb',
                source_file_type: 'qb',
                header: {
                    version: 257,
                    color_format: 0,
                    z_axis_orientation: 1,
                    compressed: true,
                    visibility_mask_encoded: false
                },
                matrices: [createQbMatrix({ name: 'Matrix 1' })]
            });

            const qbEditor = reactive({
                path: '',
                fileName: 'untitled.qb',
                sourceFormat: 'qb',
                sourceFileType: 'qb',
                containerPath: '',
                containerFileName: '',
                packageTree: null,
                packageAssets: {},
                selectedAssetId: '',
                dirtyAssetIds: [],
                dirty: false,
                header: {
                    version: 257,
                    color_format: 0,
                    z_axis_orientation: 1,
                    compressed: true,
                    visibility_mask_encoded: false
                },
                matrices: [createQbMatrix({ name: 'Matrix 1' })],
                selectedMatrixIndex: 0,
                viewMode: '3d',
                selectedSlice: 0,
                sliceZoom: 22,
                clipMode: 'off',
                paintColor: '#ff6b6b',
                paintAlpha: 255,
                hoverCell: null,
                hoverFace: null,
                activeTool: 'orbit',
                viewYaw: -0.72,
                viewPitch: 0.58,
                viewZoom: 1,
                viewPanX: 0,
                viewPanY: 0
            });

            const qbMatrixForm = reactive({
                name: 'Matrix 1',
                size_x: 16,
                size_y: 16,
                size_z: 16,
                pos_x: 0,
                pos_y: 0,
                pos_z: 0
            });

            const qbCanvasRef = ref(null);
            const qbViewportCanvasRef = ref(null);
            const qbPointerMode = ref(null);
            const qbSelectedLookup = ref(new Map());
            const qbViewportFaceHits = ref([]);
            const qbViewportState = {
                mode: null,
                lastX: 0,
                lastY: 0,
                lastFaceKey: '',
            };
            const qbMouseUpHandler = () => {
                qbPointerMode.value = null;
                qbViewportState.mode = null;
                qbViewportState.lastFaceKey = '';
            };
            const qbResizeHandler = () => { scheduleQbCanvasRender(); };
            let qbHydratingDocument = false;

            const qbFaceDefinitions = [
                { id: 'px', normal: [1, 0, 0], neighbor: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.94 },
                { id: 'nx', normal: [-1, 0, 0], neighbor: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], shade: 0.72 },
                { id: 'py', normal: [0, 1, 0], neighbor: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1.12 },
                { id: 'ny', normal: [0, -1, 0], neighbor: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.56 },
                { id: 'pz', normal: [0, 0, 1], neighbor: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], shade: 0.84 },
                { id: 'nz', normal: [0, 0, -1], neighbor: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], shade: 0.66 }
            ];

            const selectedQbMatrix = computed(() => qbEditor.matrices[qbEditor.selectedMatrixIndex] || null);
            const qbPackageActive = computed(() => Boolean(qbEditor.packageTree && Object.keys(qbEditor.packageAssets || {}).length));
            const qbHasUnsavedAssets = computed(() => {
                if (qbPackageActive.value) return (qbEditor.dirtyAssetIds || []).length > 0;
                return Boolean(qbEditor.dirty);
            });
            const qbSelectedAsset = computed(() => {
                if (!qbPackageActive.value || !qbEditor.selectedAssetId) return null;
                return qbEditor.packageAssets?.[qbEditor.selectedAssetId] || null;
            });
            const qbDisplayName = computed(() => {
                if (qbSelectedAsset.value?.asset_label) return qbSelectedAsset.value.asset_label;
                return qbEditor.fileName || (qbEditor.path ? qbEditor.path.split(/[\\/]/).pop() : 'untitled.qb');
            });
            const qbContainerName = computed(() => qbEditor.containerFileName || qbEditor.fileName || 'untitled.qb');
            const qbVersionLabel = computed(() => {
                const version = Number(qbEditor.header.version || 0) >>> 0;
                return [
                    version & 255,
                    (version >>> 8) & 255,
                    (version >>> 16) & 255,
                    (version >>> 24) & 255
                ].join('.');
            });
            const qbTotalVoxelCount = computed(() => qbEditor.matrices.reduce((sum, matrix) => sum + ((matrix?.voxels || []).length), 0));
            const qbCellSize = computed(() => Math.max(12, Math.min(34, coerceQbInt(qbEditor.sliceZoom, 22))));

            const qbClipPassesVoxel = (voxel) => {
                if (!voxel) return false;
                if (qbEditor.clipMode === 'slice') return voxel[2] === qbEditor.selectedSlice;
                if (qbEditor.clipMode === 'below') return voxel[2] <= qbEditor.selectedSlice;
                return true;
            };

            const qbVisibleVoxelCount = computed(() => {
                const matrix = selectedQbMatrix.value;
                if (!matrix) return 0;
                return (matrix.voxels || []).filter(qbClipPassesVoxel).length;
            });

            const qbActiveToolLabel = computed(() => {
                switch (qbEditor.activeTool) {
                    case 'paint': return t('Paint');
                    case 'add': return t('Add');
                    case 'erase': return t('Erase');
                    case 'sample': return t('Sample');
                    case 'pan': return t('Pan');
                    default: return t('Orbit');
                }
            });

            const flattenQbBlueprintTree = (node, depth = 0, rows = []) => {
                if (!node || typeof node !== 'object') return rows;
                const nodePath = String(node.path || '');
                const hideNode = String(node.kind || '').toLowerCase() === 'blueprint'
                    && /_entities\.blueprint$/i.test(nodePath);
                if (!hideNode) {
                    rows.push({
                        id: String(node.id || `node_${rows.length}`),
                        label: String(node.label || 'Item'),
                        depth,
                        kind: String(node.kind || 'item'),
                        assetId: node.asset_id || '',
                        path: nodePath,
                        error: String(node.error || '')
                    });
                }
                (node.children || []).forEach((child) => flattenQbBlueprintTree(child, hideNode ? depth : depth + 1, rows));
                return rows;
            };

            const qbBlueprintAssetRows = computed(() => flattenQbBlueprintTree(qbEditor.packageTree));

            const shadeQbColor = (r, g, b, shade) => {
                const clamp = (channel) => Math.max(0, Math.min(255, Math.round(channel * shade)));
                return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
            };

            const setQbViewMode = (mode) => {
                qbEditor.viewMode = mode === '2d' ? '2d' : '3d';
                qbEditor.hoverFace = null;
                qbEditor.hoverCell = null;
                qbViewportState.mode = null;
                qbViewportState.lastFaceKey = '';
                scheduleQbCanvasRender();
            };

            const pointInPolygon = (pointX, pointY, polygon) => {
                let inside = false;
                for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                    const xi = polygon[i].x;
                    const yi = polygon[i].y;
                    const xj = polygon[j].x;
                    const yj = polygon[j].y;
                    const intersects = ((yi > pointY) !== (yj > pointY))
                        && (pointX < ((xj - xi) * (pointY - yi)) / ((yj - yi) || 1e-7) + xi);
                    if (intersects) inside = !inside;
                }
                return inside;
            };

            const projectQbPoint = (point) => {
                const cosYaw = Math.cos(qbEditor.viewYaw);
                const sinYaw = Math.sin(qbEditor.viewYaw);
                const cosPitch = Math.cos(qbEditor.viewPitch);
                const sinPitch = Math.sin(qbEditor.viewPitch);
                const mirroredX = -point.x;

                const x1 = mirroredX * cosYaw - point.z * sinYaw;
                const z1 = mirroredX * sinYaw + point.z * cosYaw;
                const y2 = point.y * cosPitch - z1 * sinPitch;
                const z2 = point.y * sinPitch + z1 * cosPitch;

                return { x: x1, y: y2, z: z2 };
            };

            const qbDisplayX = (matrix, x) => {
                if (!matrix) return x;
                return matrix.size_x - 1 - x;
            };

            const qbVoxelToWorldPoint = (matrix, voxelX, voxelY, voxelZ, cornerX = 0, cornerY = 0, cornerZ = 0) => ({
                x: voxelX + cornerX - (matrix.size_x / 2),
                y: voxelY + cornerY - (matrix.size_y / 2),
                z: voxelZ + cornerZ - (matrix.size_z / 2)
            });

            const getSelectedQbVoxel = (x, y, z) => qbSelectedLookup.value.get(qbVoxelKey(x, y, z)) || null;

            const rebuildQbLookup = () => {
                const matrix = selectedQbMatrix.value;
                const nextLookup = new Map();
                if (matrix) {
                    (matrix.voxels || []).forEach((voxel) => {
                        nextLookup.set(qbVoxelKey(voxel[0], voxel[1], voxel[2]), voxel);
                    });
                    matrix.voxel_count = matrix.voxels.length;
                    if (qbEditor.selectedSlice >= matrix.size_z) {
                        qbEditor.selectedSlice = Math.max(0, matrix.size_z - 1);
                    }
                } else {
                    qbEditor.selectedSlice = 0;
                }
                qbSelectedLookup.value = nextLookup;
            };

            const syncQbMatrixForm = () => {
                const matrix = selectedQbMatrix.value;
                if (!matrix) {
                    qbMatrixForm.name = 'Matrix';
                    qbMatrixForm.size_x = 16;
                    qbMatrixForm.size_y = 16;
                    qbMatrixForm.size_z = 16;
                    qbMatrixForm.pos_x = 0;
                    qbMatrixForm.pos_y = 0;
                    qbMatrixForm.pos_z = 0;
                    return;
                }
                qbMatrixForm.name = matrix.name;
                qbMatrixForm.size_x = matrix.size_x;
                qbMatrixForm.size_y = matrix.size_y;
                qbMatrixForm.size_z = matrix.size_z;
                qbMatrixForm.pos_x = matrix.pos_x;
                qbMatrixForm.pos_y = matrix.pos_y;
                qbMatrixForm.pos_z = matrix.pos_z;
            };

            const scheduleQbCanvasRender = () => {
                nextTick(() => {
                    const matrix = selectedQbMatrix.value;
                    const sliceCanvas = qbCanvasRef.value;
                    const sliceContext = sliceCanvas ? sliceCanvas.getContext('2d') : null;

                    if (sliceCanvas && sliceContext) {
                        if (!matrix) {
                            sliceCanvas.width = 1;
                            sliceCanvas.height = 1;
                            sliceContext.clearRect(0, 0, 1, 1);
                        } else {
                            const cellSize = qbCellSize.value;
                            sliceCanvas.width = Math.max(1, matrix.size_x * cellSize);
                            sliceCanvas.height = Math.max(1, matrix.size_y * cellSize);

                            sliceContext.clearRect(0, 0, sliceCanvas.width, sliceCanvas.height);
                            sliceContext.fillStyle = '#ffffff';
                            sliceContext.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);

                            (matrix.voxels || []).forEach((voxel) => {
                                if (voxel[2] !== qbEditor.selectedSlice) return;
                                const drawX = qbDisplayX(matrix, voxel[0]) * cellSize;
                                const drawY = (matrix.size_y - 1 - voxel[1]) * cellSize;
                                sliceContext.fillStyle = qbEditor.header.visibility_mask_encoded
                                    ? `rgb(${voxel[3]}, ${voxel[4]}, ${voxel[5]})`
                                    : `rgba(${voxel[3]}, ${voxel[4]}, ${voxel[5]}, ${Math.max(0.16, voxel[6] / 255)})`;
                                sliceContext.fillRect(drawX, drawY, cellSize, cellSize);
                                if (qbIsAttachmentVoxel(voxel)) {
                                    sliceContext.strokeStyle = qbAttachmentStrokeColor;
                                    sliceContext.lineWidth = Math.max(2, Math.min(4, cellSize * 0.14));
                                    sliceContext.strokeRect(drawX + 1, drawY + 1, Math.max(1, cellSize - 2), Math.max(1, cellSize - 2));

                                    const markerInset = Math.max(3, Math.floor(cellSize * 0.28));
                                    sliceContext.beginPath();
                                    sliceContext.strokeStyle = 'rgba(255,255,255,0.92)';
                                    sliceContext.lineWidth = Math.max(1.5, Math.min(3, cellSize * 0.1));
                                    sliceContext.moveTo(drawX + markerInset, drawY + markerInset);
                                    sliceContext.lineTo(drawX + cellSize - markerInset, drawY + cellSize - markerInset);
                                    sliceContext.moveTo(drawX + cellSize - markerInset, drawY + markerInset);
                                    sliceContext.lineTo(drawX + markerInset, drawY + cellSize - markerInset);
                                    sliceContext.stroke();
                                }
                            });

                            sliceContext.strokeStyle = 'rgba(24,35,54,0.12)';
                            sliceContext.lineWidth = 1;
                            sliceContext.beginPath();
                            for (let x = 0; x <= matrix.size_x; x += 1) {
                                const lineX = Math.round(x * cellSize) + 0.5;
                                sliceContext.moveTo(lineX, 0);
                                sliceContext.lineTo(lineX, sliceCanvas.height);
                            }
                            for (let y = 0; y <= matrix.size_y; y += 1) {
                                const lineY = Math.round(y * cellSize) + 0.5;
                                sliceContext.moveTo(0, lineY);
                                sliceContext.lineTo(sliceCanvas.width, lineY);
                            }
                            sliceContext.stroke();

                            if (qbEditor.hoverCell && qbEditor.hoverCell.z === qbEditor.selectedSlice) {
                                sliceContext.strokeStyle = '#5ec6ff';
                                sliceContext.lineWidth = 2;
                                sliceContext.strokeRect(
                                    qbDisplayX(matrix, qbEditor.hoverCell.x) * cellSize + 1,
                                    (matrix.size_y - 1 - qbEditor.hoverCell.y) * cellSize + 1,
                                    cellSize - 2,
                                    cellSize - 2
                                );
                            }
                        }
                    }

                    const viewportCanvas = qbViewportCanvasRef.value;
                    const viewportContext = viewportCanvas ? viewportCanvas.getContext('2d') : null;
                    if (!viewportCanvas || !viewportContext) return;

                    if (!matrix) {
                        viewportCanvas.width = 1;
                        viewportCanvas.height = 1;
                        viewportContext.clearRect(0, 0, 1, 1);
                        qbViewportFaceHits.value = [];
                        return;
                    }

                    const viewportRect = viewportCanvas.parentElement?.getBoundingClientRect();
                    const cssWidth = Math.max(320, Math.round(viewportRect?.width || 640));
                    const cssHeight = Math.max(320, Math.round(viewportRect?.height || 460));
                    const dpr = window.devicePixelRatio || 1;
                    viewportCanvas.width = Math.round(cssWidth * dpr);
                    viewportCanvas.height = Math.round(cssHeight * dpr);

                    viewportContext.clearRect(0, 0, viewportCanvas.width, viewportCanvas.height);
                    viewportContext.fillStyle = '#ffffff';
                    viewportContext.fillRect(0, 0, viewportCanvas.width, viewportCanvas.height);

                    const cameraDistance = Math.max(matrix.size_x, matrix.size_y, matrix.size_z) * 2.8 + 8;
                    const scale = Math.min(viewportCanvas.width, viewportCanvas.height) * 1.6 * qbEditor.viewZoom;
                    const centerX = viewportCanvas.width / 2 + qbEditor.viewPanX * dpr;
                    const centerY = viewportCanvas.height / 2 + qbEditor.viewPanY * dpr;

                    const faces = [];
                    const visibleLookup = new Set((matrix.voxels || []).filter(qbClipPassesVoxel).map((voxel) => qbVoxelKey(voxel[0], voxel[1], voxel[2])));

                    (matrix.voxels || []).forEach((voxel) => {
                        if (!qbClipPassesVoxel(voxel)) return;

                        qbFaceDefinitions.forEach((faceDef) => {
                            const neighborKey = qbVoxelKey(
                                voxel[0] + faceDef.neighbor[0],
                                voxel[1] + faceDef.neighbor[1],
                                voxel[2] + faceDef.neighbor[2]
                            );
                            if (visibleLookup.has(neighborKey)) return;

                            const rotatedNormal = projectQbPoint({
                                x: faceDef.normal[0],
                                y: faceDef.normal[1],
                                z: faceDef.normal[2]
                            });
                            if (rotatedNormal.z <= 0.01) return;

                            const polygon = [];
                            const depths = [];

                            for (const corner of faceDef.corners) {
                                const worldPoint = qbVoxelToWorldPoint(matrix, voxel[0], voxel[1], voxel[2], corner[0], corner[1], corner[2]);
                                const rotated = projectQbPoint(worldPoint);
                                const depth = cameraDistance - rotated.z;
                                if (depth <= 0.2) return;

                                polygon.push({
                                    x: centerX + (rotated.x * scale) / depth,
                                    y: centerY - (rotated.y * scale) / depth
                                });
                                depths.push(rotated.z);
                            }

                            if (polygon.length !== 4) return;

                            faces.push({
                                faceId: faceDef.id,
                                voxel,
                                isAttachment: qbIsAttachmentVoxel(voxel),
                                normal: faceDef.normal,
                                polygon,
                                depth: depths.reduce((sum, value) => sum + value, 0) / depths.length,
                                fill: qbEditor.header.visibility_mask_encoded
                                    ? shadeQbColor(voxel[3], voxel[4], voxel[5], faceDef.shade)
                                    : shadeQbColor(voxel[3], voxel[4], voxel[5], faceDef.shade),
                                alpha: 1,
                                key: `${qbVoxelKey(voxel[0], voxel[1], voxel[2])}:${faceDef.id}`,
                                addTarget: [
                                    voxel[0] + faceDef.normal[0],
                                    voxel[1] + faceDef.normal[1],
                                    voxel[2] + faceDef.normal[2]
                                ]
                            });
                        });
                    });

                    faces.sort((a, b) => a.depth - b.depth);
                    qbViewportFaceHits.value = faces;
                    if (qbEditor.hoverFace) {
                        qbEditor.hoverFace = faces.find((face) => face.key === qbEditor.hoverFace.key) || null;
                        qbEditor.hoverCell = qbEditor.hoverFace
                            ? { x: qbEditor.hoverFace.voxel[0], y: qbEditor.hoverFace.voxel[1], z: qbEditor.hoverFace.voxel[2] }
                            : null;
                    }

                    faces.forEach((face) => {
                        viewportContext.beginPath();
                        face.polygon.forEach((point, index) => {
                            if (index === 0) viewportContext.moveTo(point.x, point.y);
                            else viewportContext.lineTo(point.x, point.y);
                        });
                        viewportContext.closePath();
                        viewportContext.fillStyle = face.fill;
                        viewportContext.globalAlpha = face.alpha;
                        viewportContext.fill();
                        viewportContext.globalAlpha = 1;
                        viewportContext.strokeStyle = 'rgba(24,35,54,0.18)';
                        viewportContext.lineWidth = Math.max(1, dpr);
                        viewportContext.stroke();
                        if (face.isAttachment) {
                            viewportContext.fillStyle = qbAttachmentGlowColor;
                            viewportContext.fill();
                            viewportContext.strokeStyle = qbAttachmentStrokeColor;
                            viewportContext.lineWidth = Math.max(2, 2 * dpr);
                            viewportContext.stroke();
                        }
                    });

                    if (qbEditor.hoverFace) {
                        viewportContext.beginPath();
                        qbEditor.hoverFace.polygon.forEach((point, index) => {
                            if (index === 0) viewportContext.moveTo(point.x, point.y);
                            else viewportContext.lineTo(point.x, point.y);
                        });
                        viewportContext.closePath();
                        viewportContext.strokeStyle = '#5ec6ff';
                        viewportContext.lineWidth = Math.max(2, 2 * dpr);
                        viewportContext.stroke();
                        viewportContext.fillStyle = 'rgba(94,198,255,0.14)';
                        viewportContext.fill();
                    }
                });
            };

            const markQbDirty = () => {
                if (qbHydratingDocument) return;
                qbEditor.dirty = true;
                if (qbPackageActive.value && qbEditor.selectedAssetId && !qbEditor.dirtyAssetIds.includes(qbEditor.selectedAssetId)) {
                    qbEditor.dirtyAssetIds = [...qbEditor.dirtyAssetIds, qbEditor.selectedAssetId];
                }
            };

            const serializeQbDocument = () => ({
                header: {
                    version: Number(qbEditor.header.version || 257) >>> 0,
                    color_format: Number(qbEditor.header.color_format || 0),
                    z_axis_orientation: Number(qbEditor.header.z_axis_orientation || 1),
                    compressed: Boolean(qbEditor.header.compressed),
                    visibility_mask_encoded: Boolean(qbEditor.header.visibility_mask_encoded)
                },
                matrices: qbEditor.matrices.map((matrix) => ({
                    name: matrix.name,
                    size_x: matrix.size_x,
                    size_y: matrix.size_y,
                    size_z: matrix.size_z,
                    pos_x: matrix.pos_x,
                    pos_y: matrix.pos_y,
                    pos_z: matrix.pos_z,
                    voxels: (matrix.voxels || []).map((voxel) => [...voxel])
                }))
            });

            const clearQbPackageState = () => {
                qbEditor.containerPath = '';
                qbEditor.containerFileName = '';
                qbEditor.packageTree = null;
                qbEditor.packageAssets = {};
                qbEditor.selectedAssetId = '';
                qbEditor.dirtyAssetIds = [];
            };

            const storeCurrentQbAssetState = () => {
                if (!qbPackageActive.value || !qbEditor.selectedAssetId) return;
                const currentAsset = qbEditor.packageAssets?.[qbEditor.selectedAssetId];
                if (!currentAsset) return;
                qbEditor.packageAssets[qbEditor.selectedAssetId] = {
                    ...currentAsset,
                    ...serializeQbDocument(),
                    path: qbEditor.path || currentAsset.path || '',
                    file_name: qbEditor.fileName || currentAsset.file_name || '',
                    source_format: qbEditor.sourceFormat || currentAsset.source_format || 'qb',
                    source_file_type: qbEditor.sourceFileType || currentAsset.source_file_type || 'qb',
                    asset_id: currentAsset.asset_id || qbEditor.selectedAssetId,
                    asset_label: currentAsset.asset_label || qbDisplayName.value
                };
            };

            const applyQbDocument = (document, options = {}) => {
                const { packagePayload = null, preservePackage = false, selectedAssetId = '' } = options;
                const normalizedDocument = document || createEmptyQbDocument();
                qbHydratingDocument = true;

                if (packagePayload) {
                    qbEditor.containerPath = packagePayload.container_path || normalizedDocument.path || '';
                    qbEditor.containerFileName = packagePayload.file_name || normalizedDocument.file_name || '';
                    qbEditor.packageTree = packagePayload.root || null;
                    qbEditor.packageAssets = packagePayload.assets || {};
                    qbEditor.selectedAssetId = selectedAssetId || packagePayload.selected_asset_id || '';
                } else if (!preservePackage) {
                    clearQbPackageState();
                }

                qbEditor.path = normalizedDocument.path || '';
                qbEditor.fileName = normalizedDocument.file_name || (normalizedDocument.path ? normalizedDocument.path.split(/[\\/]/).pop() : 'untitled.qb');
                qbEditor.sourceFormat = normalizedDocument.source_format || 'qb';
                qbEditor.sourceFileType = normalizedDocument.source_file_type || 'qb';
                qbEditor.header = {
                    version: Number(normalizedDocument.header?.version || 257) >>> 0,
                    color_format: Number(normalizedDocument.header?.color_format || 0),
                    z_axis_orientation: Number(normalizedDocument.header?.z_axis_orientation || 1),
                    compressed: Boolean(normalizedDocument.header?.compressed),
                    visibility_mask_encoded: Boolean(normalizedDocument.header?.visibility_mask_encoded)
                };
                qbEditor.matrices = (normalizedDocument.matrices || []).map((matrix, index) => normalizeQbMatrix(matrix, `Matrix ${index + 1}`));
                qbEditor.selectedMatrixIndex = qbEditor.matrices.length > 0 ? 0 : -1;
                qbEditor.viewMode = '3d';
                qbEditor.selectedSlice = 0;
                qbEditor.clipMode = 'off';
                qbEditor.hoverCell = null;
                qbEditor.hoverFace = null;
                qbEditor.activeTool = 'orbit';
                qbEditor.viewYaw = -0.72;
                qbEditor.viewPitch = 0.58;
                qbEditor.viewZoom = 1;
                qbEditor.viewPanX = 0;
                qbEditor.viewPanY = 0;
                qbEditor.paintAlpha = qbEditor.header.visibility_mask_encoded ? 126 : 255;
                qbEditor.dirty = qbPackageActive.value && qbEditor.selectedAssetId
                    ? qbEditor.dirtyAssetIds.includes(qbEditor.selectedAssetId)
                    : false;

                syncQbMatrixForm();
                rebuildQbLookup();
                qbHydratingDocument = false;
                scheduleQbCanvasRender();
            };

            const ensureQbDiscardChanges = async () => {
                if (!qbHasUnsavedAssets.value) return true;
                return window.showConfirmModal({
                    title: t('Discard QB Changes?'),
                    message: t('You have unsaved QB edits. Continue and lose those changes?'),
                    confirmLabel: t('Discard'),
                    cancelLabel: t('Keep Editing'),
                    danger: true
                });
            };

            const uniqueQbMatrixName = () => {
                const usedNames = new Set(qbEditor.matrices.map(matrix => matrix.name.toLowerCase()));
                let index = qbEditor.matrices.length + 1;
                while (usedNames.has(`matrix ${index}`.toLowerCase())) {
                    index += 1;
                }
                return `Matrix ${index}`;
            };

            const selectQbMatrix = (index) => {
                qbEditor.selectedMatrixIndex = index;
            };

            const selectQbPackageAsset = (assetId) => {
                if (!assetId || !qbPackageActive.value || assetId === qbEditor.selectedAssetId) return;
                const asset = qbEditor.packageAssets?.[assetId];
                if (!asset) return;
                storeCurrentQbAssetState();
                qbEditor.selectedAssetId = assetId;
                applyQbDocument(asset, { preservePackage: true, selectedAssetId: assetId });
            };

            const addQbMatrix = () => {
                const matrix = createQbMatrix({ name: uniqueQbMatrixName() });
                qbEditor.matrices.push(matrix);
                qbEditor.selectedMatrixIndex = qbEditor.matrices.length - 1;
                qbEditor.selectedSlice = 0;
                markQbDirty();
                rebuildQbLookup();
                syncQbMatrixForm();
                scheduleQbCanvasRender();
            };

            const removeSelectedQbMatrix = async () => {
                if (!selectedQbMatrix.value) return;
                const confirmed = await window.showConfirmModal({
                    title: t('Remove Matrix'),
                    message: t('Remove the selected matrix from this QB file?'),
                    confirmLabel: t('Remove'),
                    cancelLabel: t('Cancel'),
                    danger: true
                });
                if (!confirmed) return;

                qbEditor.matrices.splice(qbEditor.selectedMatrixIndex, 1);
                qbEditor.selectedMatrixIndex = qbEditor.matrices.length > 0
                    ? Math.max(0, Math.min(qbEditor.selectedMatrixIndex, qbEditor.matrices.length - 1))
                    : -1;
                qbEditor.hoverCell = null;
                qbEditor.hoverFace = null;
                markQbDirty();
                rebuildQbLookup();
                syncQbMatrixForm();
                scheduleQbCanvasRender();
            };

            const applyQbMatrixForm = () => {
                const matrix = selectedQbMatrix.value;
                if (!matrix) return;

                const nextName = String(qbMatrixForm.name || '').trim() || `Matrix ${qbEditor.selectedMatrixIndex + 1}`;
                const nextSizeX = coerceQbSize(qbMatrixForm.size_x, matrix.size_x);
                const nextSizeY = coerceQbSize(qbMatrixForm.size_y, matrix.size_y);
                const nextSizeZ = coerceQbSize(qbMatrixForm.size_z, matrix.size_z);
                const nextPosX = coerceQbInt(qbMatrixForm.pos_x, matrix.pos_x);
                const nextPosY = coerceQbInt(qbMatrixForm.pos_y, matrix.pos_y);
                const nextPosZ = coerceQbInt(qbMatrixForm.pos_z, matrix.pos_z);

                const previousCount = matrix.voxels.length;
                matrix.name = nextName;
                matrix.size_x = nextSizeX;
                matrix.size_y = nextSizeY;
                matrix.size_z = nextSizeZ;
                matrix.pos_x = nextPosX;
                matrix.pos_y = nextPosY;
                matrix.pos_z = nextPosZ;
                matrix.voxels = matrix.voxels
                    .filter((voxel) => voxel[0] < nextSizeX && voxel[1] < nextSizeY && voxel[2] < nextSizeZ)
                    .sort(qbVoxelSort);
                matrix.voxel_count = matrix.voxels.length;

                if (qbEditor.selectedSlice >= matrix.size_z) {
                    qbEditor.selectedSlice = Math.max(0, matrix.size_z - 1);
                }

                markQbDirty();
                rebuildQbLookup();
                syncQbMatrixForm();
                scheduleQbCanvasRender();

                const removed = previousCount - matrix.voxels.length;
                if (removed > 0) {
                    window.showToast(t('{count} voxel(s) were clipped by the new matrix bounds.').replace('{count}', removed));
                }
            };

            const hexToRgb = (hex) => {
                const clean = String(hex || '').replace('#', '').trim();
                if (clean.length !== 6) return { r: 255, g: 107, b: 107 };
                return {
                    r: Number.parseInt(clean.slice(0, 2), 16),
                    g: Number.parseInt(clean.slice(2, 4), 16),
                    b: Number.parseInt(clean.slice(4, 6), 16)
                };
            };

            const resolveQbPaintAlpha = () => {
                const fallback = qbEditor.header.visibility_mask_encoded ? 126 : 255;
                const next = clampQbByte(qbEditor.paintAlpha, fallback);
                return next > 0 ? next : fallback;
            };

            const upsertSelectedQbVoxel = (x, y, z, r, g, b, a) => {
                const matrix = selectedQbMatrix.value;
                if (!matrix) return false;

                const nextVoxel = [x, y, z, clampQbByte(r), clampQbByte(g), clampQbByte(b), clampQbByte(a)];
                const key = qbVoxelKey(x, y, z);
                const existing = qbSelectedLookup.value.get(key);
                if (existing && existing.every((value, index) => value === nextVoxel[index])) {
                    return false;
                }

                if (existing) {
                    const targetIndex = matrix.voxels.findIndex((voxel) => voxel[0] === x && voxel[1] === y && voxel[2] === z);
                    if (targetIndex >= 0) {
                        matrix.voxels.splice(targetIndex, 1, nextVoxel);
                    } else {
                        matrix.voxels.push(nextVoxel);
                    }
                } else {
                    matrix.voxels.push(nextVoxel);
                }

                qbSelectedLookup.value.set(key, nextVoxel);
                matrix.voxel_count = matrix.voxels.length;
                return true;
            };

            const removeSelectedQbVoxel = (x, y, z) => {
                const matrix = selectedQbMatrix.value;
                if (!matrix) return false;

                const key = qbVoxelKey(x, y, z);
                if (!qbSelectedLookup.value.has(key)) return false;

                const targetIndex = matrix.voxels.findIndex((voxel) => voxel[0] === x && voxel[1] === y && voxel[2] === z);
                if (targetIndex >= 0) {
                    matrix.voxels.splice(targetIndex, 1);
                }
                qbSelectedLookup.value.delete(key);
                matrix.voxel_count = matrix.voxels.length;
                return true;
            };

            const sampleQbVoxel = (voxel) => {
                if (!voxel) return;
                qbEditor.paintColor = qbVoxelHex(voxel);
                qbEditor.paintAlpha = voxel[6];
                window.showToast(t('Sampled voxel color.'));
            };

            const removeQbVoxel = (voxel) => {
                if (!voxel) return;
                if (removeSelectedQbVoxel(voxel[0], voxel[1], voxel[2])) {
                    markQbDirty();
                    scheduleQbCanvasRender();
                }
            };

            const clearAttachmentPointsInDocument = (document) => {
                let removed = 0;
                (document?.matrices || []).forEach((matrix) => {
                    const before = (matrix.voxels || []).length;
                    matrix.voxels = (matrix.voxels || []).filter((voxel) => !qbIsAttachmentVoxel(voxel));
                    matrix.voxel_count = matrix.voxels.length;
                    removed += before - matrix.voxels.length;
                });
                return removed;
            };

            const getPackageAssetAttachmentPoints = (asset) => {
                const points = [];
                (asset?.matrices || []).forEach((matrix, matrixIndex) => {
                    (matrix?.voxels || []).forEach((voxel) => {
                        if (!qbIsAttachmentVoxel(voxel)) return;
                        points.push({ matrixIndex, x: voxel[0], y: voxel[1], z: voxel[2] });
                    });
                });
                return points;
            };

            const setCurrentQbAttachmentPoint = (cell = qbHoveredEditableCell.value) => {
                const matrix = selectedQbMatrix.value;
                if (!matrix || !cell) {
                    window.showToast(t('Hover a voxel or slice cell first.'), true);
                    return false;
                }
                clearAttachmentPointsInDocument(qbEditor);
                const changed = upsertSelectedQbVoxel(cell.x, cell.y, cell.z, 255, 0, 255, 255);
                if (changed) {
                    qbEditor.selectedSlice = cell.z;
                    qbEditor.hoverCell = { x: cell.x, y: cell.y, z: cell.z };
                    markQbDirty();
                    rebuildQbLookup();
                    scheduleQbCanvasRender();
                    window.showToast(t('Attachment point updated.'));
                }
                return changed;
            };

            const clearCurrentQbAttachmentPoints = () => {
                const removed = clearAttachmentPointsInDocument(qbEditor);
                if (removed <= 0) return;
                markQbDirty();
                rebuildQbLookup();
                scheduleQbCanvasRender();
                window.showToast(t('Attachment point cleared.'));
            };

            const focusCurrentQbAttachmentPoint = () => {
                const point = qbCurrentAttachmentPoint.value;
                if (!point) {
                    window.showToast(t('This asset does not have exactly one attachment point.'), true);
                    return;
                }
                qbEditor.selectedMatrixIndex = point.matrixIndex;
                qbEditor.selectedSlice = point.z;
                qbEditor.viewMode = '2d';
                qbEditor.clipMode = 'slice';
                nextTick(() => {
                    qbEditor.hoverCell = { x: point.x, y: point.y, z: point.z };
                    scheduleQbCanvasRender();
                });
            };

            const syncAttachmentPointAcrossPackageFamily = () => {
                const point = qbCurrentAttachmentPoint.value;
                if (!qbPackageActive.value || !point) {
                    window.showToast(t('Set exactly one attachment point in the current asset first.'), true);
                    return;
                }

                storeCurrentQbAssetState();
                let changedAssets = 0;
                qbPackageFamilyAssetIds.value.forEach((assetId) => {
                    const asset = assetId === qbEditor.selectedAssetId
                        ? { ...qbEditor.packageAssets?.[assetId], matrices: qbEditor.matrices }
                        : qbEditor.packageAssets?.[assetId];
                    if (!asset) return;
                    const existingPoints = getPackageAssetAttachmentPoints(asset);
                    const alreadyMatches = existingPoints.length === 1
                        && existingPoints[0].matrixIndex === point.matrixIndex
                        && existingPoints[0].x === point.x
                        && existingPoints[0].y === point.y
                        && existingPoints[0].z === point.z;
                    if (alreadyMatches) return;

                    clearAttachmentPointsInDocument(asset);
                    const targetMatrix = asset.matrices?.[point.matrixIndex]
                        || asset.matrices?.find((matrix) => matrix?.name === qbEditor.matrices?.[point.matrixIndex]?.name);
                    if (!targetMatrix) return;
                    targetMatrix.voxels = targetMatrix.voxels || [];
                    targetMatrix.voxels.push([point.x, point.y, point.z, 255, 0, 255, 255]);
                    targetMatrix.voxels.sort(qbVoxelSort);
                    targetMatrix.voxel_count = targetMatrix.voxels.length;
                    if (!qbEditor.dirtyAssetIds.includes(assetId)) {
                        qbEditor.dirtyAssetIds = [...qbEditor.dirtyAssetIds, assetId];
                    }
                    changedAssets += 1;
                });

                if (changedAssets > 0) {
                    qbEditor.dirty = qbEditor.selectedAssetId ? qbEditor.dirtyAssetIds.includes(qbEditor.selectedAssetId) : qbEditor.dirty;
                    rebuildQbLookup();
                    scheduleQbCanvasRender();
                    window.showToast(t('Synced attachment point to {count} package asset(s).').replace('{count}', changedAssets));
                }
            };

            const setQbTool = (tool) => {
                qbEditor.activeTool = tool;
                qbViewportState.mode = null;
                qbViewportState.lastFaceKey = '';
                scheduleQbCanvasRender();
            };

            const resetQbView = () => {
                qbEditor.viewYaw = -0.72;
                qbEditor.viewPitch = 0.58;
                qbEditor.viewZoom = 1;
                qbEditor.viewPanX = 0;
                qbEditor.viewPanY = 0;
                scheduleQbCanvasRender();
            };

            const qbViewportFaceFromMouseEvent = (event) => {
                const canvas = qbViewportCanvasRef.value;
                if (!canvas) return null;
                const rect = canvas.getBoundingClientRect();
                if (!rect.width || !rect.height) return null;
                const pointX = (event.clientX - rect.left) * (canvas.width / rect.width);
                const pointY = (event.clientY - rect.top) * (canvas.height / rect.height);
                const faces = qbViewportFaceHits.value || [];
                for (let index = faces.length - 1; index >= 0; index -= 1) {
                    const face = faces[index];
                    if (pointInPolygon(pointX, pointY, face.polygon)) {
                        return face;
                    }
                }
                return null;
            };

            const applyQbViewportFaceAction = (face, tool = qbEditor.activeTool) => {
                if (!face) return false;
                if (tool === 'sample') {
                    sampleQbVoxel(face.voxel);
                    return false;
                }

                if (tool === 'erase') {
                    const changed = removeSelectedQbVoxel(face.voxel[0], face.voxel[1], face.voxel[2]);
                    if (changed) {
                        markQbDirty();
                        scheduleQbCanvasRender();
                    }
                    return changed;
                }

                const { r, g, b } = hexToRgb(qbEditor.paintColor);
                if (tool === 'paint') {
                    const changed = upsertSelectedQbVoxel(face.voxel[0], face.voxel[1], face.voxel[2], r, g, b, resolveQbPaintAlpha());
                    if (changed) {
                        markQbDirty();
                        scheduleQbCanvasRender();
                    }
                    return changed;
                }

                if (tool === 'add') {
                    const matrix = selectedQbMatrix.value;
                    if (!matrix) return false;
                    const [targetX, targetY, targetZ] = face.addTarget;
                    if (targetX < 0 || targetX >= matrix.size_x || targetY < 0 || targetY >= matrix.size_y || targetZ < 0 || targetZ >= matrix.size_z) {
                        window.showToast(t('Expand the matrix bounds before adding voxels outside the current volume.'), true);
                        return false;
                    }
                    if (getSelectedQbVoxel(targetX, targetY, targetZ)) {
                        return false;
                    }
                    const changed = upsertSelectedQbVoxel(targetX, targetY, targetZ, r, g, b, resolveQbPaintAlpha());
                    if (changed) {
                        markQbDirty();
                        scheduleQbCanvasRender();
                    }
                    return changed;
                }

                return false;
            };

            const fillQbSlice = () => {
                const matrix = selectedQbMatrix.value;
                if (!matrix) return;

                const { r, g, b } = hexToRgb(qbEditor.paintColor);
                const alpha = resolveQbPaintAlpha();
                let changed = 0;

                for (let y = 0; y < matrix.size_y; y += 1) {
                    for (let x = 0; x < matrix.size_x; x += 1) {
                        if (upsertSelectedQbVoxel(x, y, qbEditor.selectedSlice, r, g, b, alpha)) {
                            changed += 1;
                        }
                    }
                }

                if (changed > 0) {
                    markQbDirty();
                    scheduleQbCanvasRender();
                    window.showToast(t('Filled {count} voxel(s) in the current slice.').replace('{count}', changed));
                }
            };

            const clearQbSlice = () => {
                const matrix = selectedQbMatrix.value;
                if (!matrix) return;

                const targets = matrix.voxels.filter((voxel) => voxel[2] === qbEditor.selectedSlice);
                if (targets.length === 0) return;

                targets.forEach((voxel) => removeSelectedQbVoxel(voxel[0], voxel[1], voxel[2]));
                markQbDirty();
                scheduleQbCanvasRender();
                window.showToast(t('Cleared {count} voxel(s) from the current slice.').replace('{count}', targets.length));
            };

            const stepQbSlice = (delta) => {
                const matrix = selectedQbMatrix.value;
                if (!matrix) return;
                qbEditor.selectedSlice = Math.max(0, Math.min(matrix.size_z - 1, qbEditor.selectedSlice + delta));
            };

            const qbSliceVoxels = computed(() => {
                const matrix = selectedQbMatrix.value;
                if (!matrix) return [];

                return (matrix.voxels || [])
                    .filter((voxel) => voxel[2] === qbEditor.selectedSlice)
                    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
                    .map((voxel) => ({
                        key: qbVoxelKey(voxel[0], voxel[1], voxel[2]),
                        coords: `${voxel[0]}, ${voxel[1]}, ${voxel[2]}`,
                        color: qbVoxelHex(voxel).toUpperCase(),
                        swatch: qbEditor.header.visibility_mask_encoded
                            ? qbVoxelHex(voxel)
                            : `rgba(${voxel[3]}, ${voxel[4]}, ${voxel[5]}, ${Math.max(0.16, voxel[6] / 255)})`,
                        a: voxel[6],
                        raw: voxel
                    }));
            });

            const qbHoverSummary = computed(() => {
                if (!qbEditor.hoverCell) return null;
                const voxel = getSelectedQbVoxel(qbEditor.hoverCell.x, qbEditor.hoverCell.y, qbEditor.hoverCell.z);
                return {
                    coords: `${qbEditor.hoverCell.x}, ${qbEditor.hoverCell.y}, ${qbEditor.hoverCell.z}`,
                    color: voxel
                        ? `${qbVoxelHex(voxel).toUpperCase()} | ${qbEditor.header.visibility_mask_encoded ? `${t('Mask')} ${voxel[6]}` : `${t('Alpha')} ${voxel[6]}`}`
                        : t('Empty')
                };
            });

            const qbHoveredEditableCell = computed(() => {
                if (qbEditor.hoverFace?.voxel) {
                    return { x: qbEditor.hoverFace.voxel[0], y: qbEditor.hoverFace.voxel[1], z: qbEditor.hoverFace.voxel[2] };
                }
                if (qbEditor.hoverCell) return { ...qbEditor.hoverCell };
                return null;
            });

            const qbCurrentAttachmentPoints = computed(() => {
                const points = [];
                qbEditor.matrices.forEach((matrix, matrixIndex) => {
                    (matrix?.voxels || []).forEach((voxel) => {
                        if (!qbIsAttachmentVoxel(voxel)) return;
                        points.push({
                            matrixIndex,
                            matrixName: matrix.name,
                            x: voxel[0],
                            y: voxel[1],
                            z: voxel[2],
                            key: `${matrixIndex}:${qbVoxelKey(voxel[0], voxel[1], voxel[2])}`
                        });
                    });
                });
                return points;
            });

            const qbCurrentAttachmentPoint = computed(() => qbCurrentAttachmentPoints.value.length === 1 ? qbCurrentAttachmentPoints.value[0] : null);

            const qbCurrentAssetFamilyKey = computed(() => {
                const asset = qbSelectedAsset.value;
                const rawName = String(asset?.file_name || qbEditor.fileName || '');
                const lower = rawName.replace(/\.qb$/i, '').toLowerCase();
                return lower.replace(/_(a|s|t)$/i, '');
            });

            const qbPackageFamilyAssetIds = computed(() => {
                if (!qbPackageActive.value || !qbCurrentAssetFamilyKey.value) return [];
                return Object.entries(qbEditor.packageAssets || {})
                    .filter(([, asset]) => String(asset?.source_file_type || '').toLowerCase() === 'qb')
                    .filter(([, asset]) => {
                        const stem = String(asset?.file_name || '').replace(/\.qb$/i, '').toLowerCase().replace(/_(a|s|t)$/i, '');
                        return stem === qbCurrentAssetFamilyKey.value;
                    })
                    .map(([assetId]) => assetId)
                    .sort((leftId, rightId) => {
                        const leftName = String(qbEditor.packageAssets[leftId]?.file_name || '').toLowerCase();
                        const rightName = String(qbEditor.packageAssets[rightId]?.file_name || '').toLowerCase();
                        return leftName.localeCompare(rightName);
                    });
            });

            const qbAttachmentStatus = computed(() => {
                const currentCount = qbCurrentAttachmentPoints.value.length;
                const siblingCounts = qbPackageFamilyAssetIds.value.map((assetId) => {
                    const asset = qbEditor.packageAssets?.[assetId];
                    let count = 0;
                    (asset?.matrices || []).forEach((matrix) => {
                        (matrix?.voxels || []).forEach((voxel) => {
                            if (qbIsAttachmentVoxel(voxel)) count += 1;
                        });
                    });
                    return { assetId, label: asset?.asset_label || asset?.file_name || assetId, count };
                });
                return {
                    currentCount,
                    currentLabel: currentCount === 0 ? t('Missing') : currentCount === 1 ? t('Ready') : t('Multiple'),
                    familyCount: siblingCounts.length,
                    familyUniform: siblingCounts.length > 0 && siblingCounts.every((item) => item.count === 1),
                    siblingCounts
                };
            });

            const qbCellFromMouseEvent = (event) => {
                const matrix = selectedQbMatrix.value;
                const canvas = qbCanvasRef.value;
                if (!matrix || !canvas) return null;

                const rect = canvas.getBoundingClientRect();
                if (!rect.width || !rect.height) return null;

                const cellSize = qbCellSize.value;
                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;
                const localX = (event.clientX - rect.left) * scaleX;
                const localY = (event.clientY - rect.top) * scaleY;
                const drawX = Math.floor(localX / cellSize);
                const x = matrix.size_x - 1 - drawX;
                const drawY = Math.floor(localY / cellSize);
                const y = matrix.size_y - 1 - drawY;

                if (x < 0 || x >= matrix.size_x || y < 0 || y >= matrix.size_y) return null;
                return { x, y, z: qbEditor.selectedSlice };
            };

            const applyQbCellAction = (cell, mode) => {
                if (!cell) return;
                if (mode === 'sample') {
                    const targetVoxel = getSelectedQbVoxel(cell.x, cell.y, cell.z);
                    if (targetVoxel) sampleQbVoxel(targetVoxel);
                    return;
                }

                let changed = false;
                if (mode === 'erase') {
                    changed = removeSelectedQbVoxel(cell.x, cell.y, cell.z);
                } else {
                    const { r, g, b } = hexToRgb(qbEditor.paintColor);
                    changed = upsertSelectedQbVoxel(cell.x, cell.y, cell.z, r, g, b, resolveQbPaintAlpha());
                }

                if (changed) {
                    markQbDirty();
                    scheduleQbCanvasRender();
                }
            };

            const onQbCanvasMouseDown = (event) => {
                const cell = qbCellFromMouseEvent(event);
                if (!cell) return;
                event.preventDefault();

                if (event.altKey || event.button === 1) {
                    applyQbCellAction(cell, 'sample');
                    return;
                }

                const mode = event.button === 2 ? 'erase' : 'paint';
                qbPointerMode.value = mode;
                applyQbCellAction(cell, mode);
            };

            const onQbCanvasMouseMove = (event) => {
                const cell = qbCellFromMouseEvent(event);
                const previous = qbEditor.hoverCell;
                if (!cell && previous) {
                    qbEditor.hoverCell = null;
                    scheduleQbCanvasRender();
                } else if (cell && (!previous || previous.x !== cell.x || previous.y !== cell.y || previous.z !== cell.z)) {
                    qbEditor.hoverCell = cell;
                    scheduleQbCanvasRender();
                }

                if (qbPointerMode.value && cell) {
                    applyQbCellAction(cell, qbPointerMode.value);
                }
            };

            const onQbCanvasMouseLeave = () => {
                qbEditor.hoverCell = null;
                scheduleQbCanvasRender();
            };

            const onQbViewportWheel = (event) => {
                event.preventDefault();
                const delta = event.deltaY < 0 ? 1.12 : 0.9;
                qbEditor.viewZoom = Math.max(0.35, Math.min(4, qbEditor.viewZoom * delta));
                scheduleQbCanvasRender();
            };

            const updateQbViewportHover = (event) => {
                const face = qbViewportFaceFromMouseEvent(event);
                qbEditor.hoverFace = face;
                qbEditor.hoverCell = face
                    ? { x: face.voxel[0], y: face.voxel[1], z: face.voxel[2] }
                    : null;
                scheduleQbCanvasRender();
                return face;
            };

            const onQbViewportMouseDown = (event) => {
                event.preventDefault();
                const face = qbViewportFaceFromMouseEvent(event);
                qbEditor.hoverFace = face;
                qbEditor.hoverCell = face
                    ? { x: face.voxel[0], y: face.voxel[1], z: face.voxel[2] }
                    : null;

                qbViewportState.lastX = event.clientX;
                qbViewportState.lastY = event.clientY;
                qbViewportState.lastFaceKey = '';

                if (event.button === 2 || qbEditor.activeTool === 'pan') {
                    qbViewportState.mode = 'pan';
                    return;
                }

                if (qbEditor.activeTool === 'orbit' || !face) {
                    qbViewportState.mode = 'orbit';
                    return;
                }

                qbViewportState.mode = 'edit';
                applyQbViewportFaceAction(face, qbEditor.activeTool);
                qbViewportState.lastFaceKey = face.key;
            };

            const onQbViewportMouseMove = (event) => {
                if (!qbViewportState.mode) {
                    updateQbViewportHover(event);
                    return;
                }

                const deltaX = event.clientX - qbViewportState.lastX;
                const deltaY = event.clientY - qbViewportState.lastY;
                qbViewportState.lastX = event.clientX;
                qbViewportState.lastY = event.clientY;

                if (qbViewportState.mode === 'orbit') {
                    qbEditor.viewYaw -= deltaX * 0.01;
                    qbEditor.viewPitch = Math.max(-1.35, Math.min(1.35, qbEditor.viewPitch + deltaY * 0.01));
                    scheduleQbCanvasRender();
                    return;
                }

                if (qbViewportState.mode === 'pan') {
                    qbEditor.viewPanX += deltaX;
                    qbEditor.viewPanY += deltaY;
                    scheduleQbCanvasRender();
                    return;
                }

                if (qbViewportState.mode === 'edit') {
                    const face = qbViewportFaceFromMouseEvent(event);
                    qbEditor.hoverFace = face;
                    qbEditor.hoverCell = face
                        ? { x: face.voxel[0], y: face.voxel[1], z: face.voxel[2] }
                        : null;
                    if (face && face.key !== qbViewportState.lastFaceKey && (qbEditor.activeTool === 'paint' || qbEditor.activeTool === 'erase' || qbEditor.activeTool === 'add')) {
                        applyQbViewportFaceAction(face, qbEditor.activeTool);
                        qbViewportState.lastFaceKey = face.key;
                    } else {
                        scheduleQbCanvasRender();
                    }
                }
            };

            const onQbViewportMouseLeave = () => {
                if (!qbViewportState.mode) {
                    qbEditor.hoverFace = null;
                    qbEditor.hoverCell = null;
                    scheduleQbCanvasRender();
                }
            };

            const qbGlobalMouseMoveHandler = (event) => {
                if (qbViewportState.mode && event.target !== qbViewportCanvasRef.value) {
                    onQbViewportMouseMove(event);
                }
            };

            const toggleQbVisibilityMaskMode = () => {
                if (qbHydratingDocument) return;
                const nextVisibleValue = qbEditor.header.visibility_mask_encoded ? 126 : 255;
                qbEditor.matrices.forEach((matrix) => {
                    matrix.voxels = (matrix.voxels || []).map((voxel) => ([
                        voxel[0],
                        voxel[1],
                        voxel[2],
                        voxel[3],
                        voxel[4],
                        voxel[5],
                        voxel[6] > 0 ? nextVisibleValue : 0
                    ]));
                });
                qbEditor.paintAlpha = nextVisibleValue;
                rebuildQbLookup();
                markQbDirty();
                scheduleQbCanvasRender();
            };

            const openQbFileLocation = async () => {
                await openPathInExplorer(qbEditor.path);
            };

            const saveQbDocumentToPath = async (path) => {
                if (!path) return false;
                isWorking.savingQb = true;
                try {
                    storeCurrentQbAssetState();
                    const result = await eel.save_qb_file(path, serializeQbDocument())();
                    if (result && result.success) {
                        qbEditor.path = result.path || path;
                        qbEditor.fileName = result.file_name || qbDisplayName.value;
                        if (qbPackageActive.value && qbEditor.selectedAssetId) {
                            qbEditor.dirtyAssetIds = qbEditor.dirtyAssetIds.filter((id) => id !== qbEditor.selectedAssetId);
                        }
                        qbEditor.dirty = false;
                        if (qbPackageActive.value && qbEditor.selectedAssetId && qbEditor.packageAssets[qbEditor.selectedAssetId]) {
                            qbEditor.packageAssets[qbEditor.selectedAssetId] = {
                                ...qbEditor.packageAssets[qbEditor.selectedAssetId],
                                ...serializeQbDocument(),
                                path: qbEditor.path,
                                file_name: qbEditor.fileName,
                                source_format: qbEditor.sourceFormat,
                                source_file_type: qbEditor.sourceFileType
                            };
                        }
                        window.showToast(t('QB file saved to:\n{path}').replace('{path}', qbEditor.path));
                        return true;
                    }
                    window.showToast(t('Failed to save QB file:\n{error}').replace('{error}', result?.error || t('Unknown error occurred')), true);
                    return false;
                } catch (error) {
                    window.showToast(t('Failed to save QB file.'), true);
                    return false;
                } finally {
                    isWorking.savingQb = false;
                }
            };

            const saveQbDocumentAs = async () => {
                const dialogResult = await eel.ask_qb_save_file(qbEditor.path || '', qbDisplayName.value || 'untitled.qb')();
                const targetPath = dialogResult?.value ?? dialogResult?.data?.value ?? dialogResult;
                if (!targetPath) return false;
                return saveQbDocumentToPath(targetPath);
            };

            const saveQbDocument = async () => {
                if (qbEditor.path) {
                    return saveQbDocumentToPath(qbEditor.path);
                }
                return saveQbDocumentAs();
            };

            const newQbDocument = async () => {
                const canDiscard = await ensureQbDiscardChanges();
                if (!canDiscard) return;
                applyQbDocument(createEmptyQbDocument());
            };

            const openQbDocument = async () => {
                const canDiscard = await ensureQbDiscardChanges();
                if (!canDiscard) return;

                const dialogResult = await eel.ask_qb_file()();
                const filePath = dialogResult?.value ?? dialogResult?.data?.value ?? dialogResult;
                if (!filePath) return;

                const result = await eel.load_qb_file(filePath)();
                if (!result || !result.success) {
                    window.showToast(t('Failed to open voxel file:\n{error}').replace('{error}', result?.error || t('Unknown error occurred')), true);
                    return;
                }

                applyQbDocument(result.document, { packagePayload: result.package || null });
                if (result.package) {
                    window.showToast(t('Opened Trove blueprint assets in the voxel editor.'));
                } else if (result.document?.source_file_type === 'blueprint') {
                    window.showToast(t('Imported Trove blueprint into the voxel editor.'));
                }
            };

            watch(selectedQbMatrix, () => {
                qbEditor.hoverFace = null;
                qbEditor.hoverCell = null;
                syncQbMatrixForm();
                rebuildQbLookup();
                scheduleQbCanvasRender();
            }, { immediate: true });

            watch(() => qbEditor.selectedSlice, () => {
                qbEditor.hoverFace = null;
                qbEditor.hoverCell = null;
                scheduleQbCanvasRender();
            });

            watch(() => qbEditor.sliceZoom, () => {
                scheduleQbCanvasRender();
            });

            watch(() => qbEditor.clipMode, () => {
                qbEditor.hoverFace = null;
                qbEditor.hoverCell = null;
                scheduleQbCanvasRender();
            });

            watch(() => qbEditor.viewMode, () => {
                qbEditor.hoverFace = null;
                qbEditor.hoverCell = null;
                qbViewportState.mode = null;
                qbViewportState.lastFaceKey = '';
                scheduleQbCanvasRender();
            });

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;
                if (typeof saved.activeTab === 'string') activeTab.value = saved.activeTab;
                if (typeof saved.selectedGamePath === 'string') selectedGamePath.value = saved.selectedGamePath;
            };

            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    activeTab: activeTab.value,
                    selectedGamePath: selectedGamePath.value
                });
            };

            const runQueuedModderOperation = async ({ label, operation, task }) => {
                return window.JobQueue.run({
                    label,
                    task,
                    retryTask: task,
                    cancel: () => eel.cancel_modder_tools_operation(operation)()
                });
            };

            const unwrapResponse = (resp, key = null, fallback = null) => {
                if (key) {
                    if (resp && Object.prototype.hasOwnProperty.call(resp, key)) return resp[key];
                    if (resp && resp.data && Object.prototype.hasOwnProperty.call(resp.data, key)) return resp.data[key];
                }
                if (resp && resp.data !== undefined && resp.success !== undefined) return resp.data;
                return resp ?? fallback;
            };

            const readSettings = async () => {
                const settingsResp = await eel.get_settings()();
                return unwrapResponse(settingsResp, null, {}) || {};
            };

            const scanForGames = async () => {
                try {
                    const response = await eel.get_detected_game_paths()();
                    const settings = await readSettings();
                    const paths = unwrapResponse(response, 'paths', []);
                    const safePaths = Array.isArray(paths) ? paths : [];

                    if (safePaths.length > 0) {
                        installs.value = safePaths;
                        if (settings.last_game_path && installs.value.some(p => p.path === settings.last_game_path)) {
                            selectedGamePath.value = settings.last_game_path;
                        } else {
                            selectedGamePath.value = installs.value[0].path;
                        }
                        return;
                    }

                    installs.value = [];
                    selectedGamePath.value = '';
                    if (response && response.error) {
                        window.showToast(t('Game path detection failed: {error}').replace('{error}', response.error), true);
                    }
                } catch (error) {
                    installs.value = [];
                    selectedGamePath.value = '';
                    window.showToast(t('Game path detection failed.'), true);
                }
            };

            watch(selectedGamePath, async (newVal) => {
                if (!newVal) return;
                const settings = await readSettings();
                settings.last_game_path = newVal;
                await eel.save_settings(settings)();
            });

            watch([activeTab, selectedGamePath], persistState, { deep: true });

            const openPathInExplorer = async (path) => {
                if (!path) {
                    window.showToast(t('No path selected.'), true);
                    return;
                }
                const result = await eel.open_path_in_explorer(path)();
                if (!result || !result.success) {
                    window.showToast(t('Failed to open folder: {error}').replace('{error}', result?.error || t('Unknown error occurred')), true);
                }
            };

            const openSelectedGamePath = async () => {
                await openPathInExplorer(selectedGamePath.value);
            };

            const openProjectFolder = async () => {
                await openPathInExplorer(project.dir);
            };

            const openBuildOutputFolder = async () => {
                await openPathInExplorer(lastBuildOutputPath.value);
            };

            const openCompileOutputFolder = async () => {
                await openPathInExplorer(lastCompiledProjectPath.value);
            };

            const openBuildFileLocation = async (file) => {
                await openPathInExplorer(file?.path);
            };

            const openProjectFileLocation = async (file) => {
                await openPathInExplorer(file?.abs_path);
            };

            const chooseBuildPreview = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                const result = await eel.ask_preview_file(selectedGamePath.value)();
                const file = result?.file;
                if (file) {
                    const nextPreviewName = file.name;
                    const previewPath = normalizeInternalPath(previewInternalPath(nextPreviewName));
                    if (build.files.some(existing => normalizeInternalPath(existing.internal_path) === previewPath)) {
                        window.showToast(t("Preview image path cannot also be included in the files list."), true);
                        return;
                    }
                    build.preview = file.data;
                    build.previewName = nextPreviewName;
                }
            };

            const chooseBuildConfig = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                const result = await eel.ask_config_file(selectedGamePath.value)();
                const file = result?.file;
                if (file) {
                    build.config = file.data;
                    build.configName = 'default.cfg';
                }
            };

            const detectBuildOverrides = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                
                isWorking.detectingOverrides = true;
                
                const pathsToCheck = build.files.map(f => f.path);
                if (pathsToCheck.length > 0) {
                    const missingResult = await eel.get_missing_files(pathsToCheck)();
                    if (missingResult.success && missingResult.missing) {
                        build.files = build.files.filter(f => !missingResult.missing.includes(f.path));
                    }
                }
                
                let result;
                try {
                    result = await runQueuedModderOperation({
                        label: t('Detect override files'),
                        operation: 'detect_overrides',
                        task: () => eel.detect_override_files(selectedGamePath.value)()
                    });
                } catch (e) {
                    window.showToast(String(e || t('Error detecting overrides.')), true);
                    isWorking.detectingOverrides = false;
                    return;
                }

                if (result.cancelled) {
                    window.showToast(t('Override detection cancelled.'));
                    isWorking.detectingOverrides = false;
                    return;
                }
                if (result.success) {
                    let addedCount = 0;
                    result.files.forEach(f => {
                        if (!build.files.find(existing => existing.path === f.path)) {
                            build.files.push({ internal_path: f.internal_path, path: f.path });
                            addedCount++;
                        }
                    });
                    const validationError = validateSpecialFileSelections({
                        files: build.files,
                        previewName: build.previewName,
                        hasPreview: Boolean(build.preview),
                        hasConfig: Boolean(build.config)
                    });
                    if (validationError) {
                        build.files = build.files.filter(file => !result.files.some(added => added.path === file.path));
                        window.showToast(t(validationError), true);
                        isWorking.detectingOverrides = false;
                        return;
                    }
                    if (addedCount === 0) window.showToast(t("No new override files found in the source directory."), true);
                    else window.showToast(t("{count} override file(s) successfully detected.").replace("{count}", addedCount));
                } else {
                    window.showToast(t("Error detecting overrides: {error}").replace("{error}", result.error), true);
                }
                isWorking.detectingOverrides = false;
            };

            const addBuildFiles = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                try {
                    const result = await eel.ask_add_files(selectedGamePath.value)();
                    if (result && result.success) {
                        if (result.rejected && result.rejected.length > 0) {
                            window.showToast(t("Denied {count} file(s):\nSelected files must be located within the active game path.").replace("{count}", result.rejected.length), true);
                        }
                        if (result.rejected_cfg && result.rejected_cfg.length > 0) {
                            window.showToast(t("Denied {count} file(s):\n.cfg files must be added through the Config File option.").replace("{count}", result.rejected_cfg.length), true);
                        }
                        if (result.files && result.files.length > 0) {
                            const newFiles = [];
                            result.files.forEach(f => {
                                if (!build.files.find(existing => existing.path === f.path)) {
                                    newFiles.push({ internal_path: f.internal_path, path: f.path });
                                }
                            });
                            build.files.push(...newFiles);
                            const validationError = validateSpecialFileSelections({
                                files: build.files,
                                previewName: build.previewName,
                                hasPreview: Boolean(build.preview),
                                hasConfig: Boolean(build.config)
                            });
                            if (validationError) {
                                build.files = build.files.filter(file => !newFiles.some(added => added.path === file.path));
                                window.showToast(t(validationError), true);
                            }
                        }
                    }
                } catch (e) {
                    window.showToast(t("An error occurred while adding files."), true);
                }
            };

            const removeBuildFile = (file) => {
                build.files = build.files.filter(f => f.path !== file.path);
                window.showUndoToast(
                    t('Removed file from build list.'),
                    6,
                    () => {
                        if (!build.files.find(f => f.path === file.path)) {
                            build.files.push(file);
                        }
                    }
                );
            };

            const autoStructureBuild = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                isWorking.autoStructuringBuild = true;
                try {
                    const result = await runQueuedModderOperation({
                        label: t('Auto-structure build workspace files'),
                        operation: 'auto_structure_workspace',
                        task: () => eel.auto_structure_workspace(selectedGamePath.value, selectedGamePath.value)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Auto-structure cancelled.'));
                        return;
                    }
                    if (result.success) window.showToast(t("Successfully auto-structured {count} files!").replace("{count}", result.count));
                    else window.showToast(t("Error structuring files: {error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred while structuring files."), true);
                }
                isWorking.autoStructuringBuild = false;
            };

            const buildTMod = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a target game installation."), true);
                const title = build.title.trim();
                if (/[<>:"/\\|?*]/.test(title)) return window.showToast(t("Mod title contains illegal characters (< > : \" / \\ | ? *).\nPlease remove them to continue."), true);
                if (build.notes.trim().length > 220) return window.showToast(t("Mod notes cannot exceed 220 characters."), true);
                if (!title) return window.showToast(t("Please enter a mod title."), true);
                if (!build.author.trim()) return window.showToast(t("Please enter a mod author."), true);
                if (!build.version.trim()) return window.showToast(t("Please enter a mod version."), true);
                if (!build.notes.trim()) return window.showToast(t("Please enter mod notes or a description."), true);
                if (build.tags.length === 0) return window.showToast(t("Please select at least one tag."), true);
                if (build.files.length === 0) return window.showToast(t("Please add at least one file to your mod!"), true);
                const buildValidationError = validateSpecialFileSelections({
                    files: build.files,
                    previewName: build.previewName,
                    hasPreview: Boolean(build.preview),
                    hasConfig: Boolean(build.config)
                });
                if (buildValidationError) return window.showToast(t(buildValidationError), true);

                isWorking.buildingTMod = true;
                try {
                    const pathsToCheck = build.files.map(f => f.path);
                    if (pathsToCheck.length > 0) {
                        const missingResult = await eel.get_missing_files(pathsToCheck)();
                        if (missingResult.success && missingResult.missing && missingResult.missing.length > 0) {
                            build.files = build.files.filter(f => !missingResult.missing.includes(f.path));
                            window.showToast(t("Warning: {count} file(s) were missing from disk and have been removed from the list.\n\nPlease review your files and click Build TMod again.").replace("{count}", missingResult.missing.length), true);
                            isWorking.buildingTMod = false;
                            return;
                        }
                    }

                    const payload = {
                        gamePath: selectedGamePath.value,
                        title: title,
                        author: build.author.trim(),
                        version: build.version.trim(),
                        notes: build.notes.trim(),
                        tags: build.tags,
                        previewBase64: build.preview || null,
                        previewName: build.previewName || "preview.png",
                        configBase64: build.config || null,
                        configName: build.configName || "config.cfg",
                        files: build.files.map(f => ({ internal_path: f.internal_path, abs_path: f.path }))
                    };

                    const runBuild = async (requestPayload) => runQueuedModderOperation({
                        label: t("Build TMod '{name}'").replace('{name}', title),
                        operation: 'build_tmod',
                        task: () => eel.build_tmod(requestPayload)()
                    });

                    let result = await runBuild(payload);
                    if (!result.cancelled && !result.success && result.code === 'FILE_EXISTS') {
                        const overwriteConfirmed = await window.showConfirmModal({
                            title: t('Overwrite Existing TMod?'),
                            message: t('A file with this name already exists. Do you want to overwrite it?'),
                            confirmLabel: t('Overwrite'),
                            cancelLabel: t('Cancel'),
                            danger: true
                        });

                        if (!overwriteConfirmed) {
                            isWorking.buildingTMod = false;
                            window.showToast(t('Build cancelled.'));
                            return;
                        }

                        result = await runBuild({ ...payload, overwrite: true });
                    }

                    if (result.cancelled) {
                        window.showToast(t('Build cancelled.'));
                        isWorking.buildingTMod = false;
                        return;
                    }
                    if (result.success) {
                        lastBuildOutputPath.value = result.path || '';
                        window.showToast(t("TMod successfully built!\nSaved to: {path}").replace("{path}", result.path), false);
                    }
                    else window.showToast(t("Failed to build TMod:\n{error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred while building the TMod."), true);
                }
                isWorking.buildingTMod = false;
            };

            const browseExtractSource = async () => {
                const fileResp = await eel.ask_tmod_file()();
                const file = fileResp?.value ?? fileResp?.data?.value ?? fileResp;
                if (file) extract.source = file;
            };
            const browseExtractDest = async () => {
                const dirResp = await eel.ask_extract_destination()();
                const dir = dirResp?.value ?? dirResp?.data?.value ?? dirResp;
                if (dir) extract.dest = dir;
            };
            const extractTMod = async () => {
                if (!extract.source) return window.showToast(t("Please select a Source TMod File."), true);
                if (!extract.dest) return window.showToast(t("Please select a Destination Folder."), true);
                
                isWorking.extracting = true;
                try {
                    const result = await runQueuedModderOperation({
                        label: t('Extract TMod archive'),
                        operation: 'extract_tmod',
                        task: () => eel.extract_tmod(extract.source, extract.dest)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Extraction cancelled.'));
                        isWorking.extracting = false;
                        return;
                    }
                    if (result.success) window.showToast(t("Successfully extracted {count} files to:\n{path}").replace("{count}", result.count).replace("{path}", extract.dest));
                    else window.showToast(t("Failed to extract TMod:\n{error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred during extraction."), true);
                }
                isWorking.extracting = false;
            };

            const chooseProjectPreview = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                const result = await eel.ask_preview_file(selectedGamePath.value)();
                const file = result?.file;
                if (file) {
                    const nextPreviewName = file.name;
                    const previewPath = normalizeInternalPath(previewInternalPath(nextPreviewName));
                    if (project.files.some(existing => normalizeInternalPath(existing.rel_path) === previewPath)) {
                        window.showToast(t("Preview image path cannot also be included in the files list."), true);
                        return;
                    }
                    project.preview = file.data;
                    project.previewName = nextPreviewName;
                }
            };

            const chooseProjectConfig = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                const result = await eel.ask_config_file(selectedGamePath.value)();
                const file = result?.file;
                if (file) {
                    project.config = file.data;
                    project.configName = 'default.cfg';
                }
            };

            const refreshProjectFiles = async () => {
                if (!project.dir || !project.activeVersion) return;
                isWorking.refreshProjectFiles = true;
                const result = await eel.get_project_files(project.dir, project.activeVersion)();
                if (result.success) project.files = result.files;
                isWorking.refreshProjectFiles = false;
            };

            watch(() => project.activeVersion, () => {
                refreshProjectFiles();
            });

            const loadProjectData = async (dir) => {
                const result = await eel.load_mod_project(dir)();
                if (result.success) {
                    project.title = result.data.title || '';
                    project.author = result.data.author || '';
                    project.notes = result.data.notes || '';
                    project.tags = result.data.tags || [];
                    project.preview = result.data.previewBase64 || '';
                    project.previewName = result.data.previewName || '';
                    project.config = result.data.configBase64 || '';
                    project.configName = result.data.configName || '';
                    
                    project.versions = result.data.versions || ["1.0"];
                    project.activeVersion = result.data.active_version || project.versions[0];
                } else {
                    window.showToast(t("Error loading project: {error}").replace("{error}", result.error), true);
                }
            };

            const browseProject = async () => {
                const dirResp = await eel.ask_mod_source_directory()();
                const dir = dirResp?.value ?? dirResp?.data?.value ?? dirResp;
                if (dir) {
                    project.dir = dir;
                    await loadProjectData(dir);
                }
            };

            const saveProject = async () => {
                if (!project.dir) return;
                if (project.notes.trim().length > 220) return window.showToast(t("Project notes cannot exceed 220 characters."), true);

                const payload = {
                    title: project.title.trim(),
                    author: project.author.trim(),
                    notes: project.notes.trim(),
                    tags: project.tags,
                    active_version: project.activeVersion,
                    previewBase64: project.preview || null,
                    previewName: project.previewName || "preview.png",
                    configBase64: project.config || null,
                    configName: project.config ? (project.configName || "config.cfg") : ""
                };

                const result = await eel.save_mod_project(project.dir, payload)();
                if (result.success) window.showToast(t("Project metadata saved successfully!"));
                else window.showToast(t("Error saving project: {error}").replace("{error}", result.error), true);
            };

            const newVersion = async () => {
                if (!project.dir) return;
                const nv = prompt(t("Enter new version number (e.g., 1.1):"));
                if (!nv) return;

                const result = await eel.create_project_version(project.dir, nv)();
                if (result.success) {
                    window.showToast(t("New version folder created!"));
                    await loadProjectData(project.dir);
                    project.activeVersion = nv;
                } else window.showToast(t("Error creating version: {error}").replace("{error}", result.error), true);
            };

            const autoStructureProject = async () => {
                if (!project.dir || !project.activeVersion || !selectedGamePath.value) return window.showToast(t("Ensure a project, version, and game path are selected."), true);
                isWorking.autoStructuringProject = true;
                try {
                    const result = await runQueuedModderOperation({
                        label: t('Auto-structure project version files'),
                        operation: 'auto_structure_project',
                        task: () => eel.auto_structure_project_version(project.dir, project.activeVersion, selectedGamePath.value)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Project auto-structure cancelled.'));
                        return;
                    }
                    if (result.success) {
                        window.showToast(t("Successfully structured {count} files!").replace("{count}", result.count));
                        await refreshProjectFiles();
                    } else window.showToast(t("Error structuring files: {error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred."), true);
                }
                isWorking.autoStructuringProject = false;
            };

            const compileProject = async () => {
                if (!project.dir || !project.activeVersion || !selectedGamePath.value) return window.showToast(t("Ensure a project, version, and game path are selected."), true);
                if (!project.title.trim()) return window.showToast(t("Project title cannot be empty."), true);
                if (project.notes.trim().length > 220) return window.showToast(t("Project notes cannot exceed 220 characters."), true);
                const projectValidationError = validateSpecialFileSelections({
                    files: project.files.map(file => ({ internal_path: file.rel_path })),
                    previewName: project.previewName,
                    hasPreview: Boolean(project.preview),
                    hasConfig: Boolean(project.config)
                });
                if (projectValidationError) return window.showToast(t(projectValidationError), true);

                await saveProject();
                
                isWorking.compilingProject = true;
                try {
                    const result = await runQueuedModderOperation({
                        label: t("Compile project '{name}'").replace('{name}', project.title.trim() || t('Untitled')),
                        operation: 'compile_project',
                        task: () => eel.compile_project(project.dir, project.activeVersion, selectedGamePath.value)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Project compile cancelled.'));
                        isWorking.compilingProject = false;
                        return;
                    }
                    if (result.success) {
                        lastCompiledProjectPath.value = result.path || '';
                        window.showToast(t("Project successfully compiled!\nSaved to: {path}").replace("{path}", result.path), false);
                    }
                    else window.showToast(t("Failed to compile project:\n{error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred while compiling the project."), true);
                }
                isWorking.compilingProject = false;
            };

            const placeOverrides = async () => {
                if (!project.dir || !project.activeVersion || !selectedGamePath.value) return window.showToast(t("Ensure a project, version, and game path are selected."), true);
                isWorking.placingOverrides = true;
                try {
                    const result = await runQueuedModderOperation({
                        label: t('Place project overrides into game'),
                        operation: 'place_overrides',
                        task: () => eel.place_project_overrides(project.dir, project.activeVersion, selectedGamePath.value)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Placing overrides cancelled.'));
                        isWorking.placingOverrides = false;
                        return;
                    }
                    if (result.success) {
                        if (result.count === 0) window.showToast(t("No valid files found to test."));
                        else {
                            project.activeOverrides = result.placed_files;
                            window.showToast(t("{count} files placed in game overrides for testing.").replace("{count}", result.count));
                        }
                    } else window.showToast(t("Error placing overrides: {error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred."), true);
                }
                isWorking.placingOverrides = false;
            };

            const removeOverrides = async () => {
                if (project.activeOverrides.length === 0) return;
                const confirmed = await window.showConfirmModal({
                    title: t('Remove Overrides'),
                    message: t('Remove all currently placed override files from the game?'),
                    confirmLabel: t('Remove'),
                    cancelLabel: t('Cancel'),
                    danger: true
                });
                if (!confirmed) return;

                isWorking.removingOverrides = true;
                try {
                    const removedSnapshot = [...project.activeOverrides];
                    const result = await runQueuedModderOperation({
                        label: t('Remove project overrides from game'),
                        operation: 'remove_overrides',
                        task: () => eel.remove_project_overrides(project.activeOverrides)()
                    });
                    if (result.cancelled) {
                        if (result.undo_token) {
                            window.showUndoToast(
                                t('Removal cancelled. Restore removed files?'),
                                10,
                                async () => {
                                    const undoResult = await eel.undo_remove_project_overrides(result.undo_token)();
                                    if (!undoResult.success) {
                                        window.showToast(t('Undo failed: {error}').replace('{error}', undoResult.error || t('Unknown error occurred')), true);
                                        return;
                                    }
                                    project.activeOverrides = removedSnapshot;
                                    window.showToast(t('Overrides restored.'));
                                }
                            );
                        }
                        window.showToast(t('Removing overrides cancelled.'));
                        isWorking.removingOverrides = false;
                        return;
                    }
                    if (result.success) {
                        window.showToast(t("{count} override files successfully removed from game.").replace("{count}", result.count));
                        project.activeOverrides = [];

                        if (result.undo_token) {
                            window.showUndoToast(
                                t('Overrides removed.'),
                                10,
                                async () => {
                                    const undoResult = await eel.undo_remove_project_overrides(result.undo_token)();
                                    if (!undoResult.success) {
                                        window.showToast(t('Undo failed: {error}').replace('{error}', undoResult.error || t('Unknown error occurred')), true);
                                        return;
                                    }
                                    if (undoResult.restored > 0) {
                                        project.activeOverrides = removedSnapshot;
                                    }
                                    if (undoResult.conflicts && undoResult.conflicts.length > 0) {
                                        window.showToast(t('Undo completed with conflicts for existing files.'), true);
                                    } else {
                                        window.showToast(t('Overrides restored.'));
                                    }
                                }
                            );
                        }
                    } else window.showToast(t("Error removing overrides: {error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred."), true);
                }
                isWorking.removingOverrides = false;
            };

            const loadModdingSoftware = async () => {
                try {
                    const response = await fetch('assets/data/modding_software.json');
                    const data = await response.json();
                    const categoryIcons = { 'blueprints': 'fa-cube', 'vfx': 'fa-wand-magic-sparkles', 'ui': 'fa-layer-group', 'sound': 'fa-headphones', 'textures': 'fa-palette' };
                    
                    for (const [cat, catData] of Object.entries(data)) {
                        catData.icon = categoryIcons[cat] || 'fa-laptop-code';
                    }
                    softwareCategories.value = data;
                } catch (e) { console.error("Failed to load software:", e); }
            };

            const ensureEmbeddedFileManagerLoaded = async () => {
                if (embeddedFileManagerLoaded) return;
                if (embeddedFileManagerLoading) {
                    await embeddedFileManagerLoading;
                    return;
                }

                embeddedFileManagerLoading = (async () => {
                    const host = document.getElementById('modder-tools-file-manager-host');
                    if (!host) return;

                    const response = await fetch('views/file_manager.html', { cache: 'no-store' });
                    if (!response.ok) throw new Error(`Failed to load file manager view (${response.status})`);

                    const html = await response.text();
                    const parsed = new DOMParser().parseFromString(html, 'text/html');
                    const root = parsed.querySelector('#file-manager-vue-app');
                    if (!root) throw new Error('File Manager root element not found');

                    host.innerHTML = '';
                    host.appendChild(root);

                    document.dispatchEvent(new CustomEvent('file_manager_loaded'));
                    embeddedFileManagerLoaded = true;
                })();

                try {
                    await embeddedFileManagerLoading;
                } finally {
                    embeddedFileManagerLoading = null;
                }
            };

            const syncEmbeddedFileManagerTab = (tabName) => {
                document.dispatchEvent(new CustomEvent('file_manager_set_tab', { detail: { tab: tabName } }));
            };

            const handleEmbeddedTabSelection = async (newTab) => {
                if (newTab !== 'file_explorer' && newTab !== 'update_tracker') return;
                await ensureEmbeddedFileManagerLoaded();
                syncEmbeddedFileManagerTab(newTab === 'file_explorer' ? 'tab-explorer' : 'tab-tracker');
            };

            watch(activeTab, (newTab) => {
                if (newTab === 'qb_editor') {
                    scheduleQbCanvasRender();
                }
                handleEmbeddedTabSelection(newTab).catch((e) => {
                    console.error('Failed to load embedded File Manager:', e);
                    window.showToast(t('Failed to load Game File Manager inside Modder Tools.'), true);
                });
            });

            onMounted(async () => {
                hydratingState = true;
                if (window.AppSettings) {
                    await window.AppSettings.load();
                    const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                    applyStateSnapshot(saved);
                }
                if (window.pendingModderToolsTab) {
                    activeTab.value = window.pendingModderToolsTab;
                    window.pendingModderToolsTab = null;
                }
                await scanForGames();
                await loadModdingSoftware();
                applyQbDocument(createEmptyQbDocument());
                await handleEmbeddedTabSelection(activeTab.value);
                window.addEventListener('mouseup', qbMouseUpHandler);
                window.addEventListener('mousemove', qbGlobalMouseMoveHandler);
                window.addEventListener('resize', qbResizeHandler);
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                hydratingState = false;
            });

            onBeforeUnmount(() => {
                window.removeEventListener('mouseup', qbMouseUpHandler);
                window.removeEventListener('mousemove', qbGlobalMouseMoveHandler);
                window.removeEventListener('resize', qbResizeHandler);
                if (window._fileManagerApp && typeof window._fileManagerApp.unmount === 'function') {
                    window._fileManagerApp.unmount();
                    window._fileManagerApp = null;
                }
            });

            return {
                t, activeTab, installs, selectedGamePath, gameOptions,
                lastBuildOutputPath, lastCompiledProjectPath,
                tagOptions, build, extract, project, softwareCategories, isWorking,
                qbEditor, qbMatrixForm, qbCanvasRef, qbViewportCanvasRef, selectedQbMatrix, qbPackageActive, qbHasUnsavedAssets, qbSelectedAsset, qbBlueprintAssetRows, qbDisplayName, qbContainerName, qbVersionLabel, qbTotalVoxelCount, qbVisibleVoxelCount, qbSliceVoxels, qbHoverSummary, qbActiveToolLabel, qbCurrentAttachmentPoint, qbAttachmentStatus, qbHoveredEditableCell,
                scanForGames, chooseBuildPreview, detectBuildOverrides, addBuildFiles, removeBuildFile, autoStructureBuild, buildTMod,
                chooseBuildConfig,
                openSelectedGamePath, openProjectFolder, openBuildOutputFolder, openCompileOutputFolder, openBuildFileLocation, openProjectFileLocation,
                browseExtractSource, browseExtractDest, extractTMod,
                chooseProjectPreview, chooseProjectConfig, refreshProjectFiles, browseProject, saveProject, newVersion, autoStructureProject, compileProject, placeOverrides, removeOverrides,
                markQbDirty, newQbDocument, openQbDocument, saveQbDocument, saveQbDocumentAs, openQbFileLocation,
                selectQbMatrix, selectQbPackageAsset, addQbMatrix, removeSelectedQbMatrix, applyQbMatrixForm, fillQbSlice, clearQbSlice, stepQbSlice, setQbTool, setQbViewMode, resetQbView, setCurrentQbAttachmentPoint, clearCurrentQbAttachmentPoints, focusCurrentQbAttachmentPoint, syncAttachmentPointAcrossPackageFamily,
                onQbCanvasMouseDown, onQbCanvasMouseMove, onQbCanvasMouseLeave,
                onQbViewportMouseDown, onQbViewportMouseMove, onQbViewportMouseLeave, onQbViewportWheel,
                toggleQbVisibilityMaskMode, sampleQbVoxel, removeQbVoxel
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);
    app.component('select2', window.Select2Component);
    
    if (window._modderToolsApp) window._modderToolsApp.unmount();
    window._modderToolsApp = app;
    app.mount('#modder-tools-vue-app');
});
