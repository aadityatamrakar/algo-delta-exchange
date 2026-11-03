# Server rebuild — retire the legacy stack, upgrade the OS, deploy the desk system

Target: `ip-172-31-22-247` (EC2, arm64), in place. Ubuntu 20.04 → 24.04, MongoDB 4.4 → 8.0,
legacy loopback stack removed, desk system deployed against the restored data.

Companion to `DEPLOYMENT.md`, which covers a *fresh* install. This covers the *replacement* of what
is already on that box. Read §4 and §6 of that doc before Phase 4 — the `DESK_MASTER_KEY` warning
in particular.

> **Verified from the server on 2026-07-27:** `t4g.xlarge` (Graviton2, ARMv8.2-A, 4 vCPU / 16 GB),
> Ubuntu 20.04 focal, `aarch64`. MongoDB 4.4.18 standalone, dbPath `/var/lib/mongodb`, 878 MB,
> databases `admin`/`algo`/`config`/`local`. Auth **disabled**, `bindIp: 0.0.0.0`, port firewalled
> to the operator's IP. `mongod.service` **disabled** (would not survive a reboot).
>
> **Hardware constraint cleared:** MongoDB 5.0+ needs ARMv8.2-A on arm64. Graviton1 (`a1.*`) could
> not run it at all; Graviton2 can — `/proc/cpuinfo` shows `atomics`, `asimdrdm`, `lrcpc`,
> `asimddp`. No blocker to 8.0 from the CPU.
>
> Everything else below is procedure, not observation — check as you go.

---

## The two things that will actually bite

**1. `apt_pkg` is broken on this box.** Running any command that is not found prints:

```
ModuleNotFoundError: No module named 'apt_pkg'
```

`do-release-upgrade` is a Python program built on `apt_pkg`. With the binding broken it can fail
*partway through* a release upgrade, which is the single worst outcome available here. **Phase 1
fixes this before anything else.** Do not skip it because the box otherwise seems fine.

**2. An EBS snapshot is the only real rollback.** A `mongodump` archive restores the *data*. It
does not restore a half-upgraded OS with a broken boot chain. Phase 0 takes a snapshot and it is
not optional.

**3. Disk was tight — resolved 2026-07-28.** Started at 29 GB root / 17 GB used / **13 GB free**,
which is thin for two release upgrades plus ~1.2 GB of local backups. Cleanup recovered ~3 GB
(`apt clean`, `autoremove --purge`, `journalctl --vacuum-size=200M`, `pm2 flush`, and removing the
duplicate disabled snap revisions — every snap had two). Now **16 GB free**, which is sufficient.
Growing the EBS volume proved unnecessary; if a future run starts below ~10 GB free, expand to
60 GB (`aws ec2 modify-volume`, then `growpart /dev/nvme0n1 1` + `resize2fs /dev/nvme0n1p1`) before
Phase 2 rather than risking a mid-upgrade disk-full.

---

## Phase 0 — Back up and snapshot

> **Decided 2026-07-28: the database backup here is SKIPPED.** The operator holds an independent
> backup of the legacy data elsewhere and does not want a second copy pulled off this box. 0.2–0.5
> are therefore not performed, and the legacy data is **discarded with the box**, not migrated.
> **0.6 (the EBS snapshot) still applies** — it is the rollback for a failed OS upgrade, which a
> database backup does not cover. Do 0.1 and 0.6.

Nothing is deleted in this phase. Do not proceed to Phase 1 until every check here passes.

### 0.1 Inventory what is on the box

You cannot restore what you did not know was there.

There is **no nginx and no TLS** on this box — verified 2026-07-28. The legacy dashboard was served
by the loopback app itself over plain HTTP, and there are no certificates to preserve.

```sh
sudo -i && mkdir -p /root/keep
pm2 list > /root/keep/pm2-list.txt          # every legacy process
crontab -l > /root/keep/crontab-root.txt 2>/dev/null
sudo -u ubuntu crontab -l > /root/keep/crontab-ubuntu.txt 2>/dev/null
cp -a /home/ubuntu/algospot/server/*.json /root/keep/ 2>/dev/null   # datasources, config
env | grep -i "DESK_\|ZERODHA\|XTS" > /root/keep/env.txt 2>/dev/null
```

`/root/keep` survives the release upgrades — no need to copy it off the box.

**`DESK_MASTER_KEY`:** nothing is sealed with it yet (there is no `desk-brokers` collection — the
desk system has never run here). It becomes load-bearing the moment XTS or Zerodha credentials are
entered on the Brokers page. Use the value from `.env.prod` and keep a copy off the machine.

