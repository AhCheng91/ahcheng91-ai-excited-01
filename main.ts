// Whale in the Midnight Street — an enormous whale breaches out of a rain-soaked street, water exploding through the streetlight glow.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ENTRY_FILE = 'entry.jpg';
const OUTPUT_FILE = 'entry.png';

const MAX_FILE_BYTES = 1048576;
const MAX_FRAME_SIDE = 1024;

const SOF0 = 0xc0;
const SOF15 = 0xcf;

const skipTable = new Set([
  0x01,
  0xd8,
]);

const lengthTable = new Set([
  0xc4,
  0xcc,
]);

function readUint16BE(bytes, offset) {
  return bytes[offset] * 256 + bytes[offset + 1];
}

class RuleError extends Error {
  constructor(rule, detail) {
    const suffix = detail ? ` — ${detail}` : '';
    super(`rule ${rule}${suffix}`);
    this.name = 'RuleError';
    this.rule = rule;
  }
}

function validateMagic(bytes) {
  const ok =
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  if (!ok) {
    throw new RuleError('magic', 'file must start with JPEG bytes FF D8 FF');
  }
}

function validateSize(bytes) {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new RuleError(
      'size',
      `file is ${bytes.length} bytes, limit is ${MAX_FILE_BYTES}`,
    );
  }
}

function scanDataNextMarker(bytes, start) {
  let i = start;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const next = bytes[i + 1];
    if (next === 0x00 || next === 0xff) {
      i += 2;
      continue;
    }
    return i;
  }
  return -1;
}

function parseFrameDimensions(bytes) {
  if (bytes.length < 4) {
    throw new RuleError('dimension', 'too short to walk marker segments');
  }
  let offset = 2;
  let maxHeight = 0;
  let maxWidth = 0;
  while (offset + 2 <= bytes.length) {
    const marker = bytes[offset];
    if (marker !== 0xff) {
      throw new RuleError(
        'dimension',
        `expected marker prefix FF at offset ${offset}, found 0x${marker.toString(16)}`,
      );
    }
    let code = bytes[offset + 1];
    let segStart = offset + 2;
    if (code === 0xff) {
      while (code === 0xff && segStart < bytes.length) {
        code = bytes[segStart];
        segStart += 1;
      }
    }
    if (segStart > bytes.length) {
      throw new RuleError('dimension', 'ran out of bytes while skipping fill bytes');
    }
    if (code === 0xd9 || code === 0x00) {
      break;
    }
    if (skipTable.has(code)) {
      offset = segStart;
      continue;
    }
    if (segStart + 2 > bytes.length) {
      throw new RuleError('dimension', 'segment length field truncated');
    }
    const segLen = readUint16BE(bytes, segStart);
    if (segLen < 2) {
      throw new RuleError('dimension', `segment 0x${code.toString(16)} has invalid length ${segLen}`);
    }
    const isSOF = code >= SOF0 && code <= SOF15 && !lengthTable.has(code);
    if (isSOF) {
      if (segStart + 7 > bytes.length) {
        throw new RuleError('dimension', 'SOF segment truncated');
      }
      const precision = bytes[segStart + 2];
      if (precision !== 0xff) {
        const height = readUint16BE(bytes, segStart + 3);
        const width = readUint16BE(bytes, segStart + 5);
        if (height > maxHeight) {
          maxHeight = height;
        }
        if (width > maxWidth) {
          maxWidth = width;
        }
      }
      offset = segStart + segLen;
      continue;
    }
    if (code === 0xda) {
      const next = scanDataNextMarker(bytes, segStart + segLen);
      if (next === -1) {
        break;
      }
      offset = next;
      continue;
    }
    offset = segStart + segLen;
  }
  if (maxHeight === 0 || maxWidth === 0) {
    return null;
  }
  return { height: maxHeight, width: maxWidth };
}

function validateDimension(bytes) {
  const frame = parseFrameDimensions(bytes);
  if (frame === null) {
    throw new RuleError('dimension', 'no frame segment found');
  }
  if (frame.height > MAX_FRAME_SIDE || frame.width > MAX_FRAME_SIDE) {
    throw new RuleError(
      'dimension',
      `frame is ${frame.width}x${frame.height}, limit is ${MAX_FRAME_SIDE} per side`,
    );
  }
}

function outputDirectory() {
  const dir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  return resolve(dir);
}

async function main() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const entryPath = join(moduleDir, ENTRY_FILE);
  const outDir = outputDirectory();
  const outPath = join(outDir, OUTPUT_FILE);

  let bytes;
  try {
    bytes = await readFile(entryPath);
  } catch (error) {
    throw new RuleError('source', `cannot read ${entryPath}: ${error.message}`);
  }

  validateMagic(bytes);
  validateSize(bytes);
  validateDimension(bytes);

  try {
    await mkdir(outDir, { recursive: true });
  } catch (error) {
    throw new RuleError('output', `cannot create ${outDir}: ${error.message}`);
  }

  try {
    await writeFile(outPath, bytes);
  } catch (error) {
    throw new RuleError('output', `cannot write ${outPath}: ${error.message}`);
  }

  const frame = parseFrameDimensions(bytes) ?? { width: 0, height: 0 };
  console.log(
    `Wrote ${outPath} (${bytes.length} bytes, ${frame.width}x${frame.height})`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});