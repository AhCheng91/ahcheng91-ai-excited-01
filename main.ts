// Whale at Platform Two — a whale bursts up through a crowded subway platform, seawater and tiles exploding into the concourse.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_BYTES = 1048576;
const MAX_FRAME_DIMENSION = 1024;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const MARKER_NAMES: Record<number, string> = {
  0xc0: "SOF0 (baseline DCT)",
  0xc1: "SOF1 (extended sequential DCT)",
  0xc2: "SOF2 (progressive DCT)",
  0xc3: "SOF3 (lossless)",
  0xc4: "DHT (define Huffman table)",
  0xc5: "SOF5 (differential sequential DCT)",
  0xc6: "SOF6 (differential progressive DCT)",
  0xc7: "SOF7 (differential lossless)",
  0xc8: "JPG (reserved for JPEG extensions)",
  0xc9: "SOF9 (extended sequential, arithmetic)",
  0xca: "SOF10 (progressive, arithmetic)",
  0xcb: "SOF11 (lossless, arithmetic)",
  0xcc: "DAC (define arithmetic conditioning)",
  0xcd: "SOF13 (differential sequential, arithmetic)",
  0xce: "SOF14 (differential progressive, arithmetic)",
  0xcf: "SOF15 (differential lossless, arithmetic)",
  0xda: "SOS (start of scan)",
  0xd9: "EOI (end of image)",
};

const STANDALONE_MARKERS = new Set<number>([
  0x01,
  0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7,
  0xd8,
  0xd9,
]);

const SOF_MARKERS = new Set<number>([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

type Frame = {
  marker: number;
  precision: number;
  width: number;
  height: number;
};

class RuleError extends Error {
  constructor(rule: string, detail: string) {
    super(`Rule failed: ${rule} — ${detail}`);
    this.name = "RuleError";
  }
}

function rule(ruleName: string, ok: boolean, detail: string): void {
  if (!ok) {
    throw new RuleError(ruleName, detail);
  }
}

async function readEntryFile(directory: string): Promise<Buffer> {
  const entryPath = join(directory, "entry.jpg");
  return await readFile(entryPath);
}

function validateMagic(data: Buffer): void {
  rule(
    "JPEG_MAGIC",
    data.length >= 3 &&
      data[0] === JPEG_MAGIC[0] &&
      data[1] === JPEG_MAGIC[1] &&
      data[2] === JPEG_MAGIC[2],
    `the file must begin with the JPEG start-of-image marker FF D8 FF, found ${describeBytes(data, 3)}`,
  );
}

function validateLength(data: Buffer): void {
  rule(
    "FILE_LENGTH",
    data.length <= MAX_FILE_BYTES,
    `the file is ${data.length} bytes but the limit ${MAX_FILE_BYTES} is exceeded`,
  );
}

function describeBytes(data: Buffer, count: number): string {
  const hex: string[] = [];
  const take = Math.min(count, data.length);
  for (let i = 0; i < take; i++) {
    hex.push(data[i].toString(16).padStart(2, "0"));
  }
  return `[${hex.join(" ")}]`;
}

function collectFrames(data: Buffer): Frame[] {
  const frames: Frame[] = [];
  let index = 2;

  rule("SEGMENT_START", index <= data.length, "the byte stream is shorter than the start-of-image marker");

  while (index + 1 < data.length) {
    rule(
      "MARKER_SYNTAX",
      data[index] === 0xff,
      `every segment must begin with 0xFF at offset ${index}, found ${describeBytes(data, index + 3)}`,
    );

    while (index < data.length && data[index] === 0xff) {
      index++;
    }
    rule("MARKER_SYNTAX", index < data.length, "a marker run continues past the end of the file");

    const marker = data[index];

    rule(
      "MARKER_SYNTAX",
      marker !== 0x00 && marker !== 0xff,
      `marker 0x${marker.toString(16).padStart(2, "0")} is not an allowed segment code at offset ${index - 1}`,
    );

    if (STANDALONE_MARKERS.has(marker)) {
      index++;
      continue;
    }

    if (marker === 0xda) {
      break;
    }

    if (index + 3 >= data.length) {
      throw new RuleError(
        "SEGMENT_LENGTH",
        `marker ${markerName(marker)} at offset ${index} has no room for its length field`,
      );
    }

    const segmentLength = (data[index + 1] << 8) | data[index + 2];

    rule(
      "SEGMENT_LENGTH",
      segmentLength >= 2,
      `marker ${markerName(marker)} declares the impossible length ${segmentLength} (must be at least 2)`,
    );

    const payloadStart = index + 3;
    const payloadEnd = payloadStart + (segmentLength - 2);

    rule(
      "SEGMENT_LENGTH",
      payloadEnd <= data.length,
      `marker ${markerName(marker)} at offset ${index} ends at ${payloadEnd} which runs past the ${data.length}-byte file`,
    );

    if (SOF_MARKERS.has(marker)) {
      rule(
        "FRAME_SEGMENT",
        segmentLength >= 8,
        `frame marker ${markerName(marker)} at offset ${index} is only ${segmentLength} bytes; at least 8 are needed for a frame header`,
      );

      const precision = data[payloadStart];
      const height = (data[payloadStart + 1] << 8) | data[payloadStart + 2];
      const width = (data[payloadStart + 3] << 8) | data[payloadStart + 4];

      frames.push({ marker, precision, width, height });
    }

    index = payloadEnd;
  }

  return frames;
}

function validateDimensions(data: Buffer, frames: Frame[]): void {
  rule("FRAME_COUNT", frames.length >= 1, "no start-of-frame marker was found before the start of scan");

  for (const frame of frames) {
    rule(
      "FRAME_SIZE",
      frame.width <= MAX_FRAME_DIMENSION,
      `frame ${markerName(frame.marker)} is ${frame.width} pixels wide, but the limit is ${MAX_FRAME_DIMENSION}`,
    );

    rule(
      "FRAME_SIZE",
      frame.height <= MAX_FRAME_DIMENSION,
      `frame ${markerName(frame.marker)} is ${frame.height} pixels high, but the limit is ${MAX_FRAME_DIMENSION}`,
    );
  }
}

function markerName(marker: number): string {
  return MARKER_NAMES[marker] ?? `0x${marker.toString(16).padStart(2, "0")}`;
}

function outputDirectory(): string {
  return process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
}

async function writeOutput(directory: string, data: Buffer): Promise<void> {
  await mkdir(directory, { recursive: true });
  const outputPath = join(directory, "entry.png");
  await writeFile(outputPath, data);
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = await readEntryFile(here);

  validateMagic(bytes);
  validateLength(bytes);

  const frames = collectFrames(bytes);
  validateDimensions(bytes, frames);

  await writeOutput(outputDirectory(), bytes);
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});