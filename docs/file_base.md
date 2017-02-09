# File Bases
Starting with version 0.0.4-alpha, ENiGMA½ has support for File Bases! Documentation below covers setup of file area(s), but first some information on what to expect:

## A Different Appoach
ENiGMA½ has strayed away from the old familure setup here and instead takes a more modern approach:
* [Gazelle](https://whatcd.github.io/Gazelle/) inspired system for searching & browsing files
* No File Conferences
* File Areas are still around but should generally be used less. Instead, files can have one or more tags. Think things like `dos.retro`, `pc.warez`, `game`, etc.
* Temporary web (http:// or https://) download links in additional to standard X/Y/Z protocol support
* Users can star rate files & search/filter by ratings

## Other bells and whistles
* A given area can span one to many physical storage locations
* Upload processor can extract and use `FILE_ID.DIZ`/`DESC.SDI`, for standard descriptions as well as `README.TXT`, `*.NFO`, and so on for longer descriptions
* Upload processor also attempts release year estimation by scanning prementioned description file(s)
* Fast indexed Full Text Search (FTS)
* Duplicates validated by SHA-256

## Configuration
Like many things in ENiGMA½, configuration of file base(s) is handled via `config.hjson` entries in the `fileBase` section.

```hjson
fileBase: {
	areaStoragePrefix: /path/to/somewhere/

	storageTags: {
		/* ... */
	}

	areas: {
		/* ... */
	}
}
```

### Storage tags
**Storage Tags** define paths to a physical (file) storage location that can later be referenced in a file *Area* entry. Each entry may be either a fully qualified path or a relative path. Relative paths are relative to the value set by the `areaStoragePrefix` key. Below is an example defining a both a relative and fully qualified path each attached to a storage tag:

```hjson
storageTags: {
	retro_pc: "retro_pc" // relative
	retro_pc_bbs: "retro_pc/bbs" // still relative!
	bbs_stuff: "/path/to/bbs_stuff_storage" // fully qualified
}
```

### Areas
File base **Areas** are configured using the `fileBase::areas` configuration block in `config.hjson`. Each entry within `areas` must contain a `name`, `desc`, and `storageTags`. Remember that in ENiGMA½ while areas are important, they should generally be used less than in tradditional BBS software. It is recommended to favor the use of more **tags** over more areas. 

Example areas section:
```hjson
areas: {
	retro_pc: {
		name: Retro PC
		desc: Oldschool PC/DOS
		storageTags: [ "retro_pc", "retro_pc_bbs" ]
		acs: {
			write: GM[users] /* optional, see ACS below */
		}
	}
}
```

#### ACS
If no `acs` block is supplied, the following defaults apply to an area:
* `read` (list, download, etc.): `GM[users]`
* `write` (upload): `GM[sysops]`

To override read and/or write ACS, supply a valid `acs` member.

#### Uploads
Note that `storageTags` may contain *1:n* storage tag references. **Uploads in a particular area are stored in the first storage tag path**.

## oputil
The `oputil.js` +op utilty `file-base` command has tools for managing file bases. See `oputil.js file-base --help`.