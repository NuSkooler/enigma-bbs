---
layout: page
title: Uploads
---
## Uploads
The default ACS for file areas in ENiGMA½ is to allow regular users 'read' and sysops 'read/write'. Read ACS includes listing and downloading while write allows for uploading. See [File Base ACS](acs.md) for more information.

Let's allow regular users (in the "users" group) to upload to an area:
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

> :information_source: Remember that uploads in a particular area are stored **using the first storage tag defined in that area.**

> :bulb: Any ACS checks are allowed. See [ACS](../configuration/acs.md)
