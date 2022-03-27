---
layout: page
title: Auto Signature Editor
---
## The Auto Signature Editor
The built in `autosig_edit` module allows users to edit their auto signatures (AKA "autosig").

### Theming
The following MCI codes are available:
* MCI 1 (ie: `MT1`): Editor
* MCI 2 (ie: `BT2`): Save button

### Disabling Auto Signatures
Auto Signature support can be disabled for a particular message area by setting `autoSignatures` to false in the area's configuration block.

Example:
```hjson
my_area: {
    name: My Area
    autoSignatures: false
}
```
