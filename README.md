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

## Install in your SST project

Until a `0.1.0` release is cut, install directly from the repo:

```sh
pnpm add github:GerardKetuma/sst-ecs-ec2
```

## Releasing

Releases are cut by tag push:

```sh
# bump packages/sst-ec2/package.json version, then:
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow runs typecheck + tests, verifies the tag matches `package.json`, builds, packs a tarball, and creates a GitHub Release with auto-generated notes.

## Layout

```
packages/sst-ec2/     # Pulumi + SST component package
examples/             # 3 example SST apps
docs/                 # architecture + ops docs
plan.md               # design doc / todo list (checked off as built)
```

## License

MIT
