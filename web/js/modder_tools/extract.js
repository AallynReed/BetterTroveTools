// Pure-browser .tmod unpacker. Loaded alongside the Vue Extract view so the
// hosted web build (no eel bridge, no filesystem) can still let users extract
// a .tmod file - they pick it, we parse it locally with DataView +
// DecompressionStream, repack as STORED-method zip, and trigger a download.
//
// .tmod wire format (mirrors models/trove/mod.py:TMod.read_bytes):
//   uint64 header_size LE
//   uint16 version    LE
//   uint16 prop_count LE
//   for each property: LEB128 name_size, name bytes, LEB128 value_size, value
//   then file-table entries until pos == header_size: uint8 name_len, name
//     bytes, LEB128 index, LEB128 offset, LEB128 size, LEB128 checksum
//   bytes [header_size..end] are a zlib-compressed payload that the per-file
//   offset/size pairs index into.
const TmodUnpacker = (() => {
    let _crcTable;
    const crc32 = (u8) => {
        if (!_crcTable) {
            _crcTable = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                _crcTable[n] = c;
            }
        }
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < u8.length; i++) {
            crc = (crc >>> 8) ^ _crcTable[(crc ^ u8[i]) & 0xFF];
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    };

    const decompress = async (u8, format) => {
        const stream = new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream(format)));
        return new Uint8Array(await stream.arrayBuffer());
    };

    // Trove sometimes writes the .tmod payload as a Python zlib stream with
    // "stored" (uncompressed) blocks that the browser's DecompressionStream
    // rejects. Mirror models/trove/mod.py:TMod.manual_decompression — strip
    // the 7-byte prefix and 5-byte suffix, then concatenate 32KB chunks
    // separated by 5-byte block headers.
    const manualDecompress = (u8) => {
        if (u8.length < 12) throw new Error('payload too short for manual decompression');
        const inner = u8.subarray(7, u8.length - 5);
        const CHUNK = 32768;
        const FRAME = 5;
        const fullChunks = Math.floor(inner.length / (CHUNK + FRAME));
        const out = new Uint8Array(inner.length);
        let inPos = 0;
        let outPos = 0;
        for (let i = 0; i < fullChunks; i++) {
            out.set(inner.subarray(inPos, inPos + CHUNK), outPos);
            outPos += CHUNK;
            inPos += CHUNK + FRAME;
        }
        if (inPos < inner.length) {
            const tail = inner.subarray(inPos);
            out.set(tail, outPos);
            outPos += tail.length;
        }
        return out.subarray(0, outPos);
    };

    const parseTmod = async (arrayBuffer) => {
        if (!arrayBuffer || arrayBuffer.byteLength < 12) throw new Error('not a .tmod file (too small)');
        const dv = new DataView(arrayBuffer);
        const u8 = new Uint8Array(arrayBuffer);
        let pos = 0;
        const headerSize = Number(dv.getBigUint64(pos, true)); pos += 8;
        if (headerSize <= 12 || headerSize > arrayBuffer.byteLength) throw new Error('invalid .tmod header size');
        const version = dv.getUint16(pos, true); pos += 2;
        const propCount = dv.getUint16(pos, true); pos += 2;

        const readLeb = () => {
            let r = 0n, s = 0n;
            while (true) {
                if (pos >= u8.length) throw new Error('LEB128 past end of buffer');
                const b = u8[pos++];
                r |= BigInt(b & 0x7F) << s;
                if (!(b & 0x80)) return Number(r & ((1n << 32n) - 1n));
                s += 7n;
                if (s >= 64n) throw new Error('LEB128 too long');
            }
        };
        const dec = new TextDecoder('utf-8');

        const properties = [];
        for (let i = 0; i < propCount; i++) {
            const ns = readLeb();
            const name = dec.decode(u8.subarray(pos, pos + ns)); pos += ns;
            const vs = readLeb();
            const value = dec.decode(u8.subarray(pos, pos + vs)); pos += vs;
            properties.push({ name, value });
        }

        // Payload starts at headerSize bytes from the start. Try in order:
        // zlib-wrapped (the Python writer's default), then raw deflate, then
        // the Trove-specific stored-blocks fallback that mirrors the Python
        // manual_decompression path. Any single .tmod might only parse with
        // one of these — the third path catches files whose payload uses
        // uncompressed-block framing that the browser's DecompressionStream
        // rejects (seen on Trove-shipped .tmod files in the wild).
        const payload = u8.subarray(headerSize);
        let body;
        const errs = [];
        try { body = await decompress(payload, 'deflate'); }
        catch (e) { errs.push(`deflate: ${e?.message || e}`); }
        if (!body) {
            try { body = await decompress(payload, 'deflate-raw'); }
            catch (e) { errs.push(`deflate-raw: ${e?.message || e}`); }
        }
        if (!body) {
            try { body = manualDecompress(payload); }
            catch (e) { errs.push(`manual: ${e?.message || e}`); }
        }
        if (!body) throw new Error('failed to decompress .tmod payload (' + errs.join('; ') + ')');

        const files = [];
        while (pos < headerSize) {
            const nameLen = dv.getUint8(pos); pos += 1;
            const name = dec.decode(u8.subarray(pos, pos + nameLen)); pos += nameLen;
            const index = readLeb();
            const offset = readLeb();
            const size = readLeb();
            const checksum = readLeb();
            if (offset + size > body.length) {
                // Drop a malformed entry rather than throwing — matches the
                // backend's tolerant behavior (it returns a `skipped` list).
                continue;
            }
            files.push({ name, index, size, checksum, content: body.subarray(offset, offset + size) });
        }
        return { version, properties, files };
    };

    // Minimal STORED-method ZIP writer. No compression because .tmod payloads
    // are typically already compact and a real deflate would pull in pako-sized
    // dep weight for a marginal win on the kinds of files users extract.
    const buildZip = (entries) => {
        const enc = new TextEncoder();
        const parts = [];
        const cdRecs = [];
        let offset = 0;

        for (const e of entries) {
            const name = enc.encode(e.name.replace(/\\/g, '/'));
            const data = e.content;
            const crc = crc32(data);
            const size = data.length;

            // Local file header
            const lfh = new Uint8Array(30 + name.length);
            const lh = new DataView(lfh.buffer);
            lh.setUint32(0, 0x04034b50, true);
            lh.setUint16(4, 20, true);   // version needed
            lh.setUint16(6, 1 << 11, true); // flags: UTF-8 names
            lh.setUint16(8, 0, true);    // stored
            lh.setUint16(10, 0, true);   // dos time
            lh.setUint16(12, 0x21, true); // dos date (1980-01-01)
            lh.setUint32(14, crc, true);
            lh.setUint32(18, size, true);
            lh.setUint32(22, size, true);
            lh.setUint16(26, name.length, true);
            lh.setUint16(28, 0, true);
            lfh.set(name, 30);
            parts.push(lfh, data);

            // Central directory record
            const cd = new Uint8Array(46 + name.length);
            const cdv = new DataView(cd.buffer);
            cdv.setUint32(0, 0x02014b50, true);
            cdv.setUint16(4, 20, true);
            cdv.setUint16(6, 20, true);
            cdv.setUint16(8, 1 << 11, true);
            cdv.setUint16(10, 0, true);
            cdv.setUint16(12, 0, true);
            cdv.setUint16(14, 0x21, true);
            cdv.setUint32(16, crc, true);
            cdv.setUint32(20, size, true);
            cdv.setUint32(24, size, true);
            cdv.setUint16(28, name.length, true);
            cdv.setUint16(30, 0, true);
            cdv.setUint16(32, 0, true);
            cdv.setUint16(34, 0, true);
            cdv.setUint16(36, 0, true);
            cdv.setUint32(38, 0, true);
            cdv.setUint32(42, offset, true);
            cd.set(name, 46);
            cdRecs.push(cd);

            offset += lfh.length + data.length;
        }

        const cdStart = offset;
        let cdSize = 0;
        for (const cd of cdRecs) { parts.push(cd); cdSize += cd.length; }

        const eocd = new Uint8Array(22);
        const edv = new DataView(eocd.buffer);
        edv.setUint32(0, 0x06054b50, true);
        edv.setUint16(4, 0, true);
        edv.setUint16(6, 0, true);
        edv.setUint16(8, cdRecs.length, true);
        edv.setUint16(10, cdRecs.length, true);
        edv.setUint32(12, cdSize, true);
        edv.setUint32(16, cdStart, true);
        edv.setUint16(20, 0, true);
        parts.push(eocd);

        return new Blob(parts, { type: 'application/zip' });
    };

    const triggerDownload = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    };

    return { parseTmod, buildZip, triggerDownload };
})();

