# Wallet Sweep

An LNbits WASM extension to consolidate funds from multiple wallets, with balance previews, configurable reserves, and optional Lightning Address payouts.

Requires **LNbits 1.6.2-rc1 or later**, with the WASM host interfaces used by this repository. No LNbits core changes or browser dependencies are required.

## Use

1. Open Wallet Sweep in LNbits. Choose an existing destination wallet, then select up to 50 source wallets, individually or with Select all.
2. Optionally retain a whole number of sats in each source, and enable a subsequent Lightning Address payment.
3. Review the per-wallet amounts. Preparing this preview creates destination invoices but moves no funds.
4. Confirm internal consolidation. Sources are processed individually; a failed source does not stop the others. Review each result.
5. For an external destination, select Review external payment. Check the address, payment amount, current destination balance, and fee reserve. Re-enter the address and explicitly confirm the external payment. Partial consolidation requires an additional acknowledgement.

You can keep the funds in the destination instead. There is no automatic external send. Existing destination-wallet funds are excluded from the calculated payment amount. A private history stores plans, fixed invoices, payment intent, and receipts. Open a previous sweep to inspect its results after a refresh or interruption.

## Amounts and fees

- Amounts are in whole sats. Fractional sats remain in source wallets.
- Internal invoice payments settle inside LNbits and have no Lightning routing fees. The instance may charge service fees.
- **Retained amounts are calculated before instance service fees.** The current host does not expose those fee settings, so this extension cannot promise a balance floor after service fees. It rechecks the source balance before starting a transfer.
- External payment amounts are limited to confirmed consolidated funds and the available destination balance, less LNbits' reported fee reserve and an optional additional reserve. Actual routing fees are known only after settlement. Service fees are additional and can affect the remaining balance, including existing destination funds.
- A reserve is not a routing-fee quote. Insufficient funds or receiver payment limits leave funds in the destination wallet. Unused reserves remain there after payment.
- Wallets that cannot send Lightning payments cannot be source wallets. Empty wallets are skipped; internal transfers can consolidate a single whole sat without a Lightning routing-fee reserve.

## Failure handling

A stored invoice is used for each source and for the external payment. Repeated requests do not generate a replacement invoice or automatically retry a recorded payment. Each attempt records its intent before calling the payment host. Independent attempt receipts keep a late duplicate response from overwriting a successful result.

The current host has no general payment-status lookup or atomic storage lock. A pending result, lost response, or interrupted receipt write is therefore treated as **uncertain**, never as a failed payment that is safe to replace. An uncertain source blocks external sending. Check the normal LNbits payment history before making a separate payment or creating another sweep. The extension does not provide automatic reconciliation or rollback of completed transfers.

Consolidation previews expire after 15 minutes, subject to the invoice's own expiry. Prepared external payments expire after five minutes, also subject to the receiver's invoice expiry. Expired external invoices are not replaced automatically; use the normal wallet screen after reviewing its payment history. Concurrent creation of different external invoices for one sweep blocks external sending for that sweep.

All routes require a signed-in account. Storage is owner-scoped by LNbits. No public routes, background spending grants, arbitrary HTTP permission, wallet keys, or scheduled jobs are used.

## Build and verify

Use Node.js 22 or newer. JavaScript is componentized with pinned `@bytecodealliance/jco@1.37.0`, fetched by `npx` when needed. No packages are added to LNbits core.

```sh
make check
make build
make check-host LNBITS_ROOT=../lnbits
make package
```

`make check` runs syntax checks and payment-logic unit tests. `make check-host` uses the adjacent LNbits Python environment to instantiate the compiled component through the real host bindings, test SQLite migrations and account boundaries, and execute both payment phases with mocked backend calls. It creates a temporary database and never accesses live funds.

`make package` creates `dist/wallet_sweep-0.1.0.zip` with a single `wallet_sweep/` runtime directory and prints its SHA-256. The packager also writes `manifest.json` with the artifact hash and the expected GitHub release-asset URL for the version tag. Publish that ZIP at the declared URL before distributing the manifest. Use this artifact for releases: the automatic GitHub source archive includes Python development helpers that the WASM installer rejects.

To use a source checkout, preserve the symlink at `data/wasm_extensions/wallet_sweep` and restart or reload extensions through LNbits' normal workflow. Installation, administrator permission approval, user activation, and database migration must complete before use. Merely building the files does not activate a running instance.

## API

Base path: `/api/v1/ext/wallet_sweep`. Use LNbits account authentication. Responses carry an `ok` flag and either `data` or `error`; core also uses HTTP errors for authentication and host permission failures.

| Method | Path                | Purpose / JSON body                                                                          |
| ------ | ------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/wallets`          | List the account's wallets.                                                                  |
| POST   | `/balance`          | Read one owned wallet: `{walletId}`.                                                         |
| POST   | `/quotes`           | Prepare one fixed internal invoice: `{sourceId, destinationId, leaveSat}`. No funds move.    |
| POST   | `/plans`            | Review a plan: `{quoteIds: [...], address?: "name@example.com"}`. No funds move.             |
| GET    | `/plan?planId=…`    | Read a plan and its payment results.                                                         |
| GET    | `/history?offset=0` | List 20 private plans per page.                                                              |
| POST   | `/consolidate`      | Transfer one source: `{planId, sourceId, confirm: true}`. Call separately for each source.   |
| POST   | `/payout/prepare`   | Prepare the external invoice: `{planId, extraReserveSat?: 0}`. No funds move.                |
| POST   | `/payout/send`      | Send the fixed invoice: `{planId, payoutId, address, confirm: true, confirmPartial?: true}`. |

The external payment is always a separate explicit call. A request must not chain it automatically from consolidation. `confirm` must be the boolean `true`. `confirmPartial` is required if a nonzero source transfer failed. A successful transport response is not proof of settlement: inspect the per-source or payout `status` (`ready`, `success`, `failed`, `skipped`, or `uncertain`).
