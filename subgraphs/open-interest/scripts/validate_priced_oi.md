# validate_priced_oi.py

Replay NegRiskAdapter / CTF logs and compare circulating `yesSupply` / `noSupply`
against Polymarket's data-api open interest.

The Alchemy free plan only allows a 10-block `eth_getLogs` window, so the script
uses Alchemy (if `$HOME/.alchemy_polygon_key` is present) for `eth_call` and
`https://polygon.gateway.tenderly.co` for logs. It never prints the RPC key.

```bash
python3 scripts/validate_priced_oi.py
# optional: also replay every Dem-nomination market's splits (slow)
FULL_DEM_SPLITS=1 python3 scripts/validate_priced_oi.py
```

It pins a block, computes `amount` / `yesSupply` / `noSupply` from logs, checks
burned NO at `NO_TOKEN_BURN_ADDRESS` against `minted + burned`, and compares
`yesSupply * p + noSupply * (1-p)` (Gamma / CLOB yes price) with
`https://data-api.polymarket.com/v2/oi?condition=<id>` (fetched with curl;
Python urllib is 403'd).
