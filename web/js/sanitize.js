/* Shared HTML-safety helpers.
 *
 * The UI builds a lot of markup with template strings and assigns it through
 * `innerHTML`. Most of that markup is authored by us, but some of it carries
 * values we don't control -- a search box, a mod title from Trovesaurus, a
 * translation string shipped in a locale file. Those paths need escaping (for
 * plain text) or sanitizing (when the value is allowed to carry markup).
 *
 * Loaded before i18n.js/main.js in index.html, so `window.escapeHtml` and
 * `window.sanitizeHtml` are available to every later script.
 */
(function () {
    'use strict';

    const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    // Text -> HTML. Use for anything interpolated into a template string, both
    // in text position and inside a quoted attribute value.
    function escapeHtml(value) {
        if (value == null) return '';
        return String(value).replace(/[&<>"']/g, ch => ESCAPES[ch]);
    }

    // HTML -> text. Mirrors Python's html.unescape() for the entities that
    // actually appear in our markup and locale files, plus numeric references.
    // Unknown named entities are left untouched (html.unescape would resolve
    // them, but none of ours need it).
    const NAMED_ENTITIES = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
        times: '×', divide: '÷', middot: '·', bull: '•',
        hellip: '…', mdash: '—', ndash: '–', copy: '©',
        reg: '®', trade: '™', deg: '°', plusmn: '±',
        laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
        ldquo: '“', rdquo: '”', dagger: '†', sect: '§',
        para: '¶', permil: '‰', prime: '′', Prime: '″',
        larr: '←', uarr: '↑', rarr: '→', darr: '↓',
        harr: '↔', infin: '∞', ne: '≠', le: '≤',
        ge: '≥', micro: 'µ', euro: '€', pound: '£',
        yen: '¥', cent: '¢', frac12: '½', frac14: '¼',
        sup2: '²', sup3: '³', ensp: ' ', emsp: ' ',
        thinsp: ' ', shy: '­', zwj: '‍', zwnj: '‌'
    };

    function decodeHtmlEntities(value) {
        if (typeof value !== 'string' || value.indexOf('&') === -1) return value || '';
        // One left-to-right pass, so "&amp;lt;" decodes to "&lt;" and stops.
        return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (match, body) => {
            if (body.charAt(0) === '#') {
                const code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
                    ? parseInt(body.slice(2), 16)
                    : parseInt(body.slice(1), 10);
                if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
                try { return String.fromCodePoint(code); } catch (e) { return match; }
            }
            return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
                ? NAMED_ENTITIES[body]
                : match;
        });
    }

    // Tags a translation string, a tooltip or a remote title is allowed to use.
    // Anything outside this list is unwrapped (its text survives, the element
    // doesn't); the tags in DROP_ENTIRELY are removed with their contents.
    const ALLOWED_TAGS = new Set([
        'A', 'ABBR', 'B', 'BR', 'CODE', 'DIV', 'EM', 'HR', 'I', 'KBD', 'LI',
        'MARK', 'OL', 'P', 'PRE', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP',
        'U', 'UL', 'WBR'
    ]);
    const DROP_ENTIRELY = new Set([
        'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE',
        'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'TEMPLATE', 'SVG',
        'MATH', 'AUDIO', 'VIDEO', 'SOURCE', 'IMG'
    ]);
    const GLOBAL_ATTRS = new Set(['class', 'title', 'dir', 'lang']);
    const TAG_ATTRS = { A: new Set(['href', 'target', 'rel']) };
    const SAFE_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

    function attrAllowed(tag, name) {
        if (GLOBAL_ATTRS.has(name)) return true;
        const extra = TAG_ATTRS[tag];
        return !!(extra && extra.has(name));
    }

    function scrubElement(el) {
        const tag = el.tagName;
        // Copy the list first -- removeAttribute mutates el.attributes live.
        Array.prototype.slice.call(el.attributes).forEach(attr => {
            const name = attr.name.toLowerCase();
            if (!attrAllowed(tag, name)) { el.removeAttribute(attr.name); return; }
            if (name === 'href' && !SAFE_URL.test(attr.value.trim())) el.removeAttribute(attr.name);
        });
        if (tag === 'A' && el.getAttribute('target') === '_blank') {
            el.setAttribute('rel', 'noopener noreferrer');
        }
    }

    function scrubNode(node) {
        // Snapshot children: the loop reparents and removes as it goes.
        Array.prototype.slice.call(node.childNodes).forEach(child => {
            if (child.nodeType === Node.COMMENT_NODE) { child.remove(); return; }
            if (child.nodeType !== Node.ELEMENT_NODE) return;

            const tag = child.tagName;
            if (DROP_ENTIRELY.has(tag)) { child.remove(); return; }

            scrubNode(child);

            if (!ALLOWED_TAGS.has(tag)) {
                // Unwrap: keep the text, drop the element and its attributes.
                while (child.firstChild) node.insertBefore(child.firstChild, child);
                child.remove();
                return;
            }
            scrubElement(child);
        });
    }

    // HTML -> HTML, with everything script-capable removed. Parsing happens in
    // a <template>, which is inert: no scripts run, no resources are fetched.
    function sanitizeHtml(html) {
        if (html == null) return '';
        const str = String(html);
        if (str.indexOf('<') === -1) return str; // no markup, nothing to strip
        const tpl = document.createElement('template');
        tpl.innerHTML = str;
        scrubNode(tpl.content);
        return tpl.innerHTML;
    }

    window.escapeHtml = escapeHtml;
    window.decodeHtmlEntities = decodeHtmlEntities;
    window.sanitizeHtml = sanitizeHtml;
})();
