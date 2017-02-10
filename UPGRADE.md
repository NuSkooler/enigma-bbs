# Introduction
This document covers basic upgrade notes for major ENiGMA½ version updates.


# Before Upgrading
* Always back up your system! 
* At least back up the `db` directory and your `menu.hjson` (or renamed equivalent)


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


# Upgrading the Code
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
You will need to upgrade Node.js to [6.x+](https://github.com/nodejs/node/blob/master/doc/changelogs/CHANGELOG_V6.md). If using [nvm](https://github.com/creationix/nvm) (you should be!) the process will go something like this:
```bash
nvm install 6
nvm alias default 6
```

### ES6
Newly written code will use ES6 and a lot of code has started the migration process. Of note is the `MenuModule` class. If you have created a mod that inherits from `MenuModule`, you will need to upgrade your class to ES6.

## Manual Database Upgrade
A few upgrades need to be made to your SQLite databases:

```bash
rm db/file.sqltie3 # safe to delete this time as it was not used previously
sqlite3 db/message.sqlite
sqlite> INSERT INTO message_fts(message_fts) VALUES('rebuild');
```

## Archiver Changes
If you have overridden or made additions to archivers in your `config.hjson` you will need to update them. See [Archive Configuration](docs/archive.md) and `core/config.js`

## File Base Configuration
As 0.0.4-alpha contains file bases, you'll want to create a suitable configuration if you wish to use the feature. See [File Base Configuration](docs/file_base.md).
