// A Hummingbird the Size of a Car — a giant hummingbird hovers at a lonely gas station pump at dusk.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const INPUT_NAME = "entry.jpg";
const OUTPUT_NAME = "entry.png";
const MAX_FILE_BYTES = 1048576;
const MAX_FRAME_SIDE = 1024;

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const TEM = 0x01;

const SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

class RuleError extends Error {
  constructor(rule, message) {
    super(`rule "${rule}" failed: ${message}`);
    this.name = "RuleError";
    this.rule = rule;
  }
}

function readUint16(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1];
}

function checkFileSize(buffer) {
  if (buffer.length > MAX_FILE_BYTES) {
    throw new RuleError(
      "file-size",
      `entry.jpg is ${buffer.length} bytes but the limit is ${MAX_FILE_BYTES}`
    );
  }
}

function checkJpegMagic(buffer) {
  if (buffer.length < 3) {
    throw new RuleError(
      "jpeg-magic",
      `file is too short to start with FF D8 FF (only ${buffer.length} bytes)`
    );
  }
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw new RuleError(
      "jpeg-magic",
      `expected FF D8 FF but found ${buffer.slice(0, 3).toString("hex")}`
    );
  }
}

function checkOutputPath(outputDirectory, inputPath) {
  if (outputDirectory.trim().length === 0) {
    throw new RuleError(
      "output-path",
      "MAKEFUN_OUTPUT_DIR must not be empty"
    );
  }
  const absoluteOutputDirectory = resolve(outputDirectory.trim());
  if (absoluteOutputDirectory === "/") {
    throw new RuleError(
      "output-path",
      "refusing to write into the filesystem root"
    );
  }
  const outputPath = join(absoluteOutputDirectory, OUTPUT_NAME);
  if (outputPath === inputPath) {
    throw new RuleError(
      "output-path",
      "refusing to overwrite the input image"
    );
  }
  return outputPath;
}

function checkFrames(buffer) {
  let offset = 2;
  let largestWidth = 0;
  let largestHeight = 0;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      throw new RuleError(
        "frame-dimension",
        `expected a 0xFF marker at offset ${offset}`
      );
    }
    const code = buffer[offset + 1];
    offset += 2;

    if (code === EOI) {
      break;
    }

    if (code === SOS) {
      if (offset + 2 > buffer.length) {
        throw new RuleError(
          "frame-dimension",
          "SOS length field runs past the end of the file"
        );
      }
      const segmentLength = readUint16(buffer, offset);
      if (segmentLength < 2) {
        throw new RuleError(
          "frame-dimension",
          `SOS segment declares an implausible length of ${segmentLength}`
        );
      }
      offset += segmentLength;
      while (offset + 1 < buffer.length) {
        const byte = buffer[offset];
        if (byte !== 0xff) {
          offset += 1;
          continue;
        }
        const next = buffer[offset + 1];
        if (next === 0xff) {
          offset += 1;
          continue;
        }
        if (next === 0x00) {
          offset += 2;
          continue;
        }
        break;
      }
      continue;
    }

    if (code === TEM || (code >= 0xd0 && code <= 0xd7)) {
      continue;
    }

    if (offset + 2 > buffer.length) {
      throw new RuleError(
        "frame-dimension",
        "segment length field runs past the end of the file"
      );
    }
    const segmentLength = readUint16(buffer, offset);
    if (segmentLength < 2) {
      throw new RuleError(
        "frame-dimension",
        `segment at offset ${offset - 2} declares an implausible length of ${segmentLength}`
      );
    }
    if (offset + segmentLength > buffer.length) {
      throw new RuleError(
        "frame-dimension",
        `segment at offset ${offset - 2} overruns the file by ${
          offset + segmentLength - buffer.length
        } bytes`
      );
    }

    if (SOF_MARKERS.has(code)) {
      if (segmentLength < 7) {
        throw new RuleError(
          "frame-dimension",
          `SOF segment at offset ${offset - 2} is too short to hold a frame header`
        );
      }
      const height = readUint16(buffer, offset + 3);
      const width = readUint16(buffer, offset + 5);
      if (height > largestHeight) {
        largestHeight = height;
      }
      if (width > largestWidth) {
        largestWidth = width;
      }
    }

    offset += segmentLength;
  }

  if (largestWidth === 0 || largestHeight === 0) {
    throw new RuleError(
      "frame-dimension",
      "no frame was found in the file"
    );
  }
  if (largestWidth > MAX_FRAME_SIDE || largestHeight > MAX_FRAME_SIDE) {
    throw new RuleError(
      "frame-dimension",
      `largest frame is ${largestWidth}x${largestHeight}; each side must be at most ${MAX_FRAME_SIDE}`
    );
  }

  return { largestWidth, largestHeight };
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const inputPath = join(moduleDirectory, INPUT_NAME);
const outputDirectory = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const outputPath = checkOutputPath(outputDirectory, inputPath);

const imageBytes = await readFile(inputPath);

checkFileSize(imageBytes);
checkJpegMagic(imageBytes);
const { largestWidth, largestHeight } = checkFrames(imageBytes);

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, imageBytes);

console.log(
  `verified JPEG ${largestWidth}x${largestHeight} and wrote ${imageBytes.length} bytes to ${outputPath}`
);
