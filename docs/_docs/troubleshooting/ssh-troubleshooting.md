---
layout: page
title: Troubleshooting SSH
---

Stuck with errors trying to get your SSH setup configured? See below for some common problems. Or as always, reach out to us by creating an [Issue](https://github.com/NuSkooler/enigma-bbs/issues) or start a [Discussion](https://github.com/NuSkooler/enigma-bbs/discussions)

## No Such File or Directory

***Symptom:***
BBS not starting with an error similar to the following:

```shell
Error initializing: Error: ENOENT: no such file or directory, open '<path>/config/security/ssh_private_key.pem'
```

***Solution:***
Several things can cause this:

1. `ssh_private_key.pem` was installed to the wrong location. Make sure that it is in the `config/security` directory and has the name matching the error message. You can also change your `config.hjson` if you prefer to point to the location of the key file.
2. `ssh_private_key.pem` has the wrong file permissions. Verify that the file will be readable by the user that the BBS is running as. Because it is a cryptographic key however, we do recommend that access is restricted only to that user.

## Error With Netrunner

***Symptom:***
Some ssh clients connect, but Netrunner (and other older clients) get a connection failed message and the following is in the log:

```shell
"level":40,"error":"Handshake failed","code":2,"msg":"SSH connection error"
```

***Solution:***

The key was most likely not generated with the `-t rsa` option, and is using a newer algorithm that is not supported by Netrunner and similar clients. Regenerate the certificate with the `-t rsa` option.

***Symptom:***
Some ssh clients connect, but Netrunner (and other older clients) get a connection failed message and the following is in the log:

```shell
"level":40,"error":"Group exchange not implemented for server","msg":"SSH connection error"
```

***Solution:***

Remove the following encryption protocols from your `config.hjson`: `diffie-hellman-group-exchange-sha256` and `diffie-hellman-group-exchange-sha1`