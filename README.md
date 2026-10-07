# PixSettle Ledger on Arc

USDC settlement on [Arc](https://docs.arc.io) for small-business orders paid by **Pix**, Brazil's instant payment system, with the exception rules that cross-border merchants actually run into enforced on-chain.

It is the EVM settlement layer of [PixSettle](https://github.com/rafaorlando3/pixsettle), a reconciliation and exception-handling service for merchants on the Brazil and Paraguay border. In this repository the Pix side is **simulated off-chain**: no real Pix provider, bank or customer data is involved.

## What the contract guarantees

| Situation | On-chain rule |
| --- | --- |
| Order paid, ready to settle | `settle` pulls USDC from the treasury to the merchant and stores the SHA-256 digest of a canonical receipt (`scripts/receipt.cjs`, version `pixsettle-arc-receipt/1`); the treasury that paid is stored per order |
| Same settlement sent twice (retry, crash, timeout) | Exact replay of a `settlementId` returns `false` and pays nothing; a replay with any different field reverts |
| Second settlement for the same order | Reverts: one settlement per order |
| Customer disputes or refund requested **before** settlement | `openRefundCase` blocks settlement; the operator closes it as refunded (order ends unpaid) or dismissed (order can settle again) |
| Refund confirmed **after** settlement | The order becomes **exposure**; only that order's merchant can return the exact amount to the treasury with `returnExposure` |
| Account without code, or 18-decimal native USDC confused with the 6-decimal ERC-20 interface | Deployment reverts (`WrongDecimals`). Decimals do not authenticate the token: a fake 6-decimal token would pass the constructor, so `scripts/preflight.cjs` checks chain id, the official USDC address (no override on Arc), code, decimals and `ledger.usdc()` before any approval or transfer |

States: `None → Settled → Exposure → Closed`, and `None → RefundOpen → None | Closed`.

## Arc specifics

- USDC is read and moved only through the ERC-20 interface at `0x3600000000000000000000000000000000000000`, which uses **6 decimals** on both Arc mainnet (chain 5042) and testnet (chain 5042002). The native gas unit uses 18 decimals; the contract never touches `msg.value`. Source: [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses).
- Compiled for `evmVersion: paris` with Solidity 0.8.24.
- `scripts/check-arc.cjs` simulates the deployment with `eth_call` against the public Arc RPCs, without a key and without spending gas. On 2026-10-01 it succeeded on mainnet and testnet, the 18-decimal variant reverted with `WrongDecimals`, and the estimated deployment gas was about 1.08M (1,097,493 after the v2 changes, re-run the same day) (about 0.02 USDC at the 20 gwei mainnet gas price read the same day). This is a historical estimate, not the current cost: re-estimate gas and price right before any real run. The mainnet deployment on 2026-10-07 used 1,088,125 gas.

## Run it

Requires Node.js 20 or newer (`scripts/receipt.cjs` uses `String.prototype.isWellFormed`); checked with Node 22.

```bash
npm ci
npx hardhat test                    # 34 tests
npx hardhat run scripts/demo-flow.cjs   # the four cases on a local chain
node scripts/check-arc.cjs          # deployment simulation on Arc, no key needed
```

Deploy (keys only in environment variables, never in files):

```bash
ARC_DEPLOYER_KEY=... OPERATOR=0x... TREASURY=0x... \
  npx hardhat run scripts/deploy.cjs --network arcMainnet
ARC_DEPLOYER_KEY=... MERCHANT_KEY=... LEDGER=0x... \
  npx hardhat run scripts/demo-flow.cjs --network arcMainnet
```

## Dashboard

`web/index.html` is a single static page with no dependencies. It reads the ledger's events from a public Arc RPC with `eth_getLogs` and shows settled orders, volume, absorbed replays, open exposure and returned exposure, with explorer links. Open it with `?net=mainnet&address=<ledger>&from=<start block>`. Every number is labelled as covering only the block range read, with the RPC and the time of the snapshot. The page calls it full history only when the address and start block match the deploy published in the page (`PUBLISHED`, filled after the deploy is checked from outside); code at an address proves a contract exists, not that it is this ledger. Orders whose first event in the range is not a settlement or a refund opened before settlement are marked as having history before the range; their state starts as `Unknown` (a replay, close or return seen alone does not prove the order was never settled) and only an event that implies a state changes it, and an empty range is never shown as zero exposure. The page checks that the address has code and that the block is not in the future, reads in 10,000-block pages (up to 400 RPC requests), formats amounts exactly from integers, clears old values on any error, and only the latest load can change the page (older requests are aborted and ignored, results and errors alike). The public page has no configurable RPC.

## Deployment

Arc mainnet (chain ID 5042):

- Contract: [0x642396a0279107b256c4ad62e219e6b9678916b0](https://explorer.arc.io/address/0x642396a0279107b256c4ad62e219e6b9678916b0)
- Deployment transaction: [0xb18a12f00f2bdc52fbc5a89d6ed007d6e51ffa78dd233f354f16b8b5ab57cdc3](https://explorer.arc.io/tx/0xb18a12f00f2bdc52fbc5a89d6ed007d6e51ffa78dd233f354f16b8b5ab57cdc3)
- Deployment block: **24681974**
- Runtime code: **4,357 bytes**

A separate read-only verification on 2026-10-07 matched the deployed runtime byte for byte with the compiled v5 artifact (solc 0.8.24, optimizer 200 runs, evmVersion paris; the only filled positions are the three immutable references to the USDC address). It also checked the deployment receipt and constructor arguments, all ten demo transactions (sender, nonce, target, calldata and successful receipt), the expected ledger events, and the final order states. It does not prove real Pix payments: the Pix side remains simulated.

| Demo step | Transaction |
| --- | --- |
| Treasury approval | [0xc2f1393c…](https://explorer.arc.io/tx/0xc2f1393c37b3389d37182972998cfc1f429bc90065f8e3b4411f3d3f9059c8cf) |
| Merchant registration | [0x74c71d78…](https://explorer.arc.io/tx/0x74c71d78f8b43aa87b772292fc4466f47f2017e5c374e43b217f52ebb10dfd83) |
| Settlement | [0xb5a11b5d…](https://explorer.arc.io/tx/0xb5a11b5dce6407c58f06cdbcaa1a83a68c90ec59706da51b782cd174b3271449) |
| Exact replay | [0x40da7356…](https://explorer.arc.io/tx/0x40da7356d7475f0f867093d98e135611f3ef93a378c12f7e6b1a219699c9c88c) |
| Refund before settlement opened | [0x9f038dc6…](https://explorer.arc.io/tx/0x9f038dc680eb536c60a90aca66eaa910da946b649f19318e6c9f029bb79feaa4) |
| Refund before settlement closed | [0x18f21527…](https://explorer.arc.io/tx/0x18f21527d80474ff6e6487d9fbf7b3c4f040dc6efe6b53317944ec2d8f8d4905) |
| Second settlement | [0x4225813e…](https://explorer.arc.io/tx/0x4225813e3fe545af3d44455579059daa747bffd42c593570c9ac4a5fad27e9f1) |
| Refund after settlement opened | [0x6231895b…](https://explorer.arc.io/tx/0x6231895b3d5e4a7195e15477df37e737b051473e6bb40c1cd0b2f51b8842b4e8) |
| Merchant return approval | [0xca291314…](https://explorer.arc.io/tx/0xca2913141aa2b633025f40b749c9e5cb4214087a668123ca3c40d320495cc391) |
| Exposure returned and case closed | [0x1bd9507e…](https://explorer.arc.io/tx/0x1bd9507e5992f74730c64842a2634ee2792e4cc809043a74c73ef5fa368e5346) |

## Team

Rafael Orlando Mendes leads the project, defines the problem and exception rules, and reviews delivery. The demonstration uses fictional orders and simulated Pix events.

## License

MIT

## Receipts and demo resume (v2)

Each settlement stores `sha256` of a canonical JSON receipt (sorted keys, objects and printable-ASCII strings only; inside that domain the bytes match RFC 8785, checked in the tests against an independent implementation; anything outside it, including lone surrogates, is rejected). The receipt carries version, chain id, ledger, order, settlement id, merchant, amount in base units, currency and the simulated Pix status. `verify()` first validates the meaning of the receipt (closed schema, currency USDC, Pix status simulated, non-empty e2eId, canonical decimal chain id and positive amount below 2^256), then recomputes the digest and compares it with the `Settled` event. A receipt created with another currency or Pix status is rejected even when its own digest was recorded. Malformed receipts or events return a diagnostic instead of throwing. The digest proves the receipt did not change after it was recorded; it does not prove that a real Pix happened. In this demo Pix is simulated.

`scripts/demo-flow.cjs` keeps a stable manifest (`DEMO_MANIFEST`, `RUN_ID`). Every transaction is recorded before waiting for its receipt. Re-running with the same manifest skips confirmed steps and stops on an unknown or reverted result instead of sending again. A value cap (`MAX_TOTAL_UNITS`, default 0.20 USDC) and the preflight run before any approval; the cap covers only the two settlements, not gas, approvals or the merchant's exposure return, so gas and the balance of both signers must be estimated before a real run. Only one process can use a manifest (exclusive lock file); the manifest is checked (version, run, amount, `RUN_ID`), the receipt block is stored also when a pending hash is reconciled, and on Arc a new manifest is refused if the ledger already has orders for that `RUN_ID` (a lost manifest is reconciled from the chain, never replaced by a fresh run). A step recorded as `success` is accepted only with proof on chain: a well-formed hash and block, a successful receipt in that same block, and a transaction whose sender, target and calldata are exactly the step's; anything missing or different stops the run for reconciliation without sending. At the end the run requires the final states (order 1 Settled, orders 3 and 4 Closed) and, in each step's own transaction, the event that defines it (8 checks); a different state is reported, never "fixed" with new transactions. `test/demo-resume.sh` exercises these paths against a local node (helpers in `tools/`, local node only) and fails on an unexpected success or an unexpected error message, checking the nonces of both signers.

Since v5 a resumed run first reconciles everything without sending: the recorded steps must be an exact prefix of the plan (no gap, no reordering, only the last one may be pending), each with its receipt, matching transaction and the events of that very step (steps 1 and 2 share calldata and differ only by events), and the current order states must match that prefix. Only then are missing steps sent, each with a state check right before and a proof right after. This does not make the run atomic: an external change after a read is still possible and is caught by the final checks. `test/demo-reconcile.sh` covers a gap before a recorded step, a pending record in the middle, reordering, an order changed before resuming, step 2 pointing to step 1's transaction, and positive resumes before 4c (2 merchant transactions) and before 4d (1).
