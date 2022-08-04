---
layout: page
title: Updating
---
# Updating
Keeping your system up to date ensures you have the latest fixes, features, and general improvements. Updating ENiGMA½ can be a bit of a learning curve compared to traditional binary-release systems you may be used to, especially when running from Git cloned source.

## Updating From Source
If you have installed using Git source (if you used the `install.sh` script) follow these general steps to update your system:

1. **Back up your system**!
2. Pull down the latest source:
```bash
cd /path/to/enigma-bbs
git pull
```
3. :bulb: Review `WHATSNEW.md` and `UPDATE.md` for any specific instructions or changes to be aware of.
4. Update your dependencies:
```bash
npm install # or 'yarn'
```
4. Merge updates from `config/menu_template.hjson` to your `config/yourbbsname-menu.hjson` file (or simply use the template as a reference to spot any newly added default menus that you may wish to have on your system as well!).
5. If there are updates to the `art/themes/luciano_blocktronics/theme.hjson` file and you have a custom theme, you may want to look at them as well.
6. Finally, restart your running ENiGMA½ instance.

> :information_source: Visual diff tools such as [DiffMerge](https://www.sourcegear.com/diffmerge/downloads.php) (free, works on all major platforms) can be very helpful for the tasks outlined above!

> :bulb: It is recommended to [monitor logs](../troubleshooting/monitoring-logs.md) and poke around a bit after an update!



