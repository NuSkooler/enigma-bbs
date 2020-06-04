---
layout: page
title: Archivers
---
ENiGMA½ can detect and process various archive formats such as zip and arj for a variety of tasks from file upload processing to EchoMail bundle compress/decompression. The `archives` section of `config.hjson` is used to override defaults, add new handlers, and so on.

## Archivers
Archivers are manged via the `archives:archivers` configuration block of `config.hjson`. Each entry in this section defines an **external archiver** that can be referenced in other sections of `config.hjson` as and in code. Entries define how to `compress`, `decompress` (a full archive), `list`, and `extract` (specific files from an archive).

### Predefined Archivers
The following archivers are pre-configured in ENiGMA½ as of this writing. Remember that you can override settings or add new handlers!

#### ZZip
* Formats: .7z, .bzip2, .gzip/.gz, and more
* Key: `7Zip`
* Homepage/package: [7-zip.org](http://www.7-zip.org/). Generally obtained from a `p7zip` package in UNIX-like environments. See http://p7zip.sourceforge.net/ for details.
* Notes: Versions previous to 0.0.10-alpha defaulted to using 7zip for .zip files as well, but newer versions of the package give "volume" errors at times. See InfoZip below.

#### InfoZip
* Formats: .zip
* Key: InfoZip
* Homepage/package: http://infozip.sourceforge.net/. Often already available in Linux. You will need `zip` and `unzip` in ENiGMA's path.

#### Lha
* Formats: <a href="https://en.wikipedia.org/wiki/LHA_(file_format)">LHA</a> files such as .lzh.
* Key: `Lha`
* Homepage/package: `lhasa` on most UNIX-like environments. See also https://fragglet.github.io/lhasa/ and http://www2m.biglobe.ne.jp/~dolphin/lha/lha-unix.htm

#### Lzx
* Formats: <a href="https://en.wikipedia.org/wiki/LZX_(algorithm)#Amiga_LZX">Amiga LZX</a>
* Key: `Lzx`
* Homepage/package: `unlzx` under most UNIX-like platforms ([Debian/Ubuntu](https://launchpad.net/~rzr/+archive/ubuntu/ppa/+build/2486127), [RedHat](https://fedora.pkgs.org/28/rpm-sphere/unlzx-1.1-4.1.x86_64.rpm.html), [Source](http://xavprods.free.fr/lzx/))

#### Arj
* Formats: .arj
* Key: `Arj`
* Homepage/package: `arj` on most UNIX-like environments.

#### Rar
* Formats: .Rar
* Key: `Rar`
* Homepage/package: `unrar` on most UNIX-like environments. See also https://blog.hostonnet.com/unrar

### Archiver Configuration
Archiver entries in `config.hjson` are mostly self explanatory with the exception of `list` commands that require some additional information. The `args` member for an entry is an array of arguments to pass to `cmd`. Some variables are available to `args` that will be expanded by the system:

* `{archivePath}` (all): Path to the archive
* `{fileList}` (compress, extract): List of file(s) to compress or extract
* `{extractPath}` (decompress, extract): Path to extract *to*

For `list` commands, the `entryMatch` key must be provided. This key should provide a regular expression that matches two sub groups: One for uncompressed file byte sizes (sub group 1) and the other for file names (sub group 2). An optional `entryGroupOrder` can be supplied to change the default sub group order.

#### Example Archiver Configuration
```
7Zip: {
	compress: {
		cmd: 7za,
		args: [ "a", "-tzip", "{archivePath}", "{fileList}" ]
	}
	decompress: {
		cmd: 7za,
		args: [ "e", "-o{extractPath}", "{archivePath}" ]
	}
	list: {
		cmd: 7za,
		args: [ "l", "{archivePath}" ]
		entryMatch: "^[0-9]{4}-[0-9]{2}-[0-9]{2}\\s[0-9]{2}:[0-9]{2}:[0-9]{2}\\s[A-Za-z\\.]{5}\\s+([0-9]+)\\s+[0-9]+\\s+([^\\r\\n]+)$",
	}
	extract: {
		cmd: 7za,
		args [ "e", "-o{extractPath}", "{archivePath}", "{fileList}" ]
	}
}
```

## Archive Formats
Archive formats can be defined such that ENiGMA½ can detect them by signature or extension, then utilize the correct *archiver* to process them. Formats are defined in the `archives:formats` key in `config.hjson`. Many differnet types come pre-configured (see `core/config.js`).

### Example Archive Format Configuration
```
zip: {
	sig: "504b0304" /* byte signature in HEX */
	offset: 0
	exts: [ "zip" ]
	handler: 7Zip /* points to a defined archiver */
	desc: "ZIP Archive"
}
```