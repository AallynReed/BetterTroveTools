document.addEventListener('modder_qb_editor_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } = Vue;

    const app = createApp({
        setup() {
            const { store, t } = window.ModderTools;

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
                decodeInfo: null,
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

            // Named material presets per strict map layer, loaded once from the backend.
            const materialPresets = ref(null);

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
            // Active layer of the selected blueprint asset ('base'|'type'|'alpha'|'specular'|'rendered').
            const qbActiveLayer = computed(() => qbSelectedAsset.value?.layer || '');
            // The "Rendered (decos)" composite is a read-only preview, not an editable source.
            const qbLayerReadOnly = computed(() => Boolean(qbSelectedAsset.value?.read_only)
                || qbActiveLayer.value === 'rendered');
            // Named material presets for the strict map layers (loaded once from the backend).
            const activeLayerPresets = computed(() => {
                const layer = qbActiveLayer.value;
                if (!materialPresets.value) return [];
                return materialPresets.value[layer] || [];
            });
            const rgbToHex = (rgb) => {
                if (!Array.isArray(rgb) || rgb.length < 3) return '#000000';
                return '#' + rgb.map((c) => Math.max(0, Math.min(255, c | 0)).toString(16).padStart(2, '0')).join('');
            };
            const qbDisplayName = computed(() => {
                if (qbSelectedAsset.value?.asset_label) return qbSelectedAsset.value.asset_label;
                return qbEditor.fileName || (qbEditor.path ? qbEditor.path.split(/[\\/]/).pop() : 'untitled.qb');
            });
            const qbContainerName = computed(() => qbEditor.containerFileName || qbEditor.fileName || 'untitled.qb');
            const qbDecodeInfoRows = computed(() => {
                const info = qbEditor.decodeInfo;
                if (!info || typeof info !== 'object') return [];

                const rows = [['Source', qbEditor.sourceFormat || qbEditor.sourceFileType || 'qb']];
                if (info.kind) rows.push(['Decode Kind', String(info.kind)]);
                if (info.version != null) rows.push(['Blueprint Version', String(info.version)]);

                const geometry = info.geometry || {};
                if (geometry.strategy) rows.push(['Geometry Strategy', String(geometry.strategy)]);
                if (Array.isArray(geometry.selected_combo) && geometry.selected_combo.length === 3) {
                    rows.push(['Byte Combo', geometry.selected_combo.join(', ')]);
                }

                const selected = geometry.selected || {};
                if (selected.unique_points != null) rows.push(['Unique Points', String(selected.unique_points)]);
                if (selected.valid_points != null) rows.push(['Valid Points', String(selected.valid_points)]);
                if (selected.adjacency_pairs != null) rows.push(['Adjacency Pairs', String(selected.adjacency_pairs)]);
                if (selected.compactness != null) rows.push(['Compactness', String(selected.compactness)]);
                if (selected.mirrored_matches != null) rows.push(['Mirror Matches', String(selected.mirrored_matches)]);
                if (info.decoded_voxel_count != null) rows.push(['Decoded Voxels', String(info.decoded_voxel_count)]);
                if (info.visible_color_count != null) rows.push(['Visible Colors', String(info.visible_color_count)]);
                if (info.local_duplicate_resolutions != null) rows.push(['Local Resolutions', String(info.local_duplicate_resolutions)]);
                if (info.sequential_fill_count != null) rows.push(['Sequential Fill', String(info.sequential_fill_count)]);
                if (info.used_fallback_fill) rows.push(['Position Fill', 'Fallback cells used']);
                if (info.used_white_fallback) rows.push(['Color Fill', 'White fallback used']);

                return rows.map(([label, value]) => ({ label, value }));
            });
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
                    case 'paint': return t('modder_tools.paint');
                    case 'add': return t('modder_tools.add');
                    case 'erase': return t('modder_tools.erase');
                    case 'sample': return t('modder_tools.sample');
                    case 'pan': return t('modder_tools.pan');
                    default: return t('modder_tools.orbit');
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
                    decode_info: qbEditor.decodeInfo || currentAsset.decode_info || null,
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
                qbEditor.decodeInfo = normalizedDocument.decode_info || null;
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
                    title: t('modder_tools.discard_qb_changes'),
                    message: t('modder_tools.you_have_unsaved_qb_edits_continue_and_l_438a5e'),
                    confirmLabel: t('modder_tools.discard'),
                    cancelLabel: t('modder_tools.keep_editing'),
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

            const selectQbPackageAsset = async (assetId) => {
                if (!assetId || !qbPackageActive.value || assetId === qbEditor.selectedAssetId) return;
                let asset = qbEditor.packageAssets?.[assetId];
                if (!asset) return;
                // The "Rendered (decos)" layer is built on demand (it can be hundreds
                // of thousands of voxels -- 1 block explodes to 12^3). Fetch it the
                // first time it's selected.
                if (asset.lazy && !asset._built) {
                    if (typeof eel.build_blueprint_render !== 'function') {
                        window.showToast(t('modder_tools.full_render_needs_a_restart_the_build_bl_86eb30'), true);
                        return;
                    }
                    try {
                        window.showToast(t('modder_tools.building_full_render_this_can_take_a_mom_0b9474'));
                        const res = await eel.build_blueprint_render(
                            asset.path, store.selectedGamePath || null)();
                        if (res && res.success && res.document) {
                            asset = { ...asset, ...res.document, lazy: false, _built: true };
                            qbEditor.packageAssets[assetId] = asset;
                            const ri = res.document.render_info || {};
                            const note = ri.structure_omitted
                                ? t('modder_tools.rendered_n_decos_structure_omitted_build_bd4451').replace('{n}', ri.decos_placed ?? '?')
                                : t('modder_tools.rendered_n_decos_structure_v_voxels').replace('{n}', ri.decos_placed ?? '?').replace('{v}', (ri.voxel_count ?? 0).toLocaleString());
                            window.showToast(note);
                        } else {
                            const msg = (res && res.error) ? res.error
                                : t('modder_tools.could_not_build_the_full_render');
                            window.showToast(msg, true);
                            return;
                        }
                    } catch (e) {
                        window.showToast((t('modder_tools.could_not_build_the_full_render_7197cc') + (e && e.errorText ? e.errorText : e)), true);
                        return;
                    }
                }
                storeCurrentQbAssetState();
                qbEditor.selectedAssetId = assetId;
                applyQbDocument(asset, { preservePackage: true, selectedAssetId: assetId });
            };

            // Export the FULL, uncapped exploded render (build body + every deco at
            // 12 voxels/block, full detail) to a .qb file. The live 2D viewport can't
            // draw a whole house, but a GPU voxel viewer opens the exported .qb fine.
            const exportFullBlueprintRender = async () => {
                const bpPath = qbEditor.containerPath || qbEditor.path;
                if (!bpPath) { window.showToast(t('modder_tools.open_a_trove_blueprint_first'), true); return; }
                if (typeof eel.export_blueprint_render !== 'function') {
                    window.showToast(t('modder_tools.export_needs_a_restart_the_export_bluepr_b0522f'), true);
                    return;
                }
                const stem = String(qbEditor.containerFileName || 'blueprint').replace(/\.[^.]+$/, '');
                const dialogResult = await eel.ask_qb_save_file(bpPath, stem + '_fullrender.qb')();
                const outPath = dialogResult?.value ?? dialogResult?.data?.value ?? dialogResult;
                if (!outPath) return;
                window.showToast(t('modder_tools.exporting_full_render_to_qb_this_can_tak_b67a92'));
                try {
                    const res = await eel.export_blueprint_render(bpPath, outPath, store.selectedGamePath || null)();
                    if (res && res.success) {
                        window.showToast(t('modder_tools.exported_n_voxels_to_f')
                            .replace('{n}', (res.voxel_count || 0).toLocaleString())
                            .replace('{f}', res.file_name || outPath));
                    } else {
                        window.showToast((res && res.error) || t('modder_tools.export_failed'), true);
                    }
                } catch (e) {
                    window.showToast(t('modder_tools.export_failed_c93ab1') + (e && e.errorText ? e.errorText : e), true);
                }
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
                    title: t('modder_tools.remove_matrix'),
                    message: t('modder_tools.remove_the_selected_matrix_from_this_qb_9bfe69'),
                    confirmLabel: t('modder_tools.remove'),
                    cancelLabel: t('common.cancel'),
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
                    window.showToast(t('modder_tools.count_voxel_s_were_clipped_by_the_new_ma_c54788').replace('{count}', removed));
                }
            };

            // Set the paint colour to a named material preset (Metal, Glass, 50% ...).
            // Painting that colour into the active map layer makes recompile derive the
            // matching voxel (type, w) via the verified material tables.
            const applyMaterialPreset = (preset) => {
                if (!preset || !Array.isArray(preset.rgb)) return;
                qbEditor.paintColor = rgbToHex(preset.rgb);
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
                window.showToast(t('modder_tools.sampled_voxel_color'));
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
                    window.showToast(t('modder_tools.hover_a_voxel_or_slice_cell_first'), true);
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
                    window.showToast(t('modder_tools.attachment_point_updated'));
                }
                return changed;
            };

            const clearCurrentQbAttachmentPoints = () => {
                const removed = clearAttachmentPointsInDocument(qbEditor);
                if (removed <= 0) return;
                markQbDirty();
                rebuildQbLookup();
                scheduleQbCanvasRender();
                window.showToast(t('modder_tools.attachment_point_cleared'));
            };

            const focusCurrentQbAttachmentPoint = () => {
                const point = qbCurrentAttachmentPoint.value;
                if (!point) {
                    window.showToast(t('modder_tools.this_asset_does_not_have_exactly_one_att_0ae082'), true);
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
                    window.showToast(t('modder_tools.set_exactly_one_attachment_point_in_the_0693fc'), true);
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
                    window.showToast(t('modder_tools.synced_attachment_point_to_count_package_65bdce').replace('{count}', changedAssets));
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
                        window.showToast(t('modder_tools.expand_the_matrix_bounds_before_adding_v_3fc22f'), true);
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
                    window.showToast(t('modder_tools.filled_count_voxel_s_in_the_current_slic_b698e5').replace('{count}', changed));
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
                window.showToast(t('modder_tools.cleared_count_voxel_s_from_the_current_s_15dae2').replace('{count}', targets.length));
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
                        ? `${qbVoxelHex(voxel).toUpperCase()} | ${qbEditor.header.visibility_mask_encoded ? `${t('modder_tools.mask')} ${voxel[6]}` : `${t('modder_tools.alpha')} ${voxel[6]}`}`
                        : t('common.empty')
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
                    currentLabel: currentCount === 0 ? t('modder_tools.missing') : currentCount === 1 ? t('common.ready') : t('modder_tools.multiple'),
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
                await window.ModderTools.openPathInExplorer(qbEditor.path);
            };

            const saveQbDocumentToPath = async (path) => {
                if (!path) return false;
                store.isWorking.savingQb = true;
                try {
                    storeCurrentQbAssetState();
                    // Saving a Trove blueprint package: send all layer assets
                    // (base + type/alpha/specular) so the backend recompiles them
                    // into one .blueprint. Otherwise save the single QB document.
                    const isBlueprintTarget = String(path).toLowerCase().endsWith('.blueprint');
                    const savePayload = (isBlueprintTarget && qbPackageActive.value)
                        ? {
                            assets: qbEditor.packageAssets,
                            source_format: 'trove_blueprint_package',
                            container_path: qbEditor.containerPath,
                            file_name: qbEditor.containerFileName || qbEditor.fileName,
                        }
                        : serializeQbDocument();
                    const result = await eel.save_qb_file(path, savePayload)();
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
                                source_file_type: qbEditor.sourceFileType,
                                decode_info: qbEditor.decodeInfo
                            };
                        }
                        window.showToast(t('modder_tools.qb_file_saved_to_path').replace('{path}', qbEditor.path));
                        return true;
                    }
                    window.showToast(t('modder_tools.failed_to_save_qb_file_error').replace('{error}', result?.error || t('common.unknown_error_occurred')), true);
                    return false;
                } catch (error) {
                    window.showToast(t('modder_tools.failed_to_save_qb_file'), true);
                    return false;
                } finally {
                    store.isWorking.savingQb = false;
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

                // Pass the selected game path so blueprints get exact procedural
                // tints + resolved block names from the live game registry.
                const result = await eel.load_qb_file(filePath, store.selectedGamePath || null)();
                if (!result || !result.success) {
                    window.showToast(t('modder_tools.failed_to_open_voxel_file_error').replace('{error}', result?.error || t('common.unknown_error_occurred')), true);
                    return;
                }

                applyQbDocument(result.document, { packagePayload: result.package || null });
                if (result.package) {
                    window.showToast(t('modder_tools.opened_trove_blueprint_assets_in_the_vox_d782e1'));
                } else if (result.document?.source_file_type === 'blueprint') {
                    window.showToast(t('modder_tools.imported_trove_blueprint_into_the_voxel_aaa1f0'));
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

            // Re-render when this tab becomes visible (the parent orchestrator
            // fires modder_qb_editor_shown on the activeTab switch).
            const qbShownHandler = () => { scheduleQbCanvasRender(); };

            onMounted(async () => {
                try {
                    const res = await eel.get_material_presets()();
                    if (res && res.success && res.presets) materialPresets.value = res.presets;
                } catch (e) { /* presets are optional */ }
                applyQbDocument(createEmptyQbDocument());
                // None of these handlers call preventDefault; marking them passive
                // lets the browser fast-path scroll/touch events that overlap with
                // the QB editor without waiting for our listener to return.
                window.addEventListener('mouseup', qbMouseUpHandler, { passive: true });
                window.addEventListener('mousemove', qbGlobalMouseMoveHandler, { passive: true });
                window.addEventListener('resize', qbResizeHandler, { passive: true });
                document.addEventListener('modder_qb_editor_shown', qbShownHandler);
            });

            onUnmounted(() => {
                window.removeEventListener('mouseup', qbMouseUpHandler);
                window.removeEventListener('mousemove', qbGlobalMouseMoveHandler);
                window.removeEventListener('resize', qbResizeHandler);
                document.removeEventListener('modder_qb_editor_shown', qbShownHandler);
            });

            return {
                t, store,
                qbEditor, qbMatrixForm, qbCanvasRef, qbViewportCanvasRef, selectedQbMatrix, qbPackageActive, qbHasUnsavedAssets, qbSelectedAsset, qbBlueprintAssetRows, qbDisplayName, qbContainerName, qbDecodeInfoRows, qbVersionLabel, qbTotalVoxelCount, qbVisibleVoxelCount, qbSliceVoxels, qbHoverSummary, qbActiveToolLabel, qbCurrentAttachmentPoint, qbAttachmentStatus, qbHoveredEditableCell,
                qbActiveLayer, qbLayerReadOnly, activeLayerPresets, applyMaterialPreset, rgbToHex,
                markQbDirty, newQbDocument, openQbDocument, saveQbDocument, saveQbDocumentAs, openQbFileLocation,
                selectQbMatrix, selectQbPackageAsset, exportFullBlueprintRender, addQbMatrix, removeSelectedQbMatrix, applyQbMatrixForm, fillQbSlice, clearQbSlice, stepQbSlice, setQbTool, setQbViewMode, resetQbView, setCurrentQbAttachmentPoint, clearCurrentQbAttachmentPoints, focusCurrentQbAttachmentPoint, syncAttachmentPointAcrossPackageFamily,
                onQbCanvasMouseDown, onQbCanvasMouseMove, onQbCanvasMouseLeave,
                onQbViewportMouseDown, onQbViewportMouseMove, onQbViewportMouseLeave, onQbViewportWheel,
                toggleQbVisibilityMaskMode, sampleQbVoxel, removeQbVoxel
            };
        }
    });

    if (window._modderQbEditorApp) window._modderQbEditorApp.unmount();
    window._modderQbEditorApp = app;
    app.mount('#modder-qb-editor-vue-app-inner');
});