**Do not replace the instance or detach the EIP.** `XTS_BASE_URL` points at the broker
(`smpa.jainam.in:6543`, Jainam) and brokers commonly IP-whitelist API access. Rebuilding in place
preserves the public IP; a new instance would need re-whitelisting with the broker. Confirm egress
after the OS upgrade:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://smpa.jainam.in:6543/
```

### 0.2 Record the counts you will verify against

```sh
mkdir -p ~/rebuild
mongo algo --quiet --eval 'db.getCollectionNames().sort().forEach(c=>print(c, db[c].countDocuments()))' \
  | tee ~/rebuild/counts-before.txt
mongo algo --quiet --eval 'JSON.stringify(db.stats())' > ~/rebuild/dbstats-before.json
```

### 0.3 Dump the database

```sh
pm2 stop all                                # stop the writers first

mongodump --db=algo   --archive=$HOME/rebuild/algo-$(date +%F).gz  --gzip
mongodump --db=admin  --archive=$HOME/rebuild/admin-$(date +%F).gz --gzip   # holds smp_admin

ls -lh ~/rebuild/*.gz                       # must be NON-EMPTY — stop here if not
```

`mongodump --db=algo` does **not** include users; they live in `admin.system.users`. That is why
`admin` is dumped separately. If `mongodump` is missing: `sudo apt install -y mongodb-database-tools`.

### 0.4 Cold copy of the data directory

```sh
sudo systemctl stop mongod
sudo tar -czf $HOME/rebuild/datadir-4.4-$(date +%F).tgz -C /var/lib mongodb
sudo systemctl start mongod
```

### 0.5 Get it off the box

A backup that only exists on the machine you are about to rebuild is not a backup.

```sh
# from your laptop
scp -r ubuntu@<host>:~/rebuild ./algomaker-rebuild-backup/
# and/or
aws s3 cp ~/rebuild s3://<bucket>/algomaker/rebuild-$(date +%F)/ --recursive
```

### 0.6 Snapshot the volume

In the EC2 console, or:

```sh
TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id
# then: aws ec2 create-snapshot --volume-id <vol> --description "pre-rebuild 2026-07-27"
# or create a full AMI, which is easier to boot from if the OS upgrade fails
```

Wait for the snapshot to reach `completed` before Phase 1. **Gate: dumps verified non-empty, copied
off the box, snapshot completed.**

---

## Phase 1 — Fix apt, then retire the legacy stack

### 1.1 Clear the dead repos — blocking

Diagnosed 2026-07-28. `apt update` fails outright, so nothing can be upgraded:

- **MongoDB 4.4** — signing key expired (`EXPKEYSIG 656408E390CFB1F5`). apt rejects the whole
  update, not just that repo. Being purged anyway.
- **NodeSource** — pinned at **Node 15**. Long dead; Node 24 comes from a fresh repo in Phase 3.2.
- **deadsnakes PPA** — the cause of the `apt_pkg` failure, see 1.2. Also a conflict risk during the
  release upgrade, which brings its own Python.

```sh
ls /etc/apt/sources.list.d/
sudo rm -f /etc/apt/sources.list.d/mongodb-org-4.4.list
sudo rm -f /etc/apt/sources.list.d/nodesource.list
sudo rm -f /etc/apt/sources.list.d/deadsnakes-ubuntu-ppa-focal.list
```

Use `rm`, not `add-apt-repository --remove` — that is a Python program needing `apt_pkg`, which is
exactly what is broken.

### 1.2 Repair `apt_pkg` — blocking

**Root cause is the deadsnakes PPA, not a damaged package.** A newer Python was installed and
`/usr/bin/python3` repointed at it. `python3-apt` ships its compiled binding only for the distro
Python (3.8 on focal), so `import apt_pkg` fails under any other interpreter.
`apt install --reinstall python3-apt` does **not** fix this — verified, it succeeded and the error
persisted.

```sh
ls -l /usr/bin/python3
python3 --version                                 # anything but 3.8 = the problem
sudo ln -sfn /usr/bin/python3.8 /usr/bin/python3  # or: update-alternatives --set python3 /usr/bin/python3.8
python3 -c "import apt_pkg; print('ok')"          # must print ok
```

Do **not** uninstall the newer Python — the desk's trading logic is Python. Invoke it explicitly
(`python3.11`, or a venv). On focal, system `python3` must be 3.8 or apt, `do-release-upgrade` and
`command-not-found` all break.

### 1.3 Now bring focal fully current

```sh
sudo apt update            # must be clean: no GPG error, no traceback
sudo apt full-upgrade -y
sudo apt autoremove --purge -y
sudo reboot
```

### 1.2 Remove the legacy processes

```sh
pm2 delete all
pm2 unstartup systemd            # stop pm2 resurrecting the legacy tree on boot
pm2 kill
```

**`/home/ubuntu/algospot` is NOT purely legacy — the algomaker checkout lives inside it.** Do not
`rm -rf` that directory. Move the checkout out first, then delete only what remains:

```sh
find /home/ubuntu/algospot -maxdepth 3 -name .git -type d      # locate the checkouts
cd <the algomaker checkout> && git status --short && git remote -v && ls -la .env*
mv <the algomaker checkout> /opt/algomaker-delta && chown -R ubuntu:ubuntu /opt/algomaker-delta
ls /home/ubuntu/algospot                                        # confirm legacy-only before deleting
```

`/home/ubuntu` also holds `dump`, `mongoKey`, `postdata` and `sensibull_tools`. **`sensibull_tools`
is a separate repo that stays** — it runs as `ubuntu` and does not use MongoDB, so Phase 1 does not
touch it.

Its Python environment needs **nothing preserved**. Checked 2026-07-28: `.venv` is Python 3.8.10
containing only `pkg_resources==0.0.0` — an empty venv — while `pyproject.toml` declares
`requires-python = ">=3.12"`. It has never been runnable on focal. The OS upgrade is what makes it
installable. Afterwards:

```sh
rm -rf /home/ubuntu/sensibull_tools/.venv
sudo -u ubuntu bash -lc 'cd ~/sensibull_tools && python3.12 -m venv .venv && .venv/bin/pip install -e .'
```

### 1.3 Remove MongoDB 4.4 and its repo

Third-party repos block `do-release-upgrade`, and 4.4 is being replaced anyway.

```sh
sudo systemctl stop mongod
sudo systemctl disable mongod
sudo apt purge -y mongodb-org*
sudo rm -f /etc/apt/sources.list.d/mongodb*.list
sudo apt autoremove -y
```

`apt purge` leaves `/var/lib/mongodb` alone — dpkg does not delete data directories. Remove it
explicitly, now that Phase 0 is verified:

```sh
sudo rm -rf /var/lib/mongodb
```

### 1.4 Clear other third-party repos

```sh
ls /etc/apt/sources.list.d/          # NodeSource, docker, etc.
```

Disable anything that has no 24.04 build. `do-release-upgrade` disables them itself, but it is
better to know what you are losing than to find out afterwards.

---

## Phase 2 — Ubuntu 20.04 → 22.04 → 24.04

There is no single-step path. Two upgrades, each with a reboot.

### 2.1 Survive a dropped SSH session

**Run inside tmux.** If the connection dies mid-upgrade without it, the upgrade dies with it.

```sh
sudo apt install -y tmux
tmux new -s upgrade
# detached? reattach with: tmux attach -t upgrade
```

`do-release-upgrade` also starts a fallback sshd on **port 1022**. Your security group only permits
your IP — add 1022 for that same IP before starting, as a second way in.

### 2.2 Fully update on the current release first

```sh
sudo apt update && sudo apt full-upgrade -y
sudo apt autoremove -y
sudo reboot                       # confirm it comes back BEFORE upgrading the release
```

### 2.3 focal → jammy

```sh
sudo sed -i 's/^Prompt=.*/Prompt=lts/' /etc/update-manager/release-upgrades
sudo do-release-upgrade
```

Answering the prompts:

| Prompt | Answer |
|---|---|
| `sshd_config` modified | **Keep the local version.** Taking the maintainer's can revoke your key-based access and lock you out. |
| GRUB / `/boot/grub` | Take the maintainer's version. |
| Third-party sources disabled | Expected. Phase 1 already removed the ones that matter. |
| Restart services without asking | Yes. |

Reboot, then verify before continuing:

```sh
lsb_release -a          # jammy
uname -a
systemctl --failed      # nothing important
df -h /                 # each upgrade consumes disk
```

**Take a second snapshot here.** Reaching jammy cleanly is worth not repeating.

### 2.4 jammy → noble

```sh
sudo do-release-upgrade
```

Same prompts, same answers. Then:

```sh
lsb_release -a          # noble, 24.04
python3 -c "import apt_pkg; print('ok')"
```

---

## Phase 3 — Install the new stack

### 3.0 MongoDB will NOT start on kernel 7.0 — pin the 6.8 kernel first

Hit on 2026-07-28. Noble's current AWS kernel is **7.0.0-1009-aws**, and `mongod` refuses to start:

```
MongoDB cannot start: Linux kernel versions 6.19 and newer has a known
incompatibility with this version of MongoDB. SERVER-121912
```

It is a deliberate startup guard, not a crash. Established while diagnosing:

- **8.0.28 is the newest 8.0 patch and still refuses.** No 8.0 version helps.
- **Do not pin an older 8.0.x that predates the guard.** The guard exists because the
  incompatibility is real — an older build will not refuse, it will hit the bug. On a database that
  means risking corruption instead of a clean failure.
- **8.2 and 8.3 exist for noble but cannot be installed**: `pgp.mongodb.com/server-8.2.asc` and
  `-8.3.asc` both 404, so their repos cannot be verified. They are also rapid releases with short
  support windows.

**The fix: run noble's GA 6.8 kernel**, which is not a downgrade — 6.8 is the kernel Ubuntu 24.04
shipped with and supports for the life of the release. 7.0 arrives via the rolling HWE line.

```sh
sudo grub-reboot "Advanced options for Ubuntu>Ubuntu, with Linux 6.8.0-1061-aws"   # one-shot test
sudo reboot
uname -r                                     # 6.8.0-1061-aws

