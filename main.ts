// Made You Look — a herd of horses made of pouring sand bursts out of a sandbox while a girl holds up the sign.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_NAME = "entry.jpg";
const OUTPUT_NAME = "entry.png";
const MAX_BYTES = 1048576;
const MAX_DIMENSION = 1024;

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const RST_MIN = 0xd0;
const RST_MAX = 0xd7;

class RuleError extends Error {
  constructor(rule) {
    super(`Rule failed: ${rule}`);
    this.name = "RuleError";
  }
}

function fail(rule) {
  throw new RuleError(rule);
}

function isRestartMarker(marker) {
  return marker >= RST_MIN && marker <= RST_MAX;
}

function isStandaloneMarker(marker) {
  return isRestartMarker(marker) || marker === 0x01;
}

function isFrameHeader(marker) {
  if (marker < 0xc0 || marker > 0xcf) {
    return false;
  }
  if (marker === 0xc4 || marker === 0xc8 || marker === 0xcc) {
    return false;
  }
  return true;
}

function nextMarker(buffer, offset) {
  let i = offset;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (i < buffer.length && buffer[i] === 0xff) {
      i += 1;
    }
    if (i >= buffer.length) {
      return { marker: null, offset: buffer.length };
    }
    return { marker: buffer[i], offset: i + 1 };
  }
  return { marker: null, offset: buffer.length };
}

function scanDimensions(buffer) {
  let offset = 0;
  let largestWidth = 0;
  let largestHeight = 0;
  let sawFrame = false;
  let inEntropy = false;

  while (offset < buffer.length) {
    if (inEntropy) {
      const found = nextMarker(buffer, offset);
      if (found.marker === null) {
        return { largestWidth, largestHeight, sawFrame };
      }
      offset = found.offset;
      if (found.marker === EOI) {
        return { largestWidth, largestHeight, sawFrame };
      }
      if (isRestartMarker(found.marker)) {
        continue;
      }
      inEntropy = false;
    }

    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const markerAt = offset;
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) {
      return { largestWidth, largestHeight, sawFrame };
    }
    const marker = buffer[offset];
    offset += 1;

    if (marker === EOI || marker === SOI) {
      continue;
    }

    if (marker === SOS) {
      if (offset + 2 > buffer.length) {
        fail("marker segments must be fully contained in the file");
      }
      const length = (buffer[offset] << 8) | buffer[offset + 1];
      if (length < 2) {
        fail("segment length field is invalid");
      }
      offset += length;
      inEntropy = true;
      continue;
    }

    if (isStandaloneMarker(marker) || marker === 0x00) {
      continue;
    }

    if (offset + 2 > buffer.length) {
      fail("marker segments must be fully contained in the file");
    }
    const length = (buffer[offset] << 8) | buffer[offset + 1];
    if (length < 2) {
      fail("segment length field is invalid");
    }
    const payloadOffset = offset + 2;

    if (isFrameHeader(marker)) {
      if (length < 7) {
        fail("frame header segment is too short");
      }
      if (payloadOffset + 5 > buffer.length) {
        fail("frame header segment is not fully contained in the file");
      }
      const height = (buffer[payloadOffset + 1] << 8) | buffer[payloadOffset + 2];
      const width = (buffer[payloadOffset + 3] << 8) | buffer[payloadOffset + 4];
      sawFrame = true;
      largestHeight = Math.max(largestHeight, height);
      largestWidth = Math.max(largestWidth, width);
    }

    offset = payloadOffset + (length - 2);
  }

  return { largestWidth, largestHeight, sawFrame };
}

function validateImage(buffer) {
  if (buffer.length === 0) {
    fail("source image must not be empty");
  }
  if (buffer.length < 3) {
    fail("source image must start with the JPEG magic bytes");
  }
  if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) {
    fail("source image must start with the JPEG magic bytes FF D8 FF");
  }
  if (buffer.length > MAX_BYTES) {
    fail(`source image must be at most ${MAX_BYTES} bytes`);
  }

  const { largestWidth, largestHeight, sawFrame } = scanDimensions(buffer);

  if (!sawFrame) {
    fail("source image must contain at least one frame header (SOF)");
  }
  if (largestWidth > MAX_DIMENSION || largestHeight > MAX_DIMENSION) {
    fail(
      `the largest frame dimensions must be at most ${MAX_DIMENSION} by ${MAX_DIMENSION}; ` +
        `found ${largestWidth} by ${largestHeight}`,
    );
  }
}

function outputDirectory() {
  const env = process.env.MAKEFUN_OUTPUT_DIR;
  if (env !== undefined && env !== "") {
    return env;
  }
  return "/output";
}

async function main() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sourcePath = join(moduleDir, SOURCE_NAME);

  let buffer;
  try {
    buffer = await readFile(sourcePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(`${SOURCE_NAME} must exist next to main.ts`);
    }
    throw error;
  }

  validateImage(buffer);

  const outDir = outputDirectory();
  const outPath = join(outDir, OUTPUT_NAME);

  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, buffer);

  process.stdout.write(
    `Wrote ${outPath} (${buffer.length} bytes) from ${sourcePath} ` +
      `after validating size and frame dimensions.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
