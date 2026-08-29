# Introduction
This document covers information for keeping your system updated through periodic upgrades as well as version-to-version upgrade notes. **Be sure to read these notes for _any_ upgrade!**

# Before Upgrading
1. Always back up your system! (See [Administration - Backing Up Your System](./docs/_docs/admin/administration.md#backing-up-your-system))
2. Seriously, always back up your system!
3. Review the version to version release notes within this document.
4. [Upgrade](./docs/_docs/admin/upgrading.md)

# The Upgrade Process
ENiGMA½ does not currently have much of a "release process" in that instead, it is expected that if you want new features, you will `git pull` them to your system.

Refer to [Upgrading](./docs/_docs/admin/upgrading.md) for details around this process.

# Problems
1. Check [TROUBLESHOOTING](TROUBLESHOOTING.md) first.
2. Report your issue on [Xibalba BBS](https://xibalba.l33t.codes), or [file a issue on GitHub](https://github.com/NuSkooler/enigma-bbs/issues)!


# Version to Version Notes
> :warning: Be sure to inspect these notes during any upgrades!

## 0.5.0-beta to 0.5.1-beta

* **A TIC whose file has not arrived yet is now held instead of rejected** ([#735](https://github.com/NuSkooler/enigma-bbs/issues/735)). A `.tic` and the file it announces routinely arrive in *separate* mailer sessions, minutes or hours apart. Until now the announcement was processed the instant it landed, failed because the file was not there, and was archived to `paths.reject` — so when the file did arrive there was nothing left to pair it with, and it sat in the inbound forever. For a large file from a given peer this could fail every single time. Such a TIC is now kept and retried on later import passes, bounded by the new `scannerTossers.ftn_bso.tic.holdMaxAgeMs` (default 48 hours; `0` holds indefinitely). **No action is required.**

  **Check your inbound for files this already stranded.** Anything in `mail/ftn_secin/` (or `mail/ftn_in/`) that is not a `.pkt`, a bundle or a `.tic` is very likely an orphaned TIC payload. The matching announcement is in `mail/reject/` as `reject-tic--<timestamp>-<name>.tic`; the simplest recovery is to move *both* back into the secure inbound and let the next import pass pick them up, now that the pairing works. Re-announcement by the peer is not needed.

  Three related changes ride along, none of which need configuration:

  * **The announced filename is now matched case-insensitively.** A TIC naming `NODELIST.Z34` finds a delivered `nodelist.z34`, which on a case-sensitive filesystem it previously never did. This alone could account for a file that "never once imported".
  * **A file still being written is no longer destroyed.** A payload shorter than the TIC's `Size`, or one failing its CRC, used to be archived as a reject and unlinked — which, with a mailer that writes straight into the inbound, could delete a transfer in progress. It is now held and re-checked, and only given up on once the hold expires.
  * **The TIC password is compared without regard to case**, matching what other FTN software does and what ENiGMA½ already did for packet passwords. A TIC previously refused purely over case will now be accepted.

* **`scannerTossers.ftn_bso.tic.secureInOnly` is now enforced** ([#735](https://github.com/NuSkooler/enigma-bbs/issues/735)). It has been documented and defaulted to `true` since TIC support landed, but was never actually read: TIC files in the **unsecure** inbound were imported into the file base on the strength of an unauthenticated `From` line alone. They are now ignored — left in place, neither imported nor deleted — and the fact is logged once.

  **Action:** only if you deliberately accept TICs from the unsecure inbound. Set `tic.secureInOnly` to `false` to keep that behaviour. Note that doing so accepts files from any node matching your `nodes` configuration without the peer having authenticated, so prefer a `tic.password` if you go this route.

* **NetMail no longer needs a `netMail.routes` entry to reach a node you have already configured** ([#739](https://github.com/NuSkooler/enigma-bbs/issues/739)). A destination listed in `scannerTossers.ftn_bso.nodes` is now delivered direct; routes are still consulted first and behave exactly as before, so **no action is required** and every existing configuration resolves identically.

  **Two cases do get stricter**, both of which previously "succeeded" into a dead end:

  * NetMail addressed to **your own** FTN address used to be accepted and filed into your own outbound, where nothing would ever send it. It is now refused unless you list your own address in `nodes`, and the sender is told.
  * A route whose `network` names something not in `messageNetworks.ftn.networks` is refused when the route is chosen, rather than a step later with an error about the network. The message is the same failure either way; only the wording and timing change.

  Worth a look if you have more than one network in the **same zone**: with no `network` named on the route or the node, the zone alone cannot tell them apart and the tie goes to `defaultNetwork`. Add `network` to the `nodes` entry to be explicit — the wrong choice means mail sent from the wrong address.

* **Cross-zone routed NetMail queued before this release will not have been delivered, and needs moving by hand** ([#734](https://github.com/NuSkooler/enigma-bbs/issues/734)). NetMail routed through an uplink in a zone other than the recipient's was filed in the outbound directory for the *recipient's* zone rather than the uplink's, where no mailer would ever find it. The fix applies to newly exported mail only -- it does not relocate what is already queued.

  **Action:** only if you route NetMail across zones. Look for a zone-suffixed outbound directory that should not hold mail for that uplink -- for a `1:154/10` uplink carrying zone 2 mail, that is `outbound.002/009a000a.*` (`009a` = net 154, `000a` = node 10) plus the `.pkt` files its flow file names. Move both the flow file and the packets into the uplink's own outbound directory (`outbound/` when the uplink is in your network's default zone). **The stored paths inside the flow file do not need editing** -- a reference that no longer resolves is now also looked for by name in the flow file's own directory. If you would rather not sort it out, deleting the stray directory's contents loses the affected messages and nothing else.

  Two related changes are worth knowing about even if none of this applies to you: a flow file entry whose file is missing is now logged rather than silently skipped, and a node whose entries all point at missing files is no longer reported as having pending mail -- so it stops being dialled every poll cycle with nothing to send.

* **The most specific `nodes{}` and NetMail `routes{}` pattern now wins, rather than the first one written.** Where only one pattern matched an address nothing changes. Where several matched, the entry that applied used to depend on the order of your `config.hjson`.

  **Action:** review your configuration if it mixes a wildcard with more specific entries that also match. Two cases change behaviour, both towards what the specific entry says: a `"21:*"` node block written above `"21:1/100"` no longer shadows that node's own settings -- including `packetPassword`, which means a packet password you configured and believed to be in force may only now start being enforced -- and a `"*"` NetMail route written above `"21:*"` no longer claims mail the narrower route was meant to take.

  **The same rule can also relax a packet password, so check this direction too.** A matching entry is used whole; its fields are not merged with those of the wildcard it beat. So where the wildcard carries the password and the specific entry does not:

  ````hjson
  nodes: {
      "21:*"     : { packetPassword: MUHPA55 }
      "21:1/100" : { archiveType: ZIP }        //  no packetPassword
  }
  ````

  packets from `21:1/100` used to be password checked by way of the wildcard and now are not, because the specific entry wins and sets no password. If any of your specific node blocks omit a `packetPassword` that a broader entry supplies, add it to them.

* **The `download` file area ACS is now actually enforced.** It previously applied only to the REST API; over telnet and SSH any user who could browse an area could also download from it. If you set a `download` ACS on any file area expecting it to restrict downloads, **it was not doing so until now**.

  **Action:** review your `fileBase.areas` ACS blocks. Areas with no `download` ACS are unaffected -- the default (`GM[users]`) matches the `read` default, so nothing changes for them. Areas where you *did* set `download` will now restrict downloads to what you configured, which may be tighter than what users have actually been getting. Note that an entry whose area is no longer in `config.hjson` fails closed and can no longer be downloaded.

* **Automatic message area creation is available, and off** ([#241](https://github.com/NuSkooler/enigma-bbs/issues/241)). EchoMail for an FTN area tag you have not configured can now create that area instead of being skipped and lost. **No action is required**: with no `autoAreas` block in your configuration nothing changes, and with no network enabled the feature does no work at all.

  **If you want it**, run `./oputil.js mb auto-areas init` once and then add an `autoAreas` block per network — see [FTN](./docs/_docs/messageareas/ftn.md#automatic-area-creation). Two things are worth knowing before you turn it on:

  * The `init` command adds `auto-areas.hjson` to `includes` in your `config.hjson`. **Do not remove that file while it is still listed** — a file listed in `includes` that does not exist stops the board from starting. To back the feature out, remove the `includes` entry first, then the file.
  * Created areas are **read-only by design**: no `uplinks`, so nothing exports, plus a write-deny `acs` so nothing can be posted into them. If you want to actually link one, define it in your own `config.hjson` with `uplinks` and your own `acs` — `config.hjson` wins over the generated file, so you do not need to edit or remove anything there.

  Turning it on adds a read-only scan of your inbound directories at the start of each import cycle. For loose `.pkt` files that is a second parse; for bundles it is a second extraction, since the import removes each bundle as it finishes with it. Neither happens while the feature is off.

* **`oputil mb import-areas` is stricter about what it will import** ([#733](https://github.com/NuSkooler/enigma-bbs/issues/733)). It previously imported `;` and `%` comment lines as message areas, and imported a FILEBONE *file* echo list — which most networks ship named `*.na`, alongside their message list — as a set of areas all tagged `Area`. It now works the format out from the file's content.

  **Action:** if you have imported a `.na` file in the past, check `config.hjson` for areas tagged `;`, `%` or `Area` and remove them. Going forward, three things that used to "succeed" now stop with an explanation instead:

  * A FILEBONE list is refused and points you at `oputil.js fb import-areas`.
  * A list with the columns reversed (description first, tag last) is refused — SpookNet ships one, and the old parser accepted 35 nonsense areas from it.
  * A file in no recognised format is refused rather than half-imported.

  Lines that are skipped for their own reasons are now listed before the confirmation prompt. `AREAS.BBS` handling is unchanged.

  `oputil fb import-areas` shares the same parser. FileGate `.ZXX` and FILEBONE `.NA` files import exactly as before — verified byte for byte against real network packs — and a file echo list shipped as a plain `TAG  Description` list now imports rather than reporting "Nothing to import". **Be aware** that a plain list looks identical to a *message* echo list; `import-areas` warns before the confirmation prompt, so read the area listing before answering yes, especially with `--create-dirs`.

* **A port conflict now stops startup instead of being ignored** ([#547](https://github.com/NuSkooler/enigma-bbs/issues/547)). Previously a server that could not bind its port left the startup sequence hanging with no message and no exit; NNTP specifically logged a warning and carried on, so the board ran with NNTP silently absent. Bind failures are now reported on the console and are **fatal for every server**, and ENiGMA½ exits with a non-zero status.

  **Action:** if you run NNTP, Gopher, or the web server on a port something else on the host also uses, a start that previously "worked" (minus that service) will now stop with an explicit error. Fix the conflicting port in `config.hjson`, or disable the service with `enabled: false`.

* **BinkP sessions were left to time out rather than closing cleanly.** ENiGMA½ ended after the first binkp/1.1 batch, so the peer waited for an `M_EOB` that never arrived. Mail transferred correctly, but the remote logged the session as failed, and while ours sat waiting it held that node's lock — so crashmail queued for the node during the window was skipped until the next scheduled poll. **No action is required**; if a peer has been reporting failed sessions with your system despite the mail arriving, this is why.

* **BinkP files compressed with GZ were rejected by every other mailer** ([#723](https://github.com/NuSkooler/enigma-bbs/issues/723)). ENiGMA½ wrapped compressed data in the gzip container where [FTS-1029](http://ftsc.org/docs/fts-1029.001) — and binkd, Mystic and the rest — use the zlib one. The receiving mailer rejected the stream immediately; our side logged nothing and re-sent the file on every poll. **Nothing was lost** and **no configuration change is required**: the affected files stayed in the outbound spool and go out on the next poll.

  Only nodes with no `archiveType` were affected, since ArcMail bundles are already compressed and never carried GZ.

  **If you peer with a system still running a pre-fix ENiGMA½**, be aware the incompatibility is now reversed in that one direction: they cannot decode what we send, though we can decode what they send. Either coordinate the update, or disable compression for that node until they do:

  ```hjson
  nodes: {
      "21:1/100": {
          host: "bbs.example.com"
          gz: false
      }
  }
  ```

  Only an explicit `false` disables it. A failed decompression is also no longer fatal: ENiGMA½ asks for the file again uncompressed (an `NZ` request, per FTS-1029) and skips it rather than stalling if that does not work either.

* **BinkP sessions hung to the five minute timeout against peers using NR mode** ([#724](https://github.com/NuSkooler/enigma-bbs/issues/724)). If a peer asked for non-reliable mode, ENiGMA½ offered each file correctly but then sent its data without the `M_FILE` that [FTS-1026](http://ftsc.org/docs/fts-1026.001) requires after an `M_GET`. A conforming receiver had already closed the file and discarded the bytes without complaint, so both sides waited until the session timed out. **Nothing was lost** — the affected files stayed in the outbound spool and will go out on the next poll. **No configuration change is required.**

  binkd asks for NR mode whenever a sysop has set `-nr` **or** `-nd` on your node, which is why this could appear against one peer and not another regardless of version.

  One behaviour change worth knowing about: ENiGMA½ no longer asks peers to send *to it* in NR mode by default. That request costs a round trip per file, and FTS-1028 is explicit that it "should be used only if absolutely necessary" — binkd likewise only asks when configured to. If you peer over a link that drops often enough that restarting transfers from zero is a real cost, opt back in for that node:

  ```hjson
  nodes: {
      "21:1/100": {
          host: "bbs.example.com"
          requestNR: true
      }
  }
  ```

  Honouring a peer that asks *us* for NR mode is unconditional and needs no configuration, as the spec requires.

* **EchoMail exported to a node with no `archiveType` was silently never delivered** ([#722](https://github.com/NuSkooler/enigma-bbs/issues/722)). A node with no `archiveType` configured exports bare packets instead of ArcMail bundles, and those were written to the outbound spool with a malformed name — the dot before the extension was missing (`43792ae5cut` rather than `43792ae5.cut`). No mailer could match such a file, so the message stayed in the spool indefinitely with no error at any log level. This is fixed; un-archived packets now ship as flow file references like everything else, and **no configuration change is required**. Setting `archiveType` is no longer a workaround for anything, though it is still recommended for bandwidth.

  **Action required if you run a node without `archiveType`:** stranded files are not migrated automatically, because their names carry no destination address. Find them:

  ```bash
  #  the malformed direct-attach names
  find mail/ftn_out -type f -regextype posix-extended \
      -regex '.*/[0-9a-fA-F]{8}(out|cut|iut|hut|dut)' -print

  #  and, if you use fileCase: 'upper', names where the temp extension was never stripped
  find mail/ftn_out -type f -iname '*.pk_*' -print
  ```

  Each one is a complete FTS-0001 packet. The directory it sits in identifies the network and zone, and the destination net/node is in the packet header — normally just the uplink that area exports to, but you can read it directly:

  ```bash
  node -e 'const b = require("fs").readFileSync(process.argv[1]);
           console.log(`dest = ${b.readUInt16LE(22)}/${b.readUInt16LE(2)}`)' \
      mail/ftn_out/outbound/43792ae5cut
  ```

  To deliver one, give it a `.pkt` extension and reference it from that node's flow file, whose name is 4 hex digits of the destination net followed by 4 of its node:

  ```bash
  mv mail/ftn_out/outbound/43792ae5cut mail/ftn_out/outbound/43792ae5.pkt
  echo "^$(pwd)/mail/ftn_out/outbound/43792ae5.pkt" >> mail/ftn_out/outbound/00640000.clo
  ```

  If the messages are old enough not to be worth recovering, deleting the files is safe — they are copies; the originals remain in your message base.

* **Outbound files are now matched case-insensitively.** If you set `fileCase: 'upper'` on a node, the native BinkP mailer previously reported that node as having mail and then queued none of it — dialing every poll cycle and shipping nothing. The mailer now handles both cases, as [FTS-5005.003](http://ftsc.org/docs/fts-5005.003) §2 asks. No action required; anything queued in upper case starts shipping on the next poll. This also applies to an outbound directory inherited from a DOS-era mailer, where upper case names are the norm.

* **Mail to point addresses is now shipped by the native BinkP mailer.** `ftn_bso` has always written point mail to the `NNNNnnnn.pnt` subdirectory the spec requires, but the mailer did not look there, so it was never sent. If you carry points and have been running the built-in mailer, expect a backlog to go out on the next poll — check that the accumulated volume is something you are happy to send before starting up, and delete anything stale from `mail/ftn_out/**/*.pnt/` first if not.

* **Direct-attach netmail packets are renamed when sent.** A `NNNNnnnn.?ut` file in the outbound is now transmitted as a unique `NNNNNNNN.pkt`, per [FTS-5005.003](http://ftsc.org/docs/fts-5005.003) §3.1. Previously it went out under its `.?ut` name and the receiving system's tosser ignored it. This only affects `.?ut` files placed in your outbound by something other than ENiGMA½ — a netmail tracker, another mailer, or by hand. No action required.

* **Multi-network BSO outbound directories are now consistent between `ftn_bso` and the native BinkP mailer** ([#719](https://github.com/NuSkooler/enigma-bbs/issues/719)). The scanner/tosser and the mailer each used their own rule for deciding which FTN network owns the bare `outbound/` directory, and the two disagreed whenever more than one network was configured. Both now use the documented rule: `scannerTossers.ftn_bso.defaultNetwork` when set, otherwise the first network listed in `messageNetworks.ftn.networks`.

  **If you have two or more FTN networks configured and have _not_ set `defaultNetwork`**, the first-listed network's outbound now lands in `mail/ftn_out/outbound/` rather than `mail/ftn_out/<networkName>/`.

  * **Built-in BinkP mailer — no action required.** Mail already queued under the previous layout is still found and sent; once that directory drains you may delete it. A startup log entry appears while this applies.
  * **External mailer (Binkd, Mystic, etc.) — action required.** Either update the mailer's outbound path for that network to `outbound/`, or keep the previous layout by explicitly declaring that there is no default network:

    ```hjson
    scannerTossers: {
      ftn_bso: {
        //  no default network; every network uses its own subdirectory
        defaultNetwork: null
      }
    }
    ```

  Either way, explicitly setting `defaultNetwork` to a network name is recommended for multi-network systems: it pins the layout so that adding or reordering entries in `messageNetworks.ftn.networks` can never relocate a spool directory. See [BSO Import / Export](./docs/_docs/messageareas/bso-import-export.md).

* **Network names are now matched case-insensitively when resolving outbound directories.** Systems using a mixed-case key in `messageNetworks.ftn.networks` (e.g. `fsxNet`) on a case-sensitive filesystem could have outbound mail written to a directory the mailer never scanned. No action required.

## 0.4.0-beta to 0.5.0-beta

* No breaking changes or required migrations.

* **DORINFO graphics field changed from `1` to `2`** — ENiGMA½ now writes `2` (ANSI color) in the DORINFO graphics field instead of `1` (IBM high-bit chars). RBBS-mode doors such as TradeWars 2002 require `2` to enable ANSI color; other doors treat any non-zero value as graphics-capable and are unaffected. No configuration change required.

* **Optional: enable OSC 8 hyperlinks in message viewers** — clickable URL support is now available for `%MT` views in `preview` or `read-only` mode. The default menu templates already include `hyperlinks: true` on the appropriate views. If you maintain a custom menu config, add `hyperlinks: true` to any message-body or NFO viewer `%MT` view where you want URL detection:

  ```hjson
  MT1: {
      mode: preview
      hyperlinks: true
  }
  ```

  No effect on terminals that do not support OSC 8 — it degrades silently to plain text.

* **Optional: expose the new `user_status_config` module** — a new module lets users toggle their own availability and visibility. To add it to your menus, wire up a command or menu entry pointing to `@menu:userStatusConfig`. A minimal menu block is required in your menu config:

  ```hjson
  userStatusConfig: {
      desc: User Status
      module: user_status_config
      config: {
          art: {
              menu: user_status_config
          }
          enabledIndicator: "√"
          disabledIndicator: X
          menuInfoFormat10: "{availableIndicator}"
          menuInfoFormat11: "{visibleIndicator}"
      }
      form: {
          0: {
              mci: {
                  TL10: {}
                  TL11: {}
              }
              actionKeys: [
                  { keys: [ "a", "shift + a" ]           action: @method:toggleAvailable }
                  { keys: [ "v", "shift + v" ]           action: @method:toggleVisible }
                  { keys: [ "escape", "q", "shift + q" ] action: @systemMethod:prevMenu }
              ]
          }
      }
  }
  ```

  You will also need to create an art file named `user_status_config` (`.ans`, `.asc`, etc.) containing `TL10` and `TL11` MCI codes for the availability and visibility indicators respectively. The `menuInfoFormat10`/`menuInfoFormat11` format strings support `{availableIndicator}`, `{visibleIndicator}`, `{isAvailable}`, and `{isVisible}` tokens and can be styled with pipe codes in your theme.

* **Recommended:** review any secrets currently stored as plain text in `config.hjson` (`privateKeyPass`, SMTP/IMAP passwords, BinkP `sessionPassword`, FTN `packetPassword`, TIC `password`, `jwtSecret`, door service credentials) and consider moving them to `@file:` or `@environment:` references. This is optional but strongly encouraged — existing plain-text values continue to work unchanged. See [Security](./docs/_docs/configuration/security.md#keeping-secrets-out-of-confighjson) for examples.

## 0.3.0-beta to 0.4.0-beta
N/A

## 0.2.0-beta to 0.3.0-beta
ActivityPub data may need purged if you have utlized it. Easiest to just delete your activitypub.db file and start anew.

## 0.1.1-beta to 0.2.0-beta
N/A

## 0.1.0-beta to 0.1.1-beta
N/A

## 0.0.14-beta to 0.1.0-beta
* We are nearing 1.0! Version numbers have changed.

* ⚠️ **FSE editor footer art and menu config have changed.** The full-screen editor's `footerEditor` form (form `2`) previously used two separate `%TL` (Text Label) views — `%TL1` for cursor position and `%TL2` for INS/OVR mode — driven by a `TLTL` form config block. These have been replaced by a single `%SB1` (StatusBarView) with named panels.

  **If you have a custom `MSGEFTR` art file or a customized `createMessageEditor` / `readMessageEditor` menu config:**

  1. **Art file** (`MSGEFTR.ANS`) — Replace any `%TL1` + `%TL2` pair with a single `%SB1`. Position it where you want the combined status indicator to appear (the default theme places it near the right side of the footer line). Remove any `%TL2` entirely.

  2. **Menu config** — In the `createMessageEditor` and `readMessageEditor` (or equivalent) menu entries, replace the old form `2` block:

     ```hjson
     // OLD — remove this:
     2: {
         TLTL: {
             mci: {
                 TL1: { width: 5 }
                 TL2: { width: 4 }
             }
         }
     }
     ```

     with the new panel-mode `%SB1` config:

     ```hjson
     // NEW — use this:
     2: {
         mci: {
             SB1: {
                 width:     9
                 anchor:    left
                 justify:   left
                 separator: " "
                 panels: [
                     {
                         name:    mode
                         width:   3
                         justify: right
                     }
                     {
                         name:    pos
                         width:   5
                         justify: left
                     }
                 ]
             }
         }
     }
     ```

  In all cases, **diff the template against your existing config** before applying changes — your config likely contains other customizations you don't want to lose:

  ```bash
  diff ./misc/menu_templates/message_base.in.hjson ./config/menus/your_board-message_base.hjson
  ```

  Apply only the form `2` changes shown above. See [Configuration Files](./docs/_docs/configuration/config-files.md) for details.

* ⚠️ **New FSE keyboard shortcuts and find overlay require menu config updates.** The following changes apply to all FSE menu entries (`messageBaseNewPost`, `messageAreaViewPost`, `messageAreaReplyPost`, and their private-mail equivalents).

  **New art file — `MSGFND`:** A find-prompt footer art file is now required. Reference it in each FSE menu's `config.art` block:
  ```hjson
  config: {
      art: {
          // ... existing art keys ...
          footerFind: MSGFND
      }
  }
  ```
  The art file must contain a single `%ET1` (EditTextView) input field. Create and theme it like your other footer art files.

  **Header form (form `0`) — Escape key handler change:** Replace `@systemMethod:prevMenu` with `@method:headerEscapePressed` in the header form's `actionKeys`. This is required so that `Ctrl-A` ("change subject") can return focus to the body without exiting the FSE:
  ```hjson
  // OLD — remove:
  { keys: [ "escape" ], action: @systemMethod:prevMenu }
  // NEW — replace with:
  { keys: [ "escape" ], action: @method:headerEscapePressed }
  ```

  **Body editor (form `1`) — new action keys:** Add to the `actionKeys` array in the body (`MT1`) form:
  ```hjson
  { keys: [ "ctrl + f" ], action: @method:editModeFind }       // open find prompt
  { keys: [ "ctrl + n" ], action: @method:editModeFindNext }   // find next match
  { keys: [ "ctrl + p" ], action: @method:editModeFindPrev }   // find previous match
  { keys: [ "ctrl + a" ], action: @method:editModeChangeSubject } // edit subject inline
  ```

  **View mode (form `4`) — new action keys:** Add to the view footer `actionKeys` array:
  ```hjson
  { keys: [ "ctrl + f" ], action: @method:viewModeFind }
  { keys: [ "ctrl + n" ], action: @method:viewModeFindNext }
  { keys: [ "ctrl + p" ], action: @method:viewModeFindPrev }
  ```

  **New form `6` — find footer form:** All FSE menu entries need a form `6` definition. The simplest approach is to use the shared reference added to the template:
  ```hjson
  6: @reference:common.fseFindFooterForm
  ```
  You must also add the `fseFindFooterForm` fragment to your menu file's `common:` section. Copy it verbatim from `misc/menu_templates/message_base.in.hjson` (it is an `ET1` input with Enter to submit and Escape to cancel).

  **Editor command menu (form `3`) — upload item:** The ESC command menu (`HM1`) now includes an `"upload"` item allowing users to upload a file as the message body (ANSI art or plain text). Add `"upload"` to the `items` array and the corresponding submit action:
  ```hjson
  HM1: { items: [ "save", "discard", "help", "upload" ] }   // post
  HM1: { items: [ "save", "discard", "quote", "help", "upload" ] }  // reply
  ```
  With matching submit entries:
  ```hjson
  { value: { 1: N }, action: @method:editModeMenuUpload }
  ```
  Where `N` is the zero-based index of `"upload"` in your items list. Upload access defaults to `GM[users]`; override per-menu via `config.uploadAcs`.

  As always, **diff the template against your config** before applying changes:
  ```bash
  diff ./misc/menu_templates/message_base.in.hjson ./config/menus/your_board-message_base.hjson
  ```

* **nodemailer upgraded to v8.** If you have `email.transport` configured with AWS SES, you will need to update your transport config to use the SESv2 SDK — see the [nodemailer SES docs](https://nodemailer.com/transports/ses/). All other transports (SMTP, etc.) require no changes.

* **Pause prompt and TickerView enhancements** — new `pause: pageBreak` pagination mode, `pausePrompt`, `pausePosition`, `continuousKey`/`quitKey`, and TickerView (`%TK`) support in pause prompts. Existing `pause: true` configs continue to work unchanged. See [What's New](WHATSNEW.md) and [Pause Prompts](./docs/_docs/art/pause-prompts.md) for details.

## 0.0.13-beta to 0.0.14-beta
* A new ActivityPub menu template has been created. Upgrades will **not** have this file present so you will need to copy the template to your `config/menus` directory and rename it appropriately (it must match the `include` statement in your main `menu.hjson` file). Example:

```bash
cp ./misc/menu_templates/activitypub.in.hjson ./config/menus/my_board_name-activitypub.hjson`
```

This will expose the default ActivityPub setup. Enabling ActivityPub functionality requires the web server enabled and ActivityPub itself enabled in your `config.hjson`. See [Configuration Files Include Statements](./docs/_docs/configuration/config-files.md#includes) for more information on using `include`.

* ⚠ The menu flag `noHistory` has been revamped to work as expected. Some menu entires now need this flag. Look for any "NoResults" entries and remove `menuFlags`. For example, here is the (updated) default `fileBaseListEntriesNoResults` menu:

```hjson
fileBaseListEntriesNoResults: {
    desc: Browsing Files
    art: FBNORES
    config: {
        pause: true
        // no menuFlags here
    }
}
```

See also: [Menu Modules](./docs/_docs/modding/menu-module.md).


* Due to changes to supported algorithms in newer versions of openssl, the default list of supported algorithms for the ssh login server has changed. There are both removed ciphers as well as optional new kex algorithms available now. ***NOTE:*** Changes to supported algorithms are only needed to support keys generated with new versions of openssl, if you already have a ssl key in use you should not have to make any changes to your config.
  * Removed ciphers: 'blowfish-cbc', 'arcfour256', 'arcfour128', and 'cast128-cbc'
  * Added kex: 'curve25519-sha256', 'curve25519-sha256@libssh.org', 'curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'

## 0.0.12-beta to 0.0.13-beta
* To enable the new Waiting for Caller (WFC) support, please see [WFC](docs/modding/wfc.md).
* :exclamation: The SSH server's `ssh2` module has gone through a major upgrade. Existing users will need to comment out two SSH KEX algorithms from their `config.hjson` if present else clients such as NetRunner will not be able to connect over SSH. Comment out `diffie-hellman-group-exchange-sha256` and `diffie-hellman-group-exchange-sha1`
* Gopher configuration change. See [WHATSNEW](WHATSNEW.md)
* All features and changes are backwards compatible. There are a few new configuration options in a new `term` section in the configuration. These are all optional, but include the following options in case you use them:

```hjson
{
  term: {
    // checkUtf8Encoding requires the use of cursor
    // position reports, which are not supported on all terminals.
    // Using this with a terminal that does not support cursor
    // position reports results in a 2 second delay during the
    // connect process, but provides better auto configuration of utf-8
    checkUtf8Encoding: true


    // Checking the ANSI home position also requires the use of
    // cursor position reports, which are not supported on all
    /// terminals. Using this with a terminal that does not support
    // cursor position reports results in a 3 second delay during
    // the connect process, but works around positioning problems with
    // non-standard terminals.
    checkAnsiHomePosition: true
  }
}
```

In addition to these, there are also new options for `term.cp437TermList` and `term.utf8TermList`. Under most circumstances these should not need to be changed. If you want to customize these lists, more information is available in `config_default.js`

## 0.0.11-beta to 0.0.12-beta
* Be aware that `master` is now mainline! This means all `git pull`'s will yield the latest version. See [WHATSNEW](WHATSNEW.md) for more information.
* **BREAKING CHANGE** There is no longer a `prompt.hjson` file. Prompts are now simply part of the menu set in the `prompts` section. If you have an existing system you will need to add your `prompt.hjson` to your `menu.hjson`'s `includes` section at a minimum. Example:
```hjson
// menu.hjson
{
    includes: [
        my-prompts.hjson // ref your old prompts here
    ]
}
```
* A set of database fixes were made that cause some records to be properly cleaned up when e.g. deleting a file. Existing `file.db` databases will need to be updated **manually**. Note that this applies to users upgrading within 0.0.12-beta as well:
1. **Make a backup of your file.db!**
2. Shut down ENiGMA.
3. From the enigma-bbs directory:
```
sqlite3 db/file.sqlite3 < ./misc/update/tables_update_2020-11-29.sql
```

## 0.0.10-alpha to 0.0.11-beta
* Node.js 12.x LTS is now in use. Follow standard Node.js upgrade procedures (e.g.: `nvm install 12 && nvm use 12`).

## 0.0.9-alpha to 0.0.10-alpha
* Security related files such as private keys and certs are now looked for in `config/security` by default.
* Default archive handler for zip files has switched to InfoZip due to a bug in the latest p7Zip packages causing "volume not found" errors. Ensure you have the InfoZip `zip` and `unzip` commands in ENiGMA's path. You can switch back to 7Zip by overriding `archiveHandler` for `application/zip` in your `config.hjson` under `fileTypes` to `7Zip`.

## 0.0.8-alpha to 0.0.9-alpha
* Development is now against Node.js 10.x LTS. Follow your standard upgrade path to update to Node 10.x before using 0.0.9-alpha!
* The property `justify` found on various views previously had `left` and `right` values swapped (oops!); you will need to adjust any custom `theme.hjson` that use one or the other and swap them as well.
* Possible breaking changes in FSE: The MCI code `%TL13` for error indicator is now `%TL4`. This is part of a cleanup and standardization on "custom ranges". You may need to update your `theme.hjson` and related artwork.
* Removed view width auto-size: Some views still can auto-size their height, but in general you should be explicit in your themes
* More standardization using "custom ranges" and `itemFormat` / `focusItemFormat` semantics. Update your themes!
* In addition to using `itemFormat`, the `onelinerz` module uses `userName` vs `username` (note the case) to match other modules
* `loginServers.webSocket` configuration block has changed to be more consistent with other servers. Example:
```
webSocket: {
    ws: {
        enabled: true
    }
    wss: {
        enabled: true
        port: 1234
    }
    proxied: true	//	X-Forwarded-Proto: https support
}
```
* The module export `registerEvents` has been deprecated. If you have a module that depends on this, use the new more generic `moduleInitialize` export instead.
* The `system.db` `user_event_log` table has been updated to include a unique session ID. Previously this table was not used, but you will need to perform a slight maintenance task before it can be properly used. After updating to `0.0.9-alpha`, please run the following: `sqlite3 db/system.db DROP TABLE user_event_log;`. The new table format will be created and used at startup.
* If you have art configured for message conference or area selection via the `art` configuration value, you will need to include a `show_art` menu reference. Defaulted to `changeMessageConfPreArt` for conferences and `changeMessageAreaPreArt` for areas & included in the example `menu.hjson`.
* Config `defaults` section was theme related and as such, has been renamed to `theme`. `defaults.theme` is now `theme.default`, and `preLoginTheme` is now `theme.preLogin`. See `config.js` if this isn't clear as mud.
* Similar to the last item, `defaults.general.passwordChar` in `theme.hjson` is now just `defaults.passwordChar`.


## 0.0.7-alpha to 0.0.8-alpha
ENiGMA 0.0.8-alpha comes with some structure changes:
* Configuration files are defaulted to `./config`. Related, the `--config` option now points to a configuration **directory**
* `./mods/art` has been moved to `./art/general`
* `./mods` is now reserved for actual user addon modules
* Themes have been moved from `./mods/themes` to `./art/themes`

With the change to the `./mods` directory, `@systemModule` is now implied for `module` declarations in `menu.hjson`. To use a user module in `./mods` you must specify `@userModule`!

With the above changes, you'll need to to at least:
* Move your `~/.config/enigma-bbs/config.hjson` to `./config/config.hjson` or utlize the `--config` option.
* Move your `prompt.hjson` and `menu.hjson` (e.g. `myboardname.hjson`) to `./config`
* Move any non-theme art files, and theme directories to their appropriate locations mentioned above
* Move any module directories such as `message_post_evt` to `./mods/`
* Move any certificates, pub/private keys, etc. from `./misc` to `./config`
* Specify user modules as `@userModule:my_module_name`

## 0.0.6-alpha to 0.0.7-alpha
No issues

## 0.0.5-alpha to 0.0.6-alpha
No issues

## 0.0.4-alpha to 0.0.5-alpha
No issues

## 0.0.1-alpha to 0.0.4-alpha
### Node.js 6.x+ LTS is now **required**
You will need to upgrade Node.js to [6.x+](https://github.com/nodejs/node/blob/master/doc/changelogs/CHANGELOG_V6.md). If using [nvm](https://github.com/creationix/nvm) (you should be!) the process will go something like this:
```bash
nvm install 6
nvm alias default 6
```

### ES6
Newly written code will use ES6 and a lot of code has started the migration process. Of note is the `MenuModule` class. If you have created a mod that inherits from `MenuModule`, you will need to upgrade your class to ES6.

### Manual Database Upgrade
A few upgrades need to be made to your SQLite databases:

```bash
rm db/file.sqltie3 # safe to delete this time as it was not used previously
sqlite3 db/message.sqlite
sqlite> INSERT INTO message_fts(message_fts) VALUES('rebuild');
```

### Archiver Changes
If you have overridden or made additions to archivers in your `config.hjson` you will need to update them. See [Archive Configuration](docs/archive.md) and `core/config.js`

### File Base Configuration
As 0.0.4-alpha contains file bases, you'll want to create a suitable configuration if you wish to use the feature. See [File Base Configuration](docs/file_base.md).