# make it permanent — linux-aws-6.8 is published in noble-security, so 6.8.x keeps getting patches
sudo apt install -y linux-aws-6.8
sudo apt purge linux-aws linux-image-aws linux-image-7.0.0-1009-aws \
                linux-aws-7.0-headers-7.0.0-1009 linux-aws-7.0-tools-7.0.0-1009
sudo apt autoremove --purge -y
sudo update-grub                             # 6.8 is now newest → the automatic default
```

Removing the `linux-aws` / `linux-image-aws` metapackages is what stops 7.0 returning at the next
upgrade. No `GRUB_DEFAULT` hardcoding and no `apt-mark hold` — both would freeze kernel security
updates or break when 6.8.0-1062 ships.

**Revisit when MongoDB ships a build that supports ≥6.19**, then move back to the rolling kernel.

> Unrelated but found here: ~90 kernel images from the 20.04 era (5.4/5.8/5.11/5.13/5.15) were
> still installed, never autoremoved. `dpkg -l 'linux-image-5.*-aws' | awk '/^ii/{print $2}' |
> xargs sudo apt purge -y` reclaims the space and makes the GRUB menu legible.

### 3.1 MongoDB 8.0

Now available, because you are on noble. This is what the OS upgrade bought.

```sh
curl -fsSL https://pgp.mongodb.com/server-8.0.asc \
  | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-8.gpg
