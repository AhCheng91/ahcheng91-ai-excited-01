// Made You Look — a herd of horses made of pouring sand bursts out of a sandbox while a girl holds up the sign.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const IMAGE_FILE = join(MODULE_DIR, "entry.jpg");
const OUTPUT_FILE = "entry.png";
const MAX_BYTES = 1048576;
const MAX_DIMENSION = 1024;
const DEFAULT_OUTPUT_DIR = "/output";

const MARKER_SOI = 0xd8;
const MARKER_EOI = 0xd9;
const MARKER_SOS = 0xda;
const MARKER_TEM = 0x01;

function ruleError(name, message) {
  const error = new Error(`Rule failed: ${name}. ${message}`);
  error.name = `RuleFailed_${name}`;
  return error;
}

const ERRORS = {
  magic: ruleError(
    "magic-bytes",
    "entry.jpg does not begin with the JPEG start-of-image marker FF D8 FF.",
  ),
  length: ruleError(
    "file-size",
    "entry.jpg is longer than the allowed 1048576 bytes.",
  ),
  dimension: ruleError(
    "frame-dimensions",
    "entry.jpg contains a frame wider or taller than the allowed 1024 pixels.",
  ),
  structure: ruleError(
    "jpeg-structure",
    "entry.jpg could not be walked as a well-formed JPEG stream.",
  ),
  output: ruleError(
    "output-directory",
    "the output directory could not be created.",
  ),
  write: ruleError(
    "output-write",
    "the entry.png file could not be written.",
  ),
};

function hasLengthField(marker) {
  if (marker === MARKER_TEM) return false;
  if (marker >= 0xd0 && marker <= 0xd7) return false;
  return true;
}

function isStartOfFrame(marker) {
  if (marker < 0xc0 || marker > 0xcf) return false;
  if (marker === 0xc4 || marker === 0xc8 || marker === 0xcc) return false;
  return true;
}

function readUint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readFrameGeometry(bytes, offset) {
  const height = readUint16(bytes, offset + 5);
  const width = readUint16(bytes, offset + 7);
  return { width, height };
}

function skipEntropyData(bytes, index) {
  while (index + 1 < bytes.length) {
    const byte = bytes[index];
    if (byte !== 0xff) {
      index += 1;
      continue;
    }
    const next = bytes[index + 1];
    if (next === 0x00) {
      index += 2;
      continue;
    }
    if (next >= 0xd0 && next <= 0xd7) {
      index += 2;
      continue;
    }
    return index;
  }
  return index;
}

function walkFrames(bytes) {
  let index = 2;
  let width = 0;
  let height = 0;
  while (index + 1 < bytes.length) {
    const markerByte = bytes[index];
    if (markerByte !== 0xff) {
      throw ERRORS.structure;
    }
    const marker = bytes[index + 1];
    if (marker === MARKER_EOI) {
      break;
    }
    if (marker === MARKER_SOI) {
      throw ERRORS.structure;
    }
    if (!hasLengthField(marker)) {
      index += 2;
      continue;
    }
    const segmentLength = readUint16(bytes, index + 2);
    if (segmentLength < 2) {
      throw ERRORS.structure;
    }
    if (marker === MARKER_SOS) {
      index += 2 + segmentLength;
      index = skipEntropyData(bytes, index);
      continue;
    }
    if (isStartOfFrame(marker)) {
      if (segmentLength < 8) {
        throw ERRORS.structure;
      }
      const geometry = readFrameGeometry(bytes, index + 2);
      if (geometry.width > width) width = geometry.width;
      if (geometry.height > height) height = geometry.height;
    }
    index += 2 + segmentLength;
  }
  return { width, height };
}

function verifyJpeg(bytes) {
  if (bytes.length < 3) {
    throw ERRORS.magic;
  }
  if (bytes[0] !== 0xff || bytes[1] !== MARKER_SOI || bytes[2] !== 0xff) {
    throw ERRORS.magic;
  }
  if (bytes.length > MAX_BYTES) {
    throw ERRORS.length;
  }
  const { width, height } = walkFrames(bytes);
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw ERRORS.dimension;
  }
  return { width, height };
}

function resolveOutputDirectory() {
  const configured = process.env.MAKEFUN_OUTPUT_DIR;
  if (!configured || configured.length === 0) {
    return DEFAULT_OUTPUT_DIR;
  }
  return resolve(configured);
}

async function writeOutput(bytes, outputDirectory) {
  try {
    await mkdir(outputDirectory, { recursive: true });
  } catch (cause) {
    const error = ERRORS.output;
    error.cause = cause;
    throw error;
  }
  const destination = join(outputDirectory, OUTPUT_FILE);
  try {
    await writeFile(destination, bytes);
  } catch (cause) {
    const error = ERRORS.write;
    error.cause = cause;
    throw error;
  }
  return destination;
}

async function main() {
  const bytes = await readFile(IMAGE_FILE);
  const { width, height } = verifyJpeg(bytes);
  const outputDirectory = resolveOutputDirectory();
  const destination = await writeOutput(bytes, outputDirectory);
  console.log(`Wrote ${destination} (${bytes.length} bytes, frame ${width}x${height}).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
