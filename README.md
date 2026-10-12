## Fee Taker

Stateless Solana program for collecting a fixed fee without an extra swap.

Funds (the output of a swap, or a direct deposit) are sent to the fee taker PDA
(native) or its associated token account (spl / token-2022). In the same
transaction, `take_native` / `take_token` forwards `fee_amount` to the constant
`FEE_RECIPIENT` and the rest of the balance to the given `recipient`. If
`fee_amount` exceeds the balance, no fee is taken and the whole balance goes to
`recipient`.

`FEE_RECIPIENT` is a compile-time constant in
`programs/fee-taker/src/lib.rs`; for tokens the fee is sent to its associated
token account, which must already exist.

## Install Anchor

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm use 0.30.1
```

## Build

```bash
anchor build
```

## Test

```bash
anchor test
```

## Deploy

```bash
anchor deploy --provider.cluster devnet
```
