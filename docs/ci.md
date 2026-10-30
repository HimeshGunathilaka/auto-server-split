# CI

Run the tool on every pull request so new opportunities (or a client bundle that grows past a
budget) don't go unnoticed.

## `--check`

`--check` exits `2` when a split is available, which fails the step:

```yaml
# .github/workflows/ci.yml (excerpt)
- run: npx auto-server-split --check
```

To report splits without failing the build, add `continue-on-error: true` to the step. The output lists each available split and its estimated saving either way.

## GitHub Action

On GitHub, the repository's action runs `--check --format github`: each available split gets an annotation on its file, each timezone warning a warning annotation, and the job summary gets the markdown report. It runs the project's own installed copy unless you set `version`; either must be 1.0.2 or later, and the action stops with an error otherwise.

```yaml
# .github/workflows/auto-split.yml
on: pull_request
jobs:
  auto-split:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # --since needs the base branch
      - uses: actions/setup-node@v4
      - run: npm ci
      - uses: HimeshGunathilaka/auto-server-split@v1.0.3 # a release tag or commit SHA
        with:
          since: origin/${{ github.base_ref }} # only the files this pull request changes
          # working-directory: apps/web
          # baseline: auto-split.baseline.json
          # fail-on-changes: false
          # args: --remove-unused-directives
```

## Adopting `--check` in an existing app

Record today's opportunities with `npx auto-server-split --write-baseline auto-split.baseline.json`, commit the file, and pass `--baseline auto-split.baseline.json` (the action's `baseline` input) in CI. Only new opportunities fail the check; a component that moves keeps matching its entry by fingerprint. Regenerate the file as you apply the listed ones. `--since` is the other way to scope CI: it checks only the files a pull request touches.

## Budgets

`check` in the config decides what fails `--check`: only changes that save at least `minSaving` (or `minRouteSaving` on one route), and budgets for the total left on the table (`maxRecoverable`) and new `"use client"` files compared with the baseline (`maxNewBoundaries`). See [docs/configuration.md](configuration.md#check).

## Code scanning and other CI systems

`--format sarif --output auto-split.sarif` writes a SARIF 2.1.0 log for GitHub code scanning and other tools; results carry fingerprints, so an alert survives line moves:

```yaml
- run: npx auto-server-split --format sarif --output auto-split.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: auto-split.sarif
    category: auto-server-split
```

`--format gitlab --output gl-code-quality.json` writes a GitLab Code Quality report (`artifacts: reports: codequality`). `--format html --output auto-split.html` makes a report to keep as a build artifact.

## Comparing runs

`npx auto-server-split compare main.json pr.json` (two `--json` reports) lists new opportunities, the ones applied, savings that moved and skips that changed; `--format markdown` for a comment, `--fail-on-new` to exit `2` when there are new ones.