echo "deb [ arch=arm64 signed-by=/usr/share/keyrings/mongodb-8.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update && sudo apt install -y mongodb-org

sudo systemctl enable --now mongod        # `enable` — the old install was missing this
mongosh --quiet --eval 'db.version()'
```

The stock 8.0 `/etc/mongod.conf` binds `127.0.0.1`. **Do not copy the old config over it** — that is
where `bindIp: 0.0.0.0` came from.

### 3.2 Node — must be ≥ 24.9

Not 22, not 24.8. `crypto.argon2` landed in 24.9 and hashes operator passwords; below it the login
system does not start. `package.json` says `>=22` and is stale.

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v                                   # >= 24.9
```

`pm2@^7.0.3` is a repo dependency and the Makefile invokes it via `npx pm2` — no global install.

---

## Phase 4 — Start empty; keep the legacy data as history

**Do not restore `algo` into `algomaker`.** Verified 2026-07-28, `algo` contains only legacy
collections — the desk system has never run on this box:

| Collection | Docs | Read by the new system? |
|---|---:|---|
| `strategyPNL` | 2,283,553 | No — legacy schema |
| `paper-trade` | 197,096 | No |
| `instrument` | 57,485 | **Yes**, but regenerable with `make sync` |
| `report` | 10,428 | No |
| `OrderUpdate` | 6,504 | No |
| `orderbook` | 5,069 | No |
| `AccessToken` | 734 | No |
| `client`, `account`, `xtsAccount`, `tmp_account`, `strategyData` | <20 each | No |
| `positional`, `orderbook2`, `sparkAccount` | 0 | No — `DEPLOYMENT.md` §4: "nothing new reads it" |

