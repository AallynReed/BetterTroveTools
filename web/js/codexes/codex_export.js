/**
 * Shared CSV export for the codex sub-views.
 *
 * Every codex tab already holds its full dataset client-side — each `load*()`
 * fetches the backend's cache JSON in one request and keeps the parsed rows in
 * a ref — so exporting is a pure front-end concern: no new eel round-trip, no
 * `csv` import on the Python side.
 *
 * Loaded with `js/codexes/index.js` (the parent view bundle) rather than per
 * sub-view, so it is guaranteed to exist before any tab lazy-loads its script.
 */
(function () {
    'use strict';

    // Excel only reads a UTF-8 CSV as UTF-8 if it opens with a BOM; without it,
    // every localized name comes out mojibake.
    const BOM = '﻿';

    /**
     * RFC 4180 cell escaping: quote when the value contains the delimiter, a
     * quote, or a newline, and double any embedded quote.
     *
     * gem_builds.js's exporter interpolates raw, which is safe only because its
     * grid is entirely numeric. Codex rows are item names and descriptions —
     * commas and quotes are the norm, not the exception.
     */
    const csvCell = (value) => {
        if (value === null || value === undefined) return '';
        const text = String(value);
        if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
        return text;
    };

    /** Flatten a list-valued field into one cell. `|` because `,` and `;` both appear in item names. */
    const joinList = (values, sep = ' | ') => {
        if (!Array.isArray(values)) return '';
        return values.map(v => String(v === null || v === undefined ? '' : v).trim())
            .filter(Boolean)
            .join(sep);
    };

    /**
     * The stat blocks decoded from prefabs (`allies`, `mounts`, `dragons`) are
     * arrays of `{name, text, display_value, value, is_percent}` with varying
     * completeness — `text` is the pre-rendered line when the decoder could not
     * split it into name/value.
     */
    const statsText = (stats) => {
        if (!Array.isArray(stats)) return '';
        return stats.map(stat => {
            if (!stat || typeof stat !== 'object') return String(stat || '');
            const name = String(stat.name || '').trim();
            const display = String(stat.display_value || '').trim();
            if (name && display) return `${name}: ${display}`;
            if (name && typeof stat.value === 'number') return `${name}: ${stat.value}${stat.is_percent ? '%' : ''}`;
            return String(stat.text || name || '').trim();
        }).filter(Boolean).join(' | ');
    };

    /** Booleans read better as Yes/No than as `true`/`false` in a spreadsheet. */
    const yesNo = (value, t) => {
        const translate = typeof t === 'function' ? t : (s) => s;
        return value ? translate('common.yes') : translate('common.no');
    };

    /**
     * Column `label`s are English in every caller, on purpose: a CSV is an
     * interchange artefact, and a header that renamed itself when the user
     * switched locale would break any sheet or script already pointed at it.
     * The button, tooltip and toasts around the export are translated; the
     * *values* are too, since those are what the user is reading.
     *
     * @param {Array<Object>} rows
     * @param {Array<{label: string, value: (row: Object) => any}>} columns
     */
    const toCsv = (rows, columns) => {
        const lines = [columns.map(col => csvCell(col.label)).join(',')];
        rows.forEach(row => {
            lines.push(columns.map(col => {
                let cell;
                try {
                    cell = col.value(row);
                } catch (err) {
                    cell = '';
                }
                return csvCell(cell);
            }).join(','));
        });
        // CRLF is what RFC 4180 specifies and what Excel expects.
        return BOM + lines.join('\r\n') + '\r\n';
    };

    const download = (text, filename) => {
        // Blob rather than a `data:` URI: the codex tables run to thousands of
        // rows and a data URI would hit the browser's URL-length ceiling.
        const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        // Deferred so the click has actually started the download before the
        // object URL goes away.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    /**
     * Export a codex's rows, with the empty guard and the result toast.
     *
     * Callers pass their *filtered* list, never the paginated slice: the point
     * of the feature is "what exists / what do I have", and shipping only the
     * 36 rows currently on screen would defeat it.
     *
     * @param {{rows: Array<Object>, columns: Array<Object>, basename: string, t?: Function}} options
     * @returns {boolean} whether a file was produced
     */
    const run = ({ rows, columns, basename, t }) => {
        const translate = typeof t === 'function' ? t : (s) => s;
        const list = Array.isArray(rows) ? rows : [];
        if (list.length === 0) {
            if (window.showToast) window.showToast(translate('codexes.nothing_to_export_adjust_filters'), true);
            return false;
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const filename = `trove_${basename}_${stamp}.csv`;
        try {
            download(toCsv(list, columns), filename);
        } catch (err) {
            console.error('Codex CSV export failed:', err);
            if (window.showToast) window.showToast(translate('codexes.csv_export_failed'), true);
            return false;
        }
        if (window.showToast) {
            window.showToast(
                translate('codexes.exported_count_rows_to_filename')
                    .replace('{count}', list.length)
                    .replace('{filename}', filename)
            );
        }
        return true;
    };

    window.CodexExport = { csvCell, joinList, statsText, yesNo, toCsv, download, run };
})();
