import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.join(moduleDir, 'entry.jpg');

const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const outputPath = path.join(outputDir, 'entry.png');

const MAX_BYTES = 1048576;
const MAX_DIM = 1024;

function fail(rule, detail) {
  throw new Error(`${rule} rule failed: ${detail}`);
}

const data = await readFile(inputPath);

if (data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
  fail('magic bytes', 'entry.jpg must start with the JPEG magic bytes FF D8 FF');
}

if (data.length > MAX_BYTES) {
  fail('size', `entry.jpg is ${data.length} bytes, more than the ${MAX_BYTES}-byte limit`);
}

function isSof(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

let pos = 2;
let frame = null;

while (pos < data.length) {
  if (data[pos] !== 0xff) {
    fail('marker walk', `expected 0xff marker byte at offset ${pos}`);
  }
  while (pos < data.length && data[pos] === 0xff) pos++;
  if (pos >= data.length) fail('end of file', 'unexpected end of file while reading a marker');
  const marker = data[pos];
  pos++;

  if (marker === 0xd9) break;

  if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

  if (pos + 2 > data.length) fail('end of file', 'unexpected end of file while reading a segment length');
  const segLen = data.readUInt16BE(pos);
  if (segLen < 2) fail('marker walk', `segment length ${segLen} is too small at offset ${pos}`);
  const payloadStart = pos + 2;
  const payloadEnd = payloadStart + segLen - 2;
  if (payloadEnd > data.length) fail('end of file', 'unexpected end of file inside a segment');

  if (isSof(marker)) {
    if (payloadEnd - payloadStart < 6) fail('frame header', 'SOF segment is too short');
    const height = data.readUInt16BE(payloadStart + 1);
    const width = data.readUInt16BE(payloadStart + 3);
    frame = { width, height };
    break;
  }

  pos = payloadEnd;
}

if (frame === null) {
  fail('frame header', 'no frame header (SOF marker) found in entry.jpg');
}

if (frame.width > MAX_DIM) {
  fail('dimensions', `frame width ${frame.width} exceeds the ${MAX_DIM}-pixel limit`);
}
if (frame.height > MAX_DIM) {
  fail('dimensions', `frame height ${frame.height} exceeds the ${MAX_DIM}-pixel limit`);
}

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, data);