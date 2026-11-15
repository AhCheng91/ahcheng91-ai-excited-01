// One Frame Among Thousands — a colossal cracked-gold eye over a dark arena, one picture glowing brighter than all the rest.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The source image never moves, so describe it once and refer to it by name.
const ENTRY_FILE = 'entry.jpg';
const ENTRY_OUTPUT = 'entry.png';
const MAX_FILE_BYTES = 1024 * 1024; // one mebibyte, judge-provided ceiling
const MAX_PIXEL_EXTENT = 1024;      // both width and height may reach this
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR || '/output';

// Win at the contest: a rule that fails is an Error that names itself.
function fail(ruleName: string, details: string): never {
  throw new Error(`${ruleName}: ${details}`);
}

// The module's own directory, wherever the judge happens to place it.
function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

async function loadEntryImage(): Promise<Buffer> {
  return readFile(join(moduleDir(), ENTRY_FILE));
}

// Rule 1: a JPEG always opens with the three bytes FF D8 FF.
function checkMagicBytes(data: Uint8Array): void {
  const matches = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!matches) {
    fail('jpeg-magic', 'the image must begin with the bytes FF D8 FF');
  }
}

// Rule 2: the whole file must stay within the judge's size budget.
function checkFileSize(data: Uint8Array): void {
  if (data.byteLength > MAX_FILE_BYTES) {
    fail('max-bytes', `file is ${data.byteLength} bytes but may be at most ${MAX_FILE_BYTES}`);
  }
}

// SOF markers carry the frame dimensions; DHT/DAC/JPG carry other data instead.
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// Some markers stand alone and carry no length field of their own.
function hasNoPayload(marker: number): boolean {
  return marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7);
}

// Rule 3: hop from segment to segment using each segment's own length field
// until a frame header gives us the width and height.
function readFrameDimensions(data: Buffer): { width: number; height: number } {
  let pos = 2; // the SOI marker is already behind us
  for (;;) {
    if (pos + 1 >= data.length) {
      fail('frame-header', 'reached the end of the file without finding a frame header');
    }
    if (data[pos] !== 0xff) {
      fail('marker-prefix', `expected an FF marker prefix at offset ${pos}`);
    }

    // FF fill bytes may pad the stream before the marker proper.
    let marker = data[pos + 1];
    while (marker === 0xff) {
      pos += 1;
      if (pos + 2 >= data.length) {
        fail('marker-prefix', `file ends while reading the marker at offset ${pos}`);
      }
      marker = data[pos + 1];
    }
    const markerStart = pos + 2;

    if (hasNoPayload(marker)) {
      pos = markerStart;
      continue;
    }
    if (markerStart + 1 >= data.length) {
      fail('segment-length', `file ends while reading the length of the segment at offset ${markerStart}`);
    }
    const length = data.readUInt16BE(markerStart);
    if (length < 2) {
      fail('segment-length', `segment at offset ${markerStart} claims a length of ${length}`);
    }
    const segmentEnd = markerStart + length;
    if (segmentEnd > data.length) {
      fail('segment-length', `segment at offset ${markerStart} runs ${segmentEnd - data.length} bytes past the end of the file`);
    }

    if (isSofMarker(marker)) {
      if (length < 8) {
        fail('frame-header', `frame header at offset ${markerStart} is too short to hold dimensions`);
      }
      // Payload layout: precision(1), then height(2), then width(2).
      const height = data.readUInt16BE(markerStart + 3);
      const width = data.readUInt16BE(markerStart + 5);
      return { width, height };
    }
    pos = segmentEnd;
  }
}

// Rule 4: neither axis may exceed the arena's 1024-pixel limit.
function checkDimensions(width: number, height: number): void {
  if (width > MAX_PIXEL_EXTENT || height > MAX_PIXEL_EXTENT) {
    fail('max-dimensions', `frame is ${width}x${height} but may be at most ${MAX_PIXEL_EXTENT}x${MAX_PIXEL_EXTENT}`);
  }
}

// The judge reads the evidence from the output directory; make sure it exists.
async function writeEntryPng(data: Buffer): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(join(OUTPUT_DIR, ENTRY_OUTPUT), data);
}

async function main(): Promise<void> {
  const image = await loadEntryImage();
  checkMagicBytes(image);
  checkFileSize(image);
  const { width, height } = readFrameDimensions(image);
  checkDimensions(width, height);
  await writeEntryPng(image);
}

await main();