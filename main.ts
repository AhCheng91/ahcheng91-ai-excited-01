// One Ocean, Fresh Spun — a washing machine bursts open and pours a glowing turquoise ocean across a laundromat floor.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MAX_BYTES = 1048576;
const MAX_DIMENSION = 1024;
const IMAGE_NAME = "entry.jpg";
const OUTPUT_NAME = "entry.png";

const MARKER_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const MARKER_STANDALONE = new Set([
  0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd9,
]);

class EntryError extends Error {
  constructor(rule) {
    super(`Rule violated: ${rule}`);
    this.name = "EntryError";
    this.rule = rule;
  }
}

function moduleDirectory() {
  return dirname(fileURLToPath(import.meta.url));
}

async function readEntry() {
  const path = join(moduleDirectory(), IMAGE_NAME);
  const bytes = await readFile(path);
  return bytes;
}

function verifyMagic(bytes) {
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new EntryError("jpeg-magic-bytes");
  }
}

function verifySize(bytes) {
  if (bytes.length > MAX_BYTES) {
    throw new EntryError(`max-file-size-${MAX_BYTES}`);
  }
}

function readUint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function parseFrames(bytes) {
  let offset = 2;
  let maxWidth = 0;
  let maxHeight = 0;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new EntryError("marker-alignment");
    }

    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) {
      throw new EntryError("marker-alignment");
    }
    if (bytes[offset] === 0x00) {
      throw new EntryError("marker-alignment");
    }
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9) {
      return { maxWidth, maxHeight };
    }

    if (MARKER_STANDALONE.has(marker)) {
      continue;
    }

    if (offset + 2 > bytes.length) {
      throw new EntryError("marker-length");
    }
    const length = readUint16(bytes, offset);
    if (length < 2) {
      throw new EntryError("marker-length");
    }
    const segmentStart = offset + 2;
    const segmentEnd = segmentStart + length - 2;
    if (segmentEnd > bytes.length) {
      throw new EntryError("marker-length");
    }

    if (marker === 0xda) {
      offset = skipEntropyData(bytes, segmentEnd);
      if (offset >= bytes.length) {
        throw new EntryError("entropy-data");
      }
      continue;
    }

    if (MARKER_SOF.has(marker)) {
      if (length < 7) {
        throw new EntryError("frame-length");
      }
      const height = readUint16(bytes, segmentStart + 1);
      const width = readUint16(bytes, segmentStart + 3);
      if (width > maxWidth) {
        maxWidth = width;
      }
      if (height > maxHeight) {
        maxHeight = height;
      }
    }

    offset = segmentEnd;
  }

  throw new EntryError("missing-eoi");
}

function skipEntropyData(bytes, offset) {
  while (offset < bytes.length) {
    if (bytes[offset] === 0xff) {
      let next = offset + 1;
      while (next < bytes.length && bytes[next] === 0xff) {
        next += 1;
      }
      if (next >= bytes.length) {
        return bytes.length;
      }
      if (bytes[next] === 0x00) {
        offset = next + 1;
        continue;
      }
      return next - 1;
    }
    offset += 1;
  }
  return bytes.length;
}

function verifyDimensions(frames) {
  if (frames.maxWidth > MAX_DIMENSION) {
    throw new EntryError(`max-frame-width-${MAX_DIMENSION}`);
  }
  if (frames.maxHeight > MAX_DIMENSION) {
    throw new EntryError(`max-frame-height-${MAX_DIMENSION}`);
  }
}

function outputDirectory() {
  const dir = process.env.MAKEFUN_OUTPUT_DIR;
  if (dir === undefined || dir === "") {
    return "/output";
  }
  return dir;
}

async function writeOutput(bytes) {
  const dir = outputDirectory();
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, OUTPUT_NAME);
  await writeFile(outPath, bytes);
}

async function main() {
  const bytes = await readEntry();
  verifyMagic(bytes);
  verifySize(bytes);
  const frames = parseFrames(bytes);
  verifyDimensions(frames);
  await writeOutput(bytes);
  const sha = await import("node:crypto").then((c) => c.createHash("sha256").update(bytes).digest("hex"));
  console.log(`entry.png written (${bytes.length} bytes, ${frames.maxWidth}x${frames.maxHeight}, sha256 ${sha})`);
}

main().catch((err) => {
  if (err instanceof EntryError) {
    console.error(`Failed rule: ${err.rule}`);
    process.exitCode = 1;
    return;
  }
  throw err;
});
