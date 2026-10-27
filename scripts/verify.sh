#!/usr/bin/env bash
#
# Submits the deployed mainnet program for remote verification (OtterSec API),
# which is what Solscan / Solana Explorer read to show "Verified" + source.
#
# Usage:
#   DEPLOYER_PK=<base58 private key | path to keypair json> ./scripts/verify.sh [commit] [rpc url]
#
#   commit   git commit the deployed binary was built from (default: HEAD)
#   rpc url  mainnet rpc (default: public endpoint; a paid one is more reliable)
#
# Requirements: the repo is public, the commit is pushed to origin, and the
# deployer is the program's upgrade authority (it signs the verification PDA
# write). Answer "yes" when asked to upload the verification data on-chain.

set -euo pipefail

cd "$(dirname "$0")/.."

commit="${1:-$(git rev-parse HEAD)}"
url="${2:-https://api.mainnet-beta.solana.com}"
program_id="3mB3kHbyvn45hZ87Lp93wY5oKBrAeqKCgRE1mHj9PYYg"
repo="https://github.com/unevenlabs-sandbox/solana-fee-taker"

if [[ -z "${DEPLOYER_PK:-}" ]]; then
    echo "error: DEPLOYER_PK is not set" >&2
    exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "warning: working tree has uncommitted changes; verification uses commit $commit from origin" >&2
fi

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
        Keypair.fromSecretKey(secret);
        process.stdout.write(JSON.stringify(Array.from(secret)));
    ' > "$wallet"
fi

echo "program id: $program_id"
echo "commit:     $commit"
echo "uploader:   $(solana-keygen pubkey "$wallet")"

solana-verify verify-from-repo \
    --remote \
    --url "$url" \
    --keypair "$wallet" \
    --program-id "$program_id" \
    --library-name relay_fee_taker \
    --commit-hash "$commit" \
    "$repo"

echo "status: https://verify.osec.io/status/$program_id"
