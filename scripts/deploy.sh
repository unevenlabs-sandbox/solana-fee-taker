#!/usr/bin/env bash
#
# Builds the relay_fee_taker program reproducibly (solana-verify + docker) and
# deploys (or upgrades) it.
#
# Usage:
#   DEPLOYER_PK=<base58 private key | path to keypair json> ./scripts/deploy.sh <cluster>
#
#   <cluster>  devnet | mainnet | localnet | <rpc url>
#
# The deployer pays for the deployment and becomes (or must already be) the
# program's upgrade authority. The program id comes from
# target/deploy/relay_fee_taker-keypair.json, so that file must be the one the
# program was originally deployed with when upgrading.
#
# The binary is built with `solana-verify build` so the deployed hash matches a
# docker build of the public repo. Never deploy an `anchor build` artifact: its
# hash differs and verification (scripts/verify.sh) would fail.

set -euo pipefail

cd "$(dirname "$0")/.."

cluster="${1:-}"
if [[ -z "$cluster" ]]; then
    echo "usage: DEPLOYER_PK=<base58 private key | keypair json path> $0 <cluster>" >&2
    exit 1
fi

if [[ -z "${DEPLOYER_PK:-}" ]]; then
    echo "error: DEPLOYER_PK is not set" >&2
    exit 1
fi

if [[ ! -f target/deploy/relay_fee_taker-keypair.json ]]; then
    echo "error: target/deploy/relay_fee_taker-keypair.json not found (restore the keypair the program was deployed with)" >&2
    exit 1
fi

if ! command -v solana-verify >/dev/null; then
    echo "error: solana-verify not installed (cargo install solana-verify)" >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "error: docker is not running (solana-verify builds inside a container)" >&2
    exit 1
fi

case "$cluster" in
    mainnet) url="https://api.mainnet-beta.solana.com" ;;
    devnet) url="https://api.devnet.solana.com" ;;
    localnet) url="http://127.0.0.1:8899" ;;
    *) url="$cluster" ;;
esac

# Materialize the deployer keypair as a file for the solana cli. Base58 keys
# are converted to the json byte-array format in a temp file that is removed
# on exit, so the private key never lands in the repo.
if [[ -f "$DEPLOYER_PK" ]]; then
    wallet="$DEPLOYER_PK"
else
    wallet="$(mktemp)"
    chmod 600 "$wallet"
    trap 'rm -f "$wallet"' EXIT
    DEPLOYER_PK="$DEPLOYER_PK" node -e '
        const bs58 = require("bs58").default;
        const { Keypair } = require("@solana/web3.js");
        const secret = bs58.decode(process.env.DEPLOYER_PK);
        // Validates the key (throws on a bad length)
        Keypair.fromSecretKey(secret);
        process.stdout.write(JSON.stringify(Array.from(secret)));
    ' > "$wallet"
fi

program_id="$(solana-keygen pubkey target/deploy/relay_fee_taker-keypair.json)"
deployer="$(solana-keygen pubkey "$wallet")"

echo "cluster:    $cluster ($url)"
echo "program id: $program_id"
echo "deployer:   $deployer"

solana-verify build --library-name relay_fee_taker
echo "executable hash: $(solana-verify get-executable-hash target/deploy/relay_fee_taker.so)"

solana program deploy \
    --url "$url" \
    --keypair "$wallet" \
    --program-id target/deploy/relay_fee_taker-keypair.json \
    --with-compute-unit-price 50000 \
    --max-sign-attempts 100 \
    --use-rpc \
    target/deploy/relay_fee_taker.so

echo "on-chain hash:   $(solana-verify get-program-hash --url "$url" "$program_id")"
