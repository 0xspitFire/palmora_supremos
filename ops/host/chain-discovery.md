# Chain discovery diagnostics

Discovery reads logs; it never signs or sends transactions. A scan jump means the recorded range was not read. Cursor advancement caused by a jump is not evidence of a successful scan.

Secondary-chain logs distinguish `replication_discovery` (successful/idle tick, actual `fromBlock`/`toBlock`, captured `headBlock`, `caughtUp`, duration and partial watched-wallet coverage) from `replication_discovery_unavailable` (returned failure or exception). Provider error text and RPC URLs are never included. Existing scan-jump notices remain summarized and the exact gaps remain retained.

Robinhood discovery starts immediately and polls at most fifteen seconds after a completed caught-up scan, even when the Ethereum discovery interval is two minutes. A successful bounded batch that still has unread blocks schedules another batch after one second. Base retains its configured normal interval with the same bounded catch-up behavior. At most one batch runs per chain; stop cancels future batches. Failed batches wait for the normal interval. Persistent failure produces an actionable administrator notice after five minutes, then at most every fifteen minutes during that failure episode.

The engine classifies nested RPC failures into fixed categories. Only an explicit log-range/result-size rejection shrinks the request. Authentication, rate limits, timeouts and unknown failures do not multiply requests. Requests remain bounded by the existing eight slices per discovery batch and configured maximum range. Watched-wallet receipt-only evidence never becomes authority to replicate a mint.

## Check the deployed scanner

1. Confirm the expected release is installed and the service is running. Do not release the kill switch merely to inspect discovery; discovery is read-only.
2. Inspect only the scanner log fields listed above. During ordinary operation Robinhood should show recent successful ranges and `caughtUp=true` regularly. Catch-up batches can report false temporarily.
3. Compare consecutive successful `toBlock`/`fromBlock` values and any explicitly retained skipped ranges. A continuously moving cursor without successful ranges is insufficient.
4. Confirm new jumps are not occurring every polling interval. An outage or restart may legitimately leave an explicitly recorded gap; the fix does not erase or backfill historical gaps or certify missed opportunities.
5. If unavailable continues, use `rpc-health` and investigate provider authentication, quotas or availability through approved configuration tools. A healthy block-number response alone does not prove log queries work.

Do not infer permission to mint from scanner health. Chain grants, fresh opportunity/proof/simulation, signed custody policy, funding, admission reservations, kill switch and finality checks remain mandatory. A newly installed source release follows the usual release-bound D-017 refresh/owner acceptance process.