Every collection the desk system actually wants (`desk-daily-reports`, `desk-decisions`,
`desk-users`, `desk-brokers`, `desk-books`, `desk-strategies`, `desk-safety`, `desk-pnl-snapshots`)
is **absent**. Restoring would import 2.5 M documents in an unreadable schema to gain one
regenerable collection. The §4 keep/discard table in `DEPLOYMENT.md` assumes a host where the desk
system had already run; this host is not that.

So: **`algomaker` starts empty.** `make sync` populates `instrument` and `desk-freeze-limits`;
every other collection is created on first write.

### No restore at all — decided 2026-07-28

The `algo_legacy` side-restore was considered and **declined**: the operator holds an independent
backup off-box and wants a clean machine. Nothing is restored to this server. If the legacy P&L is
ever wanted in the new dashboard, it is a schema migration (`strategyPNL` → `desk-daily-reports`,
`orderbook`/`OrderUpdate` → `desk-decisions`) done from that external backup, at any later date.

The counts recorded before deletion, for reference if that migration ever happens:

```
AccessToken 734 · OrderUpdate 6504 · account 1 · client 14 · instrument 57485
orderbook 5069 · orderbook2 0 · paper-trade 197096 · positional 0 · report 10428
sparkAccount 0 · strategyData 2 · strategyPNL 2283553 · tmp_account 5 · xtsAccount 1
```

`smp_admin` is not recreated. Its password (`adminAlgoSMP`) is committed in git — see
`memory/security-backdoor-and-secrets.md`.

### Standalone, not a replica set

The old `mongod` ran as a single-member replica set (`rs.status().set` → `rs0`), because the legacy
`xtsOrder.js` opened a change stream. That daemon is gone and the new gateway polls a queue —
`DEPLOYMENT.md` §3. **Install 8.0 as a plain standalone**; do not configure replication.

### On enabling auth

The `Makefile`'s hardcoded `MONGO` URL carries no credentials, so turning on
`security.authorization` breaks `make up`/`make sync` until that URL is updated too. Either do both
together or leave auth off behind the `127.0.0.1` bind. The bind alone closes the exposure that
mattered.

---

## Phase 5 — Deploy the desk system

Follow `DEPLOYMENT.md` §5–§8. Condensed:

```sh
git clone <repo> /opt/algomaker-delta && cd /opt/algomaker-delta
git checkout <branch>
npm ci
cp .env.local.example .env.local && $EDITOR .env.local
npm run build --workspace @algomaker/web
```

`.env.local` essentials — full detail in §6. Start from `.env.prod`, which already holds
`DESK_API_TOKEN`, `DESK_MASTER_KEY`, `DESK_BUS_*` and the Zerodha keys:

```sh
DESK_MONGO_URL=mongodb://127.0.0.1:27017/algomaker
DESK_API_TOKEN=<from .env.prod>
DESK_MASTER_KEY=<from .env.prod — keep a copy off the machine>
DESK_CORS_ORIGINS=http://3.108.231.230              # NO :80 — see below
DESK_LIVE_TAGS=                                     # empty = every live order refused
```

### Serving the dashboard — no proxy needed

`apps/web/src/api.ts:237` builds the API base as
`${window.location.protocol}//${window.location.hostname}:8790`. The browser therefore calls port
**8790 directly**; nothing reverse-proxies it, and CORS is what permits the call.

There is no domain, only the IP `3.108.231.230`, so TLS is not obtainable (no CA issues certificates
for bare IPs) and the deployment is plain HTTP by decision. The login password and session cookie
cross the internet in cleartext; an SSH tunnel
(`ssh -L 80:127.0.0.1:80 -L 8790:127.0.0.1:8790`, browse `http://localhost`) removes that without
certificates if it is ever wanted.

Two exact details:

- **`DESK_CORS_ORIGINS=http://3.108.231.230`** — a default-port origin carries **no port suffix**.
  `http://3.108.231.230:80` will not match what the browser sends, and every request is blocked.
- **Security group must allow both 80 and 8790** from the operator's IP. Opening only 80 loads the
  dashboard and then fails every API call.

**No SPA fallback is needed.** `apps/web/src/shell.tsx:4` — routing is a ~20-line **hash** router,
not react-router, so every route is `#/...` and the server only ever serves `/` plus static assets.
There are no deep paths to rewrite, and any static file server suffices.

