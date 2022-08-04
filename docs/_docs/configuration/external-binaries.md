---
layout: page
title: External Support Binaries
---

## External Support Binaries
ENiGMA½ relies on various external binaries in order to perform common tasks such as processing file archives and extracting information from uploads/file imports, some legacy transfer protocols, etc.

:correct: Before using features such as the [File Base](../filebase/index.md) or [File Transfer Protocols](../configuration/file-transfer-protocols.md) it is highly recommended to install support binaries!

## Archivers
Below is a table of pre-configured archivers. Remember that you can override settings or add new handlers! See [Archivers](archivers.md).

| Archiver (Key) | File Types | More Info | Debian/Ubuntu (apt/dep) | Red Hat (yum/rpm) | Windows |
|----------|---------|-----------|-------------------------|-------------------|---------|
| `Arj` | .arj | [Wikipedia](https://en.wikipedia.org/wiki/ARJ) | `arj` | `arj` | [ARJ](http://arj.sourceforge.net/) |
| `7Zip` | .7z, .bzip2, .gzip/.gz, etc.<br>:warning: Does not attempt to handle zip files! See `InfoZip`! | http://www.7-zip.org | `p7zip-full` | `p7zip-full` | [7-zip](http://www.7-zip.org/) |
| `InfoZip` | .zip | http://infozip.sourceforge.net <br>`zip` and `unzip` will need to be en ENiGMA's PATH | `zip` and `unzip` | `zip` and `unzip` | [InfoZip](http://infozip.sourceforge.net/) |
| `Lha` | .lza, .lzh, etc. | [Wikipedia](https://en.wikipedia.org/wiki/LHA_(file_format)) <br> https://fragglet.github.io/lhasa/ | `lhasa` | `lhasa` | [Win32 binaries](https://soulsphere.org/projects/lhasa/win32/) |
| `Lzx` | .lzx | [Amiga LZX](https://en.wikipedia.org/wiki/LZX_(algorithm)#Amiga_LZX) | `unlzx` | `unlzx` | [Source](http://xavprods.free.fr/lzx/) |
| `Rar` | .rar | [Wikipedia](https://en.wikipedia.org/wiki/RAR_(file_format)) | `unrar` | `unrar`| [RARLAB](https://www.rarlab.com/) |
| `TarGz` | .tar.gz, .gzip | [Wikipedia](https://en.wikipedia.org/wiki/Gzip) | `tar` | `tar` | [TAR.EXE](https://ss64.com/nt/tar.html)


> :information_source: For more information see `core/config_default.js`

> :information_source: For information on changing configuration or adding more archivers see [Archivers](archivers.md).

## File Transfer Protocols
Handlers for legacy file transfer protocols such as Z-Modem and Y-Modem.

| Handler (Key) | Protocol | More Info | Debian/Ubuntu (apt/dep) | Red Hat (yum/rpm) | Windows |
|----------|---------|-----------|-------------------------|-------------------|---------|
| `xmodemSexyz`<br>`ymodemSexyz`<br>`zmodem8kSexyz` | X-Modem, Y-Modem and Z-Modem SEXYZ | [SEXYZ](http://www.synchro.net/docs/sexyz.txt) | [x86_64 Binary](https://l33t.codes/outgoing/sexyz) | [x86_64 Binary](https://l33t.codes/outgoing/sexyz) | [Synchronet FTP](ftp://ftp.synchro.net/) |
| `zmodem8kSz` | Z-Modem 8K | [Wikipedia](https://en.wikipedia.org/wiki/ZMODEM) | `lrzsz` | `lrzsz` | Unknown |


## Information Extractors
Information extraction utilities can extract information from various file types such as PDF in order to (attempt) to come up with a good default description.

| Extractor | File Types | More Info | Debian/Ubuntu (apt/dep) | Red Hat (yum/rpm) | Windows |
|----------|---------|-----------|-------------------------|-------------------|---------|
| ExifTool | .mp3, .pdf, .mp4, .jpg, .gif, .png, many more | [ExifTool](https://www.sno.phy.queensu.ca/~phil/) | `libimage-exiftool-perl` | `perl-Image-ExifTool` | Unknown |
| XDMS | Amiga DiskMasher images | | `xdms` | `xdms` | Unknown
