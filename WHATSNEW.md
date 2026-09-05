# Whats New
This document attempts to track **major** changes and additions in ENiGMA½. For details, see GitHub.

## 0.5.1-beta

* **`oputil.js config validate` checks your configuration before you restart** ([#281](https://github.com/NuSkooler/enigma-bbs/issues/281)) — a mistyped key in `config.hjson` has never been reported. Because your file is merged *into* the defaults, a typo does not replace anything: `outbund` lands quietly beside `outbound`, the setting you wrote is never read, and the board goes on using the default. Nothing is logged, and the file looks correct.

  The new command reports those, along with values whose type disagrees with the default they override:

  ```
  config.hjson: 2 issues (1 error, 1 warning)

    error    general.maxConnections
             expected number, got string

    warning  scannerTossers.ftn_bso.paths.outbund
             unknown key "outbund" -- did you mean "outbound"?
  ```

  It exits non-zero when there are errors, so it can be used from a script or a systemd `ExecStartPre`. Warnings alone are not a failure: an unrecognised key may perfectly well belong to a mod. Sections you add yourself, and the tags and names you choose for areas, networks and nodes, are never reported.

  `--check-env` additionally reports `@environment:`, `@file:` and `@reference:` specs that do not resolve. That one is opt-in because resolution depends on the shell it runs in: checked by default, a perfectly good configuration would look broken purely because it was validated from the wrong place.

  The same problems are now also reported **at startup and when you edit a running board** — on the console at startup, since the log is not open yet, and to the log on a hot reload. Neither ever stops anything: a configuration with problems is still applied, exactly as before. Set `general.configValidation` to `off` to stay silent; `oputil.js config validate` keeps working either way. There is deliberately no strict mode.

* **TIC-announced files were lost whenever the file arrived after its announcement** ([#735](https://github.com/NuSkooler/enigma-bbs/issues/735)) — a `.tic` control file and the file it announces routinely arrive in *separate* mailer sessions; a peer running HTick was observed announcing a full Zone 1 nodelist 15–20 minutes ahead of the payload. ENiGMA½ processed the `.tic` the moment it landed, could not find the file, archived the announcement to `reject/` and unlinked it. The file then arrived with nothing left to pair it with and sat in the secure inbound indefinitely. For that peer and that file it failed every single time, and recovery meant finding the orphan by hand and forcing a rescan.

  A TIC whose file is not here yet is now **held** and retried on later import passes — the same disposition HTick uses (`TIC_NotRecvd`, "has not been received, waiting") — rather than rejected. Because an import pass already runs the instant a BinkP session delivers files, the pairing normally completes within seconds of the file landing. A TIC that is never satisfied is given up on after `tic.holdMaxAgeMs` (48 hours by default) and rejected as before, so nothing accumulates forever.

  Four more defects in the same code path came out with it:

  * **The announced name was matched case-sensitively.** A TIC naming `NODELIST.Z34` never found a delivered `nodelist.z34`. Other FTN software normalises this (HTick calls `adaptcase()`); ENiGMA½ now resolves the name case-insensitively against the inbound.

  * **A file still being written could be deleted.** A payload shorter than the TIC's `Size`, or one failing its CRC, was archived as a reject and unlinked — which, with a mailer that writes directly into the inbound, could destroy a transfer in progress. Short and mismatched payloads are now held and re-checked instead.

  * **A `.tic` with no `File` field crashed the import pass.** Building the payload path threw a `TypeError` that escaped into a filesystem callback, leaving the pass hung until the five-minute watchdog fired — so every remaining TIC, and the other inbound directory, were skipped. Such a TIC is now simply rejected and the pass continues.

  * **`tic.secureInOnly` did nothing.** Documented and defaulted to `true` since TIC support landed, it was never read, so TIC files in the *unsecure* inbound were imported on the strength of an unauthenticated `From` line. It is now enforced. See [UPGRADE](UPGRADE.md) if you relied on the old behaviour.

* **A TIC could write its file anywhere the BBS user could write** ([#735](https://github.com/NuSkooler/enigma-bbs/issues/735)) — the `File` field was checked for path traversal, but `Lfile`/`Fullname` were not, and it is the *long* name a file is stored under: `paths.join(areaStorageDir, ticFileInfo.longFileName)`. A peer whose TIC otherwise validated could therefore send `Lfile ../../../somewhere/evil` and place arbitrary content outside the file base. All three fields are now checked, and `longFileName` discards an unsafe candidate rather than returning it. Found by a security review of the work above and confirmed against a live instance.

  Two smaller things fall out of the same work: the TIC password is now compared without regard to case, as other FTN software does and as ENiGMA½ already did for packet passwords; and the packet and bundle import stages, which run over the same directory first, no longer consume a TIC-announced file whose name happens to match their patterns.

* **Two more ways a TIC file could hurt you, both found by fuzzing the parser** ([#743](https://github.com/NuSkooler/enigma-bbs/issues/743)) — the same shape as the traversal above, reachable again by different routes.

  * **A single NUL byte in the `File` field stalled the entire import pass.** A name like `NODE<NUL>LIST.Z21` is not a path separator, is not `..` and is not absolute, so every safety check passed it — and the filesystem call that followed threw *synchronously*, escaping the asynchronous machinery so the import never finished. Every remaining TIC and the other inbound directory were skipped until the five-minute watchdog fired. Control characters are now rejected in an announced file name.

  * **A TIC could cause an arbitrary file to be copied and then deleted.** The path of the announced file was built without a safety check, so `File ../../../etc/passwd` resolved outside the inbound. Such a TIC is rejected — but *rejecting* is what does the damage: the reject path archives the announced file to `paths.reject` and then unlinks it. This needed neither a known node nor an area you carry, because the `File` field is read several steps before those checks.

  Nine further robustness defects came out of the same work, none individually dramatic: a legal 2-dimensional `Seenby` was written back as `undefined:1/50` to every downlink; a peer's `Seenby` list of a few thousand entries could stall the event loop for seconds; a `Crc` of `00000000` — the checksum of an empty file — was misread as a *missing* field and the TIC rejected; and a bare CR inside a value could smuggle an extra keyword line into TICs forwarded under your own name.

* **NetMail could not be sent to a node you had configured, without also adding a route for it** ([#739](https://github.com/NuSkooler/enigma-bbs/issues/739)) — `netMail.routes` is meant to say where mail goes when it is *not* going direct, but in practice it was mandatory for every NetMail destination. A message to an uplink sitting right there in `nodes{}` was refused with `No NetMail route for …`, and the sender got a delivery failure notice.

  The network was being resolved with a helper that compares an address against your own `localAddress` — the right question when *importing* a packet addressed to you, and one a correspondent can never answer yes to. So the unrouted path could only ever succeed for mail addressed to yourself.

  Destinations are now settled as the code always described: a `routes` entry if one matches, otherwise a `nodes` entry for the recipient itself, otherwise refused. Nothing that worked before changes — routes are still consulted first and handled exactly as they were.

  Two smaller things fall out of the same rework:

  * **`network` is now optional on a route.** Omitting it used to produce the same `No NetMail route` error even though a route had matched. It is filled in from the zone of the node being dialed, which is what picks the outbound directory anyway, so the from-address and the spool path cannot disagree. Name a `network` — on a route or on a `nodes` entry — only when two of your networks share a zone.

  * **Bad configuration is reported for what it is.** A route naming a network that does not exist, or carrying an address that will not parse, now says so. The first was reported a step later as a problem with the network rather than the route; the second threw.

  This also means automatic AreaFix rescan requests ([#241](https://github.com/NuSkooler/enigma-bbs/issues/241)) reach an uplink without a `routes` entry having to cover it.

* **Routed cross-zone NetMail was filed where nothing would ever look for it** ([#734](https://github.com/NuSkooler/enigma-bbs/issues/734)) -- NetMail routed through an uplink in a different zone than the recipient (the standard FidoNet zone gate: zone 2 mail leaving through a zone 1 hub) was written to the outbound directory of the *recipient's* zone instead of the *uplink's*. A mailer only looks in the zone of the node it is calling, so the session to the uplink completed cleanly having transferred nothing and the message sat on disk indefinitely.

  Nothing surfaced it. The packet's flow file was named for the uplink but filed under the recipient's zone, so the pending-mail scan -- which reads a node's address from the directory's zone plus the flow file's name -- reported a node that does not exist (`2:154/10`, for an uplink of `1:154/10`), which the poller then skipped at `debug` level. Every visible signal said success.

  Packets are now filed for the node that will actually be dialled. Three related changes mean this shape of failure is noisy rather than silent if it ever recurs:

  * A flow file entry whose file is missing is **logged** rather than skipped in silence.
  * A node whose live flow entries all point at missing files is **no longer reported as having pending mail**. That state used to put the poller in a dial-every-cycle-and-transfer-nothing loop.
  * A reference is also looked for by name **in the flow file's own directory**. Flow files store absolute paths, so mail that has been moved -- including anything misfiled by this bug before upgrading -- now ships by moving the files, with no hand-editing of flow files. See [UPGRADE](UPGRADE.md).

  Each routed NetMail also logs where it was routed, so the effective route can be confirmed rather than inferred.

* **TIC-announced files can now be forwarded to downlinks** ([#743](https://github.com/NuSkooler/enigma-bbs/issues/743)) — ENiGMA½ could only ever be a **leaf node** for FTN file echoes. A file received from an uplink was imported into the file base and then deleted from the inbound; it was never passed on. There was no way to declare downlinks, no TIC was ever generated, and the `Path` / `Seenby` fields were read but never written. Anyone downstream had to be fed by some other file processor, which in practice meant ENiGMA½ could not be used as a file-echo hub at all — a notable gap for a package that otherwise does full EchoMail and NetMail hubbing.

  Declare downlinks on the TIC area and it forwards, generating a TIC for each:

  ```hjson
  ticAreas: {
      fsx_gen: {
          areaTag:   fsxGeneral
          network:   fsxnet
          uplinks:   [ "21:1/100" ]                // who may publish into it
          downlinks: [ "21:1/200", "21:2/150" ]    // who receives it
      }
  }
  ```

  **Off unless you configure it.** An area with no `downlinks` behaves exactly as before. See [TIC Support](docs/_docs/filebase/tic-support.md#forwarding-to-downlinks).

  * **`uplinks` is an access control, not a formality.** Authentication is not per-area: every node in `nodes` is equally able to send you a TIC for any area you carry. Without `uplinks`, a node configured for some entirely unrelated reason could announce a file into an echo it has no rights to and have you relay it to that echo's subscribers under your own address, `Path` and `Seenby`. An area with `downlinks` and no `uplinks` forwards nothing and says so at startup. HTick performs the same check before forwarding.

  * **The loop guard is the part that matters.** A downlink already listed in the TIC's `Seenby` is skipped, as are the sender, the TIC's `To`, the file's `Origin`, and your own addresses on any network. Addresses are compared allowing for the 2D–5D differences that are ordinary in FTN control data — FSC-0087 lets each hop rewrite them — because a strict comparison would fail to notice a system had already seen a file and send it round again.

  * **Forwarding is gated harder than importing.** Importing affects your own file base; forwarding makes other systems receive traffic your `Path` and `Seenby` vouch for. A TIC from the unsecure inbound is never forwarded even if you import from there, and neither is one from a node with no `tic.password` — such a node is never actually authenticated, because the check is simply skipped when no password is configured. A TIC addressed to somebody else is imported but not re-announced.

  * **`Replaces` dequeues.** When a replacement supersedes a file still queued for a downlink that has not collected it, the old file and its TIC are removed from that downlink's outbound. Otherwise a downlink polling weekly would receive both — and the older one has by then been deleted locally, so it would receive neither.

  Problems that would otherwise be silent are reported at startup: an area with downlinks but no resolvable network, a downlink missing from `nodes`, or one with no TIC password.

  * **A system carrying file echoes and no message areas can now import at all.** The import pass was gated on having `messageNetworks.ftn.areas` configured, which TIC processing has nothing to do with — so a file-echo-only system logged "EchoMail export disabled" and then silently did nothing with every file its uplink sent. That configuration was barely reachable before this feature existed; it is the obvious one to try now.

* **Outbound could be dropped on the floor while a mail session was running** — ENiGMA½ appended reference records to BSO flow files without taking the flow file's `.bsy` lock, while the BinkP side rewrites those same files as entries are sent: it reads the whole file, marks a line done, and writes it back. An append landing between that read and that write was **silently discarded**. No error, no log — the queued file simply never shipped, and with nothing left referencing it, its packet sat in the outbound indefinitely. The busier the system, the more often it happened.

  [FTS-5005.003](http://ftsc.org/docs/fts-5005.003) §5.1 puts the requirement on *software*, not on mailers: "A bsy is a main control file that must be used by any software dealing with flow files in BSO […] If a bsy file exists all changes are prohibited in any corresponding flow files." The tosser queueing outbound is exactly that. Both BinkP session paths already took the lock, so the writer was the only unprotected party.

  Because `NNNNnnnn.bsy` is the standard name, honouring it also interlocks correctly with **external mailers** — Binkd takes the very same lock, so neither side needs to know about the other. (The pre-existing `enigma.bsy` flag could never serve this purpose: it is a non-FTS-5005 name in the outbound *root*, so no external mailer has reason to interpret it.) The protocol now lives in one place and is shared by the writer and the mailer rather than reimplemented on each side.

  When the lock cannot be taken the outbound is **not** queued that pass and says so — not writing is what the spec requires, and the next export cycle picks it up. `scannerTossers.ftn_bso.flowLockTimeoutMs` (default 5 seconds) bounds the wait; see [BinkP](docs/_docs/messageareas/binkp.md#flowlocktimeoutms).

  **A second, related race** was found by running two instances against each other: when one session ships more than one file to the same node, each file's completion rewrote the whole flow file independently, so all but one entry silently lost its "sent" mark. For mail the entry is deleted after sending, so the leftover reference merely dangles; for a forwarded file echo — where the file stays in your file base and must not be deleted — it looked unsent and went out again on **every** subsequent session. Those rewrites are now serialised.


* **A wildcard could shadow a more specific entry in `nodes{}` and NetMail `routes{}`** -- where several patterns matched an address, which one applied depended on nothing but the order they were written in `config.hjson`. A `"*"` route above `"21:*"` took every message; a `"21:*"` node block above `"21:1/100"` meant that node's `packetPassword` was never the one checked. The **most specific match now wins** regardless of order, which is what the native BinkP mailer already did for its own `binkp.nodes{}`.

  `routes{}` is still consulted before `nodes{}`, so a catch-all `"*"` route claims all NetMail -- AreaFix to your uplinks on other networks included. With ordering no longer deciding the outcome, a more specific route can now reliably send those direct. See [NetMail](docs/_docs/messageareas/netmail.md#which-route-applies).

* **The `download` file area ACS was enforced over the REST API and nowhere else** -- a security control that silently did not work. A file area can reasonably let everyone browse while restricting who may actually pull bytes down:

  ```hjson
  someArea: {
      acs: {
          read: GM[users]
          download: GM[donors]
      }
  }
  ```

  `read` was honoured everywhere, so browsing looked correctly gated and the configuration appeared to work. `download` was checked only by `core/rest/routes/files.js` -- over telnet and SSH, where essentially every user is, anyone who could see a file could queue and download it. It was the only ACS scope in the system with no terminal-side enforcement.

  The check is now applied at every path that can move a file to a user:

  * **Queueing** -- `DownloadQueue.add()` refuses an entry the user has no `download` right to, and the file area list shows a distinct indicator (`noDownloadAccessIndicator`, `n/a` in the shipped theme) rather than letting the queue key look broken.
  * **Protocol downloads** -- the send queue is filtered at transfer time. A download queue persists in a user property across sessions, so an item queued while permitted can outlive the permission; being removed from a group now takes effect immediately.
  * **Web download links** -- both single and batch link generation are gated in `FileAreaWeb`, which also covers the browse screen's "generate web link" action. That path never went through the download queue at all.

  Temporary session downloads -- QWK packets, FSE attachments -- are generated for the user on request, carry no ACS of their own, and are unaffected.

* **Message areas can now be created automatically for EchoMail you are not configured for** ([#241](https://github.com/NuSkooler/enigma-bbs/issues/241)) — mail arriving for an unknown FTN area tag was skipped with a warning, and since the packet was then removed, skipped meant *lost*. ENiGMA½ can now create those areas instead. **Off unless you configure it**; a system with no `autoAreas` block behaves exactly as before, and with no network enabled nothing extra runs at all.

  Setup is one command — `./oputil.js mb auto-areas init` — and then a per-network `autoAreas` block. See [FTN](docs/_docs/messageareas/ftn.md#automatic-area-creation).

  * **Created areas are read-only, and that means both halves.** They carry no `uplinks`, so nothing is exported. On its own that is not read-only: a local user could still post into an area that looks live and goes nowhere. So they also carry a write-deny ACS. To adopt one, define it in `config.hjson` with your own `uplinks` and `acs` — `config.hjson` always wins over the generated file.

  * **Nothing is ever written to your `config.hjson`.** Created areas go to a generated `auto-areas.hjson` pulled in through `includes`, which merges such that your own file wins. That file can therefore be rewritten on every pass without ever touching a description you wrote by hand.

  * **Real names and descriptions come from the network info pack.** The pack arrives by TIC like any other file; ENiGMA½ looks for it in the file area you name rather than waiting to be told, so one that landed before you enabled the feature counts too. It only renames areas you already carry — a pack lists what the *network* carries, which would otherwise leave you with hundreds of permanently empty areas.

  * **Collisions are refused, not merged.** An FTN tag lower cases straight onto a local area tag, and `PRIVATE_MAIL` would land an echo in everyone's mailbox. A tag already used in any conference, or carried by another network, is refused too, and the reason is logged.

  * **`ignore` and `maxAutoCreate`.** Adding a tag to `ignore` removes it if it was already created, so it is a real un-create. `maxAutoCreate` caps the total ever created for a network rather than the number per run — a per-run cap compounds.

  * **AreaFix rescan is optional, off, and has no default command.** [FSC-0057](http://ftsc.org/docs/fsc-0057.003) specifies `=TAG R=n` and Mystic and CrashMail II implement it, but husky and SBBSecho do not: they read it as a request to *add* an area with a garbage tag, and a husky hub with `forwardRequests` may pass that upstream. There is no portable form, so you state the one your uplink speaks or nothing is sent. Replies are matched to requests actually sent and summarised to you in NetMail.

* **`oputil mb import-areas` imported comment lines as message areas** ([#733](https://github.com/NuSkooler/enigma-bbs/issues/733)) — a leading `;` or `%` line became an area whose tag was the comment character. Measured against real network info packs, importing fsxNet's file echo list produced 18 of them and AgoraNet's 14, written straight into `config.hjson` for you to find and remove by hand.

  The area list parser is now shared between `oputil` and automatic area creation, and it works out the format from the file's **content** rather than its extension:

  * `;`, `%` and `#` comment lines are skipped. fsxNet used `%` in its 2018 pack and `;` in the current one, so both are needed.
  * A FILEBONE *file* echo list — which six of eight surveyed networks ship named `*.na`, alongside their message list — is recognised and sent to `fb import-areas` instead of being imported as areas all tagged `Area`.
  * A list with the columns reversed, description first, is recognised and refused. SpookNet ships one, and the old parser took 35 entries from it with tags like `Aliens,` — nothing on those lines is malformed enough to reject one at a time, so the decision has to be made about the file as a whole.
  * Lines that survive but cannot be used are listed for you before the confirmation prompt instead of being silently dropped.

  `AREAS.BBS` is unchanged: it cannot be told from a plain area list by shape, so it is still only assumed from the `.bbs` extension or `--type bbs`.

* **`oputil fb import-areas` shares that parser**, so a FILEBONE list is recognised by its content rather than its name, and a *file* echo list shipped as a plain `TAG  Description` list — ArakNet's, among others — imports rather than reporting "Nothing to import". FileGate `.ZXX` and FILEBONE `.NA` files produce byte-identical results to before; a multi-digit area level and flags other than `!` and `*&` are now accepted as well. Since a plain list is indistinguishable from a *message* echo list, `import-areas` says so before the confirmation prompt.

* **A missing `includes:` file said the wrong thing on startup** — a file listed in `includes` that does not exist stops the board from starting, correctly, but the message advised running `./oputil.js config new` as though `config.hjson` itself were missing, and printed the placeholder `'{configFile}'` instead of a path. Both now name the file that is actually missing and say what to do about it.

* **A second instance bound nothing, said nothing, and kept running** ([#547](https://github.com/NuSkooler/enigma-bbs/issues/547)) — starting ENiGMA½ while another instance already held its ports produced no error, no `System started!`, and no exit. The process simply sat there, serving no one.

  Node's `server.listen(port, host, cb)` registers `cb` as a one-shot `'listening'` listener: it never receives an error argument, and on a failed bind it never fires at all. Every server treated it as an error-first callback, so `EADDRINUSE` left the startup series in `listening_server.js` waiting for a callback that would never come. Telnet caught the event but logged it at `info` — and the default logging config writes to a rotating file with no console stream, so nothing reached the terminal. The remaining servers had no server-level `'error'` handler at all, so the event fell through to the process-level `uncaughtException` net, which by design keeps the process alive.

  Every login, content, and chat server now binds through a shared helper that listens for both `'listening'` and `'error'` and calls back exactly once, with an error an operator can act on — `EADDRINUSE`, `EACCES` on a privileged port, and `EADDRNOTAVAIL` each get an explanation rather than a bare code. A bind failure is now fatal for **every** server, including NNTP; see [UPGRADE.md](UPGRADE.md).

  * **Startup output now reads in the order things happen** -- the banner, then any configuration warnings, then the server list, then `System started!`. The banner was previously printed at the very end, underneath everything it was supposed to introduce.

  * **Startup now reports what actually bound.** One line per server with its address and port, so a misconfigured or missing service is visible at a glance instead of only in the log. Colour is used only when stdout is a TTY and [`NO_COLOR`](https://no-color.org/) is unset, so piped output and journals stay clean.

  * **Startup failures always exit non-zero.** An error that had already been displayed previously fell through the final handler and the process wound down with status `0`, so service managers and install scripts saw a clean exit from a failed start.

* **BinkP sessions ended on a timeout instead of a clean close** — binkp/1.1 runs a session as a series of batches: another follows any batch that carried more than the two `M_EOB`s, and only an empty batch ends the session. ENiGMA½ stopped after the first one, leaving a conforming peer waiting for an `M_EOB` that never came.

  No mail was lost — it had already transferred by then — but the peer sat until its own timeout (five minutes, for binkd) and then recorded an otherwise successful session as `failed`. With binkd's shipped `try`/`hold` settings, enough of those in a row will put us on hold and stop it calling for a while.

  The cost was ours too: an inbound session parked like that still holds the node's lock, so crashmail queued for that node inside the window is skipped and waits for the next scheduled poll — quietly defeating the point of crashmail. Sessions against binkd now finish in milliseconds and log `done (..., OK, ...)`.

  Peers below binkp/1.1, and any that never identify their version, are treated exactly as before.

* **BinkP GZ compression used the wrong container** ([#723](https://github.com/NuSkooler/enigma-bbs/issues/723)) — [FTS-1029](http://ftsc.org/docs/fts-1029.001) specifies zlib's `compress()`/`compress2()`, which produce the RFC 1950 container: two header bytes and an Adler-32 tail. ENiGMA½ emitted RFC 1952 (gzip) instead — the same deflate payload behind a different header — so every conforming peer rejected it on sight. binkd logs `Decompress <file> error -3` and abandons the transfer; the *sending* side saw nothing wrong and re-offered the same file on every poll, for days. Confirmed here against binkd 1.1a-115 and reported against Mystic 1.12A48.

  Only nodes **without** `archiveType` were affected: ArcMail bundles and archives are already compressed, so GZ is skipped for them entirely. That is the same set of systems as the packet-naming bug in #722.

  * **Both containers are accepted on receive.** The GZ option carries no version, so a pre-fix and a post-fix ENiGMA½ cannot tell each other apart. Inbound data is now sniffed and either container decoded, which keeps a half-upgraded link working in that direction. Only what we *send* changed.
  * **A failed decompression recovers instead of stalling.** FTS-1029 lets a receiver switch compression off mid-session by answering with an `M_GET` carrying an `NZ` token; ENiGMA½ now does that and takes the file again in the clear. If that fails too it sends `M_SKIP`, so the batch finishes rather than hanging to a timeout. Previously the error was logged at `warn` and the session simply stopped.
  * **Compression can be turned off per node** with `gz: false`, for a peer whose decompressor cannot be fixed.

* **BinkP outbound stalled against any peer that asked for NR mode** ([#724](https://github.com/NuSkooler/enigma-bbs/issues/724)) — a peer sending `OPT NR` obliges us to offer each file with an offset of `-1` and wait for it to name the offset it wants ([FTS-1028](http://ftsc.org/docs/fts-1028.001)). We did that, then began sending file data straight away. [FTS-1026](http://ftsc.org/docs/fts-1026.001) requires the answer to `M_GET` to "proceed with transmission of the file requested starting with an appropriate `M_FILE`", and a conforming receiver has already closed the file by the time it sends `M_GET` — binkd discards every data frame that arrives with nothing open, silently. Both sides then waited: ours for the acknowledgement, theirs for the re-announcement, until the five minute session timeout. No mail moved and nothing was logged above `debug`. Note that this had nothing to do with the peer's version: binkd asks for NR whenever a sysop sets `-nr` **or** `-nd` on a node, and `-nd` is common. Fixed, along with four related defects in the same code:

  * **`M_SKIP` wedged the batch** — a skipped file stayed in the in-flight slot forever, producing the same silent stall. binkd sends `M_SKIP` in place of `M_GET` whenever an inbound skip mask matches, so this was a second route to an identical symptom. Skips are now honoured as FTS-1026 intends: non-destructive, the file kept for a later session, the batch carrying on.

  * **`M_GET` for an already-sent file was ignored** — FTS-1026 requires recognising a request naming "a file that have been transmitted, but we are still waiting an M_GOT acknowledge for it" — the race it explicitly warns implementations about. We logged it and moved on, leaving the remote waiting.

  * **Inbound NR started each file twice** — after answering an offset request we left the receive open, so the sender's required re-announcement began a *second* receive of the same file. A FREQ arriving that way pinned the end-of-batch hold above zero and the session never sent `M_EOB`.

  * **`OPT NR` is no longer sent by default** — the frame asks the *remote* to hand us files an offset at a time, costing a round trip each; FTS-1028 says it "should be used only if absolutely necessary". It is now opt-in per node via `requestNR`. Honouring a peer's request remains unconditional, as the spec requires.

  Also removed: a denylist of binkd 0.9.x version strings that switched NR off. It was transcribed from binkd's source, where the identical list drives the *opposite* workaround.

* **BSO outbound correctness & spec compliance** — a set of fixes to the FidoNet-style outbound spool shared by `ftn_bso` and the native BinkP mailer, each checked against [FTS-5005.003](http://ftsc.org/docs/fts-5005.003) (*Advanced BinkleyTerm Style Outbound flow and control files*). All four caused mail to sit in the spool undelivered with nothing logged at any level, including `trace`. See [UPGRADE.md](UPGRADE.md) for recovery of anything already stranded.

  * **EchoMail export to a node without `archiveType`** ([#722](https://github.com/NuSkooler/enigma-bbs/issues/722)) — a node with no `archiveType` exports bare packets rather than ArcMail bundles. Those were renamed onto a BSO netmail flow file name with no separating dot (e.g. `43792ae5cut` instead of `43792ae5.cut`), which nothing — this mailer or any other — could ever match. The basename was also a message serial number rather than the destination's net/node, so simply restoring the dot would have decoded it as a phantom address. Un-archived packets now ship as flow file references (`NNNNnnnn.?lo`), exactly as ArcMail bundles and NetMail already did. This is also what the spec requires: §3.1 gives a netmail flow file a one-to-one correspondence with its destination, so a node can hold exactly one at a time, while a single export routinely produces several packets.

  * **Direct-attach packets are renamed on the wire** — §3.1 requires that a netmail flow file (`NNNNnnnn.?ut`) "must be dynamically renamed at the moment of sending to a remote system with a unique name and extension `pkt`". ENiGMA½ sent it under its `.?ut` name, so although the transfer succeeded, the receiving system's tosser did not recognize what arrived as a packet. Such files — which other software, or a sysop, may legitimately place in the outbound — are now sent as a unique `NNNNNNNN.pkt`.

  * **Upper case outbound files are now found** — §2 asks that software "be able to handle both" upper and lower case BSO filenames. The mailer's pending-mail scan was case-insensitive but its per-node lookup was not, so a node with upper case flow files (from `fileCase: 'upper'`, or an outbound inherited from a DOS-era mailer) was reported as having mail, dialed every poll cycle, and then sent nothing. Lookups, `.bsy` locks, and `.pnt` subdirectories are now all matched case-insensitively.

  * **Point addresses are now polled and shipped** — §2 puts a point's flow and control files in a `NNNNnnnn.pnt` subdirectory of the boss node's outbound. `ftn_bso` has always written that layout, but the native BinkP mailer had no knowledge of it: point mail was never sent, and polling a point address served it the boss node's mail instead. Points are now scanned, shipped, and locked in their own subdirectory.

* **Multi-network BSO outbound fix** — `ftn_bso` (the scanner/tosser) and the native BinkP mailer used two independent rules to decide which FTN network owns the bare `outbound/` spool directory. With two or more networks configured and no explicit `scannerTossers.ftn_bso.defaultNetwork`, the two disagreed: outbound NetMail and EchoMail for the first-listed network was written to `mail/ftn_out/<network>/` but looked for in `mail/ftn_out/outbound/`, so it was never sent — and never logged an error. Both sides now share a single resolver (`defaultNetwork` when set, otherwise the first listed network), network names are matched case-insensitively, and mail already queued under the previous layout is picked up and sent automatically. See [UPGRADE.md](UPGRADE.md) for details.

## 0.5.0-beta

* **NetRunner over SSH sizing fix** — NetRunner connects via stock cryptlib, which hardcodes the terminal size it reports as 80x48, throwing art positioning off by a row on an 80x25 screen. That reported size is now skipped; ENiGMA½ queries the terminal instead, which NetRunner answers correctly. SyncTERM is unaffected — Synchronet's cryptlib fork reports a real size and identifies itself distinctly. Controlled by `loginServers.ssh.untrustedTermSizeClients`.

* **v86 multi-node shared disk** — concurrent door sessions for the same disk image now share a single in-memory buffer (SharedArrayBuffer), giving all nodes a live view of the same disk — exactly as they would on a real BBS with a shared drive. Games that rely on file/record locking (e.g. TradeWars 2002) work correctly when `SHARE.COM` is loaded from `runBatch`. Single-player doors are unchanged; use `nodeMax: 1` as before. The buffer is flushed back to the image file after each session exits, serialized so concurrent exits never race at the OS level.

* **OSC 8 clickable hyperlinks** — URLs in message bodies, file NFO/readme viewers, and file download listings are now rendered as clickable hyperlinks on terminals that support the OSC 8 standard: IcyTerm, SyncTERM, VTX, and modern *nix terminals (foot, Alacritty, GNOME Terminal, kitty, WezTerm, Windows Terminal, and others). Sysops enable hyperlinks per-view by adding `hyperlinks: true` to any `%MT` view in preview or read-only mode. The default menu templates and ActivityPub viewer have this enabled out of the box. See [Multi Line Edit Text View](./docs/_docs/art/views/multi_line_edit_text_view.md) for details.

* **User status config module** — users can now toggle their own availability and visibility via the new `user_status_config` module (command `STATUS` from the main menu in the default template). Availability controls whether the user can be paged/messaged; visibility controls whether they appear in who's-online and last-callers lists. Sysops expose the module by wiring `@menu:userStatusConfig` into their menu config. The module supports `enabledIndicator`/`disabledIndicator` config overrides and `TL10`/`TL11` custom-format views (`{availableIndicator}`, `{visibleIndicator}`) for full theme control.

* **Pre-auth feedback to sysop** — visitors can now send a private message to the sysop directly from the login matrix, before logging in. The sender types a free-text name (not resolved to any user account) and composes a message using the full FSE editor. Replies to these ghost-sender messages are blocked at the inbox with a clear notice rather than failing silently. See the Sysop Chat & Contact doc for configuration details.

* **Secret file injection (`@file:`)** — any string-valued config key that holds a secret (SSH host key passphrase, SMTP/IMAP passwords, BinkP session passwords, FTN packet passwords, JWT signing secret, door service credentials, etc.) can now be kept out of `config.hjson` entirely by using the new `@file:` directive. Point it at any readable file — absolute or relative to the config directory — and ENiGMA½ reads and trims the value at startup. Docker/Podman secrets (`/run/secrets/…`) and `chmod 600` files both work. The existing `@environment:` directive is unchanged. See [Configuration Files — Secret Files](./docs/_docs/configuration/config-files.md#secret-files) and [Security](./docs/_docs/configuration/security.md) for examples covering every secret-bearing config key.

* **REST API v1** — a JSON REST API is now available under `/_enig/api/v1/` when the web server is enabled. Endpoints cover system info, message conferences and areas (read/post/delete), file areas (list/metadata/download/upload), and user profiles. Two auth schemes are supported: short-lived JWT Bearer tokens (obtained via `POST /auth/login`) and long-lived API keys managed with `oputil rest api-key`. Public access to specific message and file areas can be configured without requiring authentication. See [REST API](./docs/_docs/servers/contentservers/rest-api.md) for full documentation.

## 0.4.0-beta

* **Security hardening** — several security improvements across the system:

  * **Stronger password hashing** — PBKDF2 iteration count raised from 1,000 to 210,000 (OWASP 2024 recommendation for PBKDF2-SHA512). Existing user passwords are transparently re-hashed to the new parameters on next successful login — no user action or migration script required. Hash parameters are now stored per-user in `pw_hash_params` so future algorithm changes can be made without a flag day.

  * **Password reset token TTL** — reset tokens now expire after a configurable period (default 1 hour). Configure via `contentServers.web.resetPassword.tokenTtlMinutes` in `config.hjson`.

  * **Web endpoint rate limiting** — per-IP sliding-window rate limits are now enforced on the password reset and 2FA/OTP registration endpoints (GET and POST), returning HTTP 429 when exceeded. Limits are configurable under `contentServers.web.rateLimits` (`pwResetGet`, `pwResetPost`, `otpRegGet`, `otpRegPost`); defaults are 5–10 requests per 10-minute window.

  * **Command injection fix** — the `oputil ssh-key` generator now passes the key passphrase as a discrete process argument rather than interpolating it into a shell string, eliminating a shell injection vector.

  * **Archive util filename injection fix** — filenames in `compressTo` are now passed as discrete arguments rather than space-joined, preventing argument injection via crafted filenames.

  * **Static file symlink escape fix** — the web server's static file resolver now dereferences symlinks via `fs.realpath` before the path boundary check, preventing a symlink placed inside `staticRoot` from escaping it.

  * **Config file security note** — see [Security](./docs/_docs/configuration/security.md) for guidance on protecting `config.hjson` (which contains secrets such as `privateKeyPass`) with appropriate file permissions.

* **Native BinkP / FTN mailer** — built-in BinkP/1.1 implementation (inbound listener + outbound caller) that integrates directly with the existing BSO scanner/tosser. No external `binkd` or cron-driven poll script required for FidoNet-style networks. Two complementary triggers replace the old single-timer model:

  * **Crashmail** — when ftn_bso writes a flow file, the destination peer is dialed within ~½ second (debounced; tunable via `crashmailDebounceMs`). No more waiting for the next scheduled tick to ship outbound.
  * **Pull schedule** — `binkp.pullSchedule` (default `every 15 minutes`) dials *every* configured peer in `binkp.nodes` regardless of pending mail, so echo mail flows in from hubs that wait for the spoke to call. Per-node opt-out via `pull: false`.
  * Configure inbound port, per-node hosts/passwords (CRAM-MD5), and the schedules under `scannerTossers.ftn_bso.binkp` in `config.hjson`.

* **Internet Mail (send & receive)** — users can now send and receive internet email directly from the BBS private message system, via a new `email` scanner/tosser module. See [Email Configuration](./docs/_docs/configuration/email.md) and [Internet Mail](./docs/_docs/messageareas/internet-mail.md).

  * **Send**: private messages addressed to `user@domain.com` are delivered through your configured SMTP transport (Nodemailer-compatible — any provider, or service shortcut like Zoho/Fastmail).
  * **Receive**: inbound email is pulled from a single IMAP mailbox (polling or `IMAP IDLE`) and routed to the local user whose name matches the To: local-part. Successfully imported messages are marked `\Seen` and optionally moved to `inbound.imap.processedFolder`. Unmatched / unparseable mail is preserved as `.eml` in `mail/email/failed/`, marked `\Seen` to prevent re-fetch loops, and optionally moved to `inbound.imap.failedFolder`. ENiGMA½ never deletes mail from your IMAP server — retention is up to you or your provider.
  * **Per-user `From:` header** — when `email.outbound.fromDomain` is set, outbound mail is sent as `"UserName" <sanitized@fromDomain>` instead of the static `defaultFrom`. The SMTP `Sender:` header and envelope `MAIL FROM` are kept as the authenticated mailbox so bounces stay deliverable and receivers display the standard "on behalf of" attribution. Local-part derivation respects `users.badUserNames` — reserved names fall back to `defaultFrom`. Replacement char for invalid username characters is configurable via `email.outbound.usernameReplaceChar` (default `_`).
  * **Signature / pipe-code stripping on export** — outbound message bodies are run through the same ANSI + MCI pipe-code stripping pipeline used by the NNTP export, so signatures render cleanly in external mail clients.

* **Wide Character (CJK/UTF-8) Support** — full-width Unicode characters (CJK ideographs, Hangul, Hiragana, Katakana, fullwidth forms) are now handled correctly throughout the view and word-wrap layers

  * All display-width measurements use `wcwidth(3)` semantics — wide characters count as 2 terminal columns, combining marks as 0
  * `EditTextView` and `MultiLineEditTextView` cursor navigation, scrolling, and line-wrap all operate on display columns rather than string indices; the cursor cannot land inside the phantom second column of a wide character
  * Word-wrap (`word_wrap.js`) and `LineBuffer` wrap at display-column boundaries — a wide character is never split across lines
  * `renderStringLength`, `ansiRenderStringLength`, and the new exported `renderSplitPos` in `string_util.js` all account for wide characters; pipe codes and ANSI cursor-forward sequences are handled correctly in both
  * `getText()` on `LineBuffer` correctly round-trips CJK text — no spurious space is inserted at character-boundary soft-wrap points

* **UTF-8 Art Variants (`.utf8ans`)** — place a `FOO.UTF8ANS` alongside `FOO.ANS` in any art or theme directory; UTF-8-capable users automatically receive the UTF-8 variant while CP437 users see the standard file. No menu or theme configuration is required — selection is automatic based on the negotiated terminal encoding. See [General Art Information](./docs/_docs/art/general.md).

  * Opt-in upward UTF-8 probe — set `term.probeUtf8Encoding: true` in `config.hjson` to enable a CPR-based check that upgrades CP437-identified terminals (e.g. `ansi`, `syncterm`) to UTF-8 output when the terminal actually supports it. Uses the same cursor-advance technique as `checkUtf8Encoding`. Default: `false`.

* Full log viewer from WFC. Defaults to `l` key.

* Major FTN compatibility fixes, especially for those wanting to run a point.

* **Newscan enhancements** — users now have direct control over their newscan experience:

  * **User-configurable scan areas** — new `configure_newscan` module (key `N` from the message base menu) lets users toggle individual message areas on or off for newscan, or toggle all at once. Selection is persisted immediately as a JSON array in the `newscan_area_tags` user property. Areas not selected are skipped entirely during the scan.

  * **Newscan floor date** — a new `newscan_min_timestamp` user property acts as a non-destructive lower bound on the scan. For each area, the effective scan start is `MAX(per-area last-read pointer, first message at floor date)`. Unlike the existing *Set Newscan Date* feature (which rewrites per-area pointers), the floor is a persistent filter that never touches read state. Set or clear it via the `G` key in the configure screen, which navigates to a floor-date entry form. The existing `set_newscan_date` module is unchanged and kept for explicit pointer repositioning.

  * **New-user backlog protection** — `newscan_min_timestamp` is automatically set to the account creation timestamp for all new accounts, so users joining a busy BBS with years of message history only see posts from their join date onward.

  * **`set_newscan_date` gains `target: floor`** — sysops can wire a menu entry that writes `newscan_min_timestamp` instead of moving per-area pointers, using the same date-input UI.

  * **Count/list consistency fix** — the new message count check and the message list passed to `msg_list` now both use the same floor-adjusted effective last-read ID, eliminating the possibility of navigating to an area that shows zero qualifying messages.

## 0.3.0-beta
Various fixes

* ActivityPub MAJOR updates have landed.

* **Server-side baud rate emulation** — `baudRate` in a menu's `config` block now throttles art display on the server rather than delegating to a SyncTERM-specific terminal escape sequence. Emulation now works with every terminal client. The previous approach was sticky (rate persisted across menus until explicitly cleared); the new approach is scoped precisely to each art display and resets automatically. Existing `baudRate` config values require no changes.

* **SQLite driver migrated to `better-sqlite3`** -- This is an internal change with no impact on existing data or configuration. Results in some major DB performance gains.

* **[Z-Machine Interactive Fiction Door](./docs/_docs/modding/local-doors-zmachine.md)** — new `zmachine_door` module runs Z-Machine IF games (Zork, Colossal Cave Adventure, Photopia, Anchorhead, Lost Pig, and hundreds more) natively in Node.js. No external emulator, no serial bridge, no drop file — a cross-platform pure-JavaScript path for text-adventure games.

  * Backed by [ifvms.js](https://github.com/curiousdannii/ifvms.js) (the Z-Machine interpreter used by Parchment) and [glkote-term](https://github.com/curiousdannii/glkote-term), run in a dedicated worker thread per session for isolation.
  * Supports Z-Machine versions 3, 4, 5, and 8 — covers all classic Infocom titles, the original Crowther/Woods Adventure port, and the vast majority of modern Inform games from the [IF Archive](https://www.ifarchive.org/).

## 0.1.1-beta

* **NNTP server improvements** -- several protocol compliance and reliability fixes:
  * Article posting now correctly detects end-of-post and handles CRLF line endings
  * `AUTHINFO USER` is now advertised in `CAPABILITIES` so clients know to authenticate before posting
  * `Xref` header is now generated, improving cross-session read tracking in NNTP clients
  * Newsgroups header parsing is more robust (null-safe, whitespace-tolerant)
  * Group message cache TTL increased from 30s to 5 minutes

## 0.1.0-beta

* **[Sysop Chat / Break Into Chat](./docs/_docs/modding/sysop-chat.md)** — real-time split-screen chat between sysop and user

  * Sysop can break into chat with any node directly from WFC (`B` key on selected node)
  * Users can page the sysop via the `pageSysop` menu entry; includes per-user rate limiting and BEL + interrupt notification to all online sysops (sysops at WFC see it directly in the node list)
  * If no sysop is available, users are offered the option to send their message as private mail instead
  * Both parties share the same `sysopChat` module with role-based panel routing (sysop messages top, user messages bottom)
  * Status line uses the standard custom-range token system (`chatInfoFormat10`, etc.) — fully themable
  * WFC node list gains a `{pageIndicator}` token per row — non-empty when that node has a pending page; configurable via `pageIndicator` in the WFC `config` block
  * WFC custom tokens `{pendingPageCount}`, `{pendingPageUser}`, `{pendingPageNode}`, `{pendingPageMessage}` for surfacing page queue state in art
  * **`prefixFormat`** property on `EditTextView` — set per-view in `theme.hjson` to display a role-specific prefix before the input (e.g. `"|15{userName}|07> "`); pipe codes render live as the user types; cursor and scroll account for the prefix width automatically

## 0.1.0-beta

* **Pause Prompt Improvements** — see [Pause Prompts](./docs/_docs/art/pause-prompts.md) for the full reference

  * `pause: pageBreak` — art is paginated and displayed screen-by-screen with a prompt between pages; detects absolute-positioning ANSI and falls back to single-page display automatically
  * `pause: '<promptId>'` — shorthand: end-mode pause using the named prompt; equivalent to `pause: true` + `pausePrompt: <promptId>`
  * `pausePrompt` — per-menu override of the prompt name used for end-of-art and/or page-break pauses; accepts a string (same prompt for both) or `{ end, page }` object for independent control
  * `pausePosition` — per-menu `{ row, col }` override to force the pause prompt to a specific screen position
  * `continuousKey` / `quitKey` — configurable keys on the `pausePage` prompt to skip remaining page breaks or abort all remaining pages entirely
  * `pausePage` system prompt — add this alongside `pause` in your `prompts` block to customise page-break behavior; supports all MCI views including `%TK` (TickerView) for animated instructions
  * Pipe color codes in TickerView `text` are now preserved across all non-dynamic motion styles (`bounce`, `reveal`, `typewriter`, `fallLeft`/`fallRight`) — color survives scrolling
  * *Module developers:* `displayThemedPause` / `displayThemedPrompt` (when `pause: true`) callbacks now receive a third argument `pressedKey: { ch, key }`. Existing callers that ignore extra arguments are unaffected.

* **New MCI View Types**

  * **[TickerView](./docs/_docs/art/views/ticker_view.md) (`%TK`)** — animated single-line marquee with a two-axis model; works in any context including pause prompts (see above):
    * **Motion styles**: `left`, `right`, `bounce`, `reveal`, `typewriter`, `fallLeft`, `fallRight`
      * `fallLeft`/`fallRight`: characters spread across the window with increasing inter-char gaps toward the source edge, then all slide at 1 col/tick and stack against the target edge — a "stack of bricks" effect
    * **Effects**: text-style effects (`upper`, `lower`, `title`, `l33t`, `mixed`, and more) baked at set-time; dynamic per-tick effects (`rainbow`, `scramble`, `glitch`)
    * Text-style and dynamic effects are independent axes and can be freely combined (e.g. `l33t` + `rainbow`)
    * `scramble` renders each character's noise in its own pipe color with reverse-video; `glitch` uses `styleSGR2` for corruption color
    * Redraw optimization: ticks where the rendered output hasn't changed (e.g. `bounce` at rest, hold phases) are skipped entirely — no unnecessary cursor movement
    * All configuration via `mci` block in `menu.hjson` / `theme.hjson` — no inline MCI args needed
    * `destroy()` clears timers; view teardown in `ViewController` now calls `destroy()` on all views, fixing timers surviving menu transitions
  * **[StatusBarView](./docs/_docs/art/views/status_bar_view.md) (`%SB`)** — single-line view with two modes:
    * **Single mode**: auto-refreshing text label that re-renders a format template on a configurable `refreshInterval`; skips redraws when text hasn't changed
    * **Panel mode** (`panels` array): divides the view into independently-addressable named slots, each with its own width, alignment, color, fill character, and optional auto-refresh template. Panels are updated from code via `setPanel(name, value)` / `setPanels(updates)` without touching adjacent slots. A panel's `text` property (without `refreshInterval`) sets a static initial value evaluated once at init — useful for fixed label prefixes configured entirely from `menu.hjson`.
  * **FSE editor footer** now uses a single `%SB1` in panel mode (replacing the old separate `%TL1`/`%TL2` views) — displays cursor position and INS/OVR mode side-by-side, updated live as the cursor moves. See [UPGRADE](UPGRADE.md) if you have custom FSE art or menu config.

* **View System Modernization**

  * Converted the entire view system from `util.inherits`/prototype patterns to **ES6 classes**: `View`, `TextView`, `EditTextView`, `MaskEditTextView`, `ButtonView`, `MenuView`, `HorizontalMenuView`, `VerticalMenuView`, `FullMenuView`, `ToggleMenuView`, `SpinnerMenuView`, `MultiLineEditTextView`, `ViewController`
  * Numerous bug fixes applied during conversion (position defaults, SGR field aliasing, `key_entry_view.js` boolean logic, `color_codes.js` WWIV/CNET capture groups, `horizontal_menu_view.js` height, `multi_line_edit_text_view.js` `tabStops` binding)
  * New **[LineBuffer](./core/line_buffer.js)** — isolated, view-dependency-free line storage using `Uint32` per-character attribute words (fg, bg, bold, blink, underline, italic, strikethrough, color source, true-color flags); soft/hard EOL tracking; word-boundary wrap with character-break fallback
  * **EditTextView** and **MaskEditTextView** are now backed by `LineBuffer`: cursor-aware insert/delete at any position, left/right/home/end movement with scroll-window tracking, forward-delete, fixed partial-fill `getData()` bug in `MaskEditTextView`
  * **`client_term.js`**: `beginWrite()` / `commitWrite()` with nesting support — all writes within a keypress or focus switch are buffered and flushed as a single socket write, eliminating intermediate cursor flicker in terminals

* **`oputil user` SSH Key Management**

  * `oputil.js user import-ssh-key USERNAME KEYFILE` — imports a SSH public key for a user from a file, validates the key, and stores it for SSH key-based login
  * `oputil.js user remove-ssh-key USERNAME` — removes a user's stored SSH public key
  * `oputil.js user info USERNAME` now displays SSH key info (algorithm, SHA256 fingerprint, comment) when a key is on file

* **File Base: Wildcard/Recursive Storage Tags** ([#194](https://github.com/NuSkooler/enigma-bbs/issues/194))

  Appending `/*` to a storage tag path enables recursive scanning of all subdirectories:

  ```hjson
  storageTags: {
      scene_files: "/path/to/scene/*"   // walks all subdirs
  }
  ```

  * Files found in subdirectories are indexed with their `relPath` (e.g. `2024/April`) stored in the database, so same-named files in different subdirectories are tracked as distinct entries.
  * When an area mixes flat and wildcard tags, flat tags are scanned first and their directories are excluded from wildcard scans to prevent double-indexing.
  * `.enigmaignore` files (gitignore syntax) can be placed anywhere in a wildcard tree to exclude files or directories from scanning.
  * Startup warns on malformed wildcard patterns (e.g. a bare `*` not at the trailing `/*` position).
  * New database column `storage_tag_rel_path`; automatically added to existing installations on first startup.

* **Bug Fixes & Stability**

  * Fixed ENiGMA segfault on ARM64 Linux (Raspberry Pi) — see [#620](https://github.com/NuSkooler/enigma-bbs/issues/620)
  * Improved `install.sh`: better distutils availability check ([#631](https://github.com/NuSkooler/enigma-bbs/issues/631)), additional script improvements

## 0.0.14-beta

* **ActivityPub & Mastodon Support (Experimental)**

  * A new [ActivityPub Web Handler](./docs/_docs/servers/contentservers/activitypub-handler.md) has been added.
  * ⚠️ **WARNING**: ActivityPub is **disabled by default**. There may be **security implications**, federation may be **unstable**, and some parts may not work yet. **Use at your own risk!**
  * Provides groundwork for federated features: WebFinger discovery, NodeInfo2, actor profiles/avatars, inbox/outbox/shared inbox, and handling of common ActivityPub object types (`Note`, `Accept`, `Undo`, followers/following).
  * **WebFinger** and **NodeInfo2** handlers are also disabled by default. These may be useful for inter-BBS or other integrations, but note: WebFinger may still “advertise” ActivityPub endpoints even if AP itself is off.
  * Cool new functionality arrives with or without AP enabled:

    * **PNG Avatars**: users now get avatars (including **auto-generated defaults**) that can be served via the web frontend.
    * Message editor and timeline improvements:

      * Recognition of `@user@domain` addressing (Fediverse general)
      * Unicode → ASCII transliteration for federated messages (via AnyAscii). ...but we can use it for any <-> web!
    * **Better routing** for web handlers and `.well-known` paths.
    * **Dedicated web logging** under `contentHandlers.web.logging`.
    * TONS of fixes and improvements to the code base

    The fate of full ActivityPub support in ENiGMA is till up in the air...

* **[Web Server](/docs/_docs/servers/contentservers/web-server.md) Changes** (⚠️ some may be breaking):

  * `/static/` prefixes are no longer required (ugly hack removed).
  * Internal routes (e.g. password reset) now live under `/_enig/`.
  * File base routes now default to `/_f/` instead of `/f/`. If your `config.hjson` still uses `/f/`, update it.
  * The system will now search for `index.html` then `index.htm` if a suitable route cannot be found.
  * [Web Handler](/docs/_docs/servers/contentservers/web-handlers.md) modules are now easier to add; several exist by default.

* **Other Additions & Changes**

  * New users now have randomly generated avatars assigned (served via System General [Web Handler](/docs/_docs/servers/contentservers/web-handlers.md)).
  * CombatNet has shut down; the module (`combatnet.js`) has been removed.
  * New `NewUserPrePersist` system event available for developers to hook into account creation.
  * `viewValidationListener` callback signature has changed: now `(err, newFocusId)`. To ignore a validation error, call with `null` for `err`.
  * The Menu Flag `popParent` has been removed; `noHistory` has been updated to work as expected. See [UPGRADE](UPGRADE.md).
  * Various New User Application (NUA) properties are now optional. Remove optional fields from NUA artwork if you wish to collect less information (stored as empty string). Optional properties: Real name, Birth date, Sex, Location, Affiliations (Affils), Email, Web address.
  * Art handling now respects art width from SAUCE metadata when terminal width is greater, fixing display issues on wide UTF-8 terminals.

## 0.0.13-beta
* **Note for contributors**: ENiGMA has switched to [Prettier](https://prettier.io) for formatting/style. Please see [CONTRIBUTING](CONTRIBUTING.md) and the Prettier website for more information.
* Removed terminal `cursor position reports` from most locations in the code. This should greatly increase the number of terminal programs that work with Enigma 1/2. For more information, see [Issue #222](https://github.com/NuSkooler/enigma-bbs/issues/222). This may also resolve other issues, such as [Issue #365](https://github.com/NuSkooler/enigma-bbs/issues/365), and [Issue #320](https://github.com/NuSkooler/enigma-bbs/issues/320). Anyone that previously had terminal incompatibilities please re-check and let us know!
* Bumped up the minimum [Node.js](https://nodejs.org/en/) version to v14. This will allow more expressive Javascript programming syntax with ECMAScript 2020 to improve the development experience.
* **New Waiting For Caller (WFC)** support via the `wfc.js` module.
* Added new configuration options for `term.checkUtf8Encoding`, `term.checkAnsiHomePosition`, `term.cp437TermList`, and `term.utf8TermList`. More information on these options is available in [UPGRADE](UPGRADE.md).
* Many new system statistics available via the StatLog such as current and average load, memory, etc.
* Many new MCI codes: `MB`, `MF`, `LA`, `CL`, `UU`, `FT`, `DD`, `FB`, `DB`, `LC`, `LT`, `LD`, and more. See [MCI](./docs/art/mci.md).
* SyncTERM style font support detection.
* Added a system method to support setting the client encoding from menus, `@systemMethod:setClientEncoding`.
* Many additional backward-compatible bug fixes since the first release of 0.0.12-beta. See the [project repository](https://github.com/NuSkooler/enigma-bbs) for more information.
* Deprecated Gopher's `messageConferences` configuration key in favor of a easier to deal with `exposedConfAreas` allowing wildcards and exclusions. See [Gopher](./docs/servers/contentservers/gopher.md).
* NNTP write (aka POST) access support for authenticated users over TLS.
* [Advanced MCI formatting](./docs/art/mci.md#mci-formatting)!
* Additional options in the `abracadabra` module for launching doors. See [Local Doors](./docs/modding/local-doors.md)

## 0.0.12-beta
* The `master` branch has become mainline. What this means to users is `git pull` will always give you the latest and greatest. Make sure to read [Upgrading](./docs/admin/upgrading.md) and keep an eye on `WHATSNEW.md` (this file) and [UPGRADE](UPGRADE.md)! See also [ticket #276](https://github.com/NuSkooler/enigma-bbs/issues/276).
* Development now occurs against [Node.js 14 LTS](https://github.com/nodejs/node/blob/master/doc/changelogs/CHANGELOG_V14.md).
* The default configuration has been moved to [config_default.js](/core/config_default.js).
* A full configuration revamp has taken place. Configuration files such as `config.hjson`, `menu.hjson`, and `theme.hjson` can now utilize includes via the `includes` directive, reference 'self' sections using `@reference:` and import environment variables with `@environment`.
* An explicit prompt file previously specified by `general.promptFile` in `config.hjson` is no longer necessary. Instead, this now simply part of the `prompts` section in `menu.hjson`. The default setup still creates a separate prompt HJSON file, but it is `includes`ed in `menu.hjson`. With the removal of prompts the `PromptsChanged` event will no longer be fired.
* New `PV` ACS check for arbitrary user properties. See [ACS](./docs/configuration/acs.md) for details.
* The `message` arg used by `msg_list` has been deprecated. Please starting using `messageIndex` for this purpose. Support for `message` will be removed in the future.
* A number of new MCI codes (see [MCI](./docs/art/mci.md))
* Added ability to export/download messages. This is enabled in the default menu. See `messageAreaViewPost` in [the default message base template](./misc/menu_templates/message_base.in.hjson) and look for the download options (`@method:addToDownloadQueue`, etc.) for details on adding to your system!
* The Gopher server has had a revamp! Standard `gophermap` files are now served along with any other content you configure for your Gopher Hole! A default [gophermap](https://en.wikipedia.org/wiki/Gopher_(protocol)#Source_code_of_a_menu) can be found [in the misc directory](./misc/gophermap) that behaves like the previous implementation. See [Gopher docs](./docs/servers/gopher.md) for more information.
* Default file browser up/down/pageUp/pageDown scrolls description (e.g. FILE_ID.DIZ). If you want to expose this on an existing system see the `fileBaseListEntries` in the default `file_base.in.hjson` template.
* File base search has had an improvement to search term handling.
* `./oputil user group -group` to now accepts `~group` removing the need for special handling of the "-" character. #331
* A fix has been made to clean up old `file.db` entries when a file is removed. Previously stale records could be left or even recycled into new entries. Please see [UPGRADE.md](UPGRADE.md) for details on applying this fix (look for `tables_update_2020-11-29.sql`).
* The [./docs/modding/onelinerz.md](onelinerz) module can have `dbSuffix` set in it's `config` block to specify a separate DB file. For example to use as a requests list.
* Default hash tags can now be set in file areas. Simply supply an array or list of values in a file area block via `hashTags`.
* Added ability to pass an `env` value (map) to `abracadabra` doors. See [Local Doors](./docs/modding/local-doors.md]).
* `dropFileType` is now optional when launching doors with `abracadabra`. It can also be explicitly set to `none`.
* FSE in *view* mode can now stylize quote indicators. Supply `quoteStyleLevel1` in the `config` block. This can be a single string or an array of two strings (one to style the quotee's initials, the next for the '>' character, and finally the quoted text). See the `messageAreaViewPost` menu `config` block in the default `luciano_blocktronics` `theme.hjson` file for an example. An additional level style (e.g. for nested quotes) may be added in the future.
* FSE in *view* mode can now stylize tear lines and origin lines via `tearLineStyle` and `originStyle` `config` values in the same manor as `quoteStyleLevel`.

## 0.0.11-beta
* Upgraded from `alpha` to `beta` -- The software is far along and mature enough at this point!
* Development is now against Node.js 12.x LTS. Other versions may work but are not currently supported!
* [QWK support](./docs/messageareas/qwk.md)
* `oputil fb scan *areaTagWildcard*` scans all areas in which wildcard is matched.
* The archiver configuration `escapeTelnet` has been renamed `escapeIACs`. Support for the old value will be removed in the future.

## 0.0.10-alpha
+ `oputil.js user rename USERNAME NEWNAME`
+ `my_messages.js` module (defaulted to "m" at the message menu) to list public messages addressed to the currently logged in user. Takes into account their username and `real_name` property.
+ SSH Public Key Authentication has been added. The system uses a OpenSSH style public key set on the `ssh_public_key` user property.
+ 2-Factor (2FA) authentication is now available using [RFC-4266 - HOTP: HMAC-Based One-Time Password Algorithm)](https://tools.ietf.org/html/rfc4226), [RFC-6238 - TOTP: Time-Based One-Time Password Algorithm](https://tools.ietf.org/html/rfc6238), or [Google Authenticator](http://google-authenticator.com/). QR codes for activation are available as well. One-time backup aka recovery codes can also be used. See [Security](./docs/configuration/security.md) for more info!
* New ACS codes for new 2FA/OTP: `AR` and `AF`. See [ACS](./docs/configuration/acs.md) for details.
+ `oputil.js user 2fa USERNAME TYPE` enables 2-factor authentication for a user.
* `oputil.js user info USERNAME --security` can now display additional security information such as 2FA/OTP.
* `oputil.js fb scan --quick` is now the default. Override with `--full`.
* ACS checks can now be applied to form actions. For example:
```hjson
{
    value: { command: "SEC" }
    action: [
        {
            //  secure connections can go here
            acs: SC
            action: @menu:securityMenu
        }
        {
            //  non-secure connections
            action: @menu:secureConnectionRequired
        }
    ]
}
```
* `idleLogoutSeconds` and `preAuthIdleLogoutSeconds` can now be set to `0` to fully disable the idle monitor.
* Switched default archive handler for zip files from 7zip to InfoZip (`zip` and `unzip`) commands. See [UPGRADE](UPGRADE.md).
* Menu submit `action`'s can now in addition to being a simple string such as `@menu:someMenu`, or an array of objects with ACS checks, be a simple array of strings. In this case, a random match will be made. For example:
```hjson
submit: [
    {
        value: { command: "FOO" }
        action: [
            // one of the following actions will be matched:
            "@menu:menuStyle1"
            "@menu:menuStyle2"
        ]
    }
]
```
* Added `read` (list/view) and `write` (post) ACS support to message conferences and areas.
* Many new built in modules adding support for things like auto signatures, listing "my" messages, top stats, etc. Take a look in the docs for setting them up!
* Built in MRC support!
* Added an customizable achievement system!


## 0.0.9-alpha
* Development is now against Node.js 10.x LTS. While other Node.js series may continue to work, you're own your own and YMMV!
* Fixed `justify` properties: `left` and `right` values were formerly swapped (oops!)
* Menu items can now be arrays of *objects* not just arrays of strings.
  * The properties `itemFormat` and `focusItemFormat` allow you to supply the string format for items. For example if a menu object is `{ "userName" : "Bob", "age" : 35 }`, a `itemFormat` might be `|04{userName} |08- |14{age}`.
  * If no `itemFormat` is supplied, the default formatter is `{text}`.
  * Setting the `data` member of an object will cause form submissions to use this value instead of the selected items index.
  * See the default `luciano_blocktronics` `matrix` menu for example usage.
* You can now set the `sort` property on a menu to sort items. If `true` items are sorted by `text`. If the value is a string, it represents the key in menu objects to sort by.
* Hot-reload of configuration files such as menu.hjson, config.hjson, your themes.hjson, etc.: When a file is saved, it will be hot-reloaded into the running system
  * Note that any custom modules should make use of the new Config.get() method.
* The old concept of `autoScale` has been removed. See https://github.com/NuSkooler/enigma-bbs/issues/166
* Ability to delete from personal mailbox (finally!)
* Add ability to skip file and/or message areas during newscan. Set config.omitFileAreaTags and config.omitMessageAreaTags in new_scan configuration of your menu.hjson
* `{userName}` (sanitized) and `{userNameRaw}` as well as `{cwd}` have been added to param options when launching a door.
* Any module may now register for a system startup initialization via the `initializeModules(initInfo, cb)` export.
* User event log is now functional. Various events a user performs will be persisted to the `system.sqlite3` `user_event_log` table for up to 90 days. An example usage can be found in the updated `last_callers` module where events are turned into Ami/X style actions. Please see `UPGRADE.md`!
* New MCI codes including general purpose movement codes. See [MCI codes](docs/art/mci.md)
* `install.sh` will now attempt to use NPM's `--build-from-source` option when ARM is detected.
* `oputil.js config new` will now generate a much more complete configuration file with comments, examples, etc. `oputil.js config cat` dumps your current config to stdout.
* Handling of failed login attempts is now fully in. Disconnect clients, lock out accounts, ability to auto or unlock at (email-driven) password reset, etc. See `users.failedLogin` in `config.hjson`.
* NNTP support! See [NNTP docs](./docs/servers/nntp.md) for more information.
* `oputil.js user rm` and `oputil.js user info` are in! See [oputil CLI](./docs/admin/oputil.md).
* Performing a file scan/import using `oputil.js fb scan` now recognizes various `FILES.BBS` formats.
* Usernames found in the `config.users.badUserNames` are now not only disallowed from applying, but disconnected at any login attempt.
* Total minutes online is now tracked for users. Of course, it only starts after you get the update :)
* Form entries in `menu.hjson` can now be omitted from submission handlers using `omit: true`

## 0.0.8-alpha
* [Mystic BBS style](http://wiki.mysticbbs.com/doku.php?id=displaycodes) extended pipe color codes. These allow for example, to set "iCE" background colors.
* File descriptions (FILE_ID.DIZ, etc.) now support Renegade |## pipe, PCBoard, and other less common color codes found commonly in BBS era scene releases.
* New menu stack flags: `noHistory` now works as expected, and a new addition of `popParent`. See the default `menu.hjson` for usage.
* File structure changes making ENiGMA½ much easier to maintain and run in Docker. Thanks to RiPuk ([Dave Stephens](https://github.com/davestephens))! See [UPGRADE.md](UPGRADE.md) for details.
* Switch to pure JS [xxhash](https://github.com/mscdex/node-xxhash) instead of farmhash. Too many issues on ARM and other less popular CPUs with farmhash ([Dave Stephens](https://github.com/davestephens))
* Native [CombatNet](http://combatnet.us/) support! ([Dave Stephens](https://github.com/davestephens))
* Fix various issues with legacy DOS Telnet terminals. Note that some may still have issues with extensive CPR usage by ENiGMA½ that will be addressed in a future release.
* Added web (http://, https://) based download manager including batch downloads. Clickable links if using [VTXClient](https://github.com/codewar65/VTX_ClientServer)!
* General VTX hyperlink support for web links
* DEL vs Backspace key differences in FSE
* Correctly parse oddball `INTL`, `TOPT`, `FMPT`, `Via`, etc. FTN kludge lines
* NetMail support! You can now send and receive NetMail. To send a NetMail address a external user using `Name <address>` format from your personal email menu. For example, `Foo Bar <123:123/123>`. The system also detects other formats such asa `Name @ address` (`Foo Bar@123:123/123`)
* `oputil.js`: Added `mb areafix` command to quickly send AreaFix messages from the command line. You can manually send them from personal mail as well.
* `oputil.js fb rm|remove|del|delete` functionality to remove file base entries.
* `oputil.js fb desc` for setting/updating a file entry description.
* Users can now (re)set File and Message base pointers
* Add `--update` option to `oputil.js fb scan`
* Fix @watch path support for event scheduler including FTN, e.g. when looking for a `toss!.now` file produced by Binkd.

...LOTS more!

## Pre 0.0.8-alpha
See GitHub
