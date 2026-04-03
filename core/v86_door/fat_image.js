/* jslint node: true */
'use strict';

/**
 * fat_image.js
 *
 * Builds a 1.44MB FAT12 floppy disk image in memory and writes files into it.
 * Used by v86_worker.js to create the drop file drive (v86 mounts it as fda → A: in FreeDOS).
 *
 * FAT12 1.44MB floppy layout:
 *   Sector 0       : Boot sector (BPB)
 *   Sectors 1–9    : FAT1 (9 sectors)
 *   Sectors 10–18  : FAT2 (copy of FAT1)
 *   Sectors 19–32  : Root directory (14 sectors, 224 entries × 32 bytes)
 *   Sectors 33+    : Data area
 */

const fatfs = require('fatfs');
const { createBufferDriverSync } = require('fatfs-volume-driver');

const SECTOR_SIZE = 512;
const NUM_SECTORS = 2880; // 80 tracks × 2 heads × 18 sectors
const IMAGE_SIZE = SECTOR_SIZE * NUM_SECTORS; // 1,474,560 bytes
const SECTORS_PER_FAT = 9;
const NUM_FATS = 2;
const ROOT_ENTRY_COUNT = 224;
const SECTORS_PER_CLUSTER = 1;
const RESERVED_SECTORS = 1;

const FAT1_SECTOR = RESERVED_SECTORS;
const FAT2_SECTOR = FAT1_SECTOR + SECTORS_PER_FAT;
const ROOT_SECTOR = FAT2_SECTOR + SECTORS_PER_FAT;

function buildBootSector() {
    const sector = Buffer.alloc(SECTOR_SIZE, 0);

    sector[0] = 0xeb;
    sector[1] = 0x3c;
    sector[2] = 0x90;

    sector.write('MSDOS5.0', 3, 'ascii');

    sector.writeUInt16LE(SECTOR_SIZE, 11); // BytsPerSec
    sector[13] = SECTORS_PER_CLUSTER; // SecPerClus
    sector.writeUInt16LE(RESERVED_SECTORS, 14); // RsvdSecCnt
    sector[16] = NUM_FATS; // NumFATs
    sector.writeUInt16LE(ROOT_ENTRY_COUNT, 17); // RootEntCnt
    sector.writeUInt16LE(NUM_SECTORS, 19); // TotSec16
    sector[21] = 0xf0; // Media descriptor (1.44MB floppy)
    sector.writeUInt16LE(SECTORS_PER_FAT, 22); // FATSz16
    sector.writeUInt16LE(18, 24); // SecPerTrk
    sector.writeUInt16LE(2, 26); // NumHeads
    sector.writeUInt32LE(0, 28); // HiddSec
    sector.writeUInt32LE(0, 32); // TotSec32 (0 = use TotSec16)

    sector[36] = 0x00; // DrvNum (floppy = 0)
    sector[37] = 0x00; // Reserved1
    sector[38] = 0x29; // BootSig
    sector.writeUInt32LE(0x12345678, 39); // VolID
    sector.write('NO NAME    ', 43, 'ascii'); // VolLab (11 bytes)
    sector.write('FAT12   ', 54, 'ascii'); // FilSysType (8 bytes)

    sector[510] = 0x55;
    sector[511] = 0xaa;

    return sector;
}

function buildFATTable() {
    const fat = Buffer.alloc(SECTORS_PER_FAT * SECTOR_SIZE, 0);
    // Reserved entries: media descriptor + EOC marker
    fat[0] = 0xf0;
    fat[1] = 0xff;
    fat[2] = 0xff;
    return fat;
}

function buildEmptyFloppyImage() {
    const img = Buffer.alloc(IMAGE_SIZE, 0);
    buildBootSector().copy(img, 0);
    buildFATTable().copy(img, FAT1_SECTOR * SECTOR_SIZE);
    buildFATTable().copy(img, FAT2_SECTOR * SECTOR_SIZE);
    return img;
}

/**
 * Create a 1.44MB FAT12 floppy image containing the given files.
 *
 * @param {Array<{name: string, content: Buffer}>} files
 *   `name` is the DOS 8.3 filename (e.g. 'DOOR.SYS').
 *   `content` is a Buffer.
 * @returns {Promise<Buffer>} The completed image buffer.
 */
function createFloppyWithFiles(files) {
    const img = buildEmptyFloppyImage();

    return new Promise((resolve, reject) => {
        // partitionNumber: 0 = raw FAT at offset 0 (no MBR partition table — floppy style)
        const driver = createBufferDriverSync('', { buffer: img, partitionNumber: 0 });
        const fs = fatfs.createFileSystem(driver);

        fs.on('error', reject);

        fs.on('ready', () => {
            if (files.length === 0) {
                return resolve(img);
            }

            let pending = files.length;

            for (const { name, content } of files) {
                fs.writeFile(name, content, err => {
                    if (err) {
                        return reject(
                            new Error(`Failed to write ${name} to floppy: ${err.message}`)
                        );
                    }
                    pending--;
                    if (pending === 0) {
                        resolve(img);
                    }
                });
            }
        });
    });
}

module.exports = { createFloppyWithFiles };
