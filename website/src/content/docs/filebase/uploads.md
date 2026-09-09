---
title: Uploads
description: "Let regular users upload to an area, and where their uploads are stored."
sidebar:
    order: 4
---
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

:::note
Remember that uploads in a particular area are stored **using the first storage tag defined in that area.**
:::

:::tip
Any ACS checks are allowed. See [ACS](../configuration/acs.md)
:::
