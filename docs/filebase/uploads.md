---
layout: page
title: Uploads
---
## Uploads
The default ACS for file areas areas in ENiGMA½ is to allow read (viewing of the area), and downloads for users while only permitting SysOps to write (upload). See [File Base ACS](acs.md) for more information.

To allow uploads to a particular area, change the ACS level for `write`. For example:
```hjson
uploads: {
    name: Uploads
    desc: User Uploads
    storageTags: [
        "uploads"
    ]
    acs: {
        write: GM[users]
    }
}
````

:information_source: Remember that uploads in a particular area are stored **using the first storage tag defined in that area.**

:information_source: Any ACS checks are allowed. See [ACS](/docs/acs.md)

