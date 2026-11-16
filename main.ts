// Breakfast Comes Out of the Fridge — a colossal polar bear lunges out of an open refrigerator into a family kitchen.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const MAX_BYTES = 1048576;
const MAX_FRAME = 1024;
const MAX_SCAN_SEGMENTS = 16384;

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const TEM = 0x01;

const FIRST_RST = 0xd0;
const LAST_RST = 0xd7;

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

const RULE_SOURCE = "rule:source-image";
const RULE_MAGIC = "rule:jpeg-magic-bytes";
const RULE_BYTES = "rule:max-bytes-1m";
const RULE_FRAME = "rule:max-frame-dimensions";
const RULE_FORMAT = "rule:jpeg-structure";
const RULE_OUTPUT = "rule:output-write";

const SOURCE_NAME = "entry.jpg";
const OUTPUT_NAME = "entry.png";
const DEFAULT_OUTPUT_DIR = "/output";

function ruleError(rule, message) {
  return new Error(`${rule}: ${message}`);
}

function moduleDirectory() {
  return dirname(fileURLToPath(import.meta.url));
}

function sourceImagePath() {
  return join(moduleDirectory(), SOURCE_NAME);
}

function outputDirectory() {
  const configured = process.env.MAKEFUN_OUTPUT_DIR;
  if (configured && configured.length > 0) {
    return resolve(configured);
  }
  return DEFAULT_OUTPUT_DIR;
}

function outputImagePath() {
  return join(outputDirectory(), OUTPUT_NAME);
}

function readSourceImage(path) {
  if (!existsSync(path)) {
    throw ruleError(RULE_SOURCE, `source image does not exist: ${path}`);
  }
  return readFileSync(path);
}

function assertJpegMagic(bytes) {
  const hasMagic = bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff;
  if (!hasMagic) {
    throw ruleError(RULE_MAGIC, "file does not begin with JPEG magic bytes FF D8 FF");
  }
}

function assertWithinByteLimit(bytes) {
  if (bytes.length > MAX_BYTES) {
    throw ruleError(
      RULE_BYTES,
      `file is ${bytes.length} bytes; the limit is ${MAX_BYTES}`,
    );
  }
}

function largestFrameIn(bytes) {
  let offset = 2;
  let maxWidth = 0;
  let maxHeight = 0;
  let visitedSegments = 0;

  while (offset < bytes.length) {
    if (visitedSegments > MAX_SCAN_SEGMENTS) {
      throw ruleError(RULE_FORMAT, "too many marker segments; refusing to scan further");
    }

    if (bytes[offset] !== 0xff) {
      throw ruleError(RULE_FORMAT, `expected marker prefix FF at byte offset ${offset}`);
    }

    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= bytes.length) {
      throw ruleError(RULE_FORMAT, "file ends while reading a marker");
    }

    const marker = bytes[offset];
    offset += 1;

    if (marker === SOI || marker === EOI) {
      if (marker === EOI) {
        break;
      }
      continue;
    }

    if (marker === TEM || (marker >= FIRST_RST && marker <= LAST_RST)) {
      visitedSegments += 1;
      continue;
    }

    if (marker === SOS) {
      visitedSegments += 1;
      break;
    }

    if (offset + 2 > bytes.length) {
      throw ruleError(RULE_FORMAT, `segment ${marker.toString(16)} has no length field`);
    }

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2) {
      throw ruleError(RULE_FORMAT, `segment ${marker.toString(16)} declares an invalid length ${segmentLength}`);
    }

    const payloadStart = offset + 2;
    const payloadEnd = payloadStart + (segmentLength - 2);
    if (payloadEnd > bytes.length) {
      throw ruleError(RULE_FORMAT, `segment ${marker.toString(16)} overruns the end of the file`);
    }

    if (SOF_MARKERS.has(marker)) {
      if (payloadStart + 5 > payloadEnd) {
        throw ruleError(RULE_FORMAT, `frame header segment ${marker.toString(16)} is too short`);
      }
      const height = (bytes[payloadStart + 1] << 8) | bytes[payloadStart + 2];
      const width = (bytes[payloadStart + 3] << 8) | bytes[payloadStart + 4];
      maxWidth = Math.max(maxWidth, width);
      maxHeight = Math.max(maxHeight, height);
    }

    visitedSegments += 1;
    offset = payloadEnd;
  }

  if (maxWidth === 0 && maxHeight === 0) {
    throw ruleError(RULE_FORMAT, "no frame header segment was found in the file");
  }

  return { width: maxWidth, height: maxHeight };
}

function assertFrameDimensionsWithinLimit(bytes) {
  const { width, height } = largestFrameIn(bytes);
  if (width > MAX_FRAME || height > MAX_FRAME) {
    throw ruleError(
      RULE_FRAME,
      `largest frame is ${width}x${height}; the limit is ${MAX_FRAME} on each side`,
    );
  }
}

function writeOutput(bytes, path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  } catch (cause) {
    throw ruleError(RULE_OUTPUT, `could not write ${path}: ${cause.message}`);
  }
  return path;
}

function main() {
  const sourcePath = sourceImagePath();
  const bytes = readSourceImage(sourcePath);

  assertJpegMagic(bytes);
  assertWithinByteLimit(bytes);
  assertFrameDimensionsWithinLimit(bytes);

  const outputPath = outputImagePath();
  writeOutput(bytes, outputPath);

  console.log(`wrote ${bytes.length} bytes unchanged to ${outputPath}`);
}

main();
