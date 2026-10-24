---
title: Archivers
description: "Configure external archivers so ENiGMA½ can list, extract and create ZIP, ARJ, RAR and more."
sidebar:
    order: 11
---

ENiGMA½ can detect and process various archive formats such as zip and arj for a variety of tasks from file upload processing to EchoMail bundle compress/decompression. The `archives` section of `config.hjson` is used to override defaults, add new handlers, and so on.

Archivers are managed via the `archives:archivers` configuration block of `config.hjson`. Each entry in this section defines an **external archiver** that can be referenced in other sections of `config.hjson` and in code. Entries define how to `compress`, `decompress` (a full archive), `list`, and `extract` (specific files from an archive).

:::tip
Generally you do not need to do anything beyond installing supporting binaries. No `config.hjson` editing necessary; Please see [External Binaries](external-binaries.md)!
:::

### Quick Check

On Linux, you can quickly check what is available in your PATH:

```sh
command -v 7za zip unzip lha unlzx arj unrar tar atr unarc
```

### Archiver Configuration
Archiver entries in `config.hjson` are mostly self explanatory with the exception of `list` commands that require some additional information. The `args` member for an entry is an array of arguments to pass to `cmd`. Some variables are available to `args` that will be expanded by the system:

* `{archivePath}` (all): Path to the archive
* `{fileList}` (compress, extract): List of file(s) to compress or extract
* `{extractPath}` (decompress, extract): Path to extract *to*

For `list` commands, the `entryMatch` key must be provided. This key should provide a regular expression that matches two sub groups: One for uncompressed file byte sizes (sub group 1) and the other for file names (sub group 2). An optional `entryGroupOrder` can be supplied to change the default sub group order.

A `list` command that prints JSON in the form `unarc list --json` does sets `outputFormat: 'json'` instead of `entryMatch`. ENiGMA½ reads each entry's `name` and `size`, and skips entries whose `kind` is `directory`. See [unarc](#unarc) below.

#### Example Archiver Configuration
```hjson
7Zip: {
	compress: {
		cmd: '7za',
		args: [ 'a', '-tzip', '{archivePath}', '{fileList}' ]
	}
	decompress: {
		cmd: '7za',
		args: [ 'e', '-y', '-o{extractPath}', '{archivePath}' ]
	}
	list: {
		cmd: '7za',
		args: [ 'l', '{archivePath}' ]
		entryMatch: "^[0-9]{4}-[0-9]{2}-[0-9]{2}\\s[0-9]{2}:[0-9]{2}:[0-9]{2}\\s[A-Za-z\\.]{5}\\s+([0-9]+) [ 0-9]{12}  ([^\\r\\n]+)$",
	}
	extract: {
		cmd: '7za',
		args: [ 'e', '-y', '-o{extractPath}', '{archivePath}', '{fileList}' ]
	}
}
```

## Archive Formats
Archive formats are defined in the `fileTypes` configuration block (alongside other file types). ENiGMA½ detects archives by signature (and sometimes by extension) and then uses the `archiveHandler` value to select an entry from `archives:archivers`.

Many different types come pre-configured (see `core/config_default.js`).

### Example archive file type mapping
```
'application/zip': {
	desc: 'ZIP Archive'
	sig: '504b0304' /* byte signature in HEX */
	offset: 0
	archiveHandler: 'InfoZip' /* points to a defined archiver */
}
```

A few formats have no signature at a fixed place in the file: C64 Lynx archives start with a BASIC loader of varying length, and D64 disk images have none at all. Their file types give an `ext` and no `sig`, and are matched by extension only when no other file type's signature matches. A ZIP named `.d64` is therefore still a ZIP. The archiver then decides: if it cannot list the file, ENiGMA½ treats it as a plain file instead.

```
'application/x-d64': {
	desc: 'C64 1541 Disk Image'
	ext: '.d64'
	archiveHandler: 'Unarc'
}
```

This applies to any archive: when its archiver fails to list it -- a misnamed or damaged file, or an archiver that is not installed -- the upload is handled as a plain file, with no archive type.

`sig` may also be a list of alternatives, all found at the same `offset`. LHA archives, for example, start with `-lh` or, for LArc, `-lz` at offset 2:

```
'application/x-lzh-compressed': {
	desc: 'LHArc Archive'
	sig: [ '2d6c68', '2d6c7a' ]
	offset: 2
	archiveHandler: 'Lha'
}
```

## unarc
[unarc](https://github.com/mkrueger/unarc-rs) is a single program that reads most of the archive formats found on BBSes: ARC and PAK, ZOO, ACE, Squeeze It (SQZ), UltraCompressor II (UC2), HA, HYP and Unix `.Z`; ZIP, RAR (all versions), 7z, ARJ, LHA, tar, xz, Zstandard and Microsoft Cabinet; and the C64 Lynx, T64 and D64 formats. It is written in Rust and does not need any other archiver installed.

ENiGMA½ uses it, through the `Unarc` archiver, for ARC/PAK, ZOO, ACE, SQZ, UC2, `.Z`, xz (including `.tar.xz`), Zstandard (including `.tar.zst`), Microsoft Cabinet, C64 Lynx, T64 and D64, and Amiga DMS files. `unarc` is not shipped with ENiGMA½, though the [Docker image](../installation/docker.md#archivers-and-file-descriptions) includes it: until it is installed, those files are handled as plain files, as they always were.

- **Amiga DMS:** `unarc` unpacks the disk and lists the files on it, and the `FILE_ID.DIZ` many DMS archives carry becomes the description. A disk it cannot list -- a damaged or non-AmigaDOS disk, or an `unarc` without DMS support -- still gets its description from `xdms`, as before.
- **Amiga LZX** and **Atari ATR** are still read with `unlzx` and `atr` by default, so a board that has them keeps working. `unarc` reads both as well -- including SpartaDOS ATR disks, which `atr` cannot -- so once it is installed you can drop those two tools by pointing their archivers at it:

```hjson
archives: {
	archivers: {
		Atr: "@reference:archives.archivers.Unarc"
		Lzx: "@reference:archives.archivers.Unarc"
	}
}
```

ENiGMA½ needs `unarc` 0.8.0 or later, for `list --json` and for DMS, LZX and ATR. Install it from crates.io with Cargo (Rust 1.95 or later, from [rustup](https://rustup.rs) or `mise use -g rust`):

```sh
cargo install --locked unarc-cli
```

Instead of editing `config.hjson`, the `ENIGMA_UNARC_ARCHIVERS` environment variable can name archivers to point at `Unarc`, separated by commas: `ENIGMA_UNARC_ARCHIVERS=Atr,Lzx` does the same as the example above. The Docker image sets exactly that. Names must match an archiver key exactly; others are ignored. The variable changes the defaults only, so an entry for the same archiver in `config.hjson` replaces it outright -- and must therefore be a *complete* archiver entry. A partial one, such as `Lzx: { list: { cmd: "my-unlzx" } }`, becomes the whole `Lzx` archiver, and listing an LZX then fails.

`unarc` cannot create archives, so it is not a choice for `compress`.

Any other type can be pointed at it as well. For example, to read RAR archives with `unarc` rather than `unrar`:

```hjson
fileTypes: {
	'application/x-rar-compressed': {
		archiveHandler: 'Unarc'
	}
}
```
