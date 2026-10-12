#!/usr/bin/env bash
#
# Builds and deploys (or upgrades) the fee_taker program.
#
# Usage:
#   DEPLOYER_PK=<base58 private key | path to keypair json> ./scripts/deploy.sh <cluster>
#
#   <cluster>  devnet | mainnet | localnet | <rpc url>
#
# The deployer pays for the deployment and becomes (or must already be) the
# program's upgrade authority. The program id comes from
# target/deploy/fee_taker-keypair.json, so that file must be the one the
# program was originally deployed with when upgrading.

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

if [[ ! -f target/deploy/fee_taker-keypair.json ]]; then
    echo "error: target/deploy/fee_taker-keypair.json not found (run 'anchor build' once, or restore the keypair the program was deployed with)" >&2
    exit 1
fi

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

program_id="$(solana-keygen pubkey target/deploy/fee_taker-keypair.json)"
deployer="$(solana-keygen pubkey "$wallet")"

echo "cluster:    $cluster"
echo "program id: $program_id"
echo "deployer:   $deployer"

anchor build
anchor deploy \
    --program-name fee_taker \
    --provider.cluster "$cluster" \
    --provider.wallet "$wallet"
