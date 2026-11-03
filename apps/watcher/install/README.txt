Delta Desk watcher
==================

It sends this PC's ODIN trade and order files to Delta Desk (https://delta.optionbhai.com)
as ODIN writes them.

Install (or update)
1. Get a token: Delta Desk, Admin tab, the trader's row, "Issue token". It is shown once - copy it.
2. Right-click the downloaded zip, Properties, tick "Unblock", OK. Then "Extract All".
3. In the extracted folder, double-click install.cmd.
   - Paste the token.
   - Confirm ODIN's OnLineBackup folder (the one holding Trades and Orders); it is looked for
     under C:\ and Program Files, or type its path.
4. Done. It runs from C:\Traders, starts at every logon, and the trader's heartbeat shows on
   the Admin tab within a minute. On first start it sends the folder's whole history.

If Windows SmartScreen stops it: "More info", then "Run anyway".

To update: download the new zip and run install.cmd again; Enter keeps the token and folder.

Status: C:\Traders\watcher.log

Uninstall: delete "Delta Desk watcher" from the Startup folder (Win+R, shell:startup),
end watcher.exe in Task Manager, delete C:\Traders.
