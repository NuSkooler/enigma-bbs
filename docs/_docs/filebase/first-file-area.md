---
layout: page
title: Configuring a File Base
---
## Configuring a File Base
ENiGMA½ offers a powerful and flexible file base. Configuration of file the file base and areas is handled via the `fileBase` section of `config.hjson`.

## ENiGMA½ File Base Key Concepts
First, there are some core concepts you should understand:
* Storage Tags
* Area Tags

### Storage Tags
*Storage Tags* define paths to physical (filesystem) storage locations that are referenced in a file *Area* entry. Each entry may be either a fully qualified path or a relative path. Relative paths are relative to the value set by the `fileBase.areaStoragePrefix` key (defaults to `/path/to/enigma-bbs/file_base`).

Below is an example defining some storage tags using the relative and fully qualified forms:

```hjson
storageTags: {
	retro_pc_dos: "dos" // relative
	retro_pc_bbs: "pc/bbs" // still relative!
	bbs_stuff: "/path/to/bbs_stuff_storage" // fully qualified
}
```

:memo: On their own, storage tags don't do anything — they are simply pointers to storage locations on your system.

:warning: Remember that paths are case sensitive on most non-Windows systems!

### Areas
File base *Areas* are configured using the `fileBase.areas` configuration block in `config.hjson`. Each entry's block starts with an *area tag*. Valid members for an area are as follows:

| Item | Required | Description |
|--------|---------------|------------------|
| `name` | :+1: | Friendly area name. |
| `desc` | :-1: | Friendly area description. |
| `storageTags` | :+1: | An array of storage tags for physical storage backing of the files in this area. If uploads are enabled for this area, **first** storage tag location is utilized! |
| `sort` | :-1: | If present, provides the sort key for ordering. `name` is used otherwise. |
| `hashTags` | :-1: | Set to an array of strings or comma separated list to provide _default_ hash tags for this area. |

Example areas section:

```hjson
areas: {
	retro_pc: { // an area tag!
		name: Retro PC
		desc: Oldschool PC/DOS
		storageTags: [ "retro_pc_dos", "retro_pc_bbs" ]
		hashTags: ["retro", "pc", "dos" ]
	}
}
```
The above example defines an area called "Retro PC" which is referenced via the *area tag* of `retro_pc`. Two storage tags are used: `retro_pc_dos`, and `retro_pc_bbs`. These storage tags can be seen in the Storage Tags example above.

## Example Configuration
This combines the two concepts described above. When viewing the file areas from ENiGMA½ a user will only see the "Retro PC" area, but the files in the area are stored in the two locations defined in the `storageTags` section. We also show a uploads area. Uploads are allowed due to the [ACS](acs.md) block. See [Uploads](uploads.md) for more information.

```hjson
fileBase: {
	// override the default relative location
	areaStoragePrefix: /enigma-bbs/file_base

	storageTags: {
		retro_pc_dos: "dos"
		retro_pc_bbs: "pc/bbs"
	}

	areas: {
		retro_pc: {
			name: Retro PC
			desc: Oldschool PC/DOS
			storageTags: [ "retro_pc_dos", "retro_pc_bbs" ]
		}

		uploads: {
			name: Uploads
			desc: User uploads
			acs: {
				// allow any user to upload here
				write: GM[users]
			}
			storageTags: [ "user_uploads" ]
		}
	}
}
```

## Importing Areas
Areas can also be imported using [oputil](../admin/oputil.md) using proper FileGate "RAID" aka `FILEBONE.NA` style files. After importing areas, you may wish to tweak configuration such as better `desc` fields, ACS, or sorting.

## Importing Files (Scan For New Files)
A common task is to *import* existing files to area(s). Consider a collection of retro BBS files in the area "Retro PC" (tag: `retro_pc` above) under the storage tag of `retro_pc_bbs`. You might choose to scan for new files in this area (and thus import new entries) as follows with [oputil](../admin/oputil.md)'s `fb scan`:

```bash
./oputil.js fb scan --quick --tags retro,bbs,pc retro_pc@retro_pc_bbs
```

Here we have asked [oputil](../admin/oputil.md) to scan the file base area by it's tag `retro_pc` and only include the storage tag of `retro_pc_bbs`. Note that the storage tag could be omitted, and if so, all of `retro_pc` would be scanned. We have also indicated to #hashtag new entries with the tags "retro", "bbs", and "pc".

Please see [oputil](../admin/oputil.md) for more information.

