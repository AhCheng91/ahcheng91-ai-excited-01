// One Frame Among Thousands — a colossal cracked-gold eye over a dark arena, one picture glowing brighter than all the rest.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BYTES_AT_MOST = 1048576;
const DIMENSION_AT_MOST = 1024;
const INPUT_NAME = "entry.jpg";
const OUTPUT_NAME = "entry.png";
const DEFAULT_OUTPUT_DIR = "/output";
const ROOT = dirname(fileURLToPath(import.meta.url));

const RULES = Object.freeze({
  MAGIC: "magic 0xFFD8FF",
  LENGTH: "length at most 1048576 bytes",
  DIMENSIONS: "frame width and height at most 1024 each",
  FRAME: "frame marker present",
  SEGMENT: "marker segment within file bounds",
  READ: "source image is readable",
});

const SOI = 0xd8;
const EOI = 0xd9;
const TEM = 0x01;
const SOS = 0xda;

const STANDALONE = new Set([SOI, EOI, TEM]);
const RESTART = new Set([0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function ruleError(rule, detail) {
  return new Error(`rule failed: ${rule}${detail ? ` — ${detail}` : ""}`);
}

function readUint16BE(buf, offset) {
  return (buf[offset] << 8) | buf[offset + 1];
}

function describeCode(code) {
  return `0x${code.toString(16).padStart(2, "0")}`;
}

function walkedFrames(buf) {
  const frames = [];
  let pos = 2;
  let inScan = false;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) {
      if (inScan) {
        pos += 1;
        continue;
      }
      throw ruleError(RULES.SEGMENT, `expected 0xFF marker byte at offset ${pos}`);
    }
    while (pos < buf.length && buf[pos] === 0xff) {
      pos += 1;
    }
    if (pos >= buf.length) {
      throw ruleError(RULES.SEGMENT, "truncated marker code");
    }
    if (inScan && buf[pos] === 0x00) {
      pos += 1;
      continue;
    }
    const code = buf[pos];
    pos += 1;
    if (RESTART.has(code)) {
      continue;
    }
    if (STANDALONE.has(code)) {
      if (code === EOI) {
        break;
      }
      continue;
    }
    if (pos + 2 > buf.length) {
      throw ruleError(RULES.SEGMENT, `truncated length field for marker ${describeCode(code)}`);
    }
    const length = readUint16BE(buf, pos);
    if (length < 2) {
      throw ruleError(
        RULES.SEGMENT,
        `marker ${describeCode(code)} declares segment length ${length}, below the minimum 2`,
      );
    }
    if (pos + length > buf.length) {
      throw ruleError(
        RULES.SEGMENT,
        `marker ${describeCode(code)} declares ${length} bytes but the file ends at ${buf.length}`,
      );
    }
    if (SOF.has(code)) {
      if (length < 8) {
        throw ruleError(RULES.FRAME, `start-of-frame ${describeCode(code)} is only ${length} bytes long`);
      }
      const precision = buf[pos + 2];
      const height = readUint16BE(buf, pos + 3);
      const width = readUint16BE(buf, pos + 5);
      frames.push({ code, precision, height, width, length });
    }
    pos += length;
    if (code === SOS) {
      inScan = true;
    }
  }
  if (frames.length === 0) {
    throw ruleError(RULES.FRAME, "no start-of-frame marker seen before end of image");
  }
  return frames;
}

function frameWithinBounds(frame) {
  if (frame.width < 1 || frame.height < 1) {
    throw ruleError(
      RULES.DIMENSIONS,
      `frame size ${frame.width}x${frame.height} has a zero dimension`,
    );
  }
  if (frame.width > DIMENSION_AT_MOST || frame.height > DIMENSION_AT_MOST) {
    throw ruleError(
      RULES.DIMENSIONS,
      `frame ${frame.width}x${frame.height} exceeds ${DIMENSION_AT_MOST} in width or height`,
    );
  }
}

async function outputTarget() {
  const configured = process.env.MAKEFUN_OUTPUT_DIR;
  let dir;
  if (typeof configured === "string" && configured.length > 0) {
    dir = configured;
  } else {
    dir = DEFAULT_OUTPUT_DIR;
  }
  return { dir, path: join(dir, OUTPUT_NAME) };
}

async function main() {
  const inputPath = join(ROOT, INPUT_NAME);
  let bytes;
  try {
    bytes = await readFile(inputPath);
  } catch (err) {
    throw ruleError(RULES.READ, err.message);
  }

  const head = bytes.toString("hex", 0, Math.min(4, bytes.length));
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw ruleError(RULES.MAGIC, `file begins with ${head}`);
  }

  if (bytes.length > BYTES_AT_MOST) {
    throw ruleError(RULES.LENGTH, `${bytes.length} bytes exceeds ${BYTES_AT_MOST}`);
  }

  const frames = walkedFrames(bytes);
  for (const frame of frames) {
    frameWithinBounds(frame);
  }
  const frame = frames[0];

  const { dir, path } = await outputTarget();
  await mkdir(dir, { recursive: true });
  await writeFile(path, bytes);

  console.log(`wrote ${path}`);
  console.log(
    `frame ${frame.width}x${frame.height} (${frame.width < 1024 ? "within" : "at"} 1024), ` +
      `${frames.length} frame${frames.length === 1 ? "" : "s"} checked, ` +
      `markup ${describeCode(frame.code)}, ${bytes.length} bytes unchanged`,
  );
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exitCode = 1;
});