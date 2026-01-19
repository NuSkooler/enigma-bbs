---
layout: page
title: External Support Binaries
---

## External Support Binaries
ENiGMA½ relies on various external binaries to perform common tasks such as processing file archives, extracting information from uploads/file imports, and supporting legacy transfer protocols.

:correct: Before using features such as the [File Base](../filebase/index.md) or [File Transfer Protocols](../configuration/file-transfer-protocols.md) it is highly recommended to install support binaries!

## Quick Check

On Linux, you can quickly check what is available in your PATH:

```sh
command -v exiftool xdms pdftotext 7za zip unzip lha unlzx arj unrar tar atr sexyz sz rz
```

If a command is missing, see the tables below.

## Archivers
Below is a table of pre-configured archivers. Remember that you can override settings or add new handlers! See [Archivers](archivers.md).

| Archiver (Key) | File Types | More Info | Debian/Ubuntu (apt/deb) | Red Hat (yum/rpm) | Windows |
|----------|---------|-----------|-------------------------|-------------------|---------|
| `Arj` | .arj | [Wikipedia](https://en.wikipedia.org/wiki/ARJ) | `arj` | `arj` | [ARJ](http://arj.sourceforge.net/) |
| `7Zip` | .7z, .bzip2, .gzip/.gz, etc.<br>:warning: Does not attempt to handle zip files! See `InfoZip`! | http://www.7-zip.org | `p7zip-full` (provides `7za`) | `p7zip` / `p7zip-plugins` (often via EPEL; provides `7za`) | [7-zip](http://www.7-zip.org/) |
| `InfoZip` | .zip | http://infozip.sourceforge.net <br>`zip` and `unzip` must be in ENiGMA's PATH | `zip` and `unzip` | `zip` and `unzip` | [InfoZip](http://infozip.sourceforge.net/) |
| `Lha` | .lza, .lzh, etc. | [Wikipedia](https://en.wikipedia.org/wiki/LHA_(file_format)) <br> https://fragglet.github.io/lhasa/ | `lhasa` (provides `lha`) | Often not packaged on modern EL; build from source if needed | [Win32 binaries](https://soulsphere.org/projects/lhasa/win32/) |
| `Lzx` | .lzx | [Amiga LZX](https://en.wikipedia.org/wiki/LZX_(algorithm)#Amiga_LZX) | Often not packaged; build from source if needed | Often not packaged; build from source if needed | [Source](http://xavprods.free.fr/lzx/) |
| `Rar` | .rar | [Wikipedia](https://en.wikipedia.org/wiki/RAR_(file_format)) | `unrar` (may require non-default repo) | `unrar` (may require non-default repo) | [RARLAB](https://www.rarlab.com/) |
| `TarGz` | .tar.gz, .gzip | [Wikipedia](https://en.wikipedia.org/wiki/Gzip) | `tar` | `tar` | [TAR.EXE](https://ss64.com/nt/tar.html) |
| `Atr` | .atr | [ATR (Atari disk image)](https://en.wikipedia.org/wiki/ATR_(disk_image)) | Not typically packaged; build/install a CLI tool that provides an `atr` command | Not typically packaged; build/install a CLI tool that provides an `atr` command | Varies |


> :information_source: For the exact defaults, see `core/config_default.js`.

> :information_source: For information on changing configuration or adding more archivers see [Archivers](archivers.md).

## File Transfer Protocols
Handlers for legacy file transfer protocols such as Z-Modem and Y-Modem.

| Handler (Key) | Protocol | More Info | Debian/Ubuntu (apt/dep) | Red Hat (yum/rpm) | Windows |
|----------|---------|-----------|-------------------------|-------------------|---------|
| `xmodemSexyz`<br>`ymodemSexyz`<br>`zmodem8kSexyz` | X-Modem, Y-Modem and Z-Modem (SEXYZ) | [SEXYZ](http://www.synchro.net/docs/sexyz.txt) | Typically installed manually (standalone `sexyz` binary) | Typically installed manually (standalone `sexyz` binary) | [Synchronet FTP](ftp://ftp.synchro.net/) |
| `zmodem8kSz` | Z-Modem 8K (`sz`/`rz`) | [Wikipedia](https://en.wikipedia.org/wiki/ZMODEM) | `lrzsz` (provides `sz` and `rz`) | `lrzsz` (provides `sz` and `rz`) | Varies |


## Information Extractors
Information extraction utilities can extract information from various file types such as PDF in order to (attempt) to come up with a good default description.

| Extractor | File Types | More Info | Debian/Ubuntu (apt/deb) | Red Hat (yum/rpm) | Windows |
|----------|---------|-----------|-------------------------|-------------------|---------|
| ExifTool | .mp3, .pdf, .mp4, .jpg, .gif, .png, many more | [ExifTool](https://www.sno.phy.queensu.ca/~phil/) | `libimage-exiftool-perl` | `perl-Image-ExifTool` | Varies |
| pdftotext | .pdf (text extraction) | [poppler-utils](https://poppler.freedesktop.org/) | `poppler-utils` | `poppler-utils` | Varies |
| XDMS | Amiga DiskMasher images (.dms) | http://zakalwe.fi/~shd/foss/xdms/ | `xdms` | Often not packaged on modern EL; build from source if needed | Varies |

## Notes

- The exact command names ENiGMA executes are defined in `core/config_default.js` under `archives.archivers`, `fileTransferProtocols`, and `infoExtractUtils`.
- Your `config/config.hjson` may override defaults (for example, using `pdftotext` instead of ExifTool for PDF long descriptions).
