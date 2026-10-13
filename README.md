## Fee Taker

Stateless Solana program for collecting a fixed fee without an extra swap.

Funds (the output of a swap, or a direct deposit) are sent to the fee taker PDA
(native) or its associated token account (spl / token-2022). In the same
transaction, `take_native` / `take_token` forwards `fee_amount` to the given
fee recipient and the rest of the balance to the given `recipient`. If
`fee_amount` exceeds the balance, no fee is taken and the whole balance goes to
`recipient`.

Both recipients are passed as accounts on every call (for tokens, as token
accounts of the same mint); the program holds no state.

## Install Anchor

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm use 0.30.1
```

## Build

```bash
rustup toolchain install nightly-2025-01-01
RUSTUP_TOOLCHAIN=nightly-2025-01-01 anchor build
```

Anchor 0.30.1 builds the IDL with the `nightly` toolchain, but its IDL crate
(`anchor-syn`) uses proc_macro APIs removed from nightlies after early 2025, so
the IDL step fails on a current nightly with `cannot find type SourceFile`.
Pinning an older nightly for the build avoids that.

## Test

```bash
anchor test
```

## Deploy

```bash
DEPLOYER_PK=<base58 private key | path to keypair json> ./scripts/deploy.sh devnet
```

The deployer pays for the deployment and is the program's upgrade authority.
The program id comes from `target/deploy/fee_taker-keypair.json` (gitignored),
so keep that file somewhere safe: upgrading requires the same keypair.
