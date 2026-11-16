// One Frame Among Thousands — a colossal cracked-gold eye over a dark arena, one picture glowing brighter than all the rest.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Maximum accepted size of the source JPEG, in bytes (exactly 1 MiB).
const MAX_SOURCE_BYTES = 1048576;

// Any frame side larger than this fails the dimensions rule.
const MAX_FRAME_SIDE = 1024;

// Start-of-frame markers SOF0..SOF15. Every one of them carries a frame
// precision byte followed by a two-byte height and a two-byte width.
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const EOI = 0xd9;        // end of image marker
const RST_FIRST = 0xd0;  // first restart marker
const RST_LAST = 0xd7;   // last restart marker

/**
 * Every rejected input throws an Error that names the rule it ran into, so a
 * reader can tell instantly which guard fired and why.
 * @param {string} rule Short name of the violated rule.
 * @param {string} detail Human-readable explanation of the failure.
 * @returns {never}
 */
function fail(rule, detail) {
  throw new Error(`rule "${rule}" failed: ${detail}`);
}

/**
 * True when a marker byte is one of the start-of-frame markers whose payload
 * begins with precision/height/width fields.
 * @param {number} marker Marker byte (without the preceding 0xFF).
 * @returns {boolean}
 */
function isStartOfFrame(marker) {
  return SOF_MARKERS.has(marker);
}

/**
 * Scan for the next real JPEG marker that follows entropy-coded or padding
 * data, honouring byte-stuffed 0xFF 0x00 pairs and 0xFF 0xFF fill bytes.
 * @param {Buffer} buf The whole JPEG as bytes.
 * @param {number} from Index to begin scanning at.
 * @returns {number} Index of the 0xFF that starts the next marker, or -1.
 */
function scanToNextMarker(buf, from) {
  let i = from;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const next = buf[i + 1];
    if (next === 0xff) {
      // Fill byte before a marker; step over it.
      i += 1;
      continue;
    }
    if (next === 0x00) {
      // A byte-stuffed 0xFF inside entropy-coded data.
      i += 2;
      continue;
    }
    return i;
  }
  if (i < buf.length && buf[i] === 0xff) {
    return i;
  }
  return -1;
}

/**
 * Extract the frame width and height from a start-of-frame segment whose
 * 0xFF marker byte sits at {@code at}.
 * @param {Buffer} buf Whole JPEG bytes.
 * @param {number} at Index of the marker's 0xFF byte.
 * @returns {{ width: number, height: number }} The frame's width and height.
 */
function frameSizeAt(buf, at) {
  const height = buf.readUInt16BE(at + 5);
  const width = buf.readUInt16BE(at + 7);
  return { width, height };
}

/**
 * Enforce rule "magic": the source must start with JPEG SOI bytes FF D8 FF.
 * @param {Buffer} buf The source image bytes.
 * @returns {void}
 */
function checkMagic(buf) {
  if (buf.length < 3 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    fail(
      "magic",
      `expected the JPEG marker FF D8 FF at the start, got ${buf
        .subarray(0, Math.min(buf.length, 3))
        .toString("hex") || "<empty>"}`,
    );
  }
}

/**
 * Enforce rule "length": the whole file must be at most 1048576 bytes.
 * @param {Buffer} buf The source image bytes.
 * @returns {void}
 */
function checkLength(buf) {
  if (buf.length > MAX_SOURCE_BYTES) {
    fail(
      "length",
      `${buf.length} bytes is more than the allowed ${MAX_SOURCE_BYTES}`,
    );
  }
}

/**
 * Walk the whole marker stream, advancing each segment by its own length
 * field, and return the geometry of every start-of-frame marker in the file.
 *
 * A file may legitimately carry more than one frame — a hierarchical JPEG or
 * a multi-picture file — so every frame is measured, not just the first one.
 *
 * @param {Buffer} buf The source image bytes.
 * @returns {Array<{ width: number, height: number }>} Geometry of every frame.
 */
function collectFrameSizes(buf) {
  const frames = [];
  let pos = 2; // skip SOI
  while (pos >= 0 && pos < buf.length) {
    pos = scanToNextMarker(buf, pos);
    if (pos < 0 || pos + 1 >= buf.length) {
      break;
    }
    const code = buf[pos + 1];
    if (code === EOI) {
      break;
    }
    if (code === 0x01 || (code >= RST_FIRST && code <= RST_LAST)) {
      pos += 2; // standalone markers carry no segment body
      continue;
    }
    if (pos + 3 > buf.length) {
      fail("segment", `marker header runs past the end of the file at offset ${pos}`);
    }
    const segmentLength = buf.readUInt16BE(pos + 2);
    if (segmentLength < 2 || pos + 2 + segmentLength > buf.length) {
      fail(
        "segment",
        `segment ${code.toString(16)} at offset ${pos} claims length ` +
          `${segmentLength}, which overruns the ${buf.length}-byte file`,
      );
    }
    if (isStartOfFrame(code)) {
      if (segmentLength < 9) {
        fail(
          "segment",
          `start-of-frame marker at offset ${pos} is only ${segmentLength} ` +
            `bytes long, too short to hold a frame geometry`,
        );
      }
      frames.push(frameSizeAt(buf, pos));
    }
    pos += 2 + segmentLength;
  }
  if (frames.length === 0) {
    fail("dimensions", "no start-of-frame marker found, so no frame to measure");
  }
  return frames;
}

/**
 * Enforce rule "dimensions": every frame in the file must be at most
 * MAX_FRAME_SIDE wide and tall.
 * @param {Array<{ width: number, height: number }>} frames Frame geometries.
 * @returns {void}
 */
function checkDimensions(frames) {
  for (const frame of frames) {
    if (frame.width > MAX_FRAME_SIDE || frame.height > MAX_FRAME_SIDE) {
      fail(
        "dimensions",
        `frame is ${frame.width} x ${frame.height}; each side must be at most ` +
          `${MAX_FRAME_SIDE}`,
      );
    }
  }
}

/**
 * Resolve the output directory: $MAKEFUN_OUTPUT_DIR when set, otherwise the
 * conventional /output directory.
 * @returns {string} The directory to write entry.png into.
 */
function outputDirectory() {
  const env = path.normalize(process.env.MAKEFUN_OUTPUT_DIR ?? "");
  return env === "" || env === "." ? "/output" : env;
}

/**
 * Read the committed source image, verify every rule, and write the bytes out
 * unchanged as entry.png.
 * @returns {Promise<void>}
 */
async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(here, "entry.jpg");
  const bytes = await readFile(sourcePath);
  checkMagic(bytes);
  checkLength(bytes);
  const frames = collectFrameSizes(bytes);
  checkDimensions(frames);

  const outDir = outputDirectory();
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "entry.png"), bytes);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});