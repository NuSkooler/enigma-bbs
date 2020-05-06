---
layout: page
title: Message Networks
---
## Message Networks
ENiGMA½ supports external networks such as FidoNet-Style (FTN) and QWK by the way of importing and exporting to/from it's own internal format. This allows for a very flexible system that can easily be extended by creating new network modules.

All message network configuration occurs under the `messageNetworks.<name>` block in `config.hjson` (where name is something such as `ftn` or `qwk`). The most basic of external message network configurations generally comprises of two sections:

1. `messageNetworks.<name>.networks`: Global/general configuration for a particular network where `<name>` is for example `ftn` or `qwk`.
2. `messageNetworks.<name>.areas`: Provides mapping of ENiGMA½ **area tags** to their external counterparts.

:information_source: A related section under `scannerTossers.<name>` may provide configuration for scanning (importing) and tossing (exporting) messages for a particular network type. As an example, FidoNet-Style networks often work with BinkleyTerm Style Outbound (BSO) and thus the [FTN/BSO scanner/tosser](bso-import-export.md) (`ftn_bso`) module.

### Currently Supported Networks
The following networks are supported out of the box. Remember that you can create modules to add others if desired!

#### FidoNet-Style (FTN)
FidoNet and FidoNet style (FTN) networks as well as a [FTN/BSO scanner/tosser](bso-import-export.md) (`ftn_bso` module) are configured via the `messageNetworks.ftn` and `scannerTossers.ftn_bso` blocks in `config.hjson`.

See [FidoNet-Style Networks](ftn.md) for more information.

#### QWK
See [QWK and QWK-Net Style Networks](qwk.md) for more information.
