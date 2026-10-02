# Runtime provenance for local acceptance

These exact official versions were independently provisioned by ROOT on 2026-10-01. They are local acceptance dependencies, not production provisioning. The dedicated package/lock have no install scripts and are separate from the application dependency link.

## AWS SDK

- `@aws-sdk/client-s3` **3.1144.0**, official npm registry; upstream engine `>=20.0.0`.
- Tarball: `https://registry.npmjs.org/@aws-sdk/client-s3/-/client-s3-3.1144.0.tgz`.
- Registry integrity: `sha512-CAicFlKAuCAUEU1tIptCTh6Eikr4rig9CWYwofZdEuJm9i24XNclgCspV4DKXlOY2nK2AMGHRt88oxmwDdNW7w==`.
- Registry SHA-1: `e82c0c34ffacca4929d3c5fe66b65051aa9dadc8`.
- Exact transitive package URLs/integrities are pinned in `package-lock.json`. ROOT checked registry URL/integrity/engine, copied package+lock into its dedicated `work/dependencies/offsite-3.1144.0` cache, and `npm ci --ignore-scripts` installed 26 packages. Local source links that verified cache; no application dependency install was performed.

## age

- Official age **v1.3.2**, local architecture Darwin arm64.
- Archive: `https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-darwin-arm64.tar.gz`.
- Archive SHA-256: `e2020b073c44f692685a24d6abc378817eb81ffaaf49fd0531ef8565f767f2f5`.
- Adjacent `.proof` SHA-256: `26e3fcc371f19e35c7d37500baf8e82c4386538dc6f47e66f4e0fefec50531e4`.
- ROOT matched both hashes, built official `sigsum-verify` v0.13.1 using Go module checksum verification, and successfully verified the **full** built-in `sigsum-generic-2025-1` proof using both pinned official maintainer keys from the exact [v1.3.2 SIGSUM.md](https://github.com/FiloSottile/age/blob/v1.3.2/SIGSUM.md).
- ROOT extracted only regular `age` / `age-keygen` binaries, mode `0700`; `age --version` returned `v1.3.2`.
- Binary SHA-256 `age`: `4012dfc2725883beafb710894af4f599b7a94f8c8e0f51f02cc96ab8df33915e`.
- Binary SHA-256 `age-keygen`: `c16e229245123d0ad27442317461d63915416cad0294395cd19ca93feb3211ea`.

### Pinned binary hashes (`age-pins.json`)

The drill classes a cipher as genuine age only when the executable's SHA-256 equals the entry in `age-pins.json` for `${process.platform}-${process.arch}`; otherwise it fails with `AGE_UNPINNED`. Only `darwin-arm64` is pinned (the hash above). Before a drill, the human runs `shasum -a 256 <age>` and compares it to both this file and `age-pins.json`. A new platform (e.g. `linux-arm64`, `linux-x64`) is added only after its official archive and `.proof` are verified as above; record its binary hash here and in `age-pins.json` in the same commit.

Production Linux/Pi provisioning must select the correct architecture's official release and verify its corresponding archive/proof separately. These Darwin hashes do not validate a Linux executable. The source does not download or update either runtime.

Official primary references informing the adapter/retention boundaries: [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [AWS SDK v3 R2 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/), [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/), [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/), [age source](https://github.com/FiloSottile/age), [age format](https://age-encryption.org/v1). No external calls are made by local tests.
