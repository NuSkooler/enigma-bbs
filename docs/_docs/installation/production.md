---
layout: page
title: Production Installation
---
If you've become convinced you would like a "production" BBS running ENiGMA½ a more advanced installation
may be in order.

[PM2](https://github.com/Unitech/pm2) is an excellent choice for managing your running ENiGMA½ instances if
you've installed via the [install script](install-script.md) or [manual installation](manual.md) method.
Additionally, it is suggested that you run as a specific more locked down user (e.g. 'enigma').

If you're running ENiGMA via Docker, then process management is already handled for you!

## Running Under systemd
On Linux distributions using systemd, a unit file is a clean way to keep ENiGMA½ running and have it
restart on failure. Below is a minimal example assuming a dedicated `enigma` user with the BBS installed
to `/home/enigma/xibalba`:

```ini
# /etc/systemd/system/xibalba.service
[Unit]
Description=ENiGMA½ BBS
After=network.target

[Service]
ExecStart=/home/enigma/xibalba/misc/start.sh
WorkingDirectory=/home/enigma/xibalba/
User=enigma
Group=enigma
Restart=on-failure
KillMode=control-group
Environment=NODE_ENV=production
# See "Node.js managed by mise / nvm / asdf" below for why this is needed
Environment=PATH=/home/enigma/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

A matching `start.sh` is just:

```bash
#!/usr/bin/env bash
exec node main.js
```

Then enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xibalba
journalctl -u xibalba -f
```

### Node.js managed by mise / nvm / asdf
The [install script](install-script.md) installs Node.js via [mise](https://mise.jdx.dev/) by default.
Version managers like mise, nvm, and asdf normally hook into your interactive shell (e.g. via
`mise activate` in `~/.bashrc`) — but systemd services do **not** run an interactive shell, so that
hook never fires. Without help, `node` will not be on the service's `PATH`, and any child process
that relies on a `#!/usr/bin/env node` shebang (e.g. `oputil.js`, `util/exiftool2desc.js`) or any
scheduled event using `@execute:node` in `config.hjson` will fail with an `ENOENT`-style error.

The fix is to put the version manager's **shims directory** on the unit's `PATH`. Shims are plain
executables that dispatch to the currently-active managed version, so they work fine in
non-interactive contexts. For mise (default install location):

```ini
Environment=PATH=/home/enigma/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin
```

For nvm or asdf, substitute the appropriate shims/bin directory. Once this is set, you can use
plain `node` everywhere — including in `start.sh` and in scheduled event `@execute:` actions —
and `mise upgrade node` (or the equivalent) will not require any path changes.

Verify after `daemon-reload` and restart:

```bash
systemctl show xibalba -p Environment
```

### SELinux (RHEL, Fedora, Rocky, Alma, ...)
On SELinux-enforcing distributions, systemd will refuse to execute a script that lives under a
user's home directory unless the file has an appropriate type label (e.g. `bin_t`). Symptoms look
like this in the journal:

```
xibalba.service: Failed at step EXEC spawning /home/enigma/xibalba/misc/start.sh: Permission denied
xibalba.service: Main process exited, code=exited, status=203/EXEC
```

Persistently relabel `start.sh` (and any other executables systemd needs to run directly) so the
context survives editor saves and `restorecon` runs:

```bash
sudo semanage fcontext -a -t bin_t '/home/enigma/xibalba/misc/start\.sh'
sudo restorecon -v /home/enigma/xibalba/misc/start.sh
```

> :warning: Many editors save files via write-then-rename, which creates a new inode and **strips
> the custom SELinux context** — leaving the file as `user_home_t` and breaking the service the
> next time it restarts. The `semanage fcontext` rule above makes the correct context the default
> for that path, so a quick `restorecon` after editing puts things right. If you prefer not to
> remember that, edit the file in place (`sed -i`, `nano` with `set backupcopy yes` in vim, etc.).
