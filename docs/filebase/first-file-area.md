---
layout: page
title: Configuring a File Base
---
## ENiGMA½ File Base Key Concepts
Like many things in ENiGMA½, configuration of file base(s) is handled via `config.hjson` — specifically 
in the `fileBase` section. First, there are a couple of concepts you should understand:


### Storage tags

**Storage Tags** define paths to physical (file) storage locations that are referenced in a 
file *Area* entry. Each entry may be either a fully qualified path or a relative path. Relative paths 
are relative to the value set by the `areaStoragePrefix` key (defaults to `<enigma_install_dir/file_base`). 
Below is an example defining a both a relative and fully qualified path each attached to a storage tag:

```hjson
storageTags: {
	retro_pc: "retro_pc" // relative
	retro_pc_bbs: "retro_pc/bbs" // still relative!
	bbs_stuff: "/path/to/bbs_stuff_storage" // fully qualified
}
```

Note that on their own, storage tags don't do anything — they are simply pointers to storage locations on your system. 

### Areas

File base **Areas** are configured using the `fileBase::areas` configuration block in `config.hjson`. 
Each entry within `areas` must contain a `name`, `desc`, and `storageTags`. Remember that in ENiGMA½ 
while areas are important, they should generally be used less than in tradditional BBS software. It is 
recommended to favor the use of more **tags** over more areas. 

Example areas section:

```hjson
areas: {
	retro_pc: {
		name: Retro PC
		desc: Oldschool PC/DOS
		storageTags: [ "retro_pc", "retro_pc_bbs" ]
	}
}
```

## Example Configuration

This combines the two concepts described above. When viewing the file areas from ENiGMA½ a user will 
only see the "Retro PC" area, but the files in the area are stored in the two locations defined in the 
`storageTags` section.

```hjson
fileBase: {
	areaStoragePrefix: /enigma-bbs/file_base

	storageTags: {
		retro_pc: "retro_pc"
        retro_pc_bbs: "retro_pc/bbs"
	}

	areas: {
		retro_pc: {
            name: Retro PC
            desc: Oldschool PC/DOS
            storageTags: [ "retro_pc", "retro_pc_bbs" ]
        }
	}
}
```

