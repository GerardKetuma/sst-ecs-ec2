# sst-ecs-ec2

[![CI](https://github.com/GerardKetuma/sst-ecs-ec2/actions/workflows/ci.yml/badge.svg)](https://github.com/GerardKetuma/sst-ecs-ec2/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

SST components for running Amazon ECS services and tasks on **Bottlerocket EC2** container instances, as an alternative to Fargate.

## What's in here

- [`packages/sst-ec2`](packages/sst-ec2) — the `@gketuma/sst-ec2` package (`ClusterEc2`, `ServiceEc2`, `TaskEc2`).
- [`examples/hello-hono`](examples/hello-hono) — minimal single-service ALB app.
- [`examples/multi-service`](examples/multi-service) — API + worker sharing one cluster, on-demand + spot.
- [`examples/batch-task`](examples/batch-task) — scheduled one-shot `TaskEc2` triggered by a Lambda cron.
- [`docs/architecture.md`](docs/architecture.md) — resource graph and deploy flow.
- [`docs/debug-with-bottlerocket.md`](docs/debug-with-bottlerocket.md) — Admin container, SSM Session Manager, ECS Exec.
- [`docs/migration-from-fargate.md`](docs/migration-from-fargate.md) — porting from `sst.aws.Service`.
- [`plan.md`](plan.md) — original implementation plan and phased todo list.

## Quick start

```sh
pnpm install
pnpm typecheck
pnpm test
```

## Workflows

- **[`.github/workflows/ci.yml`](.github/workflows/ci.yml)** — runs on every push to `main` and every PR. Matrix: Node 20 + 22. Steps: checkout → pnpm install (frozen lockfile) → typecheck → test. Concurrency cancels stale runs on rapid pushes.
- **[`.github/workflows/release.yml`](.github/workflows/release.yml)** — fires on `v*.*.*` tag push. Verifies tag matches `packages/sst-ec2/package.json` version (catches bump-forget mistakes), runs typecheck + tests, builds, packs a tarball, creates a GitHub Release with auto-generated notes and the tarball attached.

## Cutting a release

```sh
# bump packages/sst-ec2/package.json from 0.1.0 → 0.1.1
git commit -am "chore: bump to 0.1.1"
git tag v0.1.1
git push && git push --tags
```

The release workflow handles the rest.

## Consumable right now

```sh
pnpm add github:GerardKetuma/sst-ecs-ec2
```

## Encountered and fixed during setup

GitHub also flagged a deprecation notice: `actions/checkout@v4`, `setup-node@v4`, `pnpm/action-setup@v4` are on Node 20 runtime which'll force to Node 24 on 2026-06-02. Cosmetic for now (the job still succeeds) — can bump to `@v5` releases when available. Not blocking.

## Layout

```
packages/sst-ec2/     # Pulumi + SST component package
examples/             # 3 example SST apps
docs/                 # architecture + ops docs
plan.md               # design doc / todo list (checked off as built)
```

## License

MIT