document.addEventListener('modder_extract_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, reactive, ref } = Vue;

    const app = createApp({
        setup() {
            const { store, t } = window.ModderTools;
            // Web build runs the extraction entirely in-browser — no eel, no
            // filesystem dialogs. Output is a downloaded .zip.
            const isWebMode = !!window.BTT_WEB_MODE;

            const extract = reactive({
                source: '', dest: ''
            });

            const validationState = reactive({
                extract: false
            });

            const webFileInput = ref(null);
            // Holds the picked browser File so extractTMod can read its bytes;
            // not reactive — we only need the latest reference.
            let pickedFile = null;

            const isExtractFieldInvalid = (field) => {
                if (!validationState.extract) return false;
                switch (field) {
                    case 'source': return !extract.source;
                    case 'dest':   return !isWebMode && !extract.dest;
                    default:       return false;
                }
            };

            const browseExtractSource = async () => {
                if (isWebMode) {
                    if (webFileInput.value) webFileInput.value.click();
                    return;
                }
                const fileResp = await eel.ask_tmod_file()();
                const file = fileResp?.value ?? fileResp?.data?.value ?? fileResp;
                if (file) extract.source = file;
            };
            const onWebFilePicked = (event) => {
                const f = event.target?.files?.[0];
                if (!f) return;
                pickedFile = f;
                extract.source = f.name;
            };
            const browseExtractDest = async () => {
                const dirResp = await eel.ask_extract_destination()();
                const dir = dirResp?.value ?? dirResp?.data?.value ?? dirResp;
                if (dir) extract.dest = dir;
            };

            const extractInWebMode = async () => {
                validationState.extract = true;
                if (!pickedFile) {
                    window.showToast(t("modder_tools.please_select_a_source_tmod_file"), true);
                    return;
                }
                store.isWorking.extracting = true;
                try {
                    const buf = await pickedFile.arrayBuffer();
                    const tmod = await TmodUnpacker.parseTmod(buf);
                    if (!tmod.files.length) {
                        window.showToast(t('modder_tools.web_extract_empty'), true);
                        return;
                    }
                    const zip = TmodUnpacker.buildZip(tmod.files);
                    const baseName = (pickedFile.name || 'tmod').replace(/\.tmod$/i, '') || 'tmod';
                    TmodUnpacker.triggerDownload(zip, `${baseName}.zip`);
                    window.showToast(t('modder_tools.web_extract_zip_done').replace('{count}', tmod.files.length));
                } catch (e) {
                    console.error('web extract failed:', e);
                    window.showToast(t('modder_tools.failed_to_extract_tmod_error').replace('{error}', String(e && e.message || e)), true);
                } finally {
                    store.isWorking.extracting = false;
                }
            };

            const extractTMod = async () => {
                if (isWebMode) return extractInWebMode();

                validationState.extract = true;
                if (!extract.source) return window.showToast(t("modder_tools.please_select_a_source_tmod_file"), true);
                if (!extract.dest) return window.showToast(t("modder_tools.please_select_a_destination_folder"), true);

                store.isWorking.extracting = true;
                try {
                    const result = await window.ModderTools.runQueuedModderOperation({
                        label: t('modder_tools.extract_tmod_archive'),
                        operation: 'extract_tmod',
                        task: () => eel.extract_tmod(extract.source, extract.dest)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('common.extraction_cancelled'));
                        store.isWorking.extracting = false;
                        return;
                    }
                    if (result.success) window.showToast(t("modder_tools.successfully_extracted_count_files_to_pa_a5ca3e").replace("{count}", result.count).replace("{path}", extract.dest));
                    else window.showToast(t("modder_tools.failed_to_extract_tmod_error").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred_during_extr_0d9416"), true);
                }
                store.isWorking.extracting = false;
            };

            return {
                t, store, extract, isWebMode, webFileInput,
                isExtractFieldInvalid,
                browseExtractSource, browseExtractDest, onWebFilePicked, extractTMod
            };
        }
    });

    if (window._modderExtractApp) window._modderExtractApp.unmount();
    window._modderExtractApp = app;
    app.mount('#modder-extract-vue-app-inner');
});
