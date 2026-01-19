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

## Install (Linux)

These commands install the most common dependencies from OS packages. Some tools are uncommon on modern distributions and may require manual installation (see “Manual installs” below).

### Debian/Ubuntu

```sh
sudo apt update
sudo apt install -y \
	arj \
	p7zip-full \
	zip unzip \
	lrzsz \
	poppler-utils \
	libimage-exiftool-perl \
	tar
```

Notes:

- `unrar` is not always available in default Debian/Ubuntu repos (it may require enabling non-free / multiverse).
- `lhasa` may provide an `lha` command on some distros.

### RHEL / AlmaLinux / Rocky

```sh
sudo dnf install -y \
	arj \
	zip unzip \
	lrzsz \
	poppler-utils \
	perl-Image-ExifTool \
	tar
```

Notes:

- `p7zip` / `p7zip-plugins` and `unrar` often require extra repositories (commonly EPEL and/or RPM Fusion), depending on distro/version.

### Manual installs

The following are frequently *not* available in default repositories:

- `sexyz` (SEXYZ X/Y/Zmodem): https://l33t.codes/outgoing/sexyz
- `xdms` (Amiga DMS): http://zakalwe.fi/~shd/foss/xdms/ (see also Debian packaging: https://github.com/glaubitz/xdms-debian)
- `unlzx` (Amiga LZX): http://xavprods.free.fr/lzx/
- `atr` (Atari disk images): https://github.com/jhallen/atari-tools (provides an `atr` CLI that matches ENiGMA’s default `Atr` archiver commands)
- `lha`: https://github.com/jca02266/lha (if you can’t get `lhasa` from packages)

## Default executable mappings (what ENiGMA actually runs)

This section is a quick reference for the *exact executable names* ENiGMA runs by default.
These defaults come from `core/config_default.js`, and can be overridden in your configuration.

### Archives (`archives.archivers`)

| Archiver key | Executable(s) | Notes |
|---|---|---|
| `7Zip` | `7za` | `p7zip` / `p7zip-full` generally provide `7za` |
| `InfoZip` | `zip`, `unzip` | Both must be in PATH |
| `Lha` | `lha` | Often provided by `lhasa` on Debian/Ubuntu; may require manual build on EL |
| `Lzx` | `unlzx` | `unlzx` is the extractor/list tool for Amiga `.lzx` |
| `Arj` | `arj` |  |
| `Rar` | `unrar` |  |
| `TarGz` | `tar` | Uses `tar` for list/extract |
| `Atr` | `atr` | Uses `atr` for list/extract of Atari `.atr` images |

### File transfer protocols (`fileTransferProtocols`)

| Handler key | Executable(s) | Notes |
|---|---|---|
| `zmodem8kSexyz` | `sexyz` | SEXYZ implements `sz`/`rz` internally via args |
| `xmodemSexyz` | `sexyz` |  |
| `ymodemSexyz` | `sexyz` |  |
| `zmodem8kSz` | `sz`, `rz` | Provided by `lrzsz` |

### Information extractors (`infoExtractUtils`)

| Extractor key | Executable(s) | Notes |
|---|---|---|
| `Exiftool2Desc` | *(internal script)* | Runs `util/exiftool2desc.js` (Node.js) which requires `exiftool` in PATH |
| `Exiftool` | `exiftool` | Used for long description extraction by default (including PDFs) |
| `XDMS2Desc` | `xdms` |  |
| `XDMS2LongDesc` | `xdms` |  |

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
| `Atr` | .atr | [ATR (Atari disk image)](https://en.wikipedia.org/wiki/ATR_(disk_image)) <br> https://github.com/jhallen/atari-tools | Not typically packaged; build from source | Not typically packaged; build from source | Varies |


> :information_source: For the exact defaults, see `core/config_default.js`.

> :information_source: For information on changing configuration or adding more archivers see [Archivers](archivers.md).

## File Transfer Protocols
Handlers for legacy file transfer protocols such as Z-Modem and Y-Modem.

| Handler (Key) | Protocol | More Info | Debian/Ubuntu (apt/deb) | Red Hat (yum/rpm) | Windows |
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
