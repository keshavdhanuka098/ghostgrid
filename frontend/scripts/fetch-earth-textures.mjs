// Downloads the real 8K Earth textures into public/ so the landing globe turns into a photoreal planet.
//   npm run textures            -> day colour + clouds (+ ocean mask if available)
//   npm run textures -- --night -> also replace the 4K city-lights map with the 8K one (old one is kept as earth-night.4k.jpg)
//
// Source: Solar System Scope (https://www.solarsystemscope.com/textures/), Creative Commons Attribution 4.0,
// derived from NASA data. Credit "Solar System Scope" somewhere on your site if you ship these.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(root, { recursive: true });
const BASE = 'https://www.solarsystemscope.com/textures/download/';
const withNight = process.argv.includes('--night');

const jobs = [
  { file: 'earth-day.jpg', src: '8k_earth_daymap.jpg', need: true, what: 'day colour map' },
  { file: 'earth-clouds.jpg', src: '8k_earth_clouds.jpg', need: true, what: 'cloud map' },
  { file: 'earth-specular.jpg', src: '8k_earth_specular_map.jpg', need: false, what: 'ocean mask (optional)' },
  ...(withNight ? [{ file: 'earth-night.jpg', src: '8k_earth_nightmap.jpg', need: false, what: '8K city lights', backup: true }] : []),
];

let failed = 0;
for (const j of jobs) {
  process.stdout.write(`- ${j.what}: ${j.src} ... `);
  try {
    const res = await fetch(BASE + j.src, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.solarsystemscope.com/textures/' }, redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/image|octet-stream/.test(type)) throw new Error(`HTTP ${res.status} ${type}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100_000) throw new Error('file too small, probably not the image');
    const out = join(root, j.file);
    if (j.backup && existsSync(out)) renameSync(out, join(root, 'earth-night.4k.jpg'));
    writeFileSync(out, buf);
    console.log(`ok (${(buf.length / 1048576).toFixed(1)} MB)`);
  } catch (e) {
    console.log(`FAILED (${e.message})`);
    if (j.need) failed++;
  }
}
if (failed) {
  console.log('\nSome files could not be downloaded automatically. Get them by hand from https://www.solarsystemscope.com/textures/');
  console.log('(Earth: "Day Map", "Clouds Map", optionally "Specular Map", 8K JPG) and save them in frontend/public/ as:');
  console.log('  earth-day.jpg   earth-clouds.jpg   earth-specular.jpg');
  process.exitCode = 1;
} else {
  console.log('\nDone. Restart `npm run dev` (or rebuild) and hard-refresh the page.');
}
