---
layout: page
title: ACS
---
## File Base ACS
[ACS Codes](../configuration/acs.md) may be used to control access to File Base areas by specifying an `acs` string in a file area's definition. If no `acs` is supplied in a file area definition, the following defaults apply to an area:
* `read` : `GM[users]`: List/view the area and it's contents.
* `write` : `GM[sysops]`: Upload.
* `download` : `GM[users]`: Download.

To override read and/or write ACS, supply a valid `acs` member.

## Example File Area Config with ACS

```hjson
areas: {
	retro_pc: {
		name: Retro PC
		desc: Oldschool PC/DOS
		storageTags: [ "retro_pc", "retro_pc_bbs" ]
		acs: {
			//	only users of the "l33t" group or those who have
			//	uploaded 10+ files can download from here...
			download: GM[l33t]|UP10
		}
	}
}
```

## See Also
[Access Condition System (ACS)](../configuration/acs.md)
