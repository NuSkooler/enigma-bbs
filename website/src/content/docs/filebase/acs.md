---
title: Access & Uploads
description: "Control who can list, download from and upload to a file area, and where uploads land."
sidebar:
    order: 3
---
[ACS codes](../configuration/acs.md) control access to file base areas via an `acs`
block in the area's definition. If an area supplies no `acs`, these defaults apply:

| Check | Default | Grants |
|-------|---------|--------|
| `read` | `GM[users]` | List and view the area and its contents |
| `download` | `GM[users]` | Download from the area |
| `write` | `GM[sysops]` | Upload to the area |

Supply any of them to override that one; the rest keep their defaults.

## Restricting Downloads

Any ACS check is allowed, so access can key off group membership, upload counts,
security level and so on:

```hjson
areas: {
    retro_pc: {
        name: Retro PC
        desc: Oldschool PC/DOS
        storageTags: [ "retro_pc", "retro_pc_bbs" ]
        acs: {
            //  only users in the "l33t" group, or those who have
            //  uploaded 10+ files, can download from here
            download: GM[l33t]|UP10
        }
    }
}
```

## Allowing User Uploads

By default only +ops can upload, since `write` defaults to `GM[sysops]`. To open
an area up to regular users, grant `write` to the `users` group:

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
```

:::note
Uploads to an area are stored using the **first storage tag defined in that
area** — `uploads` in the example above.
:::

## See Also

* [Access Condition System (ACS)](../configuration/acs.md) — the full code reference
* [Configuring a File Base](first-file-area.md) — areas, storage tags and scanning
