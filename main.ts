import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 1048576;
const MAX_DIM = 1024;
const INPUT = 'entry.jpg';

const here = dirname(fileURLToPath(import.meta.url));
const data = await readFile(join(here, INPUT));

if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
  throw new Error('rule: entry.jpg must start with the JPEG magic bytes FF D8 FF');
}
if (data.length > MAX_BYTES) {
  throw new Error(`rule: entry.jpg must be at most ${MAX_BYTES} bytes (got ${data.length})`);
}

let width = 0;
let height = 0;
let sawFrameHeader = false;
let pos = 2;

while (pos < data.length) {
  if (data[pos] !== 0xff) {
    throw new Error('rule: malformed JPEG, expected a 0xFF segment prefix');
  }
  let marker = data[pos + 1];
  while (marker === 0xff && pos + 1 < data.length) {
    pos += 1;
    marker = data[pos + 1];
  }
  if (pos + 1 >= data.length || marker === undefined || marker === 0xff) {
    throw new Error('unexpected end of file while searching for a JPEG marker');
  }
  pos += 2;

  if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8 || marker === 0x01) {
    continue;
  }

  if (pos + 1 >= data.length) {
    throw new Error('unexpected end of file while reading a JPEG segment length');
  }
  const len = data.readUInt16BE(pos);
  if (len < 2) {
    throw new Error('rule: malformed JPEG segment length at offset ' + pos);
  }

  const end = pos + len;
  if (end > data.length) {
    throw new Error('unexpected end of file: JPEG segment at offset ' + pos + ' runs past the end of the file');
  }

  if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
    if (len < 8) {
      throw new Error('rule: malformed JPEG frame header');
    }
    sawFrameHeader = true;
    height = data.readUInt16BE(pos + 3);
    width = data.readUInt16BE(pos + 5);
    break;
  }

  pos = end;
}

if (!sawFrameHeader) {
  throw new Error('rule: no JPEG frame header (SOF) found in entry.jpg');
}
if (width > MAX_DIM || height > MAX_DIM) {
  throw new Error(`rule: image dimensions ${width}x${height} must be at most ${MAX_DIM}x${MAX_DIM} pixels`);
}

const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'entry.png'), data);