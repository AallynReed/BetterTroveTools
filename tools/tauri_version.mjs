// Prints a Tauri config overlay carrying metadata.json's version: semver for Tauri, and a
// numeric MSI version (the MSI major can't exceed 255, so 2026.10.07b -> 26.10.7).
import { readFileSync } from 'node:fs';

const meta = JSON.parse(readFileSync(new URL('../metadata.json', import.meta.url), 'utf8'));
const match = /^(\d+)\.(\d+)\.(\d+)(b?)$/.exec(meta.APP_VERSION || '');
if (!match) {
    console.error(`Unrecognised APP_VERSION: ${meta.APP_VERSION}`);
    process.exit(1);
}
const [year, month, counter] = match.slice(1, 4).map(Number);
const beta = match[4] === 'b';
console.log(JSON.stringify({
    version: `${year}.${month}.${counter}${beta ? '-beta' : ''}`,
    bundle: { windows: { wix: { version: `${year % 100}.${month}.${counter}` } } },
}));
