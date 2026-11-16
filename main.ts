// The Sky Was a Sheet of Glass — a colossal whale hangs mid-lunge above a desert highway under a shattered glass sky.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MAX_BYTES = 1048576;
const MAX_SIDE = 1024;
const MARKER = 0xff;
const MARKER_SOI = 0xd8;
const MARKER_SOS = 0xda;
const MARKER_EOI = 0xd9;
const MARKER_TEM = 0x01;

const INPUT_NAME = 'entry.jpg';
const OUTPUT_NAME = 'entry.png';

function fail(rule: string, message: string): never {
    throw new Error(`${rule} rule failed: ${message}`);
}

function isEarlyTerminator(code: number): boolean {
    return code === MARKER_TEM || (code >= 0xd0 && code <= 0xd7);
}

function isFrameMarker(code: number): boolean {
    return (
        code >= 0xc0 &&
        code <= 0xcf &&
        code !== 0xc4 &&
        code !== 0xc8 &&
        code !== 0xcc
    );
}

function isStandalone(code: number): boolean {
    return code === MARKER_SOI || code === MARKER_EOI || isEarlyTerminator(code);
}

function validateMagic(buf: Buffer): void {
    if (buf.length < 3) {
        fail(
            'JPEG magic bytes',
            'file is shorter than three bytes, so it cannot start with the required FF D8 FF',
        );
    }
    if (buf[0] !== MARKER || buf[1] !== MARKER_SOI || buf[2] !== MARKER) {
        fail(
            'JPEG magic bytes',
            `expected the file to begin with FF D8 FF, found ${buf
                .subarray(0, 3)
                .toString('hex')
                .toUpperCase()}`,
        );
    }
}

function validateSize(buf: Buffer): void {
    if (buf.length > MAX_BYTES) {
        fail(
            'Entry size',
            `file is ${buf.length} bytes, exceeding the ${MAX_BYTES}-byte limit`,
        );
    }
}

function readUint16(buf: Buffer, offset: number): number {
    return (buf[offset] << 8) | buf[offset + 1];
}

function scanForNextMarker(buf: Buffer, start: number): number {
    let i = start;
    while (i + 1 < buf.length) {
        if (buf[i] !== MARKER) {
            i += 1;
            continue;
        }
        const next = buf[i + 1];
        if (next === 0x00) {
            i += 2;
            continue;
        }
        if (next === MARKER) {
            i += 1;
            continue;
        }
        if (next >= 0xd0 && next <= 0xd7) {
            i += 2;
            continue;
        }
        return i;
    }
    fail(
        'JPEG structure',
        'reached the end of the file while scanning entropy-coded data, before any closing marker',
    );
    return -1;
}

function inspectFrames(buf: Buffer): { width: number; height: number } {
    let maxWidth = 0;
    let maxHeight = 0;
    let i = 2;

    while (i < buf.length) {
        if (buf[i] !== MARKER) {
            fail(
                'JPEG structure',
                `expected a 0xFF marker byte at offset ${i}, found 0x${buf[i].toString(16).toUpperCase()}`,
            );
        }
        while (buf[i] === MARKER) {
            i += 1;
        }
        if (i >= buf.length) {
            fail('JPEG structure', `a 0xFF byte at offset ${i - 1} is not followed by a marker code`);
        }

        const code = buf[i];
        i += 1;

        if (code === 0x00) {
            fail('JPEG structure', `found a stuffed 0x00 byte outside entropy-coded data at offset ${i - 1}`);
        }

        if (isStandalone(code)) {
            if (code === MARKER_EOI) {
                break;
            }
            continue;
        }

        if (i + 1 >= buf.length) {
            fail('JPEG structure', `marker 0x${code.toString(16).toUpperCase()} is missing its length field`);
        }

        const length = readUint16(buf, i);
        if (length < 2) {
            fail('JPEG structure', `marker 0x${code.toString(16).toUpperCase()} declares an implausible length of ${length}`);
        }
        if (i + length > buf.length) {
            fail('JPEG structure', `marker 0x${code.toString(16).toUpperCase()} declares length ${length} that overruns the file`);
        }

        if (code === MARKER_SOS) {
            i = scanForNextMarker(buf, i + length);
            continue;
        }

        if (isFrameMarker(code)) {
            const segmentStart = i + 2;
            const segmentEnd = i + length;
            if (segmentEnd - segmentStart < 5) {
                fail('JPEG structure', `frame marker 0x${code.toString(16).toUpperCase()} is too short to hold dimensions`);
            }
            const height = readUint16(buf, segmentStart + 1);
            const width = readUint16(buf, segmentStart + 3);
            if (width > maxWidth) {
                maxWidth = width;
            }
            if (height > maxHeight) {
                maxHeight = height;
            }
        }

        i += length;
    }

    if (maxWidth === 0 || maxHeight === 0) {
        fail('Frame dimensions', 'no frame marker was found, so the largest dimensions could not be determined');
    }

    return { width: maxWidth, height: maxHeight };
}

function validateDimensions(buf: Buffer): { width: number; height: number } {
    const { width, height } = inspectFrames(buf);
    if (width > MAX_SIDE || height > MAX_SIDE) {
        fail(
            'Frame dimensions',
            `largest encoded frame is ${width}x${height}, exceeding the ${MAX_SIDE}x${MAX_SIDE} limit`,
        );
    }
    return { width, height };
}

function resolveOutputDir(): string {
    const configured = process.env.MAKEFUN_OUTPUT_DIR?.trim();
    if (configured && configured.length > 0) {
        return configured;
    }
    return '/output';
}

async function main(): Promise<void> {
    const inputPath = join(dirname(fileURLToPath(import.meta.url)), INPUT_NAME);

    let bytes: Buffer;
    try {
        bytes = await readFile(inputPath);
    } catch (err) {
        fail('Entry source', `could not read ${inputPath}: ${(err as Error).message}`);
        return;
    }

    validateMagic(bytes);
    validateSize(bytes);
    const { width, height } = validateDimensions(bytes);

    const outputDir = resolveOutputDir();
    const outputPath = join(outputDir, OUTPUT_NAME);
    if (outputPath === inputPath) {
        fail('Output path', `refusing to write ${outputPath} into the entry's own folder and overwrite the source image`);
    }
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, bytes);

    console.log(`wrote ${outputPath} (${bytes.length} bytes, ${width}x${height})`);
}

main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
});