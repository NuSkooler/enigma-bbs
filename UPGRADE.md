# Introduction
This document covers basic upgrade notes for major ENiGMA½.


# Before Upgrading
* Always back ALL files in the 'db' directory
* Back up your menu.hjson (or renamed equivalent)


# General Notes
Upgrades often come with changes to the default `menu.hjson`. It is wise to 
use a *different* file name for your BBS's version of this file and point to
it via `config.hjson`. For example:

```hjson
general: {
	menuFile: my_bbs.hjson
}
```

After updating code, use a program such as DiffMerge to merge in updates to
`my_bbs.hjson` from the shipping `menu.hjson`.


# Pulling Latest From GitHub
Upgrading from GitHub is easy:

```bash
cd /path/to/enigma-bbs
git pull
npm install
```


# Problems
Report your issue on Xibalba BBS, hop in #enigma-bbs on Freenet and chat, or
[file a issue on GitHub](https://github.com/NuSkooler/enigma-bbs/issues).


# 0.0.1-alpha to 0.0.4-alpha
## Node.js 6.x+ LTS is now **required**
You will need to upgrade Node.js to 6.x+. If using nvm (you should be!) the process will go something like this:
```bash
nvm install 6
nvm alias default 6
```

## Manual Database Upgrade
A few upgrades need to be made to your SQLite databases:

```bash
rm db/file.sqltie3 # safe to delete this time as it was not used previously
sqlite3 db/message.sqlite
sqlite> INSERT INTO message_fts(message_fts) VALUES('rebuild');
```

## Archiver Changes
If you have overridden or made additions to archivers in your `config.hjson` you will need to update them. See [docs/archive.md](Archive Configuration) and `core/config.js`
