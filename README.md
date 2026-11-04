# Coinbit

A bot that finds smart wallets on pump.fun (Solana) **by itself**, watches them in real time, and copies their very early buys. A Next.js dashboard lets you watch everything.

You don't add wallets by hand. The discovery engine hunts for them.

## How it works

```
 ┌─────────────┐   winners    ┌──────────────┐  scores   ┌────────────┐
 │  Sources    │ ───────────▶ │  Discovery   │ ────────▶ │ Watchlist  │
 │ DexScreener │              │ first 60     │           │ top 150    │
 │ pump.fun    │              │ buyers/coin  │           │ traders +  │
 │ self-learn  │              │ + launchers  │           │ launchers  │
 └─────────────┘              └──────────────┘           └─────┬──────┘
                                                               │ websocket
 ┌─────────────┐   exits      ┌──────────────┐  signal   ┌─────▼──────┐
 │ Positions   │ ◀─────────── │  Executor    │ ◀──────── │ Listener + │
 │ TP / SL /   │              │ paper / live │           │ Signal     │
 │ time/mirror │              │ (Jupiter)    │           │ engine     │
 └─────────────┘              └──────────────┘           └────────────┘
```

1. **Discovery** (every 6h, or when you press *Run discovery now*)
   - Collects coins that won big from DexScreener trending/boosted lists, pump.fun's top coins, and coins your watched wallets bought last week (it learns from its own data).
   - For each winner it walks the bonding curve back to launch and records the first 60 buyers and the creator.
   - It scores every wallet on how many winners it got into early and how early, plus how well copying it has actually done.
   - It filters out:
     - **Snipers and bundles**: wallets that buy in the launch block (usually the dev's group).
     - **Insiders**: wallets that are mostly early on one launcher's coins.
     - **HFT bots**: wallets with 1000+ transactions in 3 hours.
     - **Losers**: wallets whose copies keep losing money.
   - It promotes the top wallets to the watchlist. These are **traders** (early buyers) and **launchers** (creators with several winning coins). Mid-tier wallets show up naturally because ranking is based on results, not fame.
2. **Listener**: one websocket subscription per watched wallet (Helius).
3. **Signal engine**: buys when **2 or more smart wallets buy the same coin within 10 minutes**, or when a proven launcher creates a new coin. It skips the coin if:
   - its market cap is over $150K,
   - it's older than 2 hours,
   - the top 10 holders own more than 45%,
   - or any risk limit is hit.
4. **Executor**: paper mode by default. Live mode swaps through Jupiter (it handles bonding-curve and migrated coins), with an optional Jito endpoint.
5. **Position manager**:
   - Take-profit ladder: sells 50% at +100%, 30% at +300%, and 20% at +900%.
   - Stop-loss at −35%.
   - Time exit after 4 hours.
   - Mirror exit when most of the wallets that triggered the buy sell.
   - It also enforces a daily loss limit, which pauses trading when hit.
6. **Feedback loop**: every closed trade's PnL is credited to the wallets that triggered it, so bad wallets sink and good ones rise.

Two more strategies run alongside copy trading, each with its own Off / Paper / Live switch on the Overview page:

- **Migration**: buys pump.fun coins ~7 minutes after they graduate to PumpSwap, if the pool holds $13K+ of liquidity, buyers outnumber sellers after pump.fun's BOOST window, and the price hasn't moved more than 5% while the checks ran (it re-quotes just before buying).
- **Launch sniper** (off by default): buys new pump.fun coins moments after creation. The decision runs in memory with no network call. Before buying, it reads the bonding curve and only trades standard SOL-quoted curves. Live buys go through PumpPortal's Local Transaction API (0.5% fee), and every buy logs how many blocks after the launch it landed. It isn't same-block sniping: that needs a paid Geyser/shred stream.

On top of each strategy's take-profit ladder, stop-loss and time limit, every position has:
- **Profit lock**: once it's up 10%, it keeps 55% of the peak gain.
- **Quote-shock exit**: if the price drops 20% within 10 seconds, it sells straight away after a fresh sell quote confirms the drop.
- **Stagnation exit**: it sells a position that has gone nowhere after 10 minutes.

Paper buys fill at a fresh executable quote, so paper PnL tracks what live trading would get.

## Setup

```bash
cp .env.example .env          # add HELIUS_API_KEY, ADMIN_TOKEN, Telegram (optional)
docker compose up -d          # local Postgres (or use Neon/Supabase and set DATABASE_URL)
npm install
npm run db:push               # create tables

npm run worker                # the bot (discovery + listener + trading)
npm run dev                   # dashboard on http://localhost:3000
```

`npm run discover` runs a single discovery pass and prints the top wallets, which is handy for testing.

## Going live

1. Run in **paper mode** for at least a week, then check win rate and PnL on the dashboard.
2. Create a **fresh hot wallet** just for the bot and fund it with only what you're willing to lose.
3. Set `TRADING_MODE=live`, `TRADER_PRIVATE_KEY`, and keep `POSITION_SIZE_SOL` small.
4. A paid Helius plan (or Geyser gRPC) and `JITO_URL` give faster entries.

## Deploy

- **Dashboard**: Vercel. Set `DATABASE_URL` and `ADMIN_TOKEN`.
- **Worker**: needs to run all the time, so use a VPS, Railway, Fly.io or Render background worker, running `npm run worker` with the full `.env`.
- Both share the same Postgres database.

## Dashboard

- **Overview**: worker status, PnL, open positions, latest signals, a live bot log, and pause/resume and run-discovery buttons.
- **Wallets**: watching, candidate and excluded wallets with scores, winners, average entry, copy PnL, and block/allow buttons.
- **Signals**: every signal and why it was taken or skipped.
- **Positions**: open and closed trades, with a manual close button.

Dashboard actions ask for your `ADMIN_TOKEN` once.

## Roadmap

- Funding-graph clustering, to catch dev groups that use fresh wallets
- Yellowstone Geyser gRPC listener and direct pump.fun program swaps for lower latency
- Base and Ethereum (Uniswap/Aerodrome routers) via the same signal engine
- Telegram commands (`/pause`, `/positions`)

## Risks

Copy-trading meme coins is high risk:
- You always enter after the wallets you copy.
- Paid promoters and insiders often sell into the people copying them.
- Tracked wallets can switch to fresh wallets or make bait buys.

The filters reduce these risks but don't remove them. Paper-trade first, and never risk money you can't afford to lose. Nothing here is financial advice.

## Data sources

- Helius RPC and websockets
- DexScreener public API
- pump.fun's unofficial frontend API (optional, may change)
- Jupiter price and swap API
