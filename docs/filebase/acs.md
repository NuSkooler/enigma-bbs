---
layout: page
title: ACS
---

If no `acs` block is supplied in a file area definition, the following defaults apply to an area:
* `read` (list, download, etc.): `GM[users]`
* `write` (upload): `GM[sysops]`

To override read and/or write ACS, supply a valid `acs` member.

## Example File Area Config with ACS

```hjson
areas: {
	retro_pc: {
		name: Retro PC
		desc: Oldschool PC/DOS
		storageTags: [ "retro_pc", "retro_pc_bbs" ]
		acs: {
			write: GM[users]
		}
	}
}
```