Caddy is used because it binds port 80 (keeping the existing `http://3.108.231.230/` URL) and
systemd restarts it on boot — not for any routing feature. `npx serve` under pm2 was the
alternative and was rejected: it cannot bind 80 as `ubuntu` without extra capabilities, and it
fetches from the network at start, which is a poor dependency on a trading host.

```sh
sudo apt install -y caddy          # in noble universe
```

```
# /etc/caddy/Caddyfile — the http:// prefix disables automatic TLS entirely
http://:80 {
    root * /opt/algomaker-delta/apps/web/dist
    file_server
}
```

nginx does the same job if preferred: `listen 80; root /opt/algomaker-delta/apps/web/dist; index index.html;`

```sh
sudo systemctl enable --now caddy
```

Then:

```sh
make up                       # SIMULATED broker — cannot place real orders
make status
node bin/desk-user.mjs create <username>
npx pm2 startup && npx pm2 save
```

---

## Phase 6 — Verify

```sh
curl -s localhost:8790/health                    # {"ok":true}
curl -s localhost:8790/v1/desk/feed | jq .ready  # false ~90s after boot, then true
npx pm2 logs desk-api --lines 50 --nostream | grep -i "listening\|error"
```

Then in the browser: sign in, confirm the mode switch reads **PAPER**, confirm the strategies table
is empty or all-off. Every strategy seeds switched off.

**Reboot once, deliberately, before you trust it.** The old box would not have come back with a
database; confirm this one does:

```sh
sudo reboot
# then: systemctl is-enabled mongod  → enabled
#       npx pm2 list                 → desk-* running
```

Finally, a backup schedule — `desk-daily-reports` and `desk-decisions` are the irreplaceable ones,
and the absence of any backup was the real finding on the old box:

```sh
# /etc/cron.daily/mongo-backup
mongodump --db=algomaker --archive=/var/backups/mongo/algomaker-$(date +\%F).gz --gzip
find /var/backups/mongo -name '*.gz' -mtime +14 -delete
```

---

## Executed and verified — 2026-07-28

Ran end to end on `3.108.231.230`. Post-reboot state, all confirmed after a deliberate reboot:

| Check | Result |
|---|---|
| `uname -r` | `6.8.0-1061-aws` — the pin survived a real reboot |
| `systemctl is-active mongod caddy` | `active` / `active` |
| pm2 | `desk-api`, `desk-gateway`, `desk-marketdata`, `desk-runner` resurrected as `ubuntu` |
| `curl localhost:8790/health` | `{"ok":true}` |
| `curl -I localhost` | `HTTP/1.1 200 OK` |
| `make sync` | 5,503 instruments, freeze limits for 215 symbols |
| Operator | `algo` created via `bin/desk-user.mjs` |

`ready: false` on `/v1/desk/feed` outside market hours is **correct, not a fault** —
`apps/api/src/routes/health.ts:118` is `feedAlive && incomplete === 0`, and with no books held it
reduces to `feedAlive`, which is false because ticks do not flow outside the session
(`apps/marketdata/src/main.ts:10`). It flips true after 09:15.

Marketdata **auto-synced the instrument master** on first start against the empty database
(121,077 dump rows → 5,487 contracts, 6 spots) before `make sync` was run manually.

Run pm2 from `/opt/algomaker-delta`; `npx pm2` elsewhere has no local `node_modules` and downloads a
throwaway copy instead of the pinned 7.0.3.

## Rollback

| Failure point | Recovery |
|---|---|
| Phase 1–2, box unbootable or upgrade wedged | Restore the Phase 0.6 snapshot / launch the AMI. This is why the snapshot is mandatory. |
| Phase 4, restore counts do not match | Data is intact in the `.gz` archives. Drop `algomaker`, re-run `mongorestore`. |
| Phase 5–6, new system will not start | Nothing destructive has happened. The database is restored; debug the app. |

---

## Code follow-up — not blocking, but do it

> **Half of this was resolved on 2026-07-28** by `22fef02a` ("51 dependencies down to 8"):
> `mongodb` is now a **direct** dependency (`package.json:23`) and `loopback-connector-mongodb` is
> gone from the manifest entirely. The version is what is still open.

The driver is pinned at **3.7.3** (2022). Its officially supported server ceiling is MongoDB 5.0;
`DEPLOYMENT.md` §1 reports it verified against 8.2, which is empirical, not vendor-supported.
Moving to `mongodb@6.x` is now a plain version bump with no legacy package holding it back — but it
is a driver API change (`db.collection().find()` cursor semantics, the removal of callbacks), so it
wants its own commit and its own test run, not a line in a deploy.
