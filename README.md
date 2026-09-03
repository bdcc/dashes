# a16z static boards

Two fully static boards over **public a16z portfolio career data** — copy this
folder anywhere static (GitHub Pages, Netlify, a subpath) and open `index.html`.

| Board | What it shows | Data |
|---|---|---|
| **Roles Flow** (`flow/`) | the sankey flow diagram — roles through functions, companies, cities, over time | full tracked portfolio (~830 companies) |
| **Tiny World** (`world/`) | 3D cartogram: one island per job center; each company is a village of function buildings (engineering / product / design / …); click a company for its **live open roles, each linking to the job page** | speedrun cohort (~42 companies) |

Both boards load **JSON by default** and support `?data=sqlite` (sql.js opens
`demo/demo.db`, which holds the same payloads in a `payload` table plus the raw
`monitor_*` aggregate tables).

## Preview locally

```bash
python -m http.server 8071 -d publish/a16z-static
# → http://localhost:8071
```

ES modules need an http server — `file://` will not work.

## Regenerate

Run on the collector VM (this folder's generator lives in the job-collector repo):

```bash
python cli.py a16z snapshot          # fresh crawl → jobs.db
python scripts/export_static_board.py
# writes: flow/data.json · world/data.json · demo/demo.db
```

The generator **fails loudly** if any location string can't be mapped to a job
center (unplaced roles gate). The alias list is **single-sourced**: the board
resolves locations at runtime from `world/geo-data.js`
(`LOCATION_ALIASES` + `CENTERS`), and the generator parses that same file to
mirror the resolution — add a new location string there and re-run. Never
silence the gate with `--force` without fixing the alias.

Options: `--offline` (skip the live speedrun API fetch), `--force` (write even
with unplaced roles), `--db`, `--out`.

## Publish on GitHub Pages

1. Create a **new, separate repo** on github.com — public or private, your call
   (public is free hosting; nothing personal is in this folder). No README init.
   Example name: `a16z-boards`.
2. On the VM, clone it and fill it:
   ```bash
   cd /home/v/projects/job-collector
   git clone https://github.com/<you>/a16z-boards.git /home/v/a16z-boards
   cd /home/v/a16z-boards
   cp -r /home/v/projects/job-collector/publish/a16z-static/. .
   rm -rf demo/               # demo.db is ~10MB binary churn — see "sqlite option" below
   git add -A && git commit -m "first fill" && git push origin main
   ```
   The first push prompts for credentials — paste a **PAT** (repo scope). Make
   it stick: `git config credential.helper store` (or `gh auth login`).
   > **Never** add the job-collector repo itself as a remote of this one —
   > jobs.db and the personal tables live there and must never be pushed.
3. Repo → **Settings → Pages** → Deploy from branch → `main`, `/ (root)` → Save.
   You get `https://<you>.github.io/a16z-boards/` after a minute or two.

### The sqlite option (optional)

The `?data=sqlite` path loads from `demo/demo.db`. If you skip it (the `rm -rf
demo/` above), the boards still work — JSON is the default. Add it back any
time with `cp -r …/publish/a16z-static/demo .` and a push.

## Automate the refresh (cron on the VM)

The refresh pipeline needs no keys and no login — it reads the public
speedrun API and writes JSON. One cron line, daily:

```
# crontab -e
3 4 * * * cd /home/v/projects/job-collector && source ~/.bashrc && /home/v/.pyenv/shims/python3 cli.py a16z snapshot && /home/v/.pyenv/shims/python3 scripts/export_static_board.py --out /home/v/a16z-boards && git -C /home/v/a16z-boards add -A && git -C /home/v/a16z-boards commit -m "refresh $(date +%F)" && git -C /home/v/a16z-boards push origin main >> /tmp/a16z-boards-cron.log 2>&1
```

Notes:
- `--out /home/v/a16z-boards` writes the three data files straight into the
  Pages clone — no copy step. The static pages (`index.html`, `loader.js`,
  `flow/`, `world/`, README) were copied once at setup and only change when
  the boards themselves change.
- `source ~/.bashrc` gives cron the PATH and the `GITHUB_PAT` needed for
  `git push` (cron does not run your shell profile by default).
- Off the `:00` minute (4:03) so the push doesn't collide with every other
  bot's; the log file catches failures.
- The gate protects you: if a new location string would strand roles, the
  generator exits non-zero, the `&&` chain stops, nothing commits. Fix it by
  adding an alias in `world/geo-data.js`, push, and the next night heals.
- All paths absolute, pyenv python absolute — cron's PATH is minimal.
- Pages updates on push; give it a minute, then `?v=` busting is unnecessary —
  the payloads are re-fetched every page load (no aggressive caching).

## Data & privacy

- **Public-board aggregates only**: a16z portfolio company snapshots, roles,
  signals and company metadata — all read from public career APIs
  (speedrun-talent-network.com, company ATS boards).
- **Never included**: applications, watchlist, people, tasks, crawl logs,
  reports, resumes, keys. The `demo/demo.db` is generated fresh from those
  four `monitor_*` aggregate tables and a `payload` table only.
- Tiny World's role links go to the public job pages (speedrun-talent-network.com)
  — no personal application state is exposed, now or later.

## Layout

```
index.html          launcher → flow/ + world/
loader.js           shared json/sqlite loader (sql.js via jsdelivr)
flow/               Roles Flow (static build of a16z_demo)
world/              Tiny World: engine + chrome (geo-board.js, geo-data.js,
                    index.html) — villages, function buildings, roles list
demo/demo.db        reduced sqlite: monitor_* aggregates + payload table
404.html            Pages SPA fallback → back to the launcher
.nojekyll           Pages: skip Jekyll so /flow/ and /world/ pass through
```
