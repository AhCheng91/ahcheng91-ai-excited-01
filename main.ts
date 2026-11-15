import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// entry.jpg: One Frame Among Thousands, 1024x683 pixels
const INPUT = 'entry.jpg';
const MAX_BYTES = 1048576;
const MAX_DIMENSION = 1024;

const here = dirname(fileURLToPath(import.meta.url));
const inputPath = join(here, INPUT);

const data = await readFile(inputPath);

if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
  throw new Error('rule: entry.jpg must start with the JPEG magic bytes FF D8 FF');
}
if (data.length > MAX_BYTES) {
  throw new Error(`rule: entry.jpg must be at most ${MAX_BYTES} bytes (got ${data.length})`);
}

const isSof = (marker) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
const isStandalone = (marker) =>
  marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7);

let width = 0;
let height = 0;
let sawFrameHeader = false;
let pos = 2;

while (pos < data.length) {
  if (data[pos] !== 0xff) {
    throw new Error('rule: malformed JPEG: expected a 0xFF marker prefix at offset ' + pos);
  }
  let marker = data[pos + 1];
  while (marker === 0xff) {
    pos += 1;
    if (pos + 1 >= data.length) {
      throw new Error('unexpected end of file while scanning for a JPEG marker at offset ' + pos);
    }
    marker = data[pos + 1];
  }
  pos += 2;

  if (isStandalone(marker)) {
    continue;
  }

  if (pos + 1 >= data.length) {
    throw new Error('unexpected end of file while reading a JPEG segment length at offset ' + pos);
  }
  const length = data.readUInt16BE(pos);
  if (length < 2) {
    throw new Error('rule: malformed JPEG segment length at offset ' + pos);
  }
  const end = pos + length;
  if (end > data.length) {
    throw new Error('unexpected end of file: JPEG segment at offset ' + pos + ' runs past the end of the file');
  }

  if (isSof(marker)) {
    if (length < 8) {
      throw new Error('rule: malformed JPEG frame header');
    }
    sawFrameHeader = true;
    height = data.readUInt16BE(pos + 3);
    width = data.readUInt16BE(pos + 5);
    break;
  }

  pos = end;
}

if (pos >= data.length && !sawFrameHeader) {
  throw new Error('unexpected end of file while scanning for a JPEG frame header');
}

if (!sawFrameHeader) {
  throw new Error('rule: no JPEG frame header (SOF) found');
}
if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
  throw new Error(`rule: image dimensions ${width}x${height} must be at most ${MAX_DIMENSION}x${MAX_DIMENSION} pixels`);
}

const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'entry.png'), data);