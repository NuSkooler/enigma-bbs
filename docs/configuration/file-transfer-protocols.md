---
layout: page
title: File Transfer Protocols
---
ENiGMA½ currently relies on external executable binaries for "legacy" file transfer protocols such as X, Y, and ZModem. Remember that ENiGMA½ also support modern web (HTTP/HTTPS) downloads!

## File Transfer Protocols
File transfer protocols are managed via the `fileTransferProtocols` configuration block of `config.hjson`. Each entry defines an **external** protocol handler that can be used for uploads (recv), downloads (send), or both. Depending on the protocol and handler, batch receiving of files (uploads) may also be available.

### Predefined File Transfer Protocols
Please see [External Binaries](external-binaries.md) for a table of built in / predefined protocol handlers. You will need to have the binaries in ENiGMA's PATH.
#### SEXYZ
[SEXYZ from Synchronet](http://wiki.synchro.net/util:sexyz) offers a nice X, Y, and ZModem implementation including ZModem-8k & works under *nix and Windows based systems. As of this writing, ENiGMA½ is pre-configured to support ZModem-8k, XModem, and YModem using SEXYZ. An x86_64 Linux binary, and hopefully more in the future, [can be downloaded here](https://l33t.codes/bbs-linux-binaries/).

#### sz/rz
ZModem-8k is configured using the standard Linux [sz(1)](https://linux.die.net/man/1/sz) and [rz(1)](https://linux.die.net/man/1/rz) binaries. Note that these binaries also support XModem and YModem, and as such adding the configurations to your system should be fairly straight forward.

Generally available as `lrzsz` under Apt or Yum type packaging.

### File Transfer Protocol Configuration
The following top-level members are available to an external protocol configuration:
* `name`: Required; Display name of the protocol
* `type`: Required; Currently must be `external`. This will be expanded upon in the future with built in protocols.
* `sort`: Optional; Sort key. If not provided, `name` will be used for sorting.

For protocols of type `external` the following members may be defined:
* `sendCmd`: Required for protocols that can send (allow user downloads); The command/binary to execute.
* `sendArgs`: Required if using `sendCmd`; An array of arguments. A placeholder of `{fileListPath}` may be used to supply a path to a **file containing** a list of files to send, or `{filePaths}` to supply *1:n* individual file paths to send.
* `recvCmd`: Required for protocols that can receive (allow user uploads); The command/binary to execute.
* `recvArgs`: Required if using `recvCmd` and supporting **batch** uploads; An array of arguments. A placeholder of `{uploadDir}` may be used to supply the system provided upload directory. If `{uploadDir}` is not present, the system expects uploaded files to be placed in CWD which will be set to the upload directory.
* `recvArgsNonBatch`: Required if using `recvCmd` and supporting non-batch (single file) uploads; A placeholder of `{fileName}` may be supplied to indicate to the protocol what the uploaded file should be named (this will be collected from the user before the upload starts).
* `escapeTelnet`: Optional; If set to `true`, escape all internal Telnet related codes such as IAC's. This option is required for external protocol handlers such as `sz` and `rz` that do not escape themselves.

### Adding Your Own
Take a look a the example below as well as [core/config_default.js](/core/config_default.js).

#### Example File Transfer Protocol Configuration
```
zmodem8kSexyz : {
    name		: 'ZModem 8k (SEXYZ)',
    type		: 'external',
    sort		: 1,
    external	: {
        sendCmd             : 'sexyz',
        sendArgs            : [ '-telnet', '-8', 'sz', '@{fileListPath}' ],
        recvCmd             : 'sexyz',
        recvArgs            : [ '-telnet', '-8', 'rz', '{uploadDir}' ],
        recvArgsNonBatch    : [ '-telnet', '-8', 'rz', '{fileName}' ],
    }
}
```
