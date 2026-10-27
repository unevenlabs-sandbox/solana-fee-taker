## Relay Fee Taker

Stateless Solana program for collecting a fixed fee without an extra swap.

Funds (the output of a swap, or a direct deposit) are sent to the fee taker PDA
(native) or its associated token account (spl / token-2022). In the same
transaction, `take_native` / `take_token` forwards `fee_amount` to the given
fee recipient and the rest of the balance to the given `recipient`. If
`fee_amount` exceeds the balance, no fee is taken and the whole balance goes to
`recipient`.

Both recipients are passed as accounts on every call (for tokens, as token
accounts of the same mint); the program holds no state.

Program id (all clusters): `3mB3kHbyvn45hZ87Lp93wY5oKBrAeqKCgRE1mHj9PYYg`.
PDA seed: `fee_taker`.

## Install Anchor

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm use 0.30.1
```

## Build (local / IDL)

```bash
rustup toolchain install nightly-2025-01-01
RUSTUP_TOOLCHAIN=nightly-2025-01-01 anchor build
```

Anchor 0.30.1 builds the IDL with the `nightly` toolchain, but its IDL crate
(`anchor-syn`) uses proc_macro APIs removed from nightlies after early 2025, so
the IDL step fails on a current nightly with `cannot find type SourceFile`.
Pinning an older nightly for the build avoids that.

This build is for tests and for generating `target/idl/relay_fee_taker.json`.
Do not deploy its `.so`; see Deploy.

`Cargo.lock` must stay at `version = 3`: the Solana 1.18 toolchain used by
`cargo build-sbf` can't parse v4 lockfiles, which a current system `cargo`
writes on any dependency change. If it flips, set it back by hand.

## Test

```bash
anchor test
```

## Deploy

Requires docker (running) and `cargo install solana-verify`.

```bash
DEPLOYER_PK=<base58 private key | path to keypair json> ./scripts/deploy.sh mainnet
```

The script builds with `solana-verify build` (a deterministic docker build, so
the deployed hash can be verified against this repo) and deploys with
`solana program deploy`. The deployer pays and is the program's upgrade
authority. The program id comes from `target/deploy/relay_fee_taker-keypair.json`
(gitignored), so keep that file somewhere safe: upgrading requires the same
keypair.

## Verify (Solscan / Explorer "Verified" badge)

After deploying, with the deployed commit pushed to `origin` and the repo
public:

```bash
DEPLOYER_PK=<...> ./scripts/verify.sh [commit] [mainnet rpc url]
```

Answer `yes` when asked to upload the verification data on-chain (signed by the
upgrade authority). Status: https://verify.osec.io/status/3mB3kHbyvn45hZ87Lp93wY5oKBrAeqKCgRE1mHj9PYYg.
Re-run after every upgrade.

## IDL

Publishing the IDL on-chain lets explorers decode `take_token` / `take_native`
instructions by name. It is independent of deploying:

```bash
anchor idl init -f target/idl/relay_fee_taker.json 3mB3kHbyvn45hZ87Lp93wY5oKBrAeqKCgRE1mHj9PYYg \
  --provider.cluster mainnet --provider.wallet <deployer keypair json>
# after an interface change:
anchor idl upgrade -f target/idl/relay_fee_taker.json 3mB3kHbyvn45hZ87Lp93wY5oKBrAeqKCgRE1mHj9PYYg \
  --provider.cluster mainnet --provider.wallet <deployer keypair json>
```

## security.txt

`programs/relay-fee-taker/src/lib.rs` embeds a
[security.txt](https://github.com/neodyme-labs/solana-security-txt) in the
binary (name, contact, policy, source). Explorers show it on the program page.
Changing it requires a redeploy. Check a built binary with
`cargo install query-security-txt && query-security-txt target/deploy/relay_fee_taker.so`.
