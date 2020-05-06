---
layout: page
title: Message Networks
---
## Message Networks
ENiGMA½ considers all non-ENiGMA½, non-local messages (and their networks, such as FidoNet-Style (FTN) "external". That is, messages are only imported and exported from/to such a networks. Configuring such external message networks in ENiGMA½ requires three sections in your `config.hjson`.

All message network configuration occurs under the `messageNetworks.<name>` block in `config.hjson` (where name is something such as `ftn` or `qwk`). Similarly, if a scanner/tosser module exists for the network it can be configured under `scannerTossers.<name>`. An example of this is the [FTN/BSO scanner/tosser](bso-import-export.md) module where name is `ftn_bso`.

The most basic of external message network configurations generally comprises of two sections within `config.hjson`:

1. `messageNetworks.<name>.networks`: Global/general configuration for a particular network where `<name>` is for example `ftn` or `qwk`.
2. `messageNetworks.<name>.areas`: Provides mapping of ENiGMA½ **area tags** to their external counterparts.

Finally, a related section under `scannerTossers.<name>` may provide configuration for scanning (importing) and tossing (exporting) messages for a particular network type. As an example, FidoNet-Style networks often work with BinkleyTerm Style Outbound (BSO) and thus the [FTN/BSO scanner/tosser](bso-import-export.md) module.

### Supported Networks

#### FidoNet-Style (FTN)
FidoNet and FidoNet style (FTN) networks as well as a [FTN/BSO scanner/tosser](bso-import-export.md) (`ftn_bso` module) are configured via the `messageNetworks.ftn` and `scannerTossers.ftn_bso` blocks in `config.hjson`.

See [FidoNet-Style Networks](ftn.md) for more information.

#### QWK
See [QWK and QWK-Net Style Networks](qwk.md) for more information.